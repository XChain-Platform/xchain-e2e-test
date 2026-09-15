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
 * XChain Platform E2E - chunked DEPLOY, order-independent assembly (AT1/AT2/AT4/AT5)
 *
 ********************************************************************/

'use strict';

const shared = require('./shared.test');
const suite = require('./suite_state.test');

const {
    expect, chunkHelper, sourceFor, fundIndependentInputs, addressId, pickInputs,
    broadcastPiece, assemblerAction, carrierAction, assertIndependentPieces,
    placeBlockInOrder, waitFor, chunkRows, actionIndexOfTx, contractRows,
    executionRow, stateRows, readState, actionDetail, expectDeployedContractIndex,
    contractRowAt, permissionCount, idxCount, snapshotWindow, replayWindowInOrder,
    uniqueTick, PAD_2CHUNK, PAD_3CHUNK, GAS_LIMIT, START, FEE_MODE_XCHAIN,
    PENDING_STATUS, DUPLICATE_STATUS, ORPHAN_DEPTH_LIMIT,
} = shared;

async function arrangeAt5() {
        const { sdk, payout } = suite.state;
        const node = global.nodeConnector;
        const run  = uniqueTick('CD5');
        const plan = chunkHelper.planDeploy(sourceFor(run, PAD_3CHUNK), { gasLimit: GAS_LIMIT, constructorParams: [String(START)] });
        expect(plan.totalChunks, 'AT5 needs 3 chunks').to.equal(3);

        const deployer = await fundIndependentInputs(sdk, 4);
        const srcId    = await addressId(deployer.address);
        const inputs   = await pickInputs(sdk, deployer.address, 4);
        const log = (m) => console.log('    [deferred] AT5 ' + m);

        const asmTx = await broadcastPiece(sdk, deployer, assemblerAction(plan), inputs[0]);
        const c2Tx  = await broadcastPiece(sdk, deployer, carrierAction(plan, 2), inputs[1]);
        const c1Tx  = await broadcastPiece(sdk, deployer, carrierAction(plan, 1), inputs[2]);
        const c0Tx  = await broadcastPiece(sdk, deployer, carrierAction(plan, 0), inputs[3]);
        await assertIndependentPieces(node, [asmTx, c2Tx, c1Tx, c0Tx]);

        // The assembler and one carrier land BELOW the block that will be orphaned,
        // so the rollback assertions can tell what must survive from what must go.
        await placeBlockInOrder(node, payout, [asmTx], { log });
        await placeBlockInOrder(node, payout, [c2Tx], { log });
        const completingBlock = await node.getBlockCount() + 1;
        await placeBlockInOrder(node, payout, [c1Tx, c0Tx], { log });

        const A = await waitFor(async () => actionIndexOfTx(asmTx), 'the assembler to index');
        const C = await waitFor(async () => actionIndexOfTx(c0Tx), 'the completing carrier to index');
        await waitFor(async () => (await contractRows(srcId, plan.codeHash)).length === 2, 'the deployed contract row');
        expect((await contractRows(srcId, plan.codeHash)).find(r => r.action_index === C).status,
            'the group deployed at the completing carrier').to.equal('valid');
        expect((await executionRow(C)).assembler_action_index, 'the constructor row names the assembler').to.equal(A);
        expect((await stateRows(C)).length, 'the constructor wrote state').to.be.greaterThan(0);
        const permsBefore = await permissionCount(C);
        return { sdk, payout, node, run, plan, srcId, log, c1Tx, c0Tx, completingBlock, A, C, permsBefore };
}

