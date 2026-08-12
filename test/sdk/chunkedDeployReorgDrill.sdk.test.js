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
 * XChain Platform E2E - Chunked DEPLOY reorg drill
 *
 * Proves the chunked-DEPLOY reorg-safety property the handler relies on
 * (deploy.js): "assembly never consumes a chunk that does not precede it ->
 * any reorg dropping a chunk also drops the dependent DEPLOY, so rollback
 * needs no bespoke logic." A v2 assembling DEPLOY reads only VALID v4 chunk
 * carriers at a LOWER action_index, so the carriers are strictly below the
 * contract in block order. Orphaning the FIRST chunk's block therefore orphans
 * every chunk AND the dependent contract.
 *
 * The drill:
 *   1. Chunk-deploys a large contract (DEPLOY v4 carriers + assembling DEPLOY v2)
 *      inside a BOUNDED block window, so the contract is live with constructor state.
 *   2. Orphans the block carrying the FIRST chunk carrier by building an EMPTY
 *      competing chain (auto-mining held, generateBlock(addr, []) using the same
 *      mechanism as reorgBalances.test.js / xcallSourceReorgDrill), and asserts
 *      rollback.js cascaded the removal: NO deploy_chunks rows, NO contracts row,
 *      and NO contract_state for that code_hash survive on the orphan branch.
 *      Then, in the SAME test, REPLAYS the orphaned window onto the new branch
 *      block by block, each block carrying exactly the transactions it originally
 *      carried in the order it carried them (see the contract below).
 *   3. Asserts the contract reassembles DETERMINISTICALLY (same code_hash,
 *      byte-identical constructor state) and still runs - proving an
 *      order-preserving reorg cannot corrupt a chunk-assembled contract.
 *
 * REORG CONTRACT. Leg 3 used to hang for 240s with the contract never
 * reappearing. Four assumptions were wrong; all four are now enforced here:
 *
 *   a) DEPTH. A reorg is not free: the utxo-tracker aborts and HALTS (fail-closed)
 *      once a rollback passes its UNDO_BLOCKS=12 spent-output recovery window, and
 *      the decoder does the same at DISPENSER_EXPIRE_SAFE_DEPTH=126. A halted tracker
 *      wedges the whole venue until an operator resync, which is what "leg 3 never
 *      finishes" actually looked like. The drill therefore holds the auto-miner for
 *      the whole deploy and mines exactly one block per action, so the window it
 *      orphans is a handful of blocks, and it refuses to invalidate at all beyond
 *      ORPHAN_DEPTH_LIMIT.
 *   b) ORDER, NOT JUST PRESENCE. Getting the transactions back is necessary and not
 *      sufficient. A chunked deploy is order-dependent: the assembling DEPLOY v2 is
 *      evaluated at ITS position and needs every carrier already indexed, so carriers
 *      must precede it in (block, tx) order. Nothing in the mempool preserves that.
 *      The carriers and the assembler are funded from separate UTXOs of the deployer,
 *      not chained parent-to-child, so consensus imposes NO order between them; when
 *      the auto-miner drained the resurrected mempool it packed all three actions into
 *      one block by ancestor-feerate and put the ASSEMBLER FIRST. Measured on a BTC
 *      regtest venue: after the reorg the carriers re-indexed valid at
 *      action_index 450/451 (chunk 1 before chunk 0) with the assembler ahead of both
 *      at 449 - it assembled against zero carriers, went invalid, and is never retried,
 *      so the contract simply never came back and leg 3 burned its whole 240s. The node
 *      also gives back less than it took (Bitcoin Core only resurrects disconnected
 *      transactions for the first TEN blocks it disconnects - validation.cpp
 *      InvalidateBlock: `fAddToMempool = (++disconnected <= 10)`), so relying on the
 *      mempool is doubly wrong. The drill therefore snapshots the raw hex of every
 *      transaction it is about to orphan GROUPED BY BLOCK, in position, and replays the
 *      window with generateblock(payout, [rawhex...]) one block per original block.
 *      That takes raw hex and ignores the mempool, so it re-injects and orders in one
 *      step. What this proves is the real invariant: a reorg that preserves transaction
 *      order cannot change WHAT gets built, only WHERE. Reordering is a different event
 *      (the assembler is then legitimately invalid and the deployer must re-send it),
 *      and asserting determinism across it would be asserting something untrue.
 *   c) IDENTITY. The source carries a per-run marker, so the code_hash - and therefore
 *      the deploy_chunks group this drill resolves - belongs to THIS run. The source
 *      was previously fixed, so on any stack that had run the drill before,
 *      MIN(block_index) resolved to a chunk row from an EARLIER run and the drill
 *      invalidated thousands of blocks deep, tripping (a) and (b) every time.
 *   d) NO TEST BOUNDARY BETWEEN THE REORG AND THE REPLAY. This is what actually
 *      broke the drill, and it is a harness fact, not a node fact: initialCheck's root
 *      afterEach quiesces the stack via utxoTrackerConnector.quiesce(), which mines a
 *      block through the regtest miner whenever mempool_size > 0 (an explicit
 *      generate_blocks, so pauseMining does NOT hold it). Every reorg leaves the
 *      disconnected transactions sitting in the mempool, so the hook fired between the
 *      old leg 2 and leg 3 and mined the entire orphaned window into ONE block in
 *      mempool order - which is how the assembler ended up ahead of its carriers per
 *      (b). Measured on the BTC regtest venue: leg 2 ended with mempool=6 and the miner
 *      at 4372 blocks, leg 3 opened with mempool=0, an 8-tx tip block, and the miner at
 *      4373, still flagged paused. The reorg and the replay therefore live in ONE `it`,
 *      and that test hands back a mempool with nothing of this drill's in it.
 *   e) SHARED VENUE. Closing (d) is not enough on a stack another suite may be using:
 *      that suite's own quiesce hook drains OUR resurrected window just as happily
 *      (observed mid-run: a second harness started, and the window got mined while this
 *      drill sat in its rollback wait). So the replay does not assume the window is
 *      still unconfirmed - it EVICTS any block that has already swallowed part of it
 *      (invalidateblock, which puts those txs back in the mempool) and then places the
 *      window itself, retrying, and verifying each tx landed in the block the drill
 *      built for it. Evicting is safe here and only here: these blocks sit above the
 *      fork this drill already created, well inside the depth budget in (a).
 *
 * There is deliberately no pre-reorg EXECUTE: it would cost blocks against (a), and
 * its wire params name the contract's PRE-reorg action_index, which is a local MAX()+1
 * counter (db.js createActionIndex) that a reorg may renumber. Leg 3 proves the
 * reassembled contract still runs with a FRESH EXECUTE against the new index instead.
 *
 * VENUE: BTC (or LTC) regtest stack stood up by initialCheck. Uses the same
 * stack globals as xcallSourceReorgDrill (nodeConnector / regtestMinerConnector /
 * indexerDatabase). DOGE regtest is skipped (fast-chain mining model). Needs
 * Node 22 (real isolated-vm via the indexer DB layer).
 *
 * Run (host with regtest stack + Node 22):
 *     COIN=bitcoin NETWORK=regtest npm run test:sdk:chunked-reorg
 *
 ********************************************************************/

