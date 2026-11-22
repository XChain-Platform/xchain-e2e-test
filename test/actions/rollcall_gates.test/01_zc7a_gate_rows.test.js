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
 ********************************************************************/

// ZC7a: a rolled v1 epoch records one rollcall_gates row per present signer. Part of rollcall_gates.test.js.

'use strict'

const assert = require('assert')

const rc = require('../../helpers/rollcallHelper')
const { requestBlockFor } = require('./support/shared')

async function recordsGateRows(st){
    const { ctx, E1, C1 } = st
    const row = await rc.driveEpoch(ctx, E1, { silentHubs: [] })
    assert.strictEqual(Number(row.rolled), 1,
        'epoch ' + E1 + ' closed UNROLLED with every hub present. On a gates-armed venue the likeliest cause ' +
        'is a HALF-ARMED one: the DOGE indexer refuses a v1 action for an epoch its own build reads as v0 ' +
        '(`invalid: ROLLCALL v1 before gates activation`), so every signature is discarded and the epoch ' +
        'closes with nobody present. Set ' + rc.ROLLCALL_GATES_ARMING_ENV + ' in BOTH indexer containers ' +
        'and restart them. responsible_set_json=' + String(row.responsible_set_json))
    assert.strictEqual(Number(row.close_block), C1, 'epoch ' + E1 + ' must close at E + 14')

    const full  = rc.knownGates().split(',')
    const rows  = await rc.rollcallGatesRows(ctx, E1)
    const byKey = new Map(rows.map(r => [r.pubkey, r]))

    // One row per SIGNER, and the signers are the three hubs this harness runs.
    // The idle fourth staker signs nothing and must therefore have no row: a row
    // for a key that never signed would mean the close recorded a claim nobody
    // made, which is the one way this table could lie to the filter.
    for (let i = 0; i < ctx.rounds.length; i++){
        const key = ctx.roster[i].pubkey
        const got = byKey.get(key)
        assert.ok(got,
            'ZC7a: hub ' + i + ' (' + key.slice(0, 16) + '...) signed epoch ' + E1 + ' but the close wrote no ' +
            '`rollcall_gates` row for it. The close writes these rows only for a ROLLED v1 epoch and only for ' +
            'signers it VERIFIED, so a missing row means either the row failed verification against the ' +
            'rebuilt v1 canonical or the BTC indexer read the epoch as v0. Rows present: ' +
            JSON.stringify(rows.map(r => r.pubkey.slice(0, 12))))
        assert.deepStrictEqual(got.gates, full,
            'ZC7a: hub ' + i + '\'s recorded list must be exactly the list its build knows (' + full.length +
            ' gate(s)); got ' + (got.gates === null ? 'an unparseable gates_json' : got.gates.length + ' gate(s)'))
        assert.strictEqual(got.close_block, C1,
            'ZC7a: the row is written at the close block and is rolled back with it')
    }
    assert.ok(!byKey.has(ctx.roster[rc.IDLE_SEED_INDEX].pubkey),
        'ZC7a: the idle fourth staker never signs, so it must have no `rollcall_gates` row for epoch ' + E1)

    // The property the filter actually reads: a full list is a superset of the
    // gates active at any block this epoch can be judged for, so nobody is
    // dropped. Asserted rather than assumed, because it is the control ZC7c's
    // absence is measured against.
    const active = rc.activeGates(requestBlockFor(C1 + 1), ctx.network)
    assert.ok(active.length > 0,
        'no consensus gate is active at ' + requestBlockFor(C1 + 1) + ' on ' + ctx.network + ', so the subset ' +
        'test is vacuous and nothing here can be dropped for any reason')
    for (const g of active)
        assert.ok(full.includes(g),
            'ZC7a: gate ' + g + ' is active at the request block but is not in this build\'s own list, so the ' +
            'hubs published a list their own chain would drop them for')
    console.log('    epoch ' + E1 + ': ' + rows.length + ' gate row(s) recorded, ' + full.length +
                ' gate(s) each, ' + active.length + ' active at the judged request block')
}

function register(st){
    it('ZC7a: a rolled v1 epoch records one rollcall_gates row per present signer, carrying the list it signed', async function () { await recordsGateRows(st) })
}

module.exports = { register }
