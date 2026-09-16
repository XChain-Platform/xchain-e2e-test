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

const shared = require('./chunkedDeployDeferred.sdk.test/shared.test');
const suite = require('./chunkedDeployDeferred.sdk.test/suite_state.test');

const {
    expect, chunkHelper, sourceFor, fundIndependentInputs, addressId, pickInputs,
    broadcastPiece, assemblerAction, carrierAction, assertIndependentPieces,
    placeBlockInOrder, waitFor, chunkRows, actionIndexOfTx, contractRows,
    executionRow, stateRows, readState, actionDetail, expectDeployedContractIndex,
    contractRowAt, permissionCount, idxCount, snapshotWindow, replayWindowInOrder,
    uniqueTick, PAD_2CHUNK, PAD_3CHUNK, GAS_LIMIT, START, FEE_MODE_XCHAIN,
    PENDING_STATUS, DUPLICATE_STATUS, ORPHAN_DEPTH_LIMIT,
} = shared;

async function arrangeAt1() {
        const { sdk, payout, refPlan, refRun } = suite.state;
        const node = global.nodeConnector;
        const run  = refRun;                                   // the reference's source, so the state comparison is exact
        const src  = sourceFor(run, PAD_2CHUNK);
        const plan = chunkHelper.planDeploy(src, { gasLimit: GAS_LIMIT, constructorParams: [String(START)] });
        expect(plan.codeHash, 'AT1 deploys the same source as the reference').to.equal(refPlan.codeHash);

        const deployer = await fundIndependentInputs(sdk, 3);
        const srcId    = await addressId(deployer.address);
        const inputs   = await pickInputs(sdk, deployer.address, 3);

        // All three pieces on the wire before any of them is mined: this is the
        // parallel broadcast the rule exists to make safe.
        const asmTx = await broadcastPiece(sdk, deployer, assemblerAction(plan), inputs[0]);
        const c1Tx  = await broadcastPiece(sdk, deployer, carrierAction(plan, 1), inputs[1]);
        const c0Tx  = await broadcastPiece(sdk, deployer, carrierAction(plan, 0), inputs[2]);
        await assertIndependentPieces(node, [asmTx, c1Tx, c0Tx]);

        // The order no client and no miner would choose: the assembler first.
        await placeBlockInOrder(node, payout, [asmTx, c1Tx, c0Tx],
            { log: (m) => console.log('    [deferred] AT1 ' + m) });
        return { sdk, node, run, plan, srcId, asmTx, c1Tx, c0Tx };
}

async function assertAt1Assembly(ctx) {
        const { sdk, run, plan, srcId, asmTx, c1Tx, c0Tx } = ctx;
        const { refState, refGasUsed } = suite.state;
        const chunks = await waitFor(async () => {
            const rows = await chunkRows(srcId, plan.codeHash);
            return rows.length === 2 ? rows : null;
        }, 'both DEPLOY v4 carriers to index');
        expect(chunks.every(r => r.status === 'valid'), 'both carriers stored valid').to.equal(true);

        const A = await actionIndexOfTx(asmTx);
        const C = await actionIndexOfTx(c0Tx);
        const c1Index = await actionIndexOfTx(c1Tx);
        expect(A, 'the assembler indexed').to.not.equal(null);
        expect(A, 'the assembler really is FIRST in the block').to.be.lessThan(c1Index);
        expect(c1Index, 'chunk 0 really is LAST in the block').to.be.lessThan(C);
        expect(chunks.find(r => r.chunk_index === 0).action_index, 'C is the chunk-0 carrier').to.equal(C);

        const contracts = await waitFor(async () => {
            const rows = await contractRows(srcId, plan.codeHash);
            return rows.length === 2 ? rows : null;
        }, 'the pending assembler row and the deployed contract row');

        const pending  = contracts.find(r => r.action_index === A);
        const deployed = contracts.find(r => r.action_index === C);
        expect(pending,  'a contracts row at the assembler').to.not.equal(undefined);
        expect(deployed, 'a contracts row at the completing carrier').to.not.equal(undefined);
        expect(pending.status,  'the assembler landed pending, not invalid').to.equal(PENDING_STATUS);
        expect(deployed.status, 'the contract deployed at the completing carrier').to.equal('valid');

        // The constructor row sits at C and names the assembler it consumed.
        const exec = await executionRow(C);
        expect(exec, 'constructor execution row at C').to.not.equal(null);
        expect(exec.contract_index, 'the contract IS the completing action').to.equal(C);
        expect(exec.assembler_action_index, 'the constructor row names the assembler it consumed').to.equal(A);
        expect(exec.status, 'the deferred deploy is valid').to.equal('valid');

        // The assembler paid the BASE fee at its own landing and nothing more: its
        // row carries gas but strictly less than a complete deploy of the same
        // source, whose gas is base + constructor.
        const pendingExec = await executionRow(A);
        expect(pendingExec, 'the pending assembler has its own execution row').to.not.equal(null);
        expect(pendingExec.assembler_action_index, 'the assembler consumed nothing itself').to.equal(null);
        expect(pendingExec.fee_payment_mode, 'the assembler recorded the mode it paid in (XCHAIN on a gas chain)').to.equal(FEE_MODE_XCHAIN);
        expect(pendingExec.gas_used, 'the assembler was charged base gas at A').to.be.greaterThan(0);
        expect(pendingExec.gas_used, 'base gas only: strictly less than base + constructor').to.be.lessThan(refGasUsed);

        // Byte-for-byte the same state as the same source deployed in order.
        expect(await stateRows(C), 'deferred assembly produced identical constructor state').to.deep.equal(refState);
        expect(await readState(sdk, C, 'run'), 'the explorer resolves the contract at the CARRIER index').to.equal(run);
        return { A, C, c1Index, pendingExec };
}

