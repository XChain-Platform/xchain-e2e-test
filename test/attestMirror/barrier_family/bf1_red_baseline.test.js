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
 * BF1 (family section 7): the RED baseline, and the family ENUMERATED from the
 * running node. Activation INERT on every child.
 *
 * Two indexers on one venue, two blocks mined back to back, one observation loop:
 *
 *   THE WALKER (indexer 0) carries a grace LADDER, each graced member one step
 *   above the member before it in loop order, and mines a block stamped a little
 *   ahead of the hub's clock. The members then open one at a time as the hub's
 *   watermark climbs, and `/status` names each in turn: that is the enumeration,
 *   read off the node rather than off a table in this file. The ungraced ninth
 *   member (snapshot) is reached by withholding the capability snapshot on the
 *   walker's mirror edge alone, so it names itself last. Every member's mirror
 *   holds one inert finalized row, which is what closes the empty-mirror escape
 *   (family section 2) and makes members 3 to 7 reachable at all; the walker's
 *   block carries one transaction so members 1 and 2 run.
 *
 *   THE INERT NODE (indexer 1, every grace 0) meets the +7200 block: the four
 *   surface values of the baseline, and the block still uncommitted after three
 *   60 s barrier cycles printing the identical timed-out line.
 *
 * The federation is held QUIET: nothing here finalizes a row, and the leg proves
 * no row effective at or past t(B) landed, or the content escapes (dead only for
 * the first 3600 s) would make the hold shorter than the design promises.
 ********************************************************************/

const assert = require('assert')
const path = require('path')
const dotenv = require('dotenv')
dotenv.config()

const { gracedBarrierReason } = require('../../helpers/attestMirrorVenue')
const fixture = require('../helpers/barrierFamilyFixture')
const rows = require('../helpers/barrierFamilyRows')
const drive = require('../helpers/barrierFamilyDrive')

// The isolated build root this leg lives in, passed explicitly (B4).
const BUILD_ROOT = path.resolve(__dirname, '..', '..', '..', '..')

const WALKER = 0
const INERT = 1
const LADDER_STEP_S = Number(process.env.BF1_LADDER_STEP_S || 90)
// The walker's block sits this far ahead of the hub's clock: long enough that no content
// escape can open before the ladder's first rung, short enough that the walk is bounded.
const WALK_AHEAD_S = 4 * LADDER_STEP_S
const LADDER = rows.graceLadder(LADDER_STEP_S)
const SEED_TABLES = ['cross_chain_matches', 'cross_chain_calls', 'bridge_transfers', 'policy_snapshots', 'attestation_responses']

describe('BF1: the RED baseline, and the family enumerated from the running node', function () {
    this.timeout(Math.max(drive.LEG_FLOOR_MS, fixture.legTimeoutMs(WALK_AHEAD_S + (10 * LADDER_STEP_S))))

    const ctx = { venue: null, btc: null, coin: 'BTC', blocks: {}, walk: [], red: null, baseline: null, markerAddress: null }

    before(async function () {
        const up = await drive.bootFamilyVenue({
            label: 'bf1', repoRoot: BUILD_ROOT, indexerGraces: { [WALKER]: LADDER },
        })
        Object.assign(ctx, up, { coin: up.evidence.coinCode })
        console.log('BF1 ladder on indexer ' + WALKER + ': ' + JSON.stringify(LADDER))
    })

    after(async function () {
        // The miner is resumed first and unconditionally: a case that failed between the
        // held baseline and the walker block must not hand the next leg a paused chain.
        await drive.releaseChain(ctx.btc)
        if (!ctx.venue) return
        try { ctx.venue.releaseMirrorTable(WALKER, 'capability_snapshots') } catch (_) { /* never armed */ }
        await ctx.venue.stop()
    })

    it('closes every empty-mirror escape with one inert finalized row per member', async function () {
        await seedFamily(ctx)
    })

    it('mines the walker block and the +7200 block, reading both stamps back', async function () {
        await mineBoth(ctx)
    })

    it('records both indexers until the walker reaches the snapshot member', async function () {
        await observeBoth(ctx)
    })

    it('holds the +7200 block in future_block_wait with the identical timed-out line', function () {
        assertRedBaseline(ctx)
    })

    it('names the nine reachable reasons in loop order, one string for members 1 and 2', function () {
        assertEnumeration(ctx)
    })
})