async function orphanAt5(ctx) {
        const { payout, node, plan, srcId, c1Tx, c0Tx, completingBlock, A, C, permsBefore } = ctx;
        // --- orphan the completing carrier's block, and replay it REORDERED, in ONE
        // `it`: a test boundary here hands the resurrected window to the quiesce hook.
        const tipBefore = await node.getBlockCount();
        const depth     = tipBefore - completingBlock + 1;
        expect(depth, 'orphan depth (blocks to invalidate) - past ORPHAN_DEPTH_LIMIT the ' +
            'utxo-tracker halts fail-closed and the venue needs an operator resync').to.be.at.most(ORPHAN_DEPTH_LIMIT);

        const snapshot = await snapshotWindow(node, completingBlock, tipBefore);
        const window   = snapshot.blocks[0];
        expect(window.txs.some(t => t.txid === c0Tx) && window.txs.some(t => t.txid === c1Tx),
            'both carriers of the completing block snapshotted for replay').to.equal(true);

        const orphanHash = await node.getBlockHash(completingBlock);
        await node.invalidateBlock(orphanHash);
        const need = tipBefore - (completingBlock - 1) + 2;
        for (let i = 0; i < need; i++) await node.generateBlock(payout, []);
        expect(await node.getBlockCount(), 'competing chain overtakes the original tip').to.be.greaterThan(tipBefore);
        expect(await node.getBlockHash(completingBlock), 'the chain actually reorged').to.not.equal(orphanHash);

        const rolledBack = await waitFor(async () => {
            const contracts = await contractRows(srcId, plan.codeHash);
            const chunks    = await chunkRows(srcId, plan.codeHash);
            const state     = await idxCount('SELECT COUNT(*) n FROM contract_state WHERE contract_index = ?', [C]);
            const done = contracts.length === 1 && chunks.length === 1 && state === 0 && (await executionRow(C)) === null;
            return done ? { contracts, chunks } : null;
        }, 'rollback to remove the contract, its execution row and its state', 180000);

        expect(rolledBack.contracts[0].action_index, 'the assembler\'s pending row survives the orphan').to.equal(A);
        expect(rolledBack.contracts[0].status, 'and keeps its pending status').to.equal(PENDING_STATUS);
        expect(rolledBack.chunks[0].chunk_index, 'the carrier below the fork survives').to.equal(2);
        expect(await permissionCount(C), 'the contract\'s permissions row is gone').to.equal(0);
        if (permsBefore === 0)
            console.log('    [deferred] AT5 the deployed contract declared no manifest; the permissions assertion is vacuous');
        expect(await executionRow(A), 'the assembler\'s own execution row survives').to.not.equal(null);
        return { snapshot, window };
}

async function replayAt5(ctx) {
        const { sdk, payout, node, run, plan, srcId, log, c1Tx, c0Tx, A, C, snapshot, window } = ctx;
        // Replay the SAME transactions in a DIFFERENT order: chunk 0 first, so the
        // the group is completed by chunk 1 and the contract must rebuild at ITS
        // index. Funding transactions (a two-phase piece's phase 1) keep their
        // relative order ahead of the reveals; only the two actions swap.
        const byTxid    = new Map(window.txs.map(t => [t.txid, t]));
        const actionSet = new Set([c0Tx, c1Tx]);
        const reordered = window.txs.filter(t => !actionSet.has(t.txid))
            .concat([byTxid.get(c0Tx), byTxid.get(c1Tx)]);
        await replayWindowInOrder(node, {
            payout,
            blocks:     [{ height: window.height, txs: reordered }],
            txs:        snapshot.txs,
            depthLimit: ORPHAN_DEPTH_LIMIT,
            attempts:   4,
            log,
        });

        const newC = await waitFor(async () => actionIndexOfTx(c1Tx), 'chunk 1 to re-index on the new branch');
        const newContracts = await waitFor(async () => {
            const rows = await contractRows(srcId, plan.codeHash);
            return rows.length === 2 ? rows : null;
        }, 'the contract to re-deploy on the replayed branch', 240000);

        const rebuilt = newContracts.find(r => r.action_index === newC);
        expect(rebuilt, 'the contract rebuilt at the NEW last piece (chunk 1)').to.not.equal(undefined);
        expect(rebuilt.status, 'and is valid').to.equal('valid');
        expect(rebuilt.code_hash, 'the same source rebuilt: same code_hash').to.equal(plan.codeHash);
        const newExec = await executionRow(newC);
        expect(newExec.contract_index, 'the contract is the new completing action').to.equal(newC);
        expect(newExec.assembler_action_index, 'the SAME surviving assembler was consumed').to.equal(A);
        expect(await readState(sdk, newC, 'run'), 'the reassembled source is this run\'s').to.equal(run);
        expect(await readState(sdk, newC, 'count'), 'the constructor replayed deterministically').to.equal(String(START));

        console.log('    [deferred] AT5 orphaned C=' + C + '; reordered replay re-deployed at ' + newC +
                    ' under the same assembler ' + A);

        // The window is back on chain and the mempool holds nothing of this drill's,
        // so the inter-test quiesce hook has nothing left to shuffle.
        await suite.resumeMining();
}

async function at5ReorderedReplay() {
    const ctx = await arrangeAt5();
    Object.assign(ctx, await orphanAt5(ctx));
    await replayAt5(ctx);
}

describe('[sdk] chunked DEPLOY deferred assembly (a group deploys at its LAST piece, in any order)', function () {
    this.timeout(0);
    before(async function () { await suite.setup.call(this); });
    after(async function () { await suite.resumeMining(); });
    it('AT5 orphaning the completing carrier rolls the contract back; replaying the window REORDERED re-deploys it at the new last piece', at5ReorderedReplay);
});
