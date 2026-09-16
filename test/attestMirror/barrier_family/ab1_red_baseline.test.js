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
 * AB1 (parent section 5): the RED baseline, unfixed predicate, activation INERT.
 * A block stamped wallClock + 7200 with the anchorAttest grace at the production
 * 120 s on indexer 0 (siblings at 0, D34) holds the BTC indexer at
 * `stallReason = 'anchor_attest_barrier'`, `stallClearsAt == (block_time + 120)
 * * 1000`, `stallClass == 'future_block_wait'`, `atProcessableTip == true`, and
 * the block is still uncommitted after three 60 s barrier cycles printing the
 * identical timed-out line: the re-arm the "no bound" claim rests on.
 *
 * The anchor-attest member names itself only because every member BEFORE it in
 * the loop is out of the way: members 1 to 3 run only on a block with
 * transactions (the drill block carries none) and members 4 to 7 are satisfied
 * while their mirrors hold no row for this coin, which the leg asserts as a
 * precondition rather than assumes (it is the one leg that must NOT seed rows).
 *
 * The full 7320 s soak is opt-in (AB1_SOAK=1) for a one-time record; it adds no
 * assertion the deadline value does not already make.
 ********************************************************************/

const assert = require('assert')
const path = require('path')
const dotenv = require('dotenv')
dotenv.config()

const fixture = require('../helpers/barrierFamilyFixture')
const rows = require('../helpers/barrierFamilyRows')
const drive = require('../helpers/barrierFamilyDrive')
const { queryDb } = require('../mirrorDrillWaits')

const BUILD_ROOT = path.resolve(__dirname, '..', '..', '..', '..')
const HELD = 0
const REASON = 'anchor_attest_barrier'
const GRACE_S = 120
const SOAK = process.env.AB1_SOAK === '1'
const XDEX_TABLES = ['cross_chain_matches', 'cross_chain_calls', 'bridge_transfers', 'policy_snapshots']

describe('AB1: the RED baseline, the anchor-attest barrier holds a +7200 block for the stamp plus its grace', function () {
    this.timeout(Math.max(drive.LEG_FLOOR_MS, fixture.legTimeoutMs(SOAK ? drive.STAMP_AHEAD_S + GRACE_S : 600)))

    const ctx = { venue: null, btc: null, coin: 'BTC', block: null, red: null }

    before(async function () {
        const up = await drive.bootFamilyVenue({ label: 'ab1', repoRoot: BUILD_ROOT, indexerGraces: { [HELD]: { anchorAttest: GRACE_S } } })
        Object.assign(ctx, up, { coin: up.evidence.coinCode })
    })

    after(async function () {
        if (ctx.venue) await ctx.venue.stop()
    })

    it('starts from mirrors that hold no row for this coin, so no earlier member can name itself', async function () {
        await assertMirrorsEmpty(ctx)
    })

    it('mines the +7200 block and reads its stamp back', async function () {
        const wall = Math.floor(Date.now() / 1000)
        ctx.block = await drive.mineStamped(ctx.btc, wall + drive.STAMP_AHEAD_S)
        assert.ok(ctx.block.blockTime >= wall + drive.STAMP_AHEAD_S - 1, 'the block is stamped ' + ctx.block.blockTime + ', not +' + drive.STAMP_AHEAD_S)
    })

    it('holds at anchor_attest_barrier with the four surface values and three identical timed-out lines', async function () {
        await assertHeld(ctx)
    })

    it('records the full hold when AB1_SOAK=1', async function () {
        if (!SOAK) { console.log('AB1 soak not requested (AB1_SOAK=1 records it); the deadline value above is the assertion'); return }
        const got = await drive.waitCommitted(ctx.venue, HELD, ctx.block.height, (drive.STAMP_AHEAD_S + GRACE_S + 600) * 1000)
        assert.ok(got.ok, 'the held node never committed the block after its stamp plus grace passed: ' + JSON.stringify(got.s))
        console.log('AB1 soak: committed ' + ctx.block.height + ' at ' + new Date().toISOString() + ' against a deadline of ' + new Date(ctx.red.stallClearsAt).toISOString())
    })
})

async function assertMirrorsEmpty (ctx) {
    const hub = ctx.venue.hubs[ctx.venue.indexers[HELD].followsHub]
    const counts = {}
    for (const t of XDEX_TABLES) {
        const q = rows.contentEscapeSql(t, ctx.coin, 0)
        counts[t] = Number((await queryDb(ctx.venue, hub.dbName, q.sql, q.args))[0].n)
    }
    const busy = Object.keys(counts).filter((t) => counts[t] > 0)
    assert.deepStrictEqual(busy, [], 'the hub holds finalized rows for this coin in ' + JSON.stringify(counts) +
        '; a member before anchor-attest would name itself first, and this leg must not seed rows')
    console.log('AB1 precondition: ' + JSON.stringify(counts))
}

async function assertHeld (ctx) {
    const B = ctx.block.height
    const got = await drive.waitForStatus(ctx.venue, HELD, (s) => s.height === B - 1 && s.stallReason === REASON, 8 * 60 * 1000)
    assert.ok(got.ok, 'indexer ' + HELD + ' never reported ' + REASON + ' on block ' + B + ': ' + JSON.stringify(got.s) + '\n' + ctx.venue.logTail('indexer' + HELD))
    ctx.red = got.s
    assert.strictEqual(ctx.red.stallClass, 'future_block_wait', 'stallClass ' + ctx.red.stallClass)
    assert.strictEqual(ctx.red.atProcessableTip, true, 'atProcessableTip ' + ctx.red.atProcessableTip)
    assert.strictEqual(ctx.red.stallClearsAt, (ctx.block.blockTime + GRACE_S) * 1000,
        'stallClearsAt ' + ctx.red.stallClearsAt + ' is not (block_time + 120) * 1000 = ' + ((ctx.block.blockTime + GRACE_S) * 1000))
    const three = await drive.waitForStatus(ctx.venue, HELD, () => rows.timedOutLines(ctx.venue.logTail('indexer' + HELD), B).identical >= 3,
        (4 * fixture.BARRIER_CYCLE_S + 60) * 1000)
    const lines = rows.timedOutLines(ctx.venue.logTail('indexer' + HELD), B)
    assert.ok(three.ok, 'fewer than three identical timed-out lines for block ' + B + ': ' + JSON.stringify(lines) + '\n' + ctx.venue.logTail('indexer' + HELD))
    assert.strictEqual(three.s.height, B - 1, 'the block committed during the three cycles')
    assert.strictEqual(three.s.stallReason, REASON, 'the reason moved to ' + three.s.stallReason)
    await drive.assertFederationQuiet(ctx.venue, ctx.venue.indexers[HELD].followsHub, ctx.coin, ctx.block.blockTime)
    console.log('AB1 held: ' + JSON.stringify(ctx.red) + '; lines ' + JSON.stringify(lines))
}
