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

// ZC7b: a validator that publishes a SHORT gate list is recorded with exactly that list. Part of rollcall_gates.test.js.

'use strict'

const assert = require('assert')

const rc = require('../../helpers/rollcallHelper')
const { capabilitySet, requestBlockFor } = require('./support/shared')

// Measures the venue and chooses which hubs publish the short list.
async function planShortList(st){
    const { ctx, E1, E2, C1, C2, httpGet } = st
    await rc.mineBtcTo(ctx, C1 + 2, 'reading the capability set past the close of epoch ' + E1)
    const before = await capabilitySet('attestation', C1 + 1, httpGet.min_stake_xchain)
    const sourcesBefore = before.sources.size
    const allowed = httpGet.allowed_redundancy.slice().sort((a, b) => a - b)
    const redundancy = allowed.filter(r => r <= sourcesBefore).pop()
    assert.ok(redundancy,
        'ZC7d needs a request whose REDUNDANCY the venue could actually serve BEFORE the filter runs, and ' +
        'this venue qualifies ' + sourcesBefore + ' attestation source(s) at or above the http_get floor of ' +
        String(httpGet.min_stake_xchain) + ' XCHAIN, which is below the smallest redundancy http_get allows (' + allowed[0] +
        '). Stake at least ' + allowed[0] + ' attestation source(s) above that floor before driving ZC7.')

    // One dropped SOURCE per shortened key (the roster keys are one per source,
    // which assertOraclePublishFederation has already established), so this many
    // takes the surviving count below `redundancy`.
    const need = sourcesBefore - redundancy + 1
    const eligible = ctx.roster.slice(0, ctx.rounds.length).filter(r => before.keys.has(r.pubkey))
    assert.ok(eligible.length >= need,
        'ZC7 needs ' + need + ' of its own hubs to be shortened to take the surviving source count from ' +
        sourcesBefore + ' below redundancy ' + redundancy + ', but only ' + eligible.length + ' roster hub(s) ' +
        'qualify for `attestation` at the http_get floor. The venue carries ' + sourcesBefore + ' qualifying ' +
        'source(s), of which ' + (sourcesBefore - eligible.length) + ' are keys this harness does not hold ' +
        'and therefore cannot shorten. Drive ZC7 on a venue whose attestation set is the acceptance roster, ' +
        'or unstake the foreign sources.')
    const shortHubs = eligible.slice(0, need).map(r => r.index)
    const shortKeys = shortHubs.map(i => ctx.roster[i].pubkey)

    // The list itself: this build's own, minus ONE gate that is ACTIVE at the
    // block the request will be judged at. Dropping an INACTIVE gate would be a
    // list the filter accepts, and the leg would measure nothing.
    const full   = rc.knownGates().split(',')
    const active = rc.activeGates(requestBlockFor(C2 + 1), ctx.network)
    const droppedGate = active[active.length - 1]
    const shortGates = full.filter(g => g !== droppedGate).join(',')
    assert.strictEqual(shortGates.split(',').length, full.length - 1,
        'the short list must omit exactly one gate')
    console.log('    epoch ' + E2 + ': hub(s) ' + shortHubs.join(',') + ' publish a list omitting ' +
                droppedGate + ' (' + sourcesBefore + ' source(s) before, redundancy ' + redundancy + ')')
    Object.assign(st, { sourcesBefore, redundancy, shortHubs, shortKeys, droppedGate, shortGates })
}