// One inert row per member table, plus the capability snapshot the match and call rows
// point at. The snapshot is withheld from the WALKER first, so the ninth member holds
// there and nowhere else; the inert node receives it and stays clear of that member.
//
// THE CHAIN IS HELD STILL BEFORE ANYTHING IS ARMED. The snapshot member is content-keyed
// and runs on EVERY block, so once the rows are seeded and the snapshot withheld, the first
// block the walker meets that is stamped at or past the seed time parks it there forever.
// That must be the walker block and nothing earlier: a block the adaptive miner lands, or the
// two the marker's funding mines, would take the ladder and the snapshot stall first, and the
// walker would never stand on walker block - 1 (six red drives on 2026-09-17, "last []").
// So: fund the marker while the miner runs, pause the miner, read the tip, let both indexers
// commit it through the ladder, and only then withhold and seed.
async function seedFamily (ctx) {
    const held = await drive.holdBaseline(ctx.btc, ctx.venue, {
        label: 'bf1',
        graces: LADDER,
        beforeHold: () => drive.fundMarkerAddress(ctx.btc, 'BF1'),
    })
    ctx.baseline = held
    ctx.markerAddress = held.before
    const tip = held.tip
    const now = Math.floor(Date.now() / 1000)
    // Snapshot at the drill height, not the reached tip: a fresh node's stake re-derivation rejects a synthetic capability row at a reached height.
    const spec = { network: ctx.venue.network, coin: ctx.coin, effectiveTime: now, snapshotBlock: tip + 1, tag: 'bf1|' + tip }
    ctx.venue.withholdMirrorTable(WALKER, 'capability_snapshots')
    await drive.seedMirrors(ctx.venue, [rows.inertRow('capability_snapshots', spec)])
    await drive.seedMirrors(ctx.venue, rows.familySeedRows(spec))
    for (const t of SEED_TABLES) {
        await drive.waitForMirrorRows(ctx.venue, INERT, t, 1)
        await drive.waitForMirrorRows(ctx.venue, WALKER, t, 1)
    }
    await drive.waitForMirrorRows(ctx.venue, INERT, 'capability_snapshots', 1)
    await drive.assertChainHeld(ctx.btc, tip, 'the BTC chain, across the seed,')
    ctx.seedTime = now
    console.log('BF1 seeded one finalized row per member at effective_time ' + now + ', snapshot_block ' + tip)
}

async function mineBoth (ctx) {
    assert.ok(ctx.baseline && ctx.markerAddress, 'the held baseline and the funded marker address come from the seed case')
    // The marker is broadcast with mining still paused (the address was funded before the
    // hold), so it lands in the walker block and that block reads price. The walker block is
    // the first block after the held baseline, which is what observeBoth keys on.
    await drive.assertChainHeld(ctx.btc, ctx.baseline.tip, 'the BTC chain, before the walker block,')
    const marker = await drive.broadcastMarker(ctx.btc, ctx.markerAddress, 'BF1')
    const wall = Math.floor(Date.now() / 1000)
    // This mineStamped resumes the miner: the hold ends here. A block landing between the
    // walker block and the red block is harmless, because the walker is already parked on
    // the walker block and the red block's height is read back, never assumed.
    const walk = await drive.mineStamped(ctx.btc, wall + WALK_AHEAD_S)
    assert.strictEqual(walk.height, ctx.baseline.tip + 1, 'the walker block landed at ' + walk.height + ', not on the held baseline ' + ctx.baseline.tip)
    const red = await drive.mineStamped(ctx.btc, wall + drive.STAMP_AHEAD_S)
    // Never the pin, always the stamp read back: a pin BEHIND is silent and a pin AHEAD
    // wedges the miner, so a leg that trusted the call could assert against a stamp that
    // never landed.
    assert.ok(walk.blockTime >= wall + WALK_AHEAD_S - 1, 'the walker block is stamped ' + walk.blockTime + ', not ahead of ' + wall)
    assert.ok(red.blockTime >= wall + drive.STAMP_AHEAD_S - 1, 'the red block is stamped ' + red.blockTime + ', not +' + drive.STAMP_AHEAD_S)
    ctx.blocks = { walk, red, marker }
    console.log('BF1 blocks: walker ' + JSON.stringify(walk) + ', red ' + JSON.stringify(red) + ', marker tx ' + marker.txid)
}

