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
 * AB3 (parent section 5): safety preserved, and it must be falsified. Activation
 * ARMED, the horizon block placed so that the window
 * [horizonTime + grace, horizonTime + margin + grace) contains the hub's clock,
 * and the armed indexer held INSIDE that window while every row flows.
 *
 * THE LEVER, on this train. Above the activation the anchor-attest member is
 * satisfied by EITHER half (R3 (b), attest.js): the height watermark
 * `heights[anchor_reward_attestations][BTC] >= B - 144`, or the clock form
 * `watermark >= min(t(B), horizon) + grace`. The venue's only lever on a
 * height-keyed member is the heights PIN (row 9a; withholding rows passes the
 * watermark through by design, and no `ts` pin exists), so the height half is
 * held shut by pinning `B - 144 - 1` (the fixture's `pinnedHeightFor`, this
 * member's own margin) and the clock half by the horizon window itself, which
 * the spaced run puts AHEAD of the hub's clock for the margin's duration.
 *
 * Expected: `stallReason = 'anchor_attest_barrier'`, `stallClass = 'barrier_defer'`
 * (NOT future_block_wait: no clock instant exists above the activation, D41),
 * `stallClearsAt` null, a hold accumulating on `/health`, and no commit. Release
 * the pin: the node commits.
 *
 * FALSIFICATIONS (row 11, main-loop serial): run this leg with
 * AB_ARRIVAL_MARGIN_S=0 (the window is empty and the clock half opens at once, so
 * the node commits inside the pinned window: RED); short-circuit the predicate to
 * true (RED); restore byte-exact, sha256 equal either side. Removing only the
 * new `min` term cannot serve: the legacy form defers whenever the new form does.
 ********************************************************************/

const assert = require('assert')
const path = require('path')
const dotenv = require('dotenv')
dotenv.config()

const fixture = require('../helpers/barrierFamilyFixture')
const drive = require('../helpers/barrierFamilyDrive')
const { until } = require('../mirrorDrillWaits')

const BUILD_ROOT = path.resolve(__dirname, '..', '..', '..', '..')
const HELD = 0
const PEER = 1
const TABLE = 'anchor_reward_attestations'
const REASON = 'anchor_attest_barrier'
const GRACE_S = 120
const MARGIN_S = Number(process.env.AB_ARRIVAL_MARGIN_S || 600)
// Observed hold: at least two barrier cycles inside the window, well short of the margin.
const HOLD_OBSERVE_MS = (2 * fixture.BARRIER_CYCLE_S + 30) * 1000

describe('AB3: safety preserved, the armed node holds inside the horizon window under a pinned height', function () {
    this.timeout(Math.max(drive.LEG_FLOOR_MS, fixture.legTimeoutMs(MARGIN_S + 900)))

    const ctx = { venue: null, btc: null, coin: 'BTC', spaced: null, baseline: null, block: null, pin: null, held: null, hold: null }

    before(async function () {
        const up = await drive.bootFamilyVenue({
            label: 'ab3', repoRoot: BUILD_ROOT, armed: [HELD, PEER], armHubs: true,
            indexerGraces: { [HELD]: { anchorAttest: GRACE_S } },
            indexerExtraEnv: { HUB_SYNC_ANCHOR_ATTEST_ARRIVAL_MARGIN_S: String(MARGIN_S) },
        })
        Object.assign(ctx, up, { coin: up.evidence.coinCode })
    })

    after(async function () {
        // The miner is resumed first and unconditionally: a case that failed between the
        // held baseline and the drill block must not hand the next leg a paused chain.
        await drive.releaseChain(ctx.btc)
        if (!ctx.venue) return
        try { ctx.venue.releaseMirrorHeights(HELD) } catch (_) { /* never armed */ }
        await ctx.venue.stop()
    })

    it('places the horizon window around the hub\'s clock and pins the height below the member\'s line', async function () {
        await placeWindowAndPin(ctx)
    })

    it('defers at anchor_attest_barrier as barrier_defer, null deadline, a hold accumulating, no commit', async function () {
        await assertHeldInWindow(ctx)
    })

    it('commits once the pin is released', async function () {
        await assertReleaseCommits(ctx)
    })
})

// The run is stamped so that horizonTime + grace <= now < horizonTime + margin + grace:
// half a margin behind wall clock, clamped by the tip's median time. If the clamp
// leaves the window already behind wall clock the leg says so and fails, because a
// window that does not contain the hub's clock cannot hold the clock half shut.
//
// THE CHAIN IS HELD FROM HERE THROUGH THE DRILL BLOCK. `mineSpacedRun` resumes the
// adaptive miner in its finally, so a block landing between then and the pin/drop below
// would park the real tip past `ctx.spaced.run.to`; sizing the height pin and the drill
// block's expected height on that stale value is exactly the defect BF1 to BF8 hit and
// fixed with the same hold (`barrierFamilyDrive.js` holdBaseline/assertChainHeld). So:
// pause, re-read the tip, level every indexer to it and assert it held, THEN size the
// pin and drop sockets with the miner still paused, assert held once more right before
// the drill block, and let `mineStamped` end the hold.
async function placeWindowAndPin (ctx) {
    ctx.spaced = await drive.mineSpacedChain(ctx.btc, 144, GRACE_S + Math.floor(MARGIN_S / 2))
    const held = await drive.holdBaseline(ctx.btc, ctx.venue, { label: 'ab3', graces: { anchorAttest: GRACE_S } })
    ctx.baseline = held
    const horizon = ctx.spaced.run.first.blockTime
    const now = Math.floor(Date.now() / 1000)
    const window = { from: horizon + GRACE_S, to: horizon + MARGIN_S + GRACE_S }
    console.log('AB3 window ' + JSON.stringify(window) + ' against now ' + now + (ctx.spaced.clamped ? ' (stamp clamped)' : ''))
    assert.ok(now >= window.from && now < window.to - 30, 'the horizon window ' + JSON.stringify(window) + ' does not contain the hub\'s clock ' + now +
        ' with room to observe a hold; the tip\'s median time ' + ctx.spaced.floor.mtp + ' clamps the spacing')
    const tip = held.tip
    ctx.pin = { [TABLE]: { BTC: fixture.pinnedHeightFor(TABLE, tip + 1) } }
    ctx.venue.pinMirrorHeights(HELD, ctx.pin)
    ctx.venue.indexers[HELD].mirrorProxy.dropSockets()
    await drive.assertChainHeld(ctx.btc, tip, 'the BTC chain, before the drill block,')
    const wall = Math.floor(Date.now() / 1000)
    // Resumes the miner: the hold ends with the drill block.
    ctx.block = await drive.mineStamped(ctx.btc, wall + drive.STAMP_AHEAD_S)
    assert.strictEqual(ctx.block.height, tip + 1, 'the drill block landed at ' + ctx.block.height + ', not the held baseline + 1 = ' + (tip + 1))
    ctx.window = window
}

async function assertHeldInWindow (ctx) {
    const B = ctx.block.height
    const got = await drive.waitForStatus(ctx.venue, HELD, (s) => s.height === B - 1 && s.stallReason === REASON, 5 * 60 * 1000)
    assert.ok(got.ok, 'indexer ' + HELD + ' never reported ' + REASON + ' on block ' + B + ': ' + JSON.stringify(got.s) + '\n' + ctx.venue.logTail('indexer' + HELD))
    ctx.held = got.s
    ctx.venue.assertMirrorHeightPinObserved(HELD, { carriers: ['watermark', 'snapshot'] })
    assert.strictEqual(ctx.held.stallClass, 'barrier_defer', 'stallClass ' + ctx.held.stallClass + ' (want barrier_defer, D41)')
    assert.strictEqual(ctx.held.stallClearsAt, null, 'stallClearsAt ' + ctx.held.stallClearsAt + ' above the activation')
    const first = await drive.holdSnapshot(ctx.venue, HELD)
    // Bounded condition wait, not a fixed settle: polls the indexer's own hold
    // counter and stops the instant it reports the target duration, rather than
    // sleeping a guess and hoping the accounting caught up by then.
    const observed = await until(async () => {
        const snap = await drive.holdSnapshot(ctx.venue, HELD)
        return { ok: snap.barrierHoldMs - first.barrierHoldMs >= HOLD_OBSERVE_MS, snap }
    }, HOLD_OBSERVE_MS + 30000, 2000)
    const later = observed.snap
    const s = await drive.statusSnapshot(ctx.venue, HELD)
    console.log('AB3 hold: ' + JSON.stringify(first) + ' then ' + JSON.stringify(later) + '; status ' + JSON.stringify(s))
    assert.strictEqual(later.barrierHoldBlock, B, 'the hold is not on block ' + B)
    assert.ok(later.barrierHoldMs > first.barrierHoldMs && later.barrierHoldMs >= HOLD_OBSERVE_MS - 15000, 'the hold did not accumulate')
    assert.strictEqual(s.height, B - 1, 'the node committed inside the pinned window')
    assert.strictEqual(s.stallReason, REASON, 'the reason moved to ' + s.stallReason)
    assert.ok(Math.floor(Date.now() / 1000) < ctx.window.to, 'the window closed before the hold was observed; raise AB_ARRIVAL_MARGIN_S')
    const peer = await drive.waitCommitted(ctx.venue, PEER, B, 5 * 60 * 1000)
    assert.ok(peer.ok, 'the unpinned peer did not commit block ' + B + ': its own height watermark should satisfy the member')
}

async function assertReleaseCommits (ctx) {
    ctx.venue.releaseMirrorHeights(HELD, { reconnect: true })
    const got = await drive.waitCommitted(ctx.venue, HELD, ctx.block.height, 10 * 60 * 1000)
    assert.ok(got.ok, 'the held node did not commit block ' + ctx.block.height + ' after the release: ' + JSON.stringify(got.s) + '\n' + ctx.venue.logTail('indexer' + HELD))
    console.log('AB3 released: committed ' + ctx.block.height)
}
