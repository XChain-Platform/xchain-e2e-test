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
 * hold vacuously. The leg seeds one row admitted AT B, one admitted past B and one
 * LEGACY NULL row per member table, and compares the set the armed node's mirror
 * reads at B (the section 5.5 rule in its IS NULL OR SQL form) against the fixture's
 * independently computed expected set over the hub's own rows.
 *
 * A LEGACY ROW IN EVERY MEMBER TABLE, BECAUSE THE VENUE ARMS AT A CROSSING. This leg
 * used to skip bridge_transfers and policy_snapshots: armed at height 0 every block is
 * admission era, so a NULL-map seed was a modern row missing its mandatory map, those
 * two apply passes build the canonical before reading the capability set, and the
 * builder's refusal stalled the drill block (rail 2026-09-17, block 104). The refusal
 * was the product working (adjudicated 2026-09-18): the canonical builder refuses a NULL
 * admission map on any row whose era block is at or above the producer activation. The
 * leg now arms producers and consumers at the chain's tip + 1 and seeds its legacy rows
 * below that height,
 * where a NULL map is what a pre-crossing hub really wrote and the builder returns an
 * empty canonical tail, so every member table carries one. The legacy rule is BF4's.
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
// Every height-keyed member an EMPTY BTC drill block evaluates (members 1 to 3 run only on a block
// with transactions): the seeded tables plus the anchor-reward attestation rail, which holds no row
// here but still needs its published height before B can pass on first evaluation.
const HEIGHT_TABLES = TABLES.concat(['anchor_reward_attestations'])
// The block must commit well inside the stamp: a bound far below 7200 s, and above the
// attest rail's height watermark window plus one barrier attempt.
const COMMIT_BUDGET_MS = 5 * 60 * 1000

function renderEvidence (value) {
    try {
        const rendered = JSON.stringify(value, (key, item) => typeof item === 'bigint' ? item.toString() : item)
        return rendered === undefined ? String(value) : rendered
    } catch (error) {
        return '[unprintable: ' + (error && error.message ? error.message : String(error)) + ']'
    }
}

function assertionMessage (expected, found, next) {
    return 'expected ' + expected + '; found ' + renderEvidence(found) + '; inspect ' + next
}

function deferralNote (venue, indexer) {
    const which = 'indexer' + indexer
    try {
        const tail = String(venue.logTail(which) || '')
        if (!tail || /\blast 0 line\(s\) from\b/.test(tail)) {
            return 'log tail unavailable: ' + which + ' has not written any lines yet'
        }
        const lines = tail.split(/\r?\n/).filter((line) => /Deferring block /.test(line))
        if (lines.length) return 'latest deferral from ' + which + ': ' + lines[lines.length - 1].trim()
        return 'deferral evidence unavailable: no matching line in the available ' + which + ' log tail'
    } catch (error) {
        return 'log tail unavailable: ' + (error && error.message ? error.message : String(error))
    }
}

