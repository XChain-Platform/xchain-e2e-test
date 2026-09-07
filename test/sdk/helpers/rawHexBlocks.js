/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 * XChain Platform E2E - raw-hex block placement
 *
 * `generateblock(payout, [rawhex, ...])` takes RAW HEX and ignores the mempool,
 * so it re-injects and orders in one step: a drill that has to own the (block,
 * position) of a transaction can place it there whatever the node's own mempool
 * and ancestor-feerate packing would have done. That property is the whole
 * mechanism behind two otherwise unrelated drills, so it lives here rather than
 * inside either of them:
 *
 *   - chunkedDeployReorgDrill: snapshot the window it is about to orphan and lay
 *     the SAME window down again, one block per original block, in original
 *     position (its reorg contract (b) and (e)).
 *   - chunkedDeployDeferred: place unconfirmed pieces into a CHOSEN order that
 *     no client and no miner would produce, which is the case
 *     DEPLOY_DEFERRED_ASSEMBLY exists for.
 *
 * Nothing here knows about DEPLOY, chunks or the indexer: these are block
 * mechanics against a regtest node connector (test/src/BlockchainConnector.js).
 *
 ********************************************************************/

'use strict';

const { expect } = require('chai');

// Every non-coinbase transaction in [fromHeight, toHeight], grouped per block in
// the exact position it occupies, plus the same entries flat for accounting.
// Read this while the blocks are still CONNECTED: once a block is orphaned its
// transactions may be gone from the node entirely (Bitcoin Core resurrects only
// the first ten disconnected blocks' transactions), and raw hex that was never
// captured cannot be recovered.
async function snapshotWindow(node, fromHeight, toHeight) {
    const txs    = [];
    const blocks = [];
    for (let h = fromHeight; h <= toHeight; h++) {
        const block   = await node.getBlock(await node.getBlockHash(h), 1);
        const inBlock = [];
        for (let j = 1; j < block.tx.length; j++) { // j=0 is the coinbase (never re-injectable)
            const txid = block.tx[j];
            try {
                const entry = { txid, height: h, hex: await node.getTransactionHex(txid) };
                inBlock.push(entry);
                txs.push(entry);
            } catch (e) {
                // No raw hex means this block cannot be reproduced, and an out-of-order
                // rebuild is exactly the failure mode these drills exist to rule out.
                throw new Error('cannot snapshot orphaned tx ' + txid + ' at height ' + h + ': ' + e.message);
            }
        }
        blocks.push({ height: h, txs: inBlock });
    }
    return { txs, blocks };
}

