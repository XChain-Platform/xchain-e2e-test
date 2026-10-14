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
 * Step 6: a real http_get fetch fulfills the request on the home chain as an ordinary v1.
 ********************************************************************/

'use strict';

const assert = require('assert');
const internalPath = require('path');
const attestationHelper = require('../../../helpers/attestationHelper');
const chainRail = require('../../../helpers/chainRail');
const { HUB_BASE, ATTEST_URL } = require('./config');
const { railQuery, resilientSend, pumpUntil } = require('./rail');

async function fetchRealBody(ctx) {
    const httpGet = require(internalPath.join(HUB_BASE, 'src/providers/http_get.js'));
    const fetched = await httpGet.fetch(ATTEST_URL, { maxResponseBytes: 32768, timeoutMs: 15000 });
    ctx.realBody = fetched.body.toString('utf8');
    ctx.realMeta = String(fetched.meta);
    assert.strictEqual(ctx.realMeta, '200', 'expected HTTP 200 from ' + ATTEST_URL);
    console.log('    [relay-loop] fetched ' + Buffer.byteLength(ctx.realBody, 'utf8') + ' bytes from ' + ATTEST_URL);
}

function broadcastV1(ctx) {
    return resilientSend('ATTEST v1 broadcast', ctx.homeRail, () =>
        attestationHelper.broadcastAttestationResponse(ctx.homeOperator, {
            requestId:       ctx.originRequestId,
            providerId:      'http_get',
            responsePayload: ctx.realBody,
            status:          'ok',
            meta:            ctx.realMeta,
            validators:      ctx.responsibleValidators,
        }));
}

function awaitHomeResponse(ctx) {
    return pumpUntil('the home-chain ATTEST v1 response row', ctx.homeRail, async () => {
        const rows = await railQuery(ctx.homeRail,
            'SELECT at.action_index, at.response_status, at.callback_execute_action_index, s.status ' +
            'FROM attests at JOIN actions ac ON ac.action_index = at.action_index ' +
            'LEFT JOIN index_statuses s ON s.id = at.status_id ' +
            'WHERE at.request_id = ? AND ac.action_format = 1 ORDER BY at.action_index DESC LIMIT 1',
            [ctx.originRequestId]);
        return rows.length ? rows[0] : null;
    });
}

function awaitRequestTerminal(ctx) {
    return pumpUntil('the materialized request to flip terminal', ctx.homeRail, async () => {
        const rows = await railQuery(ctx.homeRail,
            'SELECT request_status FROM attests WHERE request_id = ? AND version = 0 LIMIT 1', [ctx.originRequestId]);
        return (rows.length && rows[0].request_status !== 'pending') ? rows[0] : null;
    }, 120000);
}

async function assertHomeFulfilled(ctx) {
    const response = await awaitHomeResponse(ctx);
    assert.strictEqual(String(response.status), 'valid', 'the v1 should index valid');
    assert.strictEqual(String(response.response_status), 'ok');
    ctx.homeResponseActionIndex = Number(response.action_index);

    const request = await awaitRequestTerminal(ctx);
    assert.strictEqual(String(request.request_status), 'fulfilled',
        'the materialized request should flip fulfilled on the home chain');

    // The contract is not on this chain: a home-chain callback here would run
    // against a contract index that means something else entirely.
    assert(!response.callback_execute_action_index,
        'a foreign-origin request must fire NO callback on the home chain');
    console.log('    [relay-loop] home response action_index=' + ctx.homeResponseActionIndex + ', no local callback (correct)');
}

async function fulfillOnHome(ctx) {
    await fetchRealBody(ctx);
    await chainRail.withRail(ctx.homeRail, async () => {
        await broadcastV1(ctx);
        await assertHomeFulfilled(ctx);
    });
}

module.exports = { fulfillOnHome };
