'use strict'

/*********************************************************************
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 **********************************************************************
 * BF2 (family section 7): the fix. Activation ARMED on every child (both
 * indexers and every hub, so the producers publish the height watermark the
 * consumers bind on). The identical +7200 block on the identical mirror state
 * BF1 seeds: every member is satisfied on first evaluation, no `_barrier` reason
 * appears for that block, `stallClass` reads 'none', and the block commits
 * without waiting out any part of the stamp.
 *
 * THE BINDING ASSERTION IS A ROW SET, NOT A HASH. Above the activation a row binds
 * at a different block by design, so equality with BF1's `state_hash` could only
 * hold vacuously. The leg seeds one row admitted AT B and one admitted past B per
 * member table, plus a legacy NULL row in the tables whose armed apply pass never
 * reaches that row's canonical, and compares the set the armed node's mirror reads
 * at B (the section 5.5 rule in its IS NULL OR SQL form) against the fixture's
 * independently computed expected set over the hub's own rows.
 *
 * NO LEGACY ROW IN bridge_transfers OR policy_snapshots. The venue arms at height 0,
 * so every block is admission era and no hub produces a NULL-map row; those two apply
 * passes build the canonical before reading the capability set and throw on one,
 * stalling the drill block (rail 2026-09-17, block 104). The legacy rule is BF4's.
 *
 * WHAT THIS DOES NOT PROVE. The seeded rows carry no verifiable signature, so no
 * pass APPLIES them to the ledger; the read set is the mirror's, which is the rule
 * under test, and an on-ledger apply witness needs real federation traffic (a
 * drill), which is row 11's to add beside this leg.
 ********************************************************************/

const assert = require('assert')
const path = require('path')
const dotenv = require('dotenv')
dotenv.config()

const fixture = require('../helpers/barrierFamilyFixture')
const rows = require('../helpers/barrierFamilyRows')
const drive = require('../helpers/barrierFamilyDrive')

const BUILD_ROOT = path.resolve(__dirname, '..', '..', '..', '..')
const ARMED = 0
const PEER = 1
const TABLES = ['cross_chain_matches', 'cross_chain_calls', 'bridge_transfers', 'policy_snapshots', 'attestation_responses']
// The block must commit well inside the stamp: a bound far below 7200 s, and above the
// attest rail's height watermark window plus one barrier attempt.
const COMMIT_BUDGET_MS = 5 * 60 * 1000

describe('BF2: the fix, armed, the identical block on the identical mirror state', function () {
    this.timeout(Math.max(drive.LEG_FLOOR_MS, fixture.legTimeoutMs(600)))

    const ctx = { venue: null, btc: null, coin: 'BTC', B: null, block: null, seen: [], seeded: {}, expected: {}, read: {} }

    before(async function () {
        const up = await drive.bootFamilyVenue({ label: 'bf2', repoRoot: BUILD_ROOT, armed: [ARMED, PEER], armHubs: true })
        Object.assign(ctx, up, { coin: up.evidence.coinCode })
    })

    after(async function () {
        // A case that failed while the chain was held must not leave the miner paused.
        await drive.releaseChain(ctx.btc)
        if (ctx.venue) await ctx.venue.stop()
    })

    it('seeds per member: admitted at B, admitted past B, and legacy NULL where the armed apply cannot reach it', async function () {
        await seedAdmissionRows(ctx)
    })

    it('mines the +7200 block and watches the armed node commit it without a barrier reason', async function () {
        await mineAndWatch(ctx)
    })

    it('reads the same admitted set at B as the fixture computes from the hub rows', async function () {
        await assertReadSets(ctx)
    })
})

// B is the next height; the rows are stamped against it before it exists so the
// "admitted AT B" row is exactly at the boundary and the "past B" row is beyond it.
// The chain is held from here to the drill block (miner paused BEFORE the tip is read), or a
// block the adaptive miner lands in between takes height B and the drill block lands at B + 1.
async function seedAdmissionRows (ctx) {
    const held = await drive.holdBaseline(ctx.btc, ctx.venue, { label: 'bf2' })
    const tip = held.tip
    ctx.B = tip + 1
    const now = Math.floor(Date.now() / 1000)
    // Snapshot at B, not the reached tip: a fresh node's stake re-derivation rejects a synthetic capability row at a reached height.
    const base = { network: ctx.venue.network, coin: ctx.coin, effectiveTime: now, snapshotBlock: ctx.B }
    const members = rows.admissionSeedRows(TABLES, base, ctx.B, tip)
    // Refuse before seeding: a NULL-map row the armed apply canonicalizes stalls the drill block, not this case.
    assert.deepStrictEqual(rows.armedLegacyApplyHazards(members), [], 'BF2 would seed a legacy row the armed apply pass refuses')
    const seeds = [rows.inertRow('capability_snapshots', Object.assign({ tag: 'bf2|snap|' + tip }, base))].concat(members)
    await drive.seedMirrors(ctx.venue, seeds)
    ctx.seeded = {}
    for (const t of TABLES) {
        ctx.seeded[t] = members.filter((m) => m.table === t).length
        await drive.waitForMirrorRows(ctx.venue, ARMED, t, ctx.seeded[t])
    }
    await drive.waitForMirrorRows(ctx.venue, ARMED, 'capability_snapshots', 1)
    console.log('BF2 seeded ' + JSON.stringify(ctx.seeded) + ' rows per member table against B=' + ctx.B)
}

