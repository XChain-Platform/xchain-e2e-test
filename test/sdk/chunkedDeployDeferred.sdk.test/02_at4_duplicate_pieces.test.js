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

async function landDuplicateAssemblers() {
        const { sdk, payout } = suite.state;
        const node = global.nodeConnector;
        const run  = uniqueTick('CD4');
        const plan = chunkHelper.planDeploy(sourceFor(run, PAD_2CHUNK), { gasLimit: GAS_LIMIT, constructorParams: [String(START)] });
        expect(plan.totalChunks, 'AT4 needs 2 chunks').to.equal(2);

        const deployer = await fundIndependentInputs(sdk, 6);
        const srcId    = await addressId(deployer.address);
        const inputs   = await pickInputs(sdk, deployer.address, 6);
        const log = (m) => console.log('    [deferred] AT4 ' + m);

        // (i) two assemblers for the same group, one block, nothing else landed yet.
        const asm1Tx = await broadcastPiece(sdk, deployer, assemblerAction(plan), inputs[0]);
        const asm2Tx = await broadcastPiece(sdk, deployer, assemblerAction(plan), inputs[1]);
        await assertIndependentPieces(node, [asm1Tx, asm2Tx]);
        await placeBlockInOrder(node, payout, [asm1Tx, asm2Tx], { log });

        const A1 = await waitFor(async () => actionIndexOfTx(asm1Tx), 'the first assembler to index');
        const A2 = await waitFor(async () => actionIndexOfTx(asm2Tx), 'the second assembler to index');
        // The pending row is a group member (declared hash); the rejected one is
        // read by its own index, see contractRowAt. Group counts below exclude it.
        await waitFor(async () => (await contractRows(srcId, plan.codeHash)).length === 1, 'the pending assembler row to index');
        const rejected = await waitFor(async () => contractRowAt(A2), 'the rejected assembler row to index');
        let contracts = await contractRows(srcId, plan.codeHash);
        expect(contracts.find(r => r.action_index === A1).status, 'the first assembler lands pending').to.equal(PENDING_STATUS);
        expect(rejected.status, 'a second assembler while one is pending is rejected').to.equal(DUPLICATE_STATUS);
        expect(rejected.code_hash, 'a rejected assembler stores the empty-code hash like every invalid assembler')
            .to.not.equal(plan.codeHash);
        return { sdk, payout, node, plan, srcId, inputs, log, A1, A2, contracts };
}

async function completeAndRedeploy(ctx) {
        const { sdk, payout, node, plan, srcId, inputs, log, A1 } = ctx;
        let { contracts } = ctx;
        // (ii) the carriers complete the group; only the FIRST assembler is consumed.
        const c1Tx = await broadcastPiece(sdk, deployer, carrierAction(plan, 1), inputs[2]);
        const c0Tx = await broadcastPiece(sdk, deployer, carrierAction(plan, 0), inputs[3]);
        await assertIndependentPieces(node, [c1Tx, c0Tx]);
        await placeBlockInOrder(node, payout, [c1Tx, c0Tx], { log });

        const C = await waitFor(async () => actionIndexOfTx(c0Tx), 'the completing carrier to index');
        await waitFor(async () => (await contractRows(srcId, plan.codeHash)).length === 2, 'the deployed contract row');
        const firstExec = await executionRow(C);
        expect(firstExec.assembler_action_index, 'the FIRST assembler is the one consumed').to.equal(A1);
        expect((await contractRows(srcId, plan.codeHash)).find(r => r.action_index === C).status,
            'the group deployed at the completing carrier').to.equal('valid');

        // (iii) an assembler AFTER completion finds the group complete from lower
        // carriers and deploys a SECOND contract at its own index, consuming nothing.
        const asm3Tx = await broadcastPiece(sdk, deployer, assemblerAction(plan), inputs[4]);
        await placeBlockInOrder(node, payout, [asm3Tx], { log });
        const A3 = await waitFor(async () => actionIndexOfTx(asm3Tx), 'the post-completion assembler to index');
        await waitFor(async () => (await contractRows(srcId, plan.codeHash)).length === 3, 'the second contract row');
        contracts = await contractRows(srcId, plan.codeHash);
        expect(contracts.find(r => r.action_index === A3).status,
            'an assembler over a complete group deploys immediately').to.equal('valid');
        const secondExec = await executionRow(A3);
        expect(secondExec.contract_index, 'the second contract sits at the assembler\'s own index').to.equal(A3);
        expect(secondExec.assembler_action_index,
            'a self-completed deploy consumed no separate assembler').to.equal(null);
        return { C, A3, contracts };
}

async function landDuplicateCarrier(ctx) {
        const { sdk, payout, node, plan, srcId, inputs, log, A1, A2, C, A3, contracts } = ctx;
        // (iv) a duplicate carrier after completion is stored and deploys nothing.
        const contractsBefore = contracts.length;
        const dupTx = await broadcastPiece(sdk, deployer, carrierAction(plan, 0), inputs[5]);
        await placeBlockInOrder(node, payout, [dupTx], { log });
        const dupIndex = await waitFor(async () => actionIndexOfTx(dupTx), 'the duplicate carrier to index');
        const chunks = await waitFor(async () => {
            const rows = await chunkRows(srcId, plan.codeHash);
            return rows.length === 3 ? rows : null;
        }, 'the duplicate carrier row to be stored');
        expect(chunks.find(r => r.action_index === dupIndex).status,
            'a duplicate carrier is still stored valid').to.equal('valid');
        expect((await contractRows(srcId, plan.codeHash)).length,
            'a duplicate carrier deploys nothing').to.equal(contractsBefore);
        expect(await executionRow(dupIndex), 'a duplicate carrier writes no constructor row').to.equal(null);

        console.log('    [deferred] AT4 A1=' + A1 + ' (pending, consumed) A2=' + A2 + ' (duplicate) C=' + C +
                    ' A3=' + A3 + ' (second contract) dup=' + dupIndex);
}

async function at4DuplicatePieces() {
    const ctx = await landDuplicateAssemblers();
    Object.assign(ctx, await completeAndRedeploy(ctx));
    await landDuplicateCarrier(ctx);
}

describe('[sdk] chunked DEPLOY deferred assembly (a group deploys at its LAST piece, in any order)', function () {
    this.timeout(0);
    before(async function () { await suite.setup.call(this); });
    after(async function () { await suite.resumeMining(); });
    it('AT4 duplicates: a second pending assembler is rejected, a later assembler deploys again, a duplicate carrier deploys nothing', at4DuplicatePieces);
});
