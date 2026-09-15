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

const shared = require('./chunkedDeployReorgDrill.sdk.test/shared.test');
const suite = require('./chunkedDeployReorgDrill.sdk.test/suite_state.test');

const {
    expect, submit, mine, submitOpts, idxCount, idxQuery, readState, waitUntil,
    snapshotWindow, replayWindowInOrder, sleep, ORPHAN_DEPTH_LIMIT, GAS_LIMIT, START, PAD, RUN,
} = shared;

async function chunkDeploysLargeContract() {
        const state = suite.state;
        const { sdk, deployer, plan, codeHash, ownTxids } = state;
        const node = global.nodeConnector;
        // Hold the auto-miner and mine exactly one block per action, so the window this
        // drill will orphan is a handful of blocks - see reorg contract (a). Each action
        // is broadcast without waiting on the indexer, then mined, then waited for; the
        // next action's encoder call needs the previous change CONFIRMED (submit() defaults
        // to confirmed-only UTXOs), which that block provides.
        await suite.pauseMining();
        const preDeployTip = await node.getBlockCount();
        state.preDeployTip = preDeployTip;
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
        state.contractIndex = Number(asmRows[0].action_index);
        const contractIndex = state.contractIndex;

        // Constructor state proves the chunks reassembled byte-exactly in the first place.
        expect(await readState(sdk, contractIndex, 'padlen'), 'padlen matches the reassembled source').to.equal(String(PAD.length));
        expect(await readState(sdk, contractIndex, 'run'), 'constructor ran on the assembled contract').to.equal(RUN);
        expect(await readState(sdk, contractIndex, 'count'), 'constructor seeded count').to.equal(String(START));

        // Resolve the block carrying the FIRST chunk carrier (the one we orphan). All chunk
        // rows are indexed (the contract assembled from them), so MIN() is populated.
        // Scoped to blocks this run produced - see reorg contract (c).
        const rows = await idxQuery('SELECT MIN(block_index) AS n FROM deploy_chunks WHERE code_hash = ? AND block_index > ?',
            [codeHash, preDeployTip]);
        const firstChunkBlock = Number(rows[0].n);
        state.firstChunkBlock = firstChunkBlock;
        expect(firstChunkBlock, 'first chunk carrier block resolved').to.be.a('number').and.to.be.greaterThan(preDeployTip);

        // Sanity: chunks + contract + state are all present BEFORE the reorg.
        expect(await idxCount('SELECT COUNT(*) n FROM deploy_chunks WHERE code_hash = ?', [codeHash]),
            'all chunk carriers present pre-reorg').to.equal(plan.totalChunks);
        expect(await idxCount("SELECT COUNT(*) n FROM contracts WHERE code_hash = ? AND status_id = (SELECT id FROM index_statuses WHERE status='valid')", [codeHash]),
            'assembled contract present + valid pre-reorg').to.equal(1);
        console.log('    [chunk-reorg] contractIndex=' + contractIndex + ' firstChunkBlock=' + firstChunkBlock +
                    ' window=' + (await node.getBlockCount() - preDeployTip) + ' blocks');
}

describe('[sdk] chunked DEPLOY reorg drill (orphaned chunk -> assembled contract rolls back)', function () {
    this.timeout(0);
    before(async function () { await suite.setup.call(this); });
    // The drill holds auto-mining from leg 1 through the re-injection; never leave it held.
    after(async function () { await suite.resumeMining(); });
    it('chunk-deploys a large contract into a bounded block window (live + seeded state)', chunkDeploysLargeContract);
});

require('./chunkedDeployReorgDrill.sdk.test/01_orphan_and_replay.test');
require('./chunkedDeployReorgDrill.sdk.test/02_reassembled_contract.test');
