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
 * BF3 (family section 7): the bound is real. Activation ARMED, the proxy pinning
 * one indexer's `heights[cross_chain_matches][BTC]` at `B - 4 - 1` (that member's
 * OWN margin, from the fixture) while rows and `ts` keep flowing.
 *
 * Expected: the block defers under `match_sync_barrier` with `stallClass`
 * 'barrier_defer' (NOT future_block_wait: a height-keyed member has no clock
 * instant, so `stallClearsAt` is null), a hold accumulating on `/health` and
 * crossing the 900 s ceiling into ONE forced resync, and no commit. Release the
 * pin: the node commits.
 *
 * THE THIRD CASE rides the same pin: `ts` flows while `heights` freezes, and the
 * height dimension the mirror's stall verdict gained (heightShortfalls,
 * heightsFrozenMs beside watermarkFrozenMs) is asserted to fire, which the
 * seconds-only verdict cannot see.
 *
 * FALSIFICATIONS (row 11, main-loop serial, never here): short-circuit the height
 * comparison to true and the node commits inside the pinned window (RED); run this
 * leg with BF3_ARMED=0 and the node reports future_block_wait with no hold (RED).
 ********************************************************************/

const assert = require('assert')
const path = require('path')
const dotenv = require('dotenv')
dotenv.config()

const fixture = require('../helpers/barrierFamilyFixture')
const rows = require('../helpers/barrierFamilyRows')
const drive = require('../helpers/barrierFamilyDrive')
const { diffStateHashes } = require('../mirrorDrillWaits')

const BUILD_ROOT = path.resolve(__dirname, '..', '..', '..', '..')
const PINNED = 0
const PEER = 1
const TABLE = 'cross_chain_matches'
const REASON = 'match_sync_barrier'
const ARMED_RUN = process.env.BF3_ARMED !== '0'
// The hold must cross the ceiling: the ceiling, one more barrier cycle, and slack.
const CEILING_WAIT_MS = (fixture.HOLD_CEILING_S + (2 * fixture.BARRIER_CYCLE_S) + 120) * 1000
// How long the pinned heights map must read frozen while ts flows. Read BEFORE the ceiling
// (the resync resets the age) and waited for, so the height dimension has had two minutes to fire.
const FROZEN_MIN_MS = 2 * 60 * 1000

describe('BF3: the bound is real, a pinned height holds one member and only that member', function () {
    this.timeout(Math.max(drive.LEG_FLOOR_MS, fixture.legTimeoutMs(fixture.HOLD_CEILING_S + 600)))

    const ctx = { venue: null, btc: null, coin: 'BTC', B: null, block: null, pin: null, held: null, hold: null }

    before(async function () {
        const up = await drive.bootFamilyVenue({
            label: 'bf3', repoRoot: BUILD_ROOT, armed: ARMED_RUN ? [PINNED, PEER] : [], armHubs: ARMED_RUN,
        })
        Object.assign(ctx, up, { coin: up.evidence.coinCode })
    })

    after(async function () {
        // A case that failed while the chain was held must not leave the miner paused.
        await drive.releaseChain(ctx.btc)
        if (!ctx.venue) return
        try { ctx.venue.releaseMirrorHeights(PINNED) } catch (_) { /* never armed */ }
        await ctx.venue.stop()
    })

    it('seeds one finalized match for this coin and pins the height below the member\'s line', async function () {
        await seedAndPin(ctx)
    })

    it('defers under the member\'s own reason as barrier_defer with a null deadline', async function () {
        await assertDeferred(ctx)
    })

    // Before the ceiling case, not after: the forced resync reconnects the mirror and resets
    // heightsFrozenMs, so a read after it sampled 555 ms (rail 2026-09-17, bf3-height-age-red).
    it('fires the height dimension of the stall verdict while ts keeps flowing', async function () {
        await assertHeightDimension(ctx)
    })

    it('accumulates a hold across the 900 s ceiling into one forced resync, and never commits', async function () {
        await assertHoldAndCeiling(ctx)
    })

    it('commits once the pin is released', async function () {
        await assertReleaseCommits(ctx)
    })
})

