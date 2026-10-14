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

// ZC7c: the short-list validator is absent from the attestation set and present in the price set. Part of rollcall_gates.test.js.

'use strict'

const assert = require('assert')

const rc = require('../../helpers/rollcallHelper')
const { capabilitySet, requestBlockFor } = require('./support/shared')

async function filterIsScopedToAttestation(st){
    const { ctx, E1, E2, C1, C2, shortHubs, shortKeys, droppedGate } = st
    assert.ok(shortKeys.length, 'ZC7c reads back what ZC7b published; this suite runs in file order')

    // Judge at a block whose buried snapshot is at or past E2's close, which is
    // what makes E2 the epoch the filter selects.
    await rc.mineBtcTo(ctx, C2 + 2, 'reading the capability set past the close of epoch ' + E2)
    const judgedAt = requestBlockFor(C2 + 1)
    assert.ok(rc.activeGates(judgedAt, ctx.network).includes(droppedGate),
        'ZC7c: gate ' + droppedGate + ' must still be ACTIVE at the judged request block ' + judgedAt +
        ' or the short list is a superset after all and nobody is dropped')

    const after  = await capabilitySet('attestation', C2 + 1)
    const before = await capabilitySet('attestation', C1 + 1)
    const price  = await capabilitySet('price', C2 + 1)

    for (const key of shortKeys){
        // THE CONTROL FIRST. An absence proves the filter only if the key was in
        // the set before: a key that was never there would read identically, and
        // the reading a drill must never make is "the filter worked" about a
        // validator the venue had already dropped for stake reasons.
        assert.ok(before.keys.has(key),
            'ZC7c: ' + key.slice(0, 16) + '... must be in the `attestation` set at a block judged against ' +
            'epoch ' + E1 + ' (where its list was FULL); it is not, so its absence later would say nothing ' +
            'about the rules filter. Present then: ' + JSON.stringify(Array.from(before.keys).map(k => k.slice(0, 12))))
        assert.ok(!after.keys.has(key),
            'ZC7c: ' + key.slice(0, 16) + '... published a roll call omitting ' + droppedGate + ', which is ' +
            'active at block ' + judgedAt + ', so the rules-aware filter must drop it from the `attestation` ' +
            'set. Still present: ' + JSON.stringify(Array.from(after.keys).map(k => k.slice(0, 12))))
        // The scope of the rule, and the whole reason it is a filter rather than a
        // slash: the same key is still a perfectly good price validator. Only the
        // attestation set is derived from the rules a request is governed by.
        assert.ok(price.keys.has(key),
            'ZC7c: the filter is scoped to `attestation` (D16), so ' + key.slice(0, 16) + '... must still be ' +
            'in the `price` capability set at the same block. Its absence there would mean the filter is ' +
            'running on a capability whose set has nothing to do with consensus rules.')
    }

    // The unshortened hubs are the other half of the reading: a filter that
    // emptied the set would satisfy every assertion above.
    for (let i = 0; i < ctx.rounds.length; i++){
        if (shortHubs.includes(i)) continue
        assert.ok(after.keys.has(ctx.roster[i].pubkey),
            'ZC7c: hub ' + i + ' signed the full list and must SURVIVE the filter at block ' + judgedAt +
            '; a filter that drops everybody is not the rule this suite is measuring')
    }
    console.log('    attestation set at the judged block: ' + after.keys.size + ' key(s) / ' +
                after.sources.size + ' source(s), was ' + before.keys.size + ' / ' + before.sources.size +
                ' against epoch ' + E1 + '; price set unchanged at ' + price.keys.size + ' key(s)')
}

function register(st){
    it('ZC7c: the short-list validator is absent from the attestation set at the request block and present in the price set', async function () { await filterIsScopedToAttestation(st) })
}

module.exports = { register }
