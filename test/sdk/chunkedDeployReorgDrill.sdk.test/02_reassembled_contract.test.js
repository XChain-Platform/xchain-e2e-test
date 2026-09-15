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

async function assertsReassembledContract() {
        const { codeHash, plan, sdk, deployer } = suite.state;
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
}

describe('[sdk] chunked DEPLOY reorg drill (orphaned chunk -> assembled contract rolls back)', function () {
    this.timeout(0);
    before(async function () { await suite.setup.call(this); });
    after(async function () { await suite.resumeMining(); });
    it('the replayed window reassembles the contract DETERMINISTICALLY (same hash + state)', assertsReassembledContract);
});