// The chain is held from the tip read to the drill block (miner paused BEFORE the read), so the
// pin sized for B is sized for the block this case actually mines.
async function seedAndPin (ctx) {
    const held = await drive.holdBaseline(ctx.btc, ctx.venue, { label: 'bf3' })
    const tip = held.tip
    ctx.B = tip + 1
    const now = Math.floor(Date.now() / 1000)
    // Snapshot at B, not the reached tip: a fresh node's stake re-derivation rejects a synthetic capability row at a reached height.
    const base = { network: ctx.venue.network, coin: ctx.coin, effectiveTime: now, snapshotBlock: ctx.B }
    await drive.seedMirrors(ctx.venue, [
        rows.inertRow('capability_snapshots', Object.assign({ tag: 'bf3|snap|' + tip }, base)),
        rows.inertRow(TABLE, Object.assign({ tag: 'bf3|match|' + tip, admitBlocks: { BTC: ctx.B } }, base)),
    ])
    await drive.waitForMirrorRows(ctx.venue, PINNED, TABLE, 1)
    await drive.waitForMirrorRows(ctx.venue, PEER, TABLE, 1)
    ctx.pin = { [TABLE]: { BTC: fixture.pinnedHeightFor(TABLE, ctx.B) } }
    ctx.venue.pinMirrorHeights(PINNED, ctx.pin)
    // The pin must be seen on a live carrier BEFORE the block, so a reconnect cannot
    // re-read the true height; the drop forces the ready frame and a snapshot page through it.
    ctx.venue.indexers[PINNED].mirrorProxy.dropSockets()
    await drive.assertChainHeld(ctx.btc, tip, 'the BTC chain, before the drill block,')
    const wall = Math.floor(Date.now() / 1000)
    // Resumes the miner: the hold ends with the drill block.
    ctx.block = await drive.mineStamped(ctx.btc, wall + drive.STAMP_AHEAD_S)
    assert.strictEqual(ctx.block.height, ctx.B, 'the drill block landed at ' + ctx.block.height + ', not B=' + ctx.B)
    console.log('BF3 pinned ' + JSON.stringify(ctx.pin) + ' on indexer ' + PINNED + ' for B=' + ctx.B + ' stamped ' + ctx.block.blockTime)
}

async function assertDeferred (ctx) {
    const got = await drive.waitForStatus(ctx.venue, PINNED, (s) => s.height === ctx.B - 1 && s.stallReason === REASON, 8 * 60 * 1000)
    assert.ok(got.ok, 'indexer ' + PINNED + ' never reported ' + REASON + ' on block ' + ctx.B + ': ' + JSON.stringify(got.s) +
        '\n' + ctx.venue.logTail('indexer' + PINNED))
    ctx.held = got.s
    const stats = ctx.venue.assertMirrorHeightPinObserved(PINNED, { carriers: ['watermark', 'snapshot'] })
    console.log('BF3 held: ' + JSON.stringify(ctx.held) + '; pin stats ' + JSON.stringify(stats))
    assert.strictEqual(ctx.held.stallClass, 'barrier_defer', 'stallClass ' + ctx.held.stallClass + ' (a height-keyed member is never future_block_wait)')
    assert.strictEqual(ctx.held.stallClearsAt, null, 'stallClearsAt ' + ctx.held.stallClearsAt + ' on a member with no clock instant')
    assert.strictEqual(ctx.held.heights[TABLE][ctx.coin], ctx.pin[TABLE].BTC, 'the node reads a height other than the pin')
    // The peer, unpinned, commits the same block: the hold is edge-scoped and the bound
    // is what holds, not the stamp.
    const peer = await drive.waitCommitted(ctx.venue, PEER, ctx.B, 8 * 60 * 1000)
    assert.ok(peer.ok, 'the unpinned peer did not commit block ' + ctx.B + ': ' + JSON.stringify(peer.s))
}

