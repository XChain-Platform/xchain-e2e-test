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

async function arrangeAt2() {
        const { sdk } = suite.state;
        const node = global.nodeConnector;
        const run  = uniqueTick('CD2');
        const plan = chunkHelper.planDeploy(sourceFor(run, PAD_3CHUNK), { gasLimit: GAS_LIMIT, constructorParams: [String(START)] });
        expect(plan.totalChunks, 'AT2 needs 3 chunks').to.equal(3);

        const deployer = await fundIndependentInputs(sdk, 4);
        const srcId    = await addressId(deployer.address);
        const inputs   = await pickInputs(sdk, deployer.address, 4);

        const asmTx = await broadcastPiece(sdk, deployer, assemblerAction(plan), inputs[0]);
        const c2Tx  = await broadcastPiece(sdk, deployer, carrierAction(plan, 2), inputs[1]);
        const c1Tx  = await broadcastPiece(sdk, deployer, carrierAction(plan, 1), inputs[2]);
        const c0Tx  = await broadcastPiece(sdk, deployer, carrierAction(plan, 0), inputs[3]);
        await assertIndependentPieces(node, [asmTx, c2Tx, c1Tx, c0Tx]);

        const log = (m) => console.log('    [deferred] AT2 ' + m);
        const noValidYet = async (where) => {
            const valid = (await contractRows(srcId, plan.codeHash)).filter(r => r.status === 'valid');
            expect(valid.length, 'no contract may exist ' + where).to.equal(0);
        };
        return { sdk, node, run, plan, srcId, asmTx, c2Tx, c1Tx, c0Tx, log, noValidYet };
}

async function assertAt2Order(ctx) {
        const { sdk, node, run, plan, srcId, asmTx, c2Tx, c1Tx, c0Tx, log, noValidYet } = ctx;
        const { payout } = suite.state;
        // Block 1: the LAST chunk, alone. A group missing every other position.
        await placeBlockInOrder(node, payout, [c2Tx], { log });
        await waitFor(async () => (await chunkRows(srcId, plan.codeHash)).length === 1, 'chunk 2 to index');
        await noValidYet('after the highest chunk alone');

        // Block 2: the assembler, in the middle, with two positions still missing.
        await placeBlockInOrder(node, payout, [asmTx], { log });
        const A = await waitFor(async () => actionIndexOfTx(asmTx), 'the assembler to index');
        await waitFor(async () => {
            const rows = await contractRows(srcId, plan.codeHash);
            return rows.length === 1 ? rows : null;
        }, 'the assembler to land pending');
        expect((await contractRows(srcId, plan.codeHash))[0].status,
            'an assembler with an incomplete group lands pending, not invalid').to.equal(PENDING_STATUS);
        await noValidYet('while the group is still missing chunks 0 and 1');

        // Block 3: chunk 1. Still one position short.
        await placeBlockInOrder(node, payout, [c1Tx], { log });
        await waitFor(async () => (await chunkRows(srcId, plan.codeHash)).length === 2, 'chunk 1 to index');
        await noValidYet('while the group is still missing chunk 0');

        // Block 4: chunk 0 completes the group and deploys it, here.
        await placeBlockInOrder(node, payout, [c0Tx], { log });
        const C = await waitFor(async () => actionIndexOfTx(c0Tx), 'chunk 0 to index');
        const contracts = await waitFor(async () => {
            const rows = await contractRows(srcId, plan.codeHash);
            return rows.length === 2 ? rows : null;
        }, 'the deployed contract row at the completing carrier');

        expect(contracts.find(r => r.action_index === A).status, 'the assembler keeps its pending status').to.equal(PENDING_STATUS);
        const deployed = contracts.find(r => r.action_index === C);
        expect(deployed, 'a contracts row at the last piece').to.not.equal(undefined);
        expect(deployed.status, 'the group deployed at the LAST piece').to.equal('valid');

        const exec = await executionRow(C);
        expect(exec.contract_index, 'the contract is the last piece').to.equal(C);
        expect(exec.assembler_action_index, 'the constructor row names the assembler two blocks back').to.equal(A);
        expect(await readState(sdk, C, 'run'), 'the reassembled source is this run\'s').to.equal(run);
        console.log('    [deferred] AT2 chunk2 < A=' + A + ' < chunk1 < C=' + C + ' across 4 blocks in reverse');
}

async function at2ReverseBlockOrder() {
    await assertAt2Order(await arrangeAt2());
}

describe('[sdk] chunked DEPLOY deferred assembly (a group deploys at its LAST piece, in any order)', function () {
    this.timeout(0);
    before(async function () { await suite.setup.call(this); });
    after(async function () { await suite.resumeMining(); });
    it('AT2 three chunks and the assembler across blocks in reverse: nothing deploys until the last piece', at2ReverseBlockOrder);
});