describe('BF2: the fix, armed, the identical block on the identical mirror state', function () {
    this.timeout(Math.max(drive.LEG_FLOOR_MS, fixture.legTimeoutMs(600)))

    const ctx = { venue: null, btc: null, coin: 'BTC', B: null, block: null, armHeight: null, legacyBlock: null,
                  seen: [], seeded: {}, expected: {}, read: {} }

    before(async function () {
        const up = await drive.bootFamilyVenue({ label: 'bf2', repoRoot: BUILD_ROOT, armed: [ARMED, PEER], armHubs: true, armAtCrossing: true })
        Object.assign(ctx, up, { coin: up.evidence.coinCode })
        console.log('BF2 armed at ' + ctx.armHeight + ', legacy era block ' + ctx.legacyBlock)
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
    // The crossing, asserted before anything is seeded: both eras exist on this one venue.
    assert.strictEqual(ctx.legacyBlock, fixture.legacyEraBlock(ctx.armHeight),
        assertionMessage('legacyBlock=' + fixture.legacyEraBlock(ctx.armHeight), 'legacyBlock=' + ctx.legacyBlock, 'the BF2 activation setup'))
    assert.ok(ctx.legacyBlock < ctx.armHeight,
        assertionMessage('legacyBlock below armHeight', { legacyBlock: ctx.legacyBlock, armHeight: ctx.armHeight }, 'the BF2 legacy seed era'))
    assert.ok(ctx.armHeight <= ctx.B,
        assertionMessage('armHeight at or below B', { armHeight: ctx.armHeight, B: ctx.B }, 'the BF2 crossing height'))
    const members = rows.admissionSeedRows(TABLES, base, ctx.B, tip, ctx.legacyBlock)
    // Refuse before seeding: a NULL-map row at or above the activation stalls the drill block, not this case.
    const hazards = rows.armedLegacyApplyHazards(members, ctx.armHeight)
    assert.deepStrictEqual(hazards, [], assertionMessage('no armed legacy apply hazards', hazards, 'the BF2 member seeds'))
    const seeds = [rows.inertRow('capability_snapshots', Object.assign({ tag: 'bf2|snap|' + tip }, base))].concat(members)
    await drive.seedMirrors(ctx.venue, seeds)
    ctx.seeded = {}
    for (const t of TABLES) {
        ctx.seeded[t] = members.filter((m) => m.table === t).length
        await drive.waitForMirrorRows(ctx.venue, ARMED, t, ctx.seeded[t])
    }
    await drive.waitForMirrorRows(ctx.venue, ARMED, 'capability_snapshots', 1)
    console.log('BF2 seeded ' + JSON.stringify(ctx.seeded) + ' rows per member table against B=' + ctx.B +
                ', activation ' + ctx.armHeight + ', legacy era block ' + ctx.legacyBlock)
}

async function mineAndWatch (ctx) {
    await drive.assertChainHeld(ctx.btc, ctx.B - 1, 'the BTC chain, before the drill block,')
    // "The identical mirror state" includes the hub's published heights. Without this wait the
    // block was mined before the hub published anchor_reward_attestations at all, and the armed
    // node deferred it once under anchor_attest_barrier (rail 2026-09-17, block 104, 62 s on).
    // The chain is held at B-1 through this wait, so wait at the height a held chain can
    // actually publish (drive.waitForHeldAdmissionHeights), not the plain B - margin line.
    const ready = await drive.waitForHeldAdmissionHeights(ctx.venue, ARMED, HEIGHT_TABLES, ctx.coin, ctx.B)
    console.log('BF2 heights before mining B=' + ctx.B + ': ' + JSON.stringify(ready.heights))
    await drive.assertChainHeld(ctx.btc, ctx.B - 1, 'the BTC chain, across the admission-height wait,')
    const wall = Math.floor(Date.now() / 1000)
    // Resumes the miner: the hold ends with the drill block.
    ctx.block = await drive.mineStamped(ctx.btc, wall + drive.STAMP_AHEAD_S)
    assert.strictEqual(ctx.block.height, ctx.B,
        assertionMessage('drill block height B=' + ctx.B, 'block height=' + ctx.block.height, 'the BF2 mined block'))
    assert.ok(ctx.block.blockTime >= wall + drive.STAMP_AHEAD_S - 1,
        assertionMessage('blockTime at least ' + (wall + drive.STAMP_AHEAD_S - 1), 'blockTime=' + ctx.block.blockTime, 'the BF2 block stamp'))
    const started = Date.now()
    const got = await drive.waitForStatus(ctx.venue, ARMED, (s) => {
        if (s.height === ctx.B - 1 && s.stallReason) ctx.seen.push({ at: Date.now() - started, reason: s.stallReason, stallClass: s.stallClass })
        return s.height !== null && s.height >= ctx.B
    }, COMMIT_BUDGET_MS)
    const heights = got.s && got.s.heights
    console.log('BF2 armed node: ' + JSON.stringify(got.s) + '; reasons seen while on B-1: ' + JSON.stringify(ctx.seen))
    assert.ok(got.ok, assertionMessage('armed node commit of block ' + ctx.B + ' inside ' + COMMIT_BUDGET_MS + ' ms',
        { ok: got.ok, status: got.s }, 'the armed indexer evidence: ' + deferralNote(ctx.venue, ARMED)))
    const barriers = ctx.seen.filter((x) => /_barrier$/.test(String(x.reason)))
    assert.deepStrictEqual(barriers, [], assertionMessage('no barrier reasons for block ' + ctx.B, barriers, 'the BF2 status samples'))
    assert.strictEqual(got.s.stallClass, 'none', assertionMessage('stallClass="none" after commit', got.s.stallClass, 'the BF2 final status'))
    assert.ok(heights && Object.keys(heights).length > 0,
        assertionMessage('a non-empty hub heights map', heights, 'the BF2 final status hubMirror.heights'))
    assert.ok(Date.now() - started < drive.STAMP_AHEAD_S * 1000,
        assertionMessage('commit latency below ' + (drive.STAMP_AHEAD_S * 1000) + ' ms', (Date.now() - started) + ' ms', 'the BF2 commit timer'))
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
        assert.deepStrictEqual(ctx.read[t], ctx.expected[t],
            assertionMessage(t + ' mirror read set ' + renderEvidence(ctx.expected[t]), ctx.read[t], 'the BF2 ' + t + ' rows at B=' + ctx.B))
        // The past-B row is the one seeded row not admitted at B.
        const want = ctx.seeded[t] - 1
        assert.strictEqual(ctx.expected[t].length, want,
            assertionMessage(t + ' admitted row count=' + want, ctx.expected[t].length, 'the BF2 ' + t + ' hub rows, total=' + hubRows.length))
        const col = fixture.admissionColumn(t, ctx.coin)
        const past = hubRows.filter((r) => Number(r[col]) === ctx.B + 3).map((r) => String(r[keyCol]))
        assert.strictEqual(past.length, 1,
            assertionMessage(t + ' past-B hub row count=1', past.length, 'the BF2 ' + t + ' hub rows'))
        assert.ok(!ctx.read[t].includes(past[0]),
            assertionMessage(t + ' past-B key excluded at B=' + ctx.B, ctx.read[t], 'the BF2 ' + t + ' mirror read set'))
    }
    console.log('BF2 read sets at B=' + ctx.B + ': ' + JSON.stringify(ctx.read))
}
