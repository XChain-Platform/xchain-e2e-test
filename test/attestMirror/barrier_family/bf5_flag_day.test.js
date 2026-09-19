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
 * BF5 (family section 7): the flag day earns its keep. Two BTC indexers on one
 * venue, indexer 0 ARMED by the per-index env overlay and indexer 1 INERT, over
 * the same future-stamped block, with ONE row whose admission height and
 * effective_time select DIFFERENT blocks: effective_time is below t(B) (the
 * legacy rule binds it AT B) while admit_block_btc is B + 2 (the height rule
 * binds it two blocks later). The arming seam is the regtest resolver, which
 * lowers the armed node's threshold to 0 while the inert node's stays null, so
 * the drill block sits above one threshold and below the other.
 *
 * The two nodes are shown to bind that row at different blocks: that is the
 * divergence a rolling deploy would ship. Then both above the height: identical
 * hashes at B + 2, and only the instant each cleared its barriers differs (the
 * armed node commits B at once, the inert node waits out the stamp).
 *
 * ONLY THE ACTIVATION VARIES. Both indexers run the same tree at the same
 * HUB_SCHEMA_VERSION against the same hubs; the hubs are left inert too, since
 * the height watermark they publish is not itself gated (fail-closed by absence).
 ********************************************************************/

const assert = require('assert')
const path = require('path')
const dotenv = require('dotenv')
dotenv.config()

const fixture = require('../helpers/barrierFamilyFixture')
const rows = require('../helpers/barrierFamilyRows')
const drive = require('../helpers/barrierFamilyDrive')
const { diffStateHashes, queryDb } = require('../mirrorDrillWaits')

const BUILD_ROOT = path.resolve(__dirname, '..', '..', '..', '..')
const { HUB_SCHEMA_VERSION } = require(path.join(BUILD_ROOT, 'xchain-indexer', 'src', 'hub', 'hub_schema_version.js'))

const ARMED = 0
const INERT = 1
const TABLE = 'cross_chain_matches'
// The drill block sits this far ahead of wall clock: enough that the inert node's wait
// is measurable against the armed node's immediate commit, short enough to be bounded.
const AHEAD_S = Number(process.env.BF5_AHEAD_S || 300)

describe('BF5: the flag day, one venue, two rules, one row bound at two different blocks', function () {
    this.timeout(Math.max(drive.LEG_FLOOR_MS, fixture.legTimeoutMs(AHEAD_S + 600)))

    const ctx = { venue: null, btc: null, coin: 'BTC', B: null, key: null, blocks: {}, committedAt: {}, inertSeen: [] }

    before(async function () {
        // requireMirrorReady: BF5 judges the INERT node by the match barrier, which can only clear
        // once its hub mirror is bootstrapped. Levelling on chain height alone let the 2026-09-18
        // drive start with indexer 1 still draining its bootstrap, and both of BF5's reds were that
        // one unready node rather than the rule under test.
        const up = await drive.bootFamilyVenue({ label: 'bf5', repoRoot: BUILD_ROOT, armed: [ARMED], requireMirrorReady: true })
        Object.assign(ctx, up, { coin: up.evidence.coinCode })
        assert.deepStrictEqual(Object.keys(ctx.venue.indexerEnv).map(Number), [ARMED], 'the overlay must arm indexer 0 alone')
    })

    after(async function () {
        // A case that failed while the chain was held must not leave the miner paused.
        await drive.releaseChain(ctx.btc)
        if (ctx.venue) await ctx.venue.stop()
    })

    it('seeds the one row whose two rules select different blocks', async function () {
        await seedDivergingRow(ctx)
    })

    it('binds it at B on the inert node and not on the armed node', async function () {
        await assertDivergence(ctx)
    })

    it('binds it on both above the height, with identical hashes and different clearing instants', async function () {
        await assertConvergence(ctx)
    })
})

// The chain is held from the tip read through B + 1 (miner paused BEFORE the read, and B mined
// with the miner left paused): the row's two rules are keyed on B and B + 2 exactly, so a block
// the adaptive miner lands anywhere in that run moves both off the blocks this leg mines.
async function seedDivergingRow (ctx) {
    const held = await drive.holdBaseline(ctx.btc, ctx.venue, { label: 'bf5' })
    const tip = held.tip
    ctx.B = tip + 1
    const now = Math.floor(Date.now() / 1000)
    // Snapshot at B, not the reached tip: a fresh node's stake re-derivation rejects a synthetic capability row at a reached height.
    const base = { network: ctx.venue.network, coin: ctx.coin, snapshotBlock: ctx.B }
    const row = rows.inertRow(TABLE, Object.assign({ tag: 'bf5|' + tip, effectiveTime: now - 10, admitBlocks: { BTC: ctx.B + 2 } }, base))
    await drive.seedMirrors(ctx.venue, [rows.inertRow('capability_snapshots', Object.assign({ tag: 'bf5|snap|' + tip, effectiveTime: now }, base)), row])
    await drive.waitForMirrorRows(ctx.venue, ARMED, TABLE, 1)
    await drive.waitForMirrorRows(ctx.venue, INERT, TABLE, 1)
    ctx.key = row.row.match_id
    const snap = await ctx.venue.hubSnapshot(ctx.venue.indexers[ARMED].followsHub)
    assert.strictEqual(Number(snap.schema_version), HUB_SCHEMA_VERSION, 'the hub serves schema_version ' + snap.schema_version +
        ' while both indexers run HUB_SCHEMA_VERSION ' + HUB_SCHEMA_VERSION + '; the schema axis must not vary here')
    console.log('BF5 seeded ' + ctx.key + ' with effective_time ' + (now - 10) + ' (binds at B=' + ctx.B + ' by clock) and admit_block_btc ' + (ctx.B + 2))
}