// One loop, both nodes: the walker's reason sequence and, once the inert node is on the
// red block, its snapshot plus the count of identical timed-out lines. Ends when the walker
// has reached the snapshot member and the inert node has printed three identical lines.
async function observeBoth (ctx) {
    const deadline = Date.now() + fixture.legTimeoutMs(WALK_AHEAD_S + (10 * LADDER_STEP_S), { bootS: 0, slackS: 0 })
    const walkReason = () => ctx.walk.length ? ctx.walk[ctx.walk.length - 1].stallReason : null
    let redDone = false
    while (Date.now() < deadline) {
        const w = await drive.statusSnapshot(ctx.venue, WALKER)
        if (w.stallReason && w.height === ctx.blocks.walk.height - 1) {
            ctx.walk.push({ at: Date.now(), stallReason: w.stallReason, stallClass: w.stallClass, stallClearsAt: w.stallClearsAt })
        }
        const r = await drive.statusSnapshot(ctx.venue, INERT)
        if (!redDone && r.height === ctx.blocks.red.height - 1 && r.stallReason) {
            const lines = rows.timedOutLines(ctx.venue.logTail('indexer' + INERT), ctx.blocks.red.height)
            ctx.red = Object.assign({ lines }, r)
            redDone = lines.identical >= 3
        }
        if (redDone && walkReason() === 'snapshot_sync_barrier') break
        await new Promise((res) => setTimeout(res, drive.POLL_MS))
    }
    await drive.assertFederationQuiet(ctx.venue, ctx.venue.indexers[INERT].followsHub, ctx.coin, ctx.blocks.walk.blockTime, SEED_TABLES)
    console.log('BF1 walk: ' + JSON.stringify(rows.distinctRuns(ctx.walk.map((x) => x.stallReason))) + '; red: ' + JSON.stringify(ctx.red))
    assert.ok(redDone, 'the inert node never printed three identical timed-out lines for block ' + ctx.blocks.red.height + ': ' +
        JSON.stringify(ctx.red) + '\n' + ctx.venue.logTail('indexer' + INERT))
    assert.strictEqual(walkReason(), 'snapshot_sync_barrier', 'the walker never reached the snapshot member; last ' +
        JSON.stringify(ctx.walk.slice(-3)) + '\n' + ctx.venue.logTail('indexer' + WALKER))
    ctx.venue.releaseMirrorTable(WALKER, 'capability_snapshots')
}

// The four surface values plus the re-arm the "no bound" claim rests on. The first member
// an EMPTY block can reach is match (members 1 to 3 run only on a block with transactions),
// and its grace on the inert node is 0, so the deadline is the stamp itself.
function assertRedBaseline (ctx) {
    const r = ctx.red
    assert.ok(r, 'no observation of the inert node on the red block')
    assert.strictEqual(r.stallClass, 'future_block_wait', 'stallClass ' + r.stallClass + ' (want future_block_wait): ' + JSON.stringify(r))
    assert.strictEqual(r.atProcessableTip, true, 'atProcessableTip ' + r.atProcessableTip + ': the verdict that says healthy while two hours behind')
    assert.strictEqual(r.stallReason, 'match_sync_barrier', 'the first reachable member of an empty block is match, got ' + r.stallReason)
    assert.strictEqual(r.stallClearsAt, (ctx.blocks.red.blockTime + 0) * 1000,
        'stallClearsAt ' + r.stallClearsAt + ' is not (block_time + grace 0) * 1000 = ' + (ctx.blocks.red.blockTime * 1000))
    assert.strictEqual(r.height, ctx.blocks.red.height - 1, 'the red block committed: height ' + r.height)
    assert.ok(r.lines.identical >= 3, 'fewer than three identical timed-out lines: ' + JSON.stringify(r.lines))
}

// The nine reachable reasons in loop order, from the node. Each graced member's deadline
// is the stamp plus ITS rung of the ladder, which is the "grace per member" the venue
// promises (D34); price carries no per-member deadline on the height case, so only its
// name is asserted, and the snapshot member is content-keyed (null deadline).
function assertEnumeration (ctx) {
    const seen = rows.distinctRuns(ctx.walk.map((x) => x.stallReason))
    assert.deepStrictEqual(seen, fixture.FAMILY_REASONS_LOOP_ORDER.slice(),
        'the walker named ' + JSON.stringify(seen) + ' rather than the nine reasons in loop order')
    assert.ok(rows.inLoopOrder(seen), 'the sequence is not in block-loop order')
    assert.strictEqual(new Set(fixture.mirrorBarrierReasons()).size, 9, 'the indexer source no longer carries nine reasons')
    const ladderByReason = {}
    for (const key of Object.keys(LADDER)) ladderByReason[gracedBarrierReason(key)] = LADDER[key]
    for (const obs of ctx.walk) {
        if (obs.stallReason === 'price_sync_barrier' || obs.stallReason === 'snapshot_sync_barrier') continue
        assert.strictEqual(obs.stallClass, 'future_block_wait', obs.stallReason + ' reported ' + obs.stallClass)
        assert.strictEqual(obs.stallClearsAt, (ctx.blocks.walk.blockTime + ladderByReason[obs.stallReason]) * 1000,
            obs.stallReason + ' clears at ' + obs.stallClearsAt + ', not stamp + its own grace ' + ladderByReason[obs.stallReason])
    }
    const snapshot = ctx.walk.filter((x) => x.stallReason === 'snapshot_sync_barrier')
    assert.ok(snapshot.every((x) => x.stallClearsAt === null), 'the snapshot member reported a clock deadline')
}