'use strict';

const { expect } = require('chai');
const cryptoHelper = require('../cryptoHelper');
const { makeSdk, submit, fundedGasAddress, mine, submitOpts, uniqueTick } = require('./sdkHelper');
const { chunkHelper } = require('xchain-sdk');

// A contract too large for a single DEPLOY: a ~7 KB string literal pads the source
// past the base64 single-action budget, forcing >=2 chunks. The string survives (it is
// code, not a comment); `padlen` proves byte-exact reassembly and `increment` proves
// the assembled contract runs. RUN makes the source (and so the code_hash) unique per
// run - see reorg contract (c). No xchain.* calls in module scope so readManifest is
// clean and the constructor initializes state.
const PAD = 'x'.repeat(7000);
const RUN = uniqueTick('CR');
const SRC = [
    'var PAD = "' + PAD + '";',
    'var RUN = "' + RUN + '";',
    'module.exports = {',
    '  initialize: function (xchain) {',
    '    var start = xchain.getInputParam(0);',
    '    xchain.state.set("count", String(parseInt(start) || 0));',
    '    xchain.state.set("padlen", String(PAD.length));',
    '    xchain.state.set("run", RUN);',
    '  },',
    '  increment: function() {',
    '    xchain.state.set("count", String(parseInt(xchain.state.get("count")) + 1));',
    '  }',
    '};'
].join('\n');

