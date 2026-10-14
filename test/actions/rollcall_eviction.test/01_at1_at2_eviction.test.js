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

// AT1/AT2: the idle fourth source is evicted after K rolled epochs; the hub silent for K-1 is not. Part of rollcall_eviction.test.js.

'use strict'

const assert = require('assert')

const rc = require('../../helpers/rollcallHelper')

// The hub whose absence AT2 measures. Never one of the pair that must carry
// quorum without it: hubs 0 and 1 have to roll an epoch on their own.
const AT2_SILENT_HUB = 2

async function firstEpochSilentHub(st){
    const { ctx, E1, C1, idleSource, silentSource } = st
    // Epoch 1: the AT2 hub is down. Both it and the idle source are absent,
    // and neither may be evicted on a streak of one.
    const row1 = await rc.driveEpoch(ctx, E1, { silentHubs: [AT2_SILENT_HUB] })
    assert.strictEqual(Number(row1.rolled), 1,
        'epoch ' + E1 + ' closed UNROLLED. With one hub down the remaining weight must still clear the strict ' +
        '2/3 bar, or the epoch counts for nobody and no streak forms. responsible_set_json=' +
        String(row1.responsible_set_json))
    assert.strictEqual(Number(row1.close_block), C1, 'epoch ' + E1 + ' must close at E + 14')

    const abs1 = await rc.absenceRows(ctx, E1)
    const abs1Sources = abs1.map(r => String(r.source)).sort()
    assert.deepStrictEqual(abs1Sources, [idleSource, silentSource].sort(),
        'epoch ' + E1 + ': exactly the idle source and the stopped hub\'s source must be absent, got ' +
        JSON.stringify(abs1Sources))
    for (const r of abs1)
        assert.strictEqual(Number(r.evicted), 0,
            'epoch ' + E1 + ': ' + r.source + ' must NOT be evicted on a streak of 1 (K = 2)')
}

async function secondEpochAllPresent(st){
    const { ctx, E2, idleSource, silentSource } = st
    // Epoch 2: the AT2 hub is back, so only the idle source is absent and its
    // streak reaches K.
    const row2 = st.row2 = await rc.driveEpoch(ctx, E2, { silentHubs: [] })
    assert.strictEqual(Number(row2.rolled), 1, 'epoch ' + E2 + ' must close ROLLED with all three hubs present')

    const abs2 = await rc.absenceRows(ctx, E2)
    assert.deepStrictEqual(abs2.map(r => String(r.source)), [idleSource],
        'epoch ' + E2 + ': only the idle source may be absent once the AT2 hub is back, got ' +
        JSON.stringify(abs2.map(r => String(r.source))))
    assert.strictEqual(Number(abs2[0].evicted), 1,
        'epoch ' + E2 + ': the idle source has now been absent for K = 2 consecutive ROLLED epochs and must ' +
        'be evicted')

    // AT2's whole claim, over both epochs.
    const silentAbsences = await ctx.idxQuery(
        `SELECT ra.epoch_height, ra.evicted FROM rollcall_absences ra
           JOIN index_addresses ia ON ia.id = ra.source_id WHERE ia.address = ?`, [silentSource])
    for (const r of silentAbsences)
        assert.strictEqual(Number(r.evicted), 0,
            'AT2: a hub stopped across K - 1 closes must never be evicted; epoch ' + r.epoch_height +
            ' says otherwise')

    // The DOGE side counted the presence the BTC side judged. A mismatch here
    // means the two chains disagree about who signed, which is the failure the
    // whole rail is built to make impossible.
    const signers2 = await rc.dogeSigners(ctx, E2)
    const signerKeys = new Set(signers2.map(r => String(r.pubkey).toLowerCase()))
    for (let i = 0; i < 3; i++)
        assert.ok(signerKeys.has(ctx.roster[i].pubkey),
            'epoch ' + E2 + ': hub ' + i + '\'s signature must be on the DOGE chain, got ' +
            JSON.stringify(Array.from(signerKeys)))
    assert.ok(!signerKeys.has(ctx.roster[rc.IDLE_SEED_INDEX].pubkey),
        'epoch ' + E2 + ': the idle staker never runs a hub, so its key must not appear on the DOGE chain')
}