// Drives epoch 2 with the chosen hubs silent and their own one-pair actions on chain.
async function driveShortEpoch(st){
    const { ctx, E2, shortHubs, shortKeys, shortGates } = st
    // The shortened hubs are SILENT for the epoch, and their signature reaches
    // the chain only through the action this suite builds. That is not
    // decoration: a signature they gossiped would ride the leader's action over
    // the PUBLISHER's full list, the DOGE peer's per-key read would then hold two
    // rows for one key with different lists, and which one the close saw would
    // depend on row order. One publisher per key is what makes the verdict
    // deterministic.
    //
    // BEFORE the rank-ladder climb, never after it. The close counts a DOGE row
    // only if its block is stamped no later than the BTC window-end block, and
    // the climb mines BTC up to that block whenever a high rank has to unlock,
    // which is exactly what silencing a hub forces on the survivors. Measured
    // 2026-09-08 at epoch 7230: the cut was stamped 05:26:52 UTC, the short-list
    // action parsed valid at 05:27:23, and the close read the hub as absent
    // (no_row) rather than present with a short list. In beforePublish the BTC
    // tip sits at about E + 6 and the cut is six blocks away.
    const windowEnd2 = Number(rc.rca().rollcallWindowEndHeight(E2, ctx.network))
    const row = await rc.driveEpoch(ctx, E2, {
        silentHubs: shortHubs,
        beforePublish: async () => {
            const tipNow = await ctx.btcTip()
            assert.ok(tipNow < windowEnd2 - 1,
                'epoch ' + E2 + ': BTC tip ' + tipNow + ' is already at the window end ' + windowEnd2 +
                ', so a short-list publish now would stamp after the cut and read as an absence')
            const bh = await indexerConnector.call('getblockhashes', { block_index: E2 })
            const ledgerHash = String(bh.ledger_hash).toLowerCase()
            for (const i of shortHubs){
                const sig = rc.signCanonical(ctx.roster[i].seed,
                    rc.canonical(ctx.network, E2, ledgerHash, shortGates))
                const wire = rc.buildWire(E2, ledgerHash, ctx.roster[i].pubkey,
                    [{ pubkey: ctx.roster[i].pubkey, sig: sig }], shortGates)
                assert.ok(wire.startsWith(rc.ROLLCALL_WIRE_V1 + '|'),
                    'a short-list publish must be ROLLCALL v1: v0 is positional and length-exact and cannot ' +
                    'carry a GATES field at all')
                await rc.publishWire(ctx, wire)
            }
            // The publishes must be INDEXED before the window-end cut, or the
            // close reads them as absences and the epoch measures the wrong thing.
            await rc.waitForOnChainSigners(ctx, E2, shortKeys)
        },
    })
    assert.strictEqual(Number(row.rolled), 1,
        'epoch ' + E2 + ' must ROLL: the shortened hubs are PRESENT through their own one-pair actions (the ' +
        'union rule), a short list is a valid list, and presence is what quorum counts. rolled=0 here means ' +
        'either the hand-built actions never landed or their signatures did not verify against the v1 ' +
        'canonical rebuilt from the carried GATES.')
}

async function assertShortRows(st){
    const { ctx, E2, shortHubs, shortGates, droppedGate } = st
    const rows  = await rc.rollcallGatesRows(ctx, E2)
    const byKey = new Map(rows.map(r => [r.pubkey, r]))
    const short = shortGates.split(',')
    const full2 = rc.knownGates().split(',')
    for (const i of shortHubs){
        const got = byKey.get(ctx.roster[i].pubkey)
        assert.ok(got,
            'ZC7b: hub ' + i + ' published its own roll call for epoch ' + E2 + ' but the close recorded no ' +
            'gate row for it. Its signature is over the SHORT list, so a missing row means the close rebuilt a ' +
            'canonical over different bytes than the ones this suite signed.')
        assert.deepStrictEqual(got.gates, short,
            'ZC7b: hub ' + i + '\'s row must carry EXACTLY the short list it signed, not the full list its ' +
            'build knows: the row is a statement about what this key accepted, and recording anything else ' +
            'would let a validator be judged on a list it never signed')
        assert.ok(!got.gates.includes(droppedGate),
            'ZC7b: the omitted gate ' + droppedGate + ' must not appear in the recorded short list')
    }
    for (let i = 0; i < ctx.rounds.length; i++){
        if (shortHubs.includes(i)) continue
        const got = byKey.get(ctx.roster[i].pubkey)
        assert.ok(got && got.gates,
            'ZC7b: hub ' + i + ' signed the leader\'s full list and must still have a row for epoch ' + E2)
        assert.deepStrictEqual(got.gates, full2,
            'ZC7b: an unshortened hub keeps the full list; one hub publishing a short list must not change ' +
            'what the others are recorded as knowing')
    }
}

async function recordsShortList(st){
    await planShortList(st)
    await driveShortEpoch(st)
    await assertShortRows(st)
}

function register(st){
    it('ZC7b: a validator that publishes a SHORT gate list is recorded with exactly that list', async function () { await recordsShortList(st) })
}

module.exports = { register }