const GAS_LIMIT = 400000;
const START     = 5;

// Hard ceiling on how deep this drill may orphan - see reorg contract (a). The
// utxo-tracker's UNDO_BLOCKS recovery window is 12 blocks and it halts fail-closed
// past it (the decoder's own ceiling is 126), so exceeding this does not just fail the
// drill, it wedges the venue for every other suite. The bounded deploy below normally
// spends 3-5 blocks; the guard fires before any invalidateblock, so a venue too busy
// for the drill fails it cleanly instead of taking the stack down.
const ORPHAN_DEPTH_LIMIT = 12;

function haveConnectors() {
    return global.nodeConnector && global.regtestMinerConnector && global.indexerDatabase;
}

// Indexer DB reads against the primary stack's global pool (initialCheck), exactly
// like xcallSourceReorgDrill's btcIdx helper.
async function idxQuery(sql, params) {
    const conn = await global.indexerDatabase.getConnection();
    try { return await conn.query(sql, params); } finally { await conn.release(); }
}
async function idxCount(sql, params) { return Number((await idxQuery(sql, params))[0].n); }

async function readState(sdk, contractIndex, key) {
    const state = await sdk.getContractState(contractIndex, key);
    const rows = (state && state.data) || [];
    const row = rows.find(r => r.state_key === key);
    return row ? JSON.parse(row.state_value) : undefined;
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Poll until `fn()` is truthy. Nudges a block every 15s: with the auto-miner held, a
// tx that missed its block would otherwise never confirm. Throws (rather than
// returning false) so the caller's failure names the step, not a later assertion.
async function waitUntil(fn, what, timeoutMs = 120000) {
    const deadline = Date.now() + timeoutMs;
    let polls = 0;
    while (Date.now() < deadline) {
        const got = await fn();
        if (got) return got;
        if (++polls % 15 === 0) await mine(1);
        await sleep(1000);
    }
    throw new Error('timed out after ' + (timeoutMs / 1000) + 's waiting for ' + what);
}

describe('[sdk] chunked DEPLOY reorg drill (orphaned chunk -> assembled contract rolls back)', function () {
    this.timeout(0);

    let sdk, deployer, plan, contractIndex, codeHash, firstChunkBlock, preDeployTip, payout;
    // Raw hex of every tx this drill is about to orphan: flat (for accounting) and grouped
    // per original block in original position (for the ordered replay that closes leg 2),
    // plus the subset the drill itself broadcast (which MUST come back).
    let orphanedTxs      = [];
    let orphanedBlocks   = [];
    let ownTxids         = new Set();
    let ownOrphanedTxids = [];
    let miningPaused     = false;

    async function pauseMining() {
        await global.regtestMinerConnector.pauseMining();
        miningPaused = true;
    }
    async function resumeMining() {
        if (!miningPaused) return;
        miningPaused = false;
        try { await global.regtestMinerConnector.resumeMining(); } catch (e) { /* best effort */ }
    }

    before(async function () {
        if (!haveConnectors()) this.skip();
        // Reorg via an empty competing chain is a BTC/LTC mechanism; DOGE regtest uses a
        // different (fast-chain) mining model. Skip it, as reorgBalances.test.js does.
        if (global.COIN_CODE === 'DOGE') this.skip();
        sdk = makeSdk();
        // Funded + gas-minted with the auto-miner still running: only the DEPLOY window
        // below has to be block-budgeted.
        deployer = await fundedGasAddress(sdk, 1);

        plan = chunkHelper.planDeploy(SRC, { gasLimit: GAS_LIMIT, constructorParams: [String(START)] });
        expect(plan.single, 'source must NOT fit a single DEPLOY (else not testing chunking)').to.equal(false);
        expect(plan.totalChunks, 'expected >=2 chunks').to.be.greaterThan(1);
        codeHash = plan.codeHash;
        console.log('    [chunk-reorg] deployer=' + deployer.address +
                    ' source=' + Buffer.byteLength(SRC, 'utf8') + ' B -> ' + plan.totalChunks +
                    ' chunks, hash=' + codeHash.slice(0, 12) + ' run=' + RUN);
    });

    // The drill holds auto-mining from leg 1 through the re-injection; never leave it held.
    after(async function () { await resumeMining(); });

    it('chunk-deploys a large contract into a bounded block window (live + seeded state)', async function () {
        const node = global.nodeConnector;

        // Hold the auto-miner and mine exactly one block per action, so the window this
        // drill will orphan is a handful of blocks - see reorg contract (a). Each action
        // is broadcast without waiting on the indexer, then mined, then waited for; the
        // next action's encoder call needs the previous change CONFIRMED (submit() defaults
        // to confirmed-only UTXOs), which that block provides.
        await pauseMining();
        preDeployTip = await node.getBlockCount();

        for (let i = 0; i < plan.parts.length; i++) {
            const res = await submit(sdk,
                { action: 'DEPLOY', params: { version: '4', codeHash, chunkIndex: i, totalChunks: plan.totalChunks, codePart: plan.parts[i] } },
                { pubkey: deployer.address, change: deployer.address },
                submitOpts({ wif: deployer.wif, waitForIndexer: false }));
            ownTxids.add(res.txid);
            await mine(1);
            await waitUntil(async () =>
                (await idxCount("SELECT COUNT(*) n FROM deploy_chunks dc INNER JOIN index_statuses s ON s.id=dc.status_id WHERE dc.code_hash = ? AND s.status='valid'", [codeHash])) === i + 1,
                'DEPLOY v4 carrier ' + i + ' to index valid');
        }

        const asm = await submit(sdk,
            { action: 'DEPLOY', params: { version: '2', codeHash, gasLimit: GAS_LIMIT, constructorParams: [String(START)] } },
            { pubkey: deployer.address, change: deployer.address },
            submitOpts({ wif: deployer.wif, waitForIndexer: false }));
        ownTxids.add(asm.txid);
        await mine(1);
        const asmRows = await waitUntil(async () => {
            const rows = await idxQuery(
                "SELECT action_index FROM contracts WHERE code_hash = ? AND status_id = (SELECT id FROM index_statuses WHERE status='valid') LIMIT 1",
                [codeHash]);
            return rows.length ? rows : null;
        }, 'the assembling DEPLOY v2 to index valid');
        contractIndex = Number(asmRows[0].action_index);

        // Constructor state proves the chunks reassembled byte-exactly in the first place.
        expect(await readState(sdk, contractIndex, 'padlen'), 'padlen matches the reassembled source').to.equal(String(PAD.length));
        expect(await readState(sdk, contractIndex, 'run'), 'constructor ran on the assembled contract').to.equal(RUN);
        expect(await readState(sdk, contractIndex, 'count'), 'constructor seeded count').to.equal(String(START));

        // Resolve the block carrying the FIRST chunk carrier (the one we orphan). All chunk
        // rows are indexed by now (the contract assembled from them), so MIN() is populated.
        // Scoped to blocks this run produced - see reorg contract (c).
        const rows = await idxQuery('SELECT MIN(block_index) AS n FROM deploy_chunks WHERE code_hash = ? AND block_index > ?',
            [codeHash, preDeployTip]);
        firstChunkBlock = Number(rows[0].n);
        expect(firstChunkBlock, 'first chunk carrier block resolved').to.be.a('number').and.to.be.greaterThan(preDeployTip);

        // Sanity: chunks + contract + state are all present BEFORE the reorg.
        expect(await idxCount('SELECT COUNT(*) n FROM deploy_chunks WHERE code_hash = ?', [codeHash]),
            'all chunk carriers present pre-reorg').to.equal(plan.totalChunks);
        expect(await idxCount("SELECT COUNT(*) n FROM contracts WHERE code_hash = ? AND status_id = (SELECT id FROM index_statuses WHERE status='valid')", [codeHash]),
            'assembled contract present + valid pre-reorg').to.equal(1);
        console.log('    [chunk-reorg] contractIndex=' + contractIndex + ' firstChunkBlock=' + firstChunkBlock +
                    ' window=' + (await node.getBlockCount() - preDeployTip) + ' blocks');
    });

    it('orphaning the first chunk block rolls back the chunks AND the dependent contract, then replays the window IN ORDER', async function () {
        const node = global.nodeConnector;

        // Auto-mining is still held from leg 1, so the orphaned txs are not re-mined yet.
        // Build an EMPTY competing chain longer than the original tip (generateBlock(addr, [])).
        const tipBefore = await node.getBlockCount();
        const depth     = tipBefore - firstChunkBlock + 1;
        expect(depth, 'orphan depth (blocks to invalidate) - past ORPHAN_DEPTH_LIMIT the ' +
            'utxo-tracker halts fail-closed and the venue needs an operator resync').to.be.at.most(ORPHAN_DEPTH_LIMIT);

        // Snapshot every transaction about to be orphaned, PER BLOCK and in the exact
        // position it occupies, so leg 3 can lay the same window down again - see reorg
        // contract (b). Read while the blocks are still connected.
        orphanedTxs    = [];
        orphanedBlocks = [];
        for (let h = firstChunkBlock; h <= tipBefore; h++) {
            const block = await node.getBlock(await node.getBlockHash(h), 1);
            const txs   = [];
            for (let j = 1; j < block.tx.length; j++) { // j=0 is the coinbase (never re-injectable)
                const txid = block.tx[j];
                try {
                    const entry = { txid, height: h, hex: await node.getTransactionHex(txid) };
                    txs.push(entry);
                    orphanedTxs.push(entry);
                } catch (e) {
                    // No raw hex means this block cannot be reproduced, and an out-of-order
                    // rebuild is exactly the failure mode this drill exists to rule out.
                    throw new Error('cannot snapshot orphaned tx ' + txid + ' at height ' + h + ': ' + e.message);
                }
            }
            orphanedBlocks.push({ height: h, txs });
        }
        // A two-phase (P2SH/P2WSH) action's funding tx can land in an earlier block than its
        // reveal, in which case it is below the fork and survives; only what is actually
        // orphaned has to come back. Every carrier and the assembler contribute their reveal.
        ownOrphanedTxids = orphanedTxs.filter(t => ownTxids.has(t.txid)).map(t => t.txid);
        console.log('    [chunk-reorg] orphaning ' + depth + ' blocks / ' + orphanedTxs.length +
                    ' txs (' + ownOrphanedTxids.length + ' this drill\'s) from ' + firstChunkBlock);
        expect(ownOrphanedTxids.length, 'carrier + assembling DEPLOY txs snapshotted for re-injection')
            .to.equal(ownTxids.size);

        const chunkHash = await node.getBlockHash(firstChunkBlock);
        payout = (await cryptoHelper.getNewAddress('chunk-reorg-miner', COIN, NETWORK, null, 'legacy', 0)).address;

        await node.invalidateBlock(chunkHash);
        expect(await node.getBlockCount(), 'node rolled back below the first chunk block').to.equal(firstChunkBlock - 1);

        const need = tipBefore - (firstChunkBlock - 1) + 2;
        for (let i = 0; i < need; i++) await node.generateBlock(payout, []);
        expect(await node.getBlockCount(), 'competing chain overtakes the original tip').to.be.greaterThan(tipBefore);
        expect(await node.getBlockHash(firstChunkBlock), 'the chain actually reorged').to.not.equal(chunkHash);
        console.log('    [chunk-reorg] reorged onto an empty branch; waiting for decoder -> indexer rollback');

        // Wait for node -> decoder -> indexer rollback.js to delete block_index >= firstChunkBlock
        // across deploy_chunks / contracts / contract_state. Mining stays held: the competing
        // chain is already built, and the indexer only has to follow the node.
        const deadline = Date.now() + 180000;
        let chunks = -1, contracts = -1, state = -1;
        while (Date.now() < deadline) {
            await sleep(3000);
            chunks    = await idxCount('SELECT COUNT(*) n FROM deploy_chunks WHERE code_hash = ?', [codeHash]);
            contracts = await idxCount('SELECT COUNT(*) n FROM contracts WHERE code_hash = ?', [codeHash]);
            state     = await idxCount('SELECT COUNT(*) n FROM contract_state WHERE contract_index = ?', [contractIndex]);
            if (chunks === 0 && contracts === 0 && state === 0) break;
        }
        expect(chunks, 'all chunk carriers removed by rollback').to.equal(0);
        expect(contracts, 'the dependent assembled contract removed by rollback').to.equal(0);
        expect(state, 'the contract state removed by rollback').to.equal(0);
        console.log('    [chunk-reorg] rollback clean: chunks, contract, and state all gone on the orphan branch');

        // --- replay, in the SAME test: no `it` boundary may fall here (contract (d)) ---

        // Ordering is the property under test, so the drill OWNS it rather than assuming
        // it - see contract (b) and (e). Before placing the window it evicts any block on
        // the new branch that has already swallowed part of it (that returns those txs to
        // the mempool), then mines the window itself, one block per original block, each
        // carrying EXACTLY the transactions that block carried in the order it carried
        // them. generateblock takes raw hex, so this neither needs nor trusts the mempool:
        // it re-injects and orders in one step, and a tx the node never resurrected is
        // placed just the same. Evict and place are not atomic against an outside miner,
        // so the pair is retried; each attempt verifies every tx landed in the block the
        // drill built for it.
        const REPLAY_ATTEMPTS = 4;
        let replayed = false, lastReplayError = null;

        for (let attempt = 1; attempt <= REPLAY_ATTEMPTS && !replayed; attempt++) {
            // Evict, lowest first, until nothing of the window is confirmed. Bounded: each
            // pass strictly lowers the tip, and the depth guard keeps it inside the
            // utxo-tracker's recovery window (contract (a)).
            for (let pass = 0; pass < 10; pass++) {
                let lowest = null;
                for (const tx of orphanedTxs) {
                    const v = await node.getTransaction(tx.txid);
                    if (!v || !v.blockhash || Number(v.confirmations || 0) < 1) continue;
                    const h = Number((await node.getBlock(v.blockhash, 1)).height);
                    if (lowest === null || h < lowest.height) lowest = { height: h, hash: v.blockhash };
                }
                if (!lowest) break;
                expect(await node.getBlockCount() - lowest.height + 1,
                    'evicting the re-mined window stays inside ORPHAN_DEPTH_LIMIT').to.be.at.most(ORPHAN_DEPTH_LIMIT);
                console.log('    [chunk-reorg] window partly re-mined at height ' + lowest.height +
                            ' by something else on this venue; evicting it');
                await node.invalidateBlock(lowest.hash);
            }

            // Place the window.
            try {
                const built = [];
                for (const b of orphanedBlocks) built.push(await node.generateBlock(payout, b.txs.map(t => t.hex)));

                const misplaced = [];
                for (let i = 0; i < orphanedBlocks.length; i++) {
                    const want = built[i] && built[i].hash;
                    for (const tx of orphanedBlocks[i].txs) {
                        const v = await node.getTransaction(tx.txid);
                        if (!v || v.blockhash !== want) misplaced.push(tx.txid.slice(0, 12));
                    }
                }
                if (misplaced.length) throw new Error('replayed txs not in the blocks built for them: ' + misplaced.join(','));
                replayed = true;
            } catch (e) {
                lastReplayError = e;
                console.log('    [chunk-reorg] replay attempt ' + attempt + ' failed: ' + e.message);
            }
        }
        expect(replayed, 'orphaned window replayed in original order' +
            (lastReplayError ? ' (last error: ' + lastReplayError.message + ')' : '')).to.equal(true);
        console.log('    [chunk-reorg] replayed ' + orphanedBlocks.length + ' block(s) / ' +
                    orphanedTxs.length + ' txs in original order; tip=' + (await node.getBlockCount()));

        // The window is back on-chain and the mempool holds nothing of ours, so the
        // inter-test quiesce hook has nothing of this drill's left to shuffle.
        await resumeMining();
    });

    it('the replayed window reassembles the contract DETERMINISTICALLY (same hash + state)', async function () {
        // The window is already on-chain (replayed at the end of the previous leg); all that
        // is left is to let the decoder -> indexer follow it and rebuild what the reorg removed.
        const deadline = Date.now() + 240000;
        let row = null;
        while (Date.now() < deadline) {
            await mine(1);
            await sleep(2000);
            const rows = await idxQuery(
                "SELECT action_index FROM contracts WHERE code_hash = ? AND status_id = (SELECT id FROM index_statuses WHERE status='valid') LIMIT 1",
                [codeHash]);
            if (rows.length) { row = rows[0]; break; }
        }
        expect(row, 'contract reassembled on the new branch').to.not.equal(null);

        // The re-mined contract may carry a different action_index (that is a local MAX()+1
        // counter) but the SAME code_hash - deterministic reassembly - and byte-identical
        // constructor state.
        const newIndex = Number(row.action_index);
        expect(await idxCount('SELECT COUNT(*) n FROM deploy_chunks WHERE code_hash = ?', [codeHash]),
            'all chunk carriers re-indexed on the new branch').to.equal(plan.totalChunks);
        expect(await readState(sdk, newIndex, 'padlen'), 'reassembled source byte-exact after the reorg').to.equal(String(PAD.length));
        expect(await readState(sdk, newIndex, 'run'), 'the reassembled contract is the same source').to.equal(RUN);
        expect(await readState(sdk, newIndex, 'count'), 'constructor replayed deterministically').to.equal(String(START));

        // ... and the reassembled contract is LIVE, not just present.
        const exec = await submit(sdk,
            { action: 'EXECUTE', params: { contractActionIndex: newIndex, method: 'increment', params: [] } },
            { pubkey: deployer.address, change: deployer.address },
            submitOpts({ wif: deployer.wif }));
        expect(exec.indexed.status, 'fresh EXECUTE on the reassembled contract indexed').to.equal('valid');
        await mine(1);
        await waitUntil(async () => (await readState(sdk, newIndex, 'count')) === String(START + 1),
            'the reassembled contract to execute increment');

        console.log('    [chunk-reorg] reassembled deterministically: newIndex=' + newIndex +
                    ' hash=' + codeHash.slice(0, 12) + ' (reorg safe)');
    });
});
