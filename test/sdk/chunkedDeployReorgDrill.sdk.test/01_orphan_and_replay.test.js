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
 ********************************************************************/

'use strict';

const shared = require('./shared.test');
const suite = require('./suite_state.test');

const {
    expect, submit, mine, submitOpts, idxCount, idxQuery, readState, waitUntil,
    snapshotWindow, replayWindowInOrder, sleep, ORPHAN_DEPTH_LIMIT, GAS_LIMIT, START, PAD, RUN,
} = shared;

async function orphanWindow() {
        const state = suite.state;
        const { firstChunkBlock, ownTxids } = state;
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
        const snapshot = await snapshotWindow(node, firstChunkBlock, tipBefore);
        const orphanedTxs = snapshot.txs;
        const orphanedBlocks = snapshot.blocks;
        state.orphanedTxs = orphanedTxs;
        state.orphanedBlocks = orphanedBlocks;
        // A two-phase (P2SH/P2WSH) action's funding tx can land in an earlier block than its
        // reveal, in which case it is below the fork and survives; only what is actually
        // orphaned has to come back. Every carrier and the assembler contribute their reveal.
        const ownOrphanedTxids = orphanedTxs.filter(t => ownTxids.has(t.txid)).map(t => t.txid);
        state.ownOrphanedTxids = ownOrphanedTxids;
        console.log('    [chunk-reorg] orphaning ' + depth + ' blocks / ' + orphanedTxs.length +
                    ' txs (' + ownOrphanedTxids.length + ' this drill\'s) from ' + firstChunkBlock);
        expect(ownOrphanedTxids.length, 'carrier + assembling DEPLOY txs snapshotted for re-injection')
            .to.equal(ownTxids.size);

        const chunkHash = await node.getBlockHash(firstChunkBlock);
        const payout = await suite.payout();

        await node.invalidateBlock(chunkHash);
        expect(await node.getBlockCount(), 'node rolled back below the first chunk block').to.equal(firstChunkBlock - 1);

        const need = tipBefore - (firstChunkBlock - 1) + 2;
        for (let i = 0; i < need; i++) await node.generateBlock(payout, []);
        expect(await node.getBlockCount(), 'competing chain overtakes the original tip').to.be.greaterThan(tipBefore);
        expect(await node.getBlockHash(firstChunkBlock), 'the chain actually reorged').to.not.equal(chunkHash);
        console.log('    [chunk-reorg] reorged onto an empty branch; waiting for decoder -> indexer rollback');
        return { node, payout };
}

async function awaitRollback() {
        const { codeHash, contractIndex } = suite.state;
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
}

async function replayWindow(node, payout) {
        const { orphanedBlocks, orphanedTxs } = suite.state;
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
        await replayWindowInOrder(node, {
            payout,
            blocks:     orphanedBlocks,
            txs:        orphanedTxs,
            depthLimit: ORPHAN_DEPTH_LIMIT,
            attempts:   4,
            log:        (msg) => console.log('    [chunk-reorg] ' + msg),
        });
        console.log('    [chunk-reorg] replayed ' + orphanedBlocks.length + ' block(s) / ' +
                    orphanedTxs.length + ' txs in original order; tip=' + (await node.getBlockCount()));

        // The window is back on-chain and the mempool holds nothing of ours, so the
        // inter-test quiesce hook has nothing of this drill's left to shuffle.
        await suite.resumeMining();
}

async function orphanAndReplay() {
    const { node, payout } = await orphanWindow();
    await awaitRollback();
    await replayWindow(node, payout);
}

describe('[sdk] chunked DEPLOY reorg drill (orphaned chunk -> assembled contract rolls back)', function () {
    this.timeout(0);
    before(async function () {
        await suite.setup.call(this);
        await suite.pauseMining();
    });
    after(async function () { await suite.resumeMining(); });
    it('orphaning the first chunk block rolls back the chunks AND the dependent contract, then replays the window IN ORDER', orphanAndReplay);
});