async function mineAndWatch (ctx) {
    await drive.assertChainHeld(ctx.btc, ctx.B - 1, 'the BTC chain, before the drill block,')
    const wall = Math.floor(Date.now() / 1000)
    // Resumes the miner: the hold ends with the drill block.
    ctx.block = await drive.mineStamped(ctx.btc, wall + drive.STAMP_AHEAD_S)
    assert.strictEqual(ctx.block.height, ctx.B, 'the drill block landed at ' + ctx.block.height + ', not the seeded B=' + ctx.B)
    assert.ok(ctx.block.blockTime >= wall + drive.STAMP_AHEAD_S - 1, 'the block is stamped ' + ctx.block.blockTime + ', not +' + drive.STAMP_AHEAD_S)
    const started = Date.now()
    const got = await drive.waitForStatus(ctx.venue, ARMED, (s) => {
        if (s.height === ctx.B - 1 && s.stallReason) ctx.seen.push({ at: Date.now() - started, reason: s.stallReason, stallClass: s.stallClass })
        return s.height !== null && s.height >= ctx.B
    }, COMMIT_BUDGET_MS)
    const heights = got.s && got.s.heights
    console.log('BF2 armed node: ' + JSON.stringify(got.s) + '; reasons seen while on B-1: ' + JSON.stringify(ctx.seen))
    assert.ok(got.ok, 'the armed node did not commit the +' + drive.STAMP_AHEAD_S + ' block inside ' + COMMIT_BUDGET_MS +
        ' ms: ' + JSON.stringify(got.s) + '\n' + ctx.venue.logTail('indexer' + ARMED))
    const barriers = ctx.seen.filter((x) => /_barrier$/.test(String(x.reason)))
    assert.deepStrictEqual(barriers, [], 'a barrier reason appeared for block ' + ctx.B + ' on the armed node: ' + JSON.stringify(barriers))
    assert.strictEqual(got.s.stallClass, 'none', 'stallClass after the commit is ' + got.s.stallClass)
    assert.ok(heights && Object.keys(heights).length > 0, 'the hub published no heights map; the consumer bound on nothing')
    assert.ok(Date.now() - started < drive.STAMP_AHEAD_S * 1000, 'the commit waited out the stamp')
}

// The expected set is computed by the FIXTURE over the hub's rows (independent of the
// indexer); the read set is the mirror's under the IS NULL OR rule. Both must contain the
// at-B row, and the legacy row where one was seeded, and exclude the past-B row, per table.
async function assertReadSets (ctx) {
    const hub = ctx.venue.indexers[ARMED].followsHub
    for (const t of TABLES) {
        const keyCol = rows.NATURAL_KEYS[t][0]
        const hubRows = await drive.hubRows(ctx.venue, hub, t)
        ctx.expected[t] = fixture.admittedRowSet(hubRows, t, ctx.coin, ctx.B, ctx.block.blockTime, (r) => String(r[keyCol]))
        ctx.read[t] = await drive.mirrorReadableSet(ctx.venue, ARMED, t, ctx.coin, ctx.B, ctx.block.blockTime)
        assert.deepStrictEqual(ctx.read[t], ctx.expected[t], t + ': the mirror reads ' + JSON.stringify(ctx.read[t]) +
            ' at B=' + ctx.B + ' while the hub rows admit ' + JSON.stringify(ctx.expected[t]))
        // The past-B row is the one seeded row not admitted at B.
        const want = ctx.seeded[t] - 1
        assert.strictEqual(ctx.expected[t].length, want, t + ': expected the at-B row' + (want > 1 ? ' and the legacy row' : '') +
            ', got ' + ctx.expected[t].length + ' of ' + hubRows.length + ' hub rows')
        const col = fixture.admissionColumn(t, ctx.coin)
        const past = hubRows.filter((r) => Number(r[col]) === ctx.B + 3).map((r) => String(r[keyCol]))
        assert.strictEqual(past.length, 1, t + ': the past-B row is missing on the hub')
        assert.ok(!ctx.read[t].includes(past[0]), t + ': the past-B row was read at B')
    }
    console.log('BF2 read sets at B=' + ctx.B + ': ' + JSON.stringify(ctx.read))
}