async function assertEvictionRows(st){
    const { ctx, C2, idleSource } = st
    // The eviction is a synthetic UNSTAKE at action_format = 3, one row per
    // (source, signing key) with a sweepable balance.
    const evictionRows = st.evictionRows = await rc.evictionUnstakes(ctx, idleSource)
    assert.ok(evictionRows.length >= 1,
        'the eviction must mint at least one synthetic UNSTAKE at action_format = 3 for ' + idleSource +
        '; found none. Zero sweepable rows is a deliberate no-op in evictSource(), so this also fails when ' +
        'the idle source held no active stake at the close block.')
    for (const r of evictionRows){
        assert.strictEqual(Number(r.block_index), C2, 'the synthetic UNSTAKE is stamped at the close block ' + C2)
        assert.strictEqual(String(r.status), 'valid', 'the synthetic UNSTAKE is written valid')
    }

    const cooldownBlocks = st.cooldownBlocks = Number(evictionRows[0].cooldown_end_block) - C2
    const stakeRows = await rc.stakeDeactivations(ctx, idleSource)
    const stamped   = stakeRows.filter(r => r.deactivation_block !== null)
    assert.ok(stamped.length >= 1, 'the eviction must stamp deactivation_block on the idle source\'s stake row(s)')
    const activationDelay = st.activationDelay = Number(stamped[0].deactivation_block) - C2
    console.log('    eviction: ' + evictionRows.length + ' synthetic UNSTAKE row(s), ACTIVATION_DELAY_BLOCKS=' +
                activationDelay + ', COOLDOWN_BLOCKS=' + cooldownBlocks)

    assert.ok(activationDelay <= 7,
        'AT1 reads getcapabilityvalidators at C + 7, but this venue\'s ACTIVATION_DELAY_BLOCKS is ' +
        activationDelay + ', so the evicted source is still in the capability set at C + 7. Lower ' +
        'STAKING.ACTIVATION_DELAY_BLOCKS on the regtest venue, or restate the acceptance height as C + ' +
        activationDelay + '.')
}

async function assertCapabilitySet(st){
    const { ctx, C2 } = st
    // AT1's headline.
    await rc.mineBtcTo(ctx, C2 + 7, 'AT1 read height C + 7')
    const caps = await indexerConnector.getCapabilityValidators('oracle_publish', C2 + 7)
    assert.ok(caps && !caps.error, 'getcapabilityvalidators failed: ' + JSON.stringify(caps && caps.error))
    assert.strictEqual(caps.validators.length, 3,
        'AT1: getcapabilityvalidators(oracle_publish) at C + 7 = ' + (C2 + 7) + ' must return three rows once ' +
        'the protocol has evicted the idle fourth source; got ' + caps.validators.length + ': ' +
        JSON.stringify(caps.validators.map(v => v.pubkey)))
    assert.ok(!caps.validators.some(v => String(v.pubkey).toLowerCase() === ctx.roster[rc.IDLE_SEED_INDEX].pubkey),
        'AT1: the evicted source\'s signing key must be gone from the capability set at C + 7')
}

async function assertPublicReads(st){
    const { ctx, E2, C2, idleSource, row2 } = st
    // The two plain public reads the acceptance list quotes. Their DB half is
    // landed (db.js getRollcalls / getRollcallAbsencesBySource); the JSON-RPC
    // half was still in flight when this was written and is absent from the
    // regtest BTC indexer as measured 2026-08-30, so a missing method is
    // reported as exactly that rather than passing quietly.
    if (process.env.XC_ROLLCALL_SKIP_PUBLIC_READS !== '1'){
        rc.assertPublicRollcallRead(ctx.publicReads, 'getrollcalls')
        rc.assertPublicRollcallRead(ctx.publicReads, 'getrollcallabsences')

        const list = await indexerConnector.call('getrollcalls', { limit: 5 })
        assert.ok(Array.isArray(list.rollcalls), 'getrollcalls must return { rollcalls: [...] }')
        const heights = list.rollcalls.map(r => Number(r.epoch_height))
        assert.deepStrictEqual(heights.slice(), heights.slice().sort((a, b) => b - a),
            'getrollcalls must be ordered epoch_height DESC')
        const seen2 = list.rollcalls.find(r => Number(r.epoch_height) === E2)
        assert.ok(seen2, 'getrollcalls must carry epoch ' + E2)
        assert.strictEqual(Number(seen2.snapshot_block), Number(row2.snapshot_block))
        assert.strictEqual(Number(seen2.close_block), C2)
        assert.strictEqual(Number(seen2.rolled), 1)
        assert.strictEqual(Number(seen2.absent_count), 1, 'epoch ' + E2 + ' had exactly one absent source')

        const evicted = await indexerConnector.call('getrollcallabsences', { source: idleSource, limit: 10 })
        assert.ok(Array.isArray(evicted.absences), 'getrollcallabsences must return { absences: [...] }')
        assert.strictEqual(Number(evicted.absences[0].epoch_height), E2,
            'getrollcallabsences must be ordered epoch_height DESC')
        assert.strictEqual(Number(evicted.absences[0].evicted), 1)
        assert.strictEqual(String(evicted.absences[0].source), idleSource,
            'the response echoes the canonical address, not the caller\'s input')

        const unknown = await indexerConnector.call('getrollcallabsences', {
            source: 'rollcall-acceptance-no-such-source', limit: 5,
        })
        assert.deepStrictEqual(unknown.absences, [],
            'an unknown source must return an empty list, never an error: "no absences on record" is the ' +
            'reading that makes an operator stop worrying, so it must never be a swallowed query failure')
    }
}

async function evictsIdleSource(st){
    await firstEpochSilentHub(st)
    await secondEpochAllPresent(st)
    await assertEvictionRows(st)
    await assertCapabilitySet(st)
    await assertPublicReads(st)
}

function register(st){
    it('AT1/AT2: the idle fourth source is evicted after K rolled epochs; the hub silent for K-1 is not', async function () { await evictsIdleSource(st) })
}

module.exports = { register }

module.exports.AT2_SILENT_HUB = AT2_SILENT_HUB
