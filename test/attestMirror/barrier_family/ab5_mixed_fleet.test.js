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
 * AB5 (parent section 5): a mixed fleet derives one set. Two BTC indexers on the
 * venue, indexer 0 ARMED by the per-index env overlay and indexer 1 INERT, over
 * the same future-stamped block on the same spaced chain: both end at the
 * identical `state_hash` for that block and the identical `validator_rewards`
 * row count; only the instant at which each clears the anchor-attest barrier
 * differs, and it is asserted to differ: the armed node's barrier is satisfied
 * at first evaluation (it never names `anchor_attest_barrier`), the inert node's
 * is not (it names it, in `future_block_wait`, until the stamp passes).
 *
 * The arming key is the one lever the fixture reads from the indexer's own
 * registry (XC_MIRROR_ADMISSION_ACTIVATION arms the horizon form and the height
 * rule together); the parent's D29 name for a separate anchor-attest resolver
 * does not exist in the shipped tree, by design (anchor_reward_gate.js).
 ********************************************************************/

const assert = require('assert')
const path = require('path')
const dotenv = require('dotenv')
dotenv.config()

const fixture = require('../helpers/barrierFamilyFixture')
const drive = require('../helpers/barrierFamilyDrive')
const { diffStateHashes } = require('../mirrorDrillWaits')

const BUILD_ROOT = path.resolve(__dirname, '..', '..', '..', '..')
const ARMED = 0
const INERT = 1
const REASON = 'anchor_attest_barrier'
const MARGIN_S = Number(process.env.AB_ARRIVAL_MARGIN_S || 600)

describe('AB5: a mixed fleet, one armed and one inert indexer, derives one set at different instants', function () {
    this.timeout(Math.max(drive.LEG_FLOOR_MS, fixture.legTimeoutMs(drive.STAMP_AHEAD_S + MARGIN_S + 900)))

    const ctx = { venue: null, btc: null, coin: 'BTC', block: null, cleared: {}, inertHeld: null }

    before(async function () {
        const up = await drive.bootFamilyVenue({
            label: 'ab5', repoRoot: BUILD_ROOT, armed: [ARMED],
            indexerExtraEnv: { HUB_SYNC_ANCHOR_ATTEST_ARRIVAL_MARGIN_S: String(MARGIN_S) },
        })
        Object.assign(ctx, up, { coin: up.evidence.coinCode })
        assert.deepStrictEqual(Object.keys(ctx.venue.indexerEnv).map(Number), [ARMED], 'the overlay must arm indexer 0 alone')
    })

    after(async function () {
        if (ctx.venue) await ctx.venue.stop()
    })

    it('spaces the chain behind the margin and mines the same +7200 block for both', async function () {
        await drive.spaceChainBehindMargin(ctx.btc, ctx.venue, MARGIN_S, 0)
        const wall = Math.floor(Date.now() / 1000)
        ctx.block = await drive.mineStamped(ctx.btc, wall + drive.STAMP_AHEAD_S)
        ctx.minedAt = Date.now()
        assert.ok(ctx.block.blockTime >= wall + drive.STAMP_AHEAD_S - 1, 'the block is stamped ' + ctx.block.blockTime)
    })

    it('clears the armed node at first evaluation while the inert node names the barrier in future_block_wait', async function () {
        await assertInstantsDiffer(ctx)
    })

    it('ends both at the identical state_hash and validator_rewards count once the inert node catches up', async function () {
        await assertOneSet(ctx)
    })
})

async function assertInstantsDiffer (ctx) {
    const B = ctx.block.height
    const seen = []
    const armed = await drive.waitForStatus(ctx.venue, ARMED, (s) => {
        if (s.height === B - 1 && s.stallReason) seen.push(s.stallReason)
        return s.height !== null && s.height >= B
    }, 8 * 60 * 1000)
    ctx.cleared[ARMED] = Date.now() - ctx.minedAt
    assert.ok(armed.ok, 'the armed node did not commit block ' + B + ': ' + JSON.stringify(armed.s) + '\n' + ctx.venue.logTail('indexer' + ARMED))
    assert.ok(!seen.includes(REASON), 'the armed node named ' + REASON + ' for block ' + B + ': ' + JSON.stringify(seen))
    const inert = await drive.waitForStatus(ctx.venue, INERT, (s) => s.height === B - 1 && s.stallReason === REASON, 5 * 60 * 1000)
    assert.ok(inert.ok, 'the inert node never named ' + REASON + ' for block ' + B + ': ' + JSON.stringify(inert.s) + '\n' + ctx.venue.logTail('indexer' + INERT))
    ctx.inertHeld = inert.s
    assert.strictEqual(inert.s.stallClass, 'future_block_wait', 'the inert node reports ' + inert.s.stallClass)
    assert.strictEqual(inert.s.stallClearsAt, ctx.block.blockTime * 1000, 'the inert node clears at ' + inert.s.stallClearsAt + ', not the stamp (grace 0)')
    console.log('AB5 armed cleared in ' + ctx.cleared[ARMED] + ' ms; inert held: ' + JSON.stringify(inert.s))
}

async function assertOneSet (ctx) {
    const B = ctx.block.height
    const got = await drive.waitCommitted(ctx.venue, INERT, B, (drive.STAMP_AHEAD_S + 900) * 1000)
    ctx.cleared[INERT] = Date.now() - ctx.minedAt
    assert.ok(got.ok, 'the inert node never committed block ' + B + ': ' + JSON.stringify(got.s))
    assert.ok(ctx.cleared[INERT] > ctx.cleared[ARMED] + 60000, 'the clearing instants do not differ: ' + JSON.stringify(ctx.cleared))
    const a = await drive.blockHashesOf(ctx.venue, ARMED, B)
    const b = await drive.blockHashesOf(ctx.venue, INERT, B)
    assert.deepStrictEqual(diffStateHashes(a, b), [], 'the two nodes disagree at block ' + B + ': ' + JSON.stringify(diffStateHashes(a, b)))
    const ra = await drive.rewardCount(ctx.venue, ARMED)
    const rb = await drive.rewardCount(ctx.venue, INERT)
    assert.strictEqual(ra, rb, 'validator_rewards counts differ: armed ' + ra + ', inert ' + rb)
    console.log('AB5 one set at B=' + B + ': state_root ' + String(a.state_root).slice(0, 16) + '..., rewards ' + ra + ' = ' + rb + ', cleared ' + JSON.stringify(ctx.cleared))
}