// Lay a snapshotted window back down, one block per original block, each carrying
// exactly the transactions that block carried in the order it carried them.
//
// Ordering is the property under test in the drills that call this, so it is OWNED
// rather than assumed. Before placing the window this evicts any block on the new
// branch that has already swallowed part of it (invalidateblock returns those
// transactions to the mempool), then mines the window itself. Evict and place are
// not atomic against an outside miner on a shared venue, so the pair is retried and
// each attempt verifies every transaction landed in the block built for it.
//
// `depthLimit` is the caller's orphan-depth ceiling: past the utxo-tracker's
// spent-output recovery window a rollback halts the tracker fail-closed and wedges
// the venue for every other suite, so the guard fires BEFORE any invalidateblock.
async function replayWindowInOrder(node, opts) {
    const { payout, blocks, txs, depthLimit } = opts;
    const attempts = opts.attempts === undefined ? 4 : opts.attempts;
    const log      = opts.log || (() => {});

    let replayed = false, lastReplayError = null;

    for (let attempt = 1; attempt <= attempts && !replayed; attempt++) {
        // Evict, lowest first, until nothing of the window is confirmed. Bounded: each
        // pass strictly lowers the tip, and the depth guard keeps it inside the
        // utxo-tracker's recovery window.
        for (let pass = 0; pass < 10; pass++) {
            let lowest = null;
            for (const tx of txs) {
                const v = await node.getTransaction(tx.txid);
                if (!v || !v.blockhash || Number(v.confirmations || 0) < 1) continue;
                const h = Number((await node.getBlock(v.blockhash, 1)).height);
                if (lowest === null || h < lowest.height) lowest = { height: h, hash: v.blockhash };
            }
            if (!lowest) break;
            expect(await node.getBlockCount() - lowest.height + 1,
                'evicting the re-mined window stays inside ORPHAN_DEPTH_LIMIT').to.be.at.most(depthLimit);
            log('window partly re-mined at height ' + lowest.height +
                ' by something else on this venue; evicting it');
            await node.invalidateBlock(lowest.hash);
        }

        // Place the window.
        try {
            const built = [];
            for (const b of blocks) built.push(await node.generateBlock(payout, b.txs.map(t => t.hex)));

            const misplaced = [];
            for (let i = 0; i < blocks.length; i++) {
                const want = built[i] && built[i].hash;
                for (const tx of blocks[i].txs) {
                    const v = await node.getTransaction(tx.txid);
                    if (!v || v.blockhash !== want) misplaced.push(tx.txid.slice(0, 12));
                }
            }
            if (misplaced.length) throw new Error('replayed txs not in the blocks built for them: ' + misplaced.join(','));
            replayed = true;
        } catch (e) {
            lastReplayError = e;
            log('replay attempt ' + attempt + ' failed: ' + e.message);
        }
    }
    expect(replayed, 'orphaned window replayed in original order' +
        (lastReplayError ? ' (last error: ' + lastReplayError.message + ')' : '')).to.equal(true);
    return replayed;
}

// The unconfirmed transactions `txids` depend on, deepest first.
//
// A large action is encoded in two phases (P2SH/P2WSH): a funding transaction and
// the reveal that spends it, and the reveal is the one the decoder reads as the
// action. A block must list a parent before its child, so placing the reveals in a
// chosen order means placing every unconfirmed funding transaction ahead of them.
// Confirmed inputs are already below the block being built and are skipped.
async function unconfirmedAncestors(node, txids) {
    const mempool = new Set(await node.getRawMempool());
    const seen    = new Set(txids);
    const out     = [];

    async function walk(txid) {
        const tx = await node.getTransaction(txid);
        for (const vin of (tx && tx.vin) || []) {
            const parent = vin.txid;
            if (!parent || seen.has(parent) || !mempool.has(parent)) continue;
            seen.add(parent);
            await walk(parent);                 // a parent's own parents go first
            out.push(parent);
        }
    }
    for (const txid of txids) await walk(txid);
    return out;
}

// Mine ONE block carrying exactly `txids`, in exactly that order, whatever the
// mempool would have packed. Their unconfirmed ancestors are placed ahead of them
// (see unconfirmedAncestors); the order under test is the order of `txids`
// themselves, which is the order the decoder reads and therefore the order the
// indexer assigns action indexes in.
//
// Every named transaction is verified to have landed in the block built for it: on
// a shared venue another suite's quiesce hook can mine an unconfirmed window out
// from under a drill, and a silently reordered block is exactly the false green
// this placement exists to prevent.
async function placeBlockInOrder(node, payout, txids, opts = {}) {
    const log       = opts.log || (() => {});
    const ancestors = await unconfirmedAncestors(node, txids);
    const hexes     = [];
    for (const txid of ancestors.concat(txids)) hexes.push(await node.getTransactionHex(txid));

    const built = await node.generateBlock(payout, hexes);
    const wrong = [];
    for (const txid of txids) {
        const v = await node.getTransaction(txid);
        if (!v || v.blockhash !== built.hash) wrong.push(txid.slice(0, 12));
    }
    if (wrong.length)
        throw new Error('placed txs did not land in the block built for them (already mined elsewhere?): ' + wrong.join(','));

    log('placed ' + txids.length + ' action tx(s) + ' + ancestors.length +
        ' funding tx(s) in one block at height ' + (await node.getBlockCount()));
    return built.hash;
}

module.exports = {
    snapshotWindow,
    replayWindowInOrder,
    unconfirmedAncestors,
    placeBlockInOrder,
};
