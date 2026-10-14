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
 * Step 4: ATTEST v3 materializes the origin request onto the home chain.
 ********************************************************************/

'use strict';

const assert = require('assert');
const transactionHelper = require('../../../helpers/core/transactionHelper');
const chainRail = require('../../../helpers/chainRail');
const { ATTEST_URL, REDUNDANCY, DEADLINE_BLOCKS } = require('./config');
const { railQuery, resilientSend, pumpUntil } = require('./rail');

function v3Row(ctx) {
    return {
        request_id:          ctx.originRequestId,
        snapshot_block:      ctx.snapshotBlock,
        network:             ctx.homeRail.network,
        origin_chain:        ctx.originRail.code,
        origin_action_index: Number(ctx.originRequest.action_index),
        provider_id:         'http_get',
        request_payload:     ATTEST_URL,
        redundancy:          REDUNDANCY,
        deadline_blocks:     DEADLINE_BLOCKS,
    };
}

async function broadcastV3(ctx) {
    const row = v3Row(ctx);
    const canonical = ctx.codec.requestCanonical(row);
    const wire = ctx.codec.requestWire(row, [{ pubkey: ctx.relaySigner.pubkey, sig: ctx.relaySigner.sign(canonical) }]);
    // Several signatures + a URL payload exceed the 80-byte OP_RETURN, which
    // is why the hub's own broadcaster forces P2SH too.
    await resilientSend('ATTEST v3 broadcast', ctx.homeRail, () =>
        transactionHelper.createAndSendTransaction(ctx.homeOperator, wire, null, [], 'P2SH'));
}

function awaitMaterialized(ctx) {
    return pumpUntil('the v3-materialized BTC request row', ctx.homeRail, async () => {
        const rows = await railQuery(ctx.homeRail,
            'SELECT action_index, request_status, origin_chain, origin_action_index, block_index, ' +
            'responsible_set_json, redundancy, provider_id, payload FROM attests ' +
            'WHERE request_id = ? AND version = 0 LIMIT 1', [ctx.originRequestId]);
        return rows.length ? rows[0] : null;
    });
}

function assertMaterialized(ctx, m) {
    assert.strictEqual(String(m.request_status), 'pending',
        'the materialized request should be pending on the home chain');
    assert.strictEqual(String(m.origin_chain), ctx.originRail.code);
    assert.strictEqual(Number(m.origin_action_index), Number(ctx.originRequest.action_index));
    assert.strictEqual(String(m.payload), ATTEST_URL);
    assert(Number(m.block_index) > 0, 'the materialized row carries a real BTC block_index');
    console.log('    [relay-loop] materialized on ' + ctx.homeRail.code + ' at block ' + m.block_index +
                ' (origin ' + m.origin_chain + ':' + m.origin_action_index + ')');
}

// The responsible set is pinned AS-OF the v3's own BTC block. Sign with
// exactly those keys, and fail loudly if the grind did not win the slots
// (otherwise the v1 below would fail as "insufficient signatures" and the
// real cause would be invisible).
function assertPinnedSet(ctx, m) {
    const pinned = m.responsible_set_json ? JSON.parse(m.responsible_set_json) : null;
    assert(Array.isArray(pinned) && pinned.length === REDUNDANCY,
        'the materialized row should pin a responsible set of ' + REDUNDANCY + ' keys, got ' +
        JSON.stringify(pinned));
    const pinnedSet = new Set(pinned.map(p => String(p).toLowerCase()));
    for (const v of ctx.responsibleValidators)
        assert(pinnedSet.has(v.pubkey), 'drill key ' + v.pubkey.slice(0, 16) + '... missing from the pinned responsible set');
}

async function materializeRequest(ctx) {
    await chainRail.withRail(ctx.homeRail, async () => {
        assert(Number.isInteger(ctx.snapshotBlock) && ctx.snapshotBlock > 0,
            'snapshot_block was never resolved; the staking step did not complete');
        await broadcastV3(ctx);
        const materialized = await awaitMaterialized(ctx);
        assertMaterialized(ctx, materialized);
        assertPinnedSet(ctx, materialized);
    });
}

module.exports = { materializeRequest };