async function assertDivergence (ctx) {
    await drive.assertChainHeld(ctx.btc, ctx.B - 1, 'the BTC chain, before B,')
    const wall = Math.floor(Date.now() / 1000)
    // Left PAUSED: the inert node's wait below runs for the whole stamp, and B + 1 must still
    // be the next block when the convergence case mines it.
    ctx.blocks.B = await drive.mineStamped(ctx.btc, wall + AHEAD_S, { resume: false })
    assert.strictEqual(ctx.blocks.B.height, ctx.B)
    const started = Date.now()
    const armed = await drive.waitForStatus(ctx.venue, ARMED, (s) => s.height !== null && s.height >= ctx.B, 5 * 60 * 1000)
    ctx.committedAt[ARMED] = Date.now() - started
    assert.ok(armed.ok, 'the armed node did not commit B inside five minutes: ' + JSON.stringify(armed.s) + '\n' + ctx.venue.logTail('indexer' + ARMED))
    assert.ok(armed.s.heights && Object.keys(armed.s.heights).length > 0, 'the hub published no heights map; arming bound on nothing')
    const inertNow = await drive.statusSnapshot(ctx.venue, INERT)
    assert.strictEqual(inertNow.height, ctx.B - 1, 'the inert node committed the future-stamped block early: ' + JSON.stringify(inertNow))
    assert.strictEqual(inertNow.stallClass, 'future_block_wait', 'the inert node reports ' + inertNow.stallClass + ', not future_block_wait')
    const t = ctx.blocks.B.blockTime
    const armedSet = await drive.mirrorReadableSet(ctx.venue, ARMED, TABLE, ctx.coin, ctx.B, t)
    assert.deepStrictEqual(armedSet, [], 'the armed node reads the row at B, but its admission height is B + 2')
    const inertGot = await drive.waitCommitted(ctx.venue, INERT, ctx.B, (AHEAD_S + 600) * 1000)
    ctx.committedAt[INERT] = Date.now() - started
    // The status JSON names the last barrier the block DEFERRED on, which is not the same as the
    // reason it is still uncommitted: a canonical-build refusal or a parse rollback never reaches
    // /status at all. The inert node's own log is the only carrier of that, so it rides the message.
    assert.ok(inertGot.ok, 'the inert node never committed B: ' + JSON.stringify(inertGot.s) + '\n' + ctx.venue.logTail('indexer' + INERT))
    // The inert node's read at B is the LEGACY rule alone: effective_time <= t(B).
    const inertRows = await queryDb(ctx.venue, ctx.venue.indexers[INERT].mirrorDbName,
        'SELECT match_id AS k FROM `' + TABLE + "` WHERE status = 'finalized' AND effective_time <= ? ORDER BY match_id ASC", [t])
    assert.deepStrictEqual(inertRows.map((r) => String(r.k)), [ctx.key], 'the inert node does not bind the row at B by the legacy rule')
    console.log('BF5 at B=' + ctx.B + ': armed reads [] and committed in ' + ctx.committedAt[ARMED] + ' ms; inert binds ' + ctx.key +
        ' and committed in ' + ctx.committedAt[INERT] + ' ms')
}

async function assertConvergence (ctx) {
    await drive.assertChainHeld(ctx.btc, ctx.B, 'the BTC chain, after B,')
    ctx.blocks.B1 = await drive.mineStamped(ctx.btc, null, { resume: false })
    // Resumes the miner: the hold ends with B + 2.
    ctx.blocks.B2 = await drive.mineStamped(ctx.btc, null)
    assert.strictEqual(ctx.blocks.B2.height, ctx.B + 2)
    for (const i of [ARMED, INERT]) {
        const got = await drive.waitCommitted(ctx.venue, i, ctx.B + 2, 10 * 60 * 1000)
        assert.ok(got.ok, 'indexer ' + i + ' never committed B + 2: ' + JSON.stringify(got.s) + '\n' + ctx.venue.logTail('indexer' + i))
    }
    const t2 = ctx.blocks.B2.blockTime
    const armedSet = await drive.mirrorReadableSet(ctx.venue, ARMED, TABLE, ctx.coin, ctx.B + 2, t2)
    assert.deepStrictEqual(armedSet, [ctx.key], 'the armed node does not bind the row at its admission height B + 2')
    const a = await drive.blockHashesOf(ctx.venue, ARMED, ctx.B + 2)
    const b = await drive.blockHashesOf(ctx.venue, INERT, ctx.B + 2)
    assert.deepStrictEqual(diffStateHashes(a, b), [], 'the two nodes disagree at B + 2: ' + JSON.stringify(diffStateHashes(a, b)))
    assert.strictEqual(String(a.actions_hash), String(b.actions_hash), 'actions_hash differs at B + 2')
    assert.ok(ctx.committedAt[ARMED] < ctx.committedAt[INERT] - 60000,
        'the clearing instants do not differ: armed ' + ctx.committedAt[ARMED] + ' ms, inert ' + ctx.committedAt[INERT] + ' ms')
    console.log('BF5 at B+2: both bind ' + ctx.key + ', state_root ' + String(a.state_root).slice(0, 16) + '... identical')
}