async function assertAt1Explorer(ctx) {
        const { sdk, A, C, c1Index, pendingExec } = ctx;
        const { refGasUsed } = suite.state;
        // Explorer surfaces: a later milestone, asserted only where present. Where the
        // field IS present the whole explorer contract is asserted, not just the index: the
        // clients poll `assembly_status` to know when to stop, and a carrier page that
        // names the contract but carries none of its fields renders no deploy card.
        const asmDetail = await actionDetail(sdk, A);
        if (expectDeployedContractIndex(asmDetail, C, 'assembler page resolves deployed_contract_index = C'))
            expect(String(asmDetail.assembly_status),
                'the assembler page reports the group as assembled').to.equal('valid');
        const carrierDetail = await actionDetail(sdk, C);
        if (carrierDetail && Object.prototype.hasOwnProperty.call(carrierDetail, 'deployed_contract_index')) {
            expect(Number(carrierDetail.deployed_contract_index), 'the carrier page exposes its own contract').to.equal(C);
            expect(Number(carrierDetail.assembler_action_index),
                'the carrier deploy card names the assembler it completed').to.equal(A);
            expect(String(carrierDetail.contract_status),
                'the carrier deploy card carries the contract status').to.equal('valid');
        } else {
            console.log('    [deferred] AT1 carrier deploy-card assertion SKIPPED (explorer milestone not landed)');
        }

        console.log('    [deferred] AT1 A=' + A + ' chunk1=' + c1Index + ' C=' + C +
                    ' pending_gas=' + pendingExec.gas_used + ' (reference ' + refGasUsed + ')');
}

async function at1DeferredAssembly() {
    const ctx = await arrangeAt1();
    Object.assign(ctx, await assertAt1Assembly(ctx));
    await assertAt1Explorer(ctx);
}

describe('[sdk] chunked DEPLOY deferred assembly (a group deploys at its LAST piece, in any order)', function () {
    this.timeout(0);
    before(async function () { await suite.setup.call(this); });
    // Auto-mining is held for the whole suite; never leave it held.
    after(async function () { await suite.resumeMining(); });
    it('AT1 assembler, chunk 1, chunk 0 in ONE block in that order: the contract deploys at the chunk-0 carrier', at1DeferredAssembly);
});

require('./chunkedDeployDeferred.sdk.test/01_at2_reverse_block_order.test');
require('./chunkedDeployDeferred.sdk.test/02_at4_duplicate_pieces.test');
require('./chunkedDeployDeferred.sdk.test/03_at5_reordered_replay.test');
