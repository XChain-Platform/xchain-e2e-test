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
 * Step 7: ATTEST v4 relays the response back, settles the request and injects the callback.
 ********************************************************************/

'use strict';

const assert = require('assert');
const crypto = require('crypto');
const transactionHelper = require('../../helpers/core/transactionHelper');
const chainRail = require('../../helpers/chainRail');
const { railQuery, resilientSend, pumpUntil } = require('./rail');

function v4Row(ctx) {
    const responseBytes = Buffer.from(ctx.realBody, 'utf8');
    return {
        request_id:                 ctx.originRequestId,
        snapshot_block:             ctx.snapshotBlock,
        network:                    ctx.originRail.network,
        origin_chain:               ctx.originRail.code,
        home_response_action_index: ctx.homeResponseActionIndex,
        provider_id:                'http_get',
        response_hash:              crypto.createHash('sha256').update(responseBytes).digest('hex'),
        status:                     'ok',
        meta:                       ctx.realMeta,
        response_payload_b64:       responseBytes.toString('base64'),
    };
}

// Stand in for the hub's capability mirror: the origin chain verifies
// cross_chain against hub-mirrored capability_snapshots (capability
// staking is BTC-only), so seed exactly the rows the mirror would carry
// for the one snapshot_block this v4 names.
async function seedSnapshot(ctx) {
    await railQuery(ctx.originRail,
        'INSERT IGNORE INTO capability_snapshots (snapshot_block, capability, signing_pubkey, amount, source) ' +
        'VALUES (?, ?, ?, ?, ?)',
        [ctx.snapshotBlock, 'cross_chain', ctx.relaySigner.pubkey, String(ctx.relayStakeAmount) + '.00000000', ctx.relayStakeSource.address]);
    const seeded = await railQuery(ctx.originRail,
        'SELECT signing_pubkey FROM capability_snapshots WHERE capability = ? AND snapshot_block = ?',
        ['cross_chain', ctx.snapshotBlock]);
    assert(seeded.length >= 1, 'the origin chain needs a cross_chain snapshot at ' + ctx.snapshotBlock);
}

// The v4's row is stored as attests.version = 1, NOT 4: `attests` is a
// lifecycle table and every response consumer filters on version 1, so
// the relay leg reuses that shape (the mirror of the v3 request landing
// as version 0). The on-chain provenance lives in actions.action_format,
// which is what this joins on - a query keyed on version = 4 finds
// nothing even when the relay worked perfectly.
function awaitRelayed(ctx) {
    return pumpUntil('the origin ATTEST v4 row', ctx.originRail, async () => {
        const rows = await railQuery(ctx.originRail,
            'SELECT at.action_index, at.response_status, at.callback_execute_action_index, at.meta, s.status ' +
            'FROM attests at JOIN actions ac ON ac.action_index = at.action_index ' +
            'LEFT JOIN index_statuses s ON s.id = at.status_id ' +
            'WHERE at.request_id = ? AND ac.action_format = 4 ORDER BY at.action_index DESC LIMIT 1',
            [ctx.originRequestId]);
        return rows.length ? rows[0] : null;
    });
}

function awaitOriginTerminal(ctx) {
    return pumpUntil('the origin request to flip terminal', ctx.originRail, async () => {
        const rows = await railQuery(ctx.originRail,
            'SELECT request_status, resolved_block FROM attests WHERE request_id = ? AND version = 0 LIMIT 1',
            [ctx.originRequestId]);
        return (rows.length && rows[0].request_status !== 'pending') ? rows[0] : null;
    }, 120000);
}

async function assertOriginSettled(ctx) {
    const relayed = await awaitRelayed(ctx);
    assert.strictEqual(String(relayed.status), 'valid',
        'the v4 should index valid (status was: ' + relayed.status + ')');
    assert.strictEqual(String(relayed.response_status), 'ok');

    const request = await awaitOriginTerminal(ctx);
    assert.strictEqual(String(request.request_status), 'fulfilled',
        'the origin request should be fulfilled by the relayed response');
    assert(relayed.callback_execute_action_index,
        'the callback EXECUTE must be injected on the chain the contract lives on');
}

// The loop is only closed when the CONTRACT sees the data: same shape a
// local fulfillment would have delivered, byte-for-byte the fetched body.
async function assertContractCallback(ctx) {
    const read = (key) => global.indexerDatabase.getContractState(ctx.originContract, key);
    const cbStatus  = await read('callback_status');
    const cbPayload = await read('callback_payload');
    const cbContext = await read('callback_context');
    const cbRequest = await read('callback_request_id');
    assert(cbStatus && cbPayload, 'the contract should have recorded the callback');
    assert.strictEqual(JSON.parse(cbStatus.state_value), 'ok');
    assert.strictEqual(JSON.parse(cbPayload.state_value), ctx.realBody);
    assert.strictEqual(JSON.parse(cbContext.state_value), 'ctx-xc974');
    assert.strictEqual(String(JSON.parse(cbRequest.state_value)).toLowerCase(), ctx.originRequestId);
    console.log('    [relay-loop] LOOP CLOSED: ' + ctx.originRail.code + ' contract ' + ctx.originContract +
                ' holds the body attested by ' + ctx.homeRail.code + ' validators');
}

async function relayResponseBack(ctx) {
    const row = v4Row(ctx);
    const canonical = ctx.codec.responseCanonical(row);
    const wire = ctx.codec.responseWire(row, [{ pubkey: ctx.relaySigner.pubkey, sig: ctx.relaySigner.sign(canonical) }]);

    await chainRail.withRail(ctx.originRail, async () => {
        await seedSnapshot(ctx);
        await resilientSend('ATTEST v4 broadcast', ctx.originRail, () =>
            transactionHelper.createAndSendTransaction(ctx.originOperator, wire, null, [], 'P2SH'));
        await assertOriginSettled(ctx);
        await assertContractCallback(ctx);
    });
}

module.exports = { relayResponseBack };
