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
 * AB2 (parent section 5): the fix, activation ARMED on indexer 0 (one lever arms
 * the horizon form and the family's height rule together, by design). The
 * identical +7200 block over a 144-block run spaced behind the margin: the
 * anchor-attest predicate is satisfied on FIRST evaluation, `anchor_attest_barrier`
 * never appears in `/status` for it even with its grace raised above the
 * siblings', and the stall the loop reports, if any, is a LATER family member.
 * The block commits the moment the siblings clear; `state_hash` at B and the
 * `validator_rewards` row count equal the inert node's once it catches up.
 *
 * THE MARGIN IS THE REGTEST OVERRIDE. The production 64800 s arrival margin cannot
 * be placed behind a tip whose recent blocks are minutes old (a stamp at or below
 * the median-time-past is refused by consensus), so the leg passes
 * HUB_SYNC_ANCHOR_ATTEST_ARRIVAL_MARGIN_S (regtest-only, AB_ARRIVAL_MARGIN_S,
 * default 600) and spaces the run behind THAT; AB1 carries the production grace.
 * The unit half (predicate matrix, derive-set identity) is AB4's.
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
const GRACE_S = 120
const MARGIN_S = Number(process.env.AB_ARRIVAL_MARGIN_S || 600)
const ANCHOR_AT = fixture.FAMILY_REASONS_LOOP_ORDER.indexOf('anchor_attest_barrier')

describe('AB2: the fix, the anchor-attest predicate satisfied on first evaluation over a spaced chain', function () {
    this.timeout(Math.max(drive.LEG_FLOOR_MS, fixture.legTimeoutMs(drive.STAMP_AHEAD_S + MARGIN_S + 900)))

    const ctx = { venue: null, btc: null, coin: 'BTC', spaced: null, block: null, seen: [] }

    before(async function () {
        const up = await drive.bootFamilyVenue({
            label: 'ab2', repoRoot: BUILD_ROOT, armed: [ARMED], armHubs: true,
            indexerGraces: { [ARMED]: { anchorAttest: GRACE_S } },
            indexerExtraEnv: { HUB_SYNC_ANCHOR_ATTEST_ARRIVAL_MARGIN_S: String(MARGIN_S) },
        })
        Object.assign(ctx, up, { coin: up.evidence.coinCode })
    })

    after(async function () {
        if (ctx.venue) await ctx.venue.stop()
    })

    it('spaces 144 blocks behind the margin so the horizon window is already past', async function () {
        ctx.spaced = await drive.spaceChainBehindMargin(ctx.btc, ctx.venue, MARGIN_S, GRACE_S)
        console.log('AB2 spaced run ' + ctx.spaced.run.from + '..' + ctx.spaced.run.to + ' stamped ' + ctx.spaced.stamp +
            (ctx.spaced.clamped ? ' (clamped from ' + ctx.spaced.wantStamp + ')' : '') + ', horizon opened at ' + ctx.spaced.horizonOpensAt)
    })

    it('commits the +7200 block as soon as the siblings clear, never naming anchor_attest_barrier', async function () {
        await assertArmedCommits(ctx)
    })

    it('matches the inert node\'s state_hash and validator_rewards count at B once it catches up', async function () {
        await assertIdentity(ctx)
    })
})

async function assertArmedCommits (ctx) {
    const wall = Math.floor(Date.now() / 1000)
    ctx.block = await drive.mineStamped(ctx.btc, wall + drive.STAMP_AHEAD_S)
    const B = ctx.block.height
    const started = Date.now()
    const got = await drive.waitForStatus(ctx.venue, ARMED, (s) => {
        if (s.height === B - 1 && s.stallReason) ctx.seen.push({ reason: s.stallReason, stallClass: s.stallClass, at: Date.now() - started })
        return s.height !== null && s.height >= B
    }, 8 * 60 * 1000)
    console.log('AB2 armed node reasons on B-1: ' + JSON.stringify(ctx.seen) + '; committed in ' + (Date.now() - started) + ' ms')
    assert.ok(got.ok, 'the armed node did not commit block ' + B + ' inside eight minutes: ' + JSON.stringify(got.s) + '\n' + ctx.venue.logTail('indexer' + ARMED))
    assert.ok(!ctx.seen.some((x) => x.reason === 'anchor_attest_barrier'), 'anchor_attest_barrier named itself on the armed node: ' + JSON.stringify(ctx.seen))
    for (const x of ctx.seen) {
        const at = fixture.FAMILY_REASONS_LOOP_ORDER.indexOf(x.reason)
        assert.ok(at > ANCHOR_AT, 'the stall reported was ' + x.reason + ', not a member after anchor-attest in loop order')
    }
    assert.ok(!/anchor-reward attestation mirror/.test(ctx.venue.logTail('indexer' + ARMED).split('\n').filter((l) => l.includes('Deferring block ' + B + ' ')).join('\n')),
        'the log shows the anchor-attest member deferring block ' + B)
    const inert = await drive.statusSnapshot(ctx.venue, INERT)
    assert.strictEqual(inert.height, B - 1, 'the inert sibling committed the +7200 block early: ' + JSON.stringify(inert))
}

async function assertIdentity (ctx) {
    const B = ctx.block.height
    const got = await drive.waitCommitted(ctx.venue, INERT, B, (drive.STAMP_AHEAD_S + 900) * 1000)
    assert.ok(got.ok, 'the inert node never caught up to block ' + B + ': ' + JSON.stringify(got.s))
    const a = await drive.blockHashesOf(ctx.venue, ARMED, B)
    const b = await drive.blockHashesOf(ctx.venue, INERT, B)
    assert.deepStrictEqual(diffStateHashes(a, b), [], 'the armed and inert nodes disagree at block ' + B + ': ' + JSON.stringify(diffStateHashes(a, b)))
    const ra = await drive.rewardCount(ctx.venue, ARMED)
    const rb = await drive.rewardCount(ctx.venue, INERT)
    assert.strictEqual(ra, rb, 'validator_rewards counts differ: armed ' + ra + ', inert ' + rb)
    console.log('AB2 identity at B=' + B + ': state_root ' + String(a.state_root).slice(0, 16) + '..., validator_rewards ' + ra + ' = ' + rb)
}
