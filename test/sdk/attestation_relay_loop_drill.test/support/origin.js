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
 *
 * Step 2: the origin contract emits ATTEST v0 and the indexer admits it.
 ********************************************************************/

'use strict';

const assert = require('assert');
const cryptoHelper = require('../../../helpers/core/cryptoHelper');
const gasHelper    = require('../../../helpers/gasHelper');
const vmHelper     = require('../../../helpers/vmHelper');
const chainRail    = require('../../../helpers/chainRail');
const { ATTEST_URL, REDUNDANCY, ORIGIN_CONTRACT } = require('./config');
const { resilientSend } = require('./rail');

async function deployOriginContract(ctx) {
    const rail = ctx.originRail;
    ctx.originOperator = await resilientSend('origin operator funding', rail, () =>
        cryptoHelper.getNewFundedAddress(
            'xc974-origin-op-' + Date.now(), rail.coin, rail.network, null, 'legacy', 0, 0.2, false));
    await resilientSend('origin gas', rail, () => gasHelper.ensureGasBalance(ctx.originOperator, '5000'));

    const deploy = await resilientSend('origin deploy', rail, () =>
        vmHelper.sendDeployV0(ctx.originOperator, ORIGIN_CONTRACT, 500000));
    assert.strictEqual(deploy.contract.status, 'valid', 'origin deploy status: ' + deploy.contract.status);
    ctx.originContract = deploy.contract.action_index;
    console.log('    [relay-loop] origin contract ' + ctx.originContract);
}

async function executeAsk(ctx) {
    const exec = await resilientSend('origin execute', ctx.originRail, () =>
        vmHelper.sendExecuteV0(ctx.originOperator, ctx.originContract, 'askAcrossChains', [ATTEST_URL]));
    assert.strictEqual(exec.execution.status, 'valid', 'origin execute status: ' + exec.execution.status);

    const request = await global.indexerDatabase.waitForAttestationRequest(
        { txHash: exec.txHash, requestStatus: 'pending' }, 120000);
    assert(request, 'the origin ATTEST v0 should be admitted pending (ATTEST_RELAY_ORIGIN)');
    ctx.originRequest = request;
    ctx.originRequestId = String(ctx.originRequest.request_id).toLowerCase();
}

function assertOriginStamp(ctx) {
    const req = ctx.originRequest;
    // The stamp is the whole origin-side feature: without it the request is
    // invisible to the relay, and before the gate it would not exist at all.
    assert.strictEqual(String(req.origin_chain), ctx.originRail.code,
        'the admitted request must be stamped with its origin chain');
    assert.strictEqual(Number(req.redundancy), REDUNDANCY);
    assert.strictEqual(String(req.payload), ATTEST_URL);
    console.log('    [relay-loop] origin request ' + ctx.originRequestId.slice(0, 16) + '... action_index=' +
                req.action_index + ' block=' + req.block_index);
}

async function emitOriginRequest(ctx) {
    await chainRail.withRail(ctx.originRail, async () => {
        await deployOriginContract(ctx);
        await executeAsk(ctx);
        assertOriginStamp(ctx);
    });
}

module.exports = { emitOriginRequest };