async function assertHeightDimension (ctx) {
    // The member's line is B - margin, one above the pinned height.
    const target = fixture.pinnedHeightFor(TABLE, ctx.B) + 1
    // Waited for rather than sampled once: this case now runs before the ceiling, so the heights
    // map may not have been frozen FROZEN_MIN_MS yet when it starts (rail 2026-09-17: 121448 ms frozen, ts 1413 ms).
    const got = await drive.waitForStatus(ctx.venue, PINNED, (s) =>
        s.heightShortfalls && s.heightShortfalls[TABLE + '|' + ctx.coin] === target &&
        Number(s.heightsFrozenMs) >= FROZEN_MIN_MS && Number(s.watermarkFrozenMs) < 60000, 5 * 60 * 1000)
    assert.ok(got.ok, 'the height dimension did not stay frozen while ts flowed: ' + JSON.stringify(got.s))
    const s = got.s
    console.log('BF3 height dimension: ' + JSON.stringify({ shortfalls: s.heightShortfalls, heightsFrozenMs: s.heightsFrozenMs, watermarkFrozenMs: s.watermarkFrozenMs }))
    assert.ok(s.heightShortfalls && s.heightShortfalls[TABLE + '|' + ctx.coin] === target,
        'heightShortfalls does not name ' + TABLE + '|' + ctx.coin + ' at ' + target + ': ' + JSON.stringify(s.heightShortfalls))
    assert.ok(Number(s.heightsFrozenMs) >= FROZEN_MIN_MS, 'the heights map is not reported frozen: ' + s.heightsFrozenMs)
    assert.ok(Number(s.watermarkFrozenMs) < 60000, 'ts stopped flowing (' + s.watermarkFrozenMs + ' ms), so the stall is not the height dimension alone')
    assert.strictEqual(s.height, ctx.B - 1, 'the block committed under the pin')
}

async function assertHoldAndCeiling (ctx) {
    const first = await drive.holdSnapshot(ctx.venue, PINNED)
    assert.strictEqual(first.barrierHoldBlock, ctx.B, 'the hold is not on block ' + ctx.B + ': ' + JSON.stringify(first))
    const crossed = await waitForCeiling(ctx, first)
    console.log('BF3 hold: first ' + JSON.stringify(first) + ', crossed ' + JSON.stringify(crossed))
    assert.ok(crossed.barrierHoldMs > first.barrierHoldMs, 'the hold did not accumulate')
    assert.ok(crossed.barrierHoldMs >= fixture.HOLD_CEILING_S * 1000, 'the hold never reached the ' + fixture.HOLD_CEILING_S + ' s ceiling')
    assert.strictEqual(crossed.barrierCeilingHits, 1, 'ceiling hits ' + crossed.barrierCeilingHits + ' (want exactly one crossing for one held block)')
    const tail = ctx.venue.logTail('indexer' + PINNED)
    assert.ok(/Mirror-barrier hold ceiling reached: block \d+ has been held at match_sync_barrier/.test(tail), 'no ceiling line in the log')
    assert.ok(/forcing a mirror resync/i.test(tail), 'no forced resync in the log')
    const s = await drive.statusSnapshot(ctx.venue, PINNED)
    assert.strictEqual(s.height, ctx.B - 1, 'the block committed under the pin after the resync: a resync must open nothing')
    ctx.hold = crossed
}

async function waitForCeiling (ctx, first) {
    const deadline = Date.now() + CEILING_WAIT_MS
    let last = first
    while (Date.now() < deadline) {
        last = await drive.holdSnapshot(ctx.venue, PINNED)
        if (last.barrierCeilingHits >= 1 && last.barrierHoldMs >= fixture.HOLD_CEILING_S * 1000) return last
        await new Promise((r) => setTimeout(r, 10000))
    }
    return last
}

async function assertReleaseCommits (ctx) {
    ctx.venue.releaseMirrorHeights(PINNED, { reconnect: true })
    const got = await drive.waitCommitted(ctx.venue, PINNED, ctx.B, 10 * 60 * 1000)
    assert.ok(got.ok, 'indexer ' + PINNED + ' did not commit block ' + ctx.B + ' after the pin was released: ' + JSON.stringify(got.s) +
        '\n' + ctx.venue.logTail('indexer' + PINNED))
    const a = await drive.blockHashesOf(ctx.venue, PINNED, ctx.B)
    const b = await drive.blockHashesOf(ctx.venue, PEER, ctx.B)
    assert.deepStrictEqual(diffStateHashes(a, b), [], 'the held node and its peer disagree at block ' + ctx.B)
    console.log('BF3 released: both at block ' + ctx.B + ', state_root ' + String(a.state_root).slice(0, 16) + '...')
}
