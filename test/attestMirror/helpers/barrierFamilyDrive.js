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
 * The VENUE-BOUND half of what the barrier-family legs share: boot the family
 * venue from the isolated build root and level it, mine one block under a clock
 * pin and read its stamp back, seed the mirrors, read `/status` and `/health`
 * into the shapes the legs assert on, and prove the federation stayed quiet.
 *
 * Everything here is a thin composition over `AttestMirrorVenue`, the chain rail
 * and the fixture; the rules (what "admitted at B" means, the family order, the
 * inert row shapes) live in the fixture and in barrierFamilyRows.js, both pure.
 *
 * FAILED, NEVER SKIPPED. Once a leg is in acceptance an unavailable dependency is
 * a failed drive, so `bootFamilyVenue` asserts the venue came up rather than
 * calling `this.skip()` the way the older at* legs do.
 ********************************************************************/

const assert = require('assert')
const fs = require('fs')
const path = require('path')

const { createRail, withRail } = require('../../helpers/chainRail')
const { until, untilOrClearDogeStall, venueTipProbe, queryDb } = require('../mirrorDrillWaits')
const XChainIndexerConnector = require('../../../src/XChainIndexerConnector.js')
const fixture = require('./barrierFamilyFixture')
const rows = require('./barrierFamilyRows')

const LEVEL_TIMEOUT_MS = 25 * 60 * 1000
const POLL_MS = 2000
// No leg's mocha budget is below this: the venue boot alone (five hubs, two indexers, a
// catch-up from the chain's genesis) has measured close to the at* legs' 45 minutes.
const LEG_FLOOR_MS = 60 * 60 * 1000

// The stamp every headline leg mines its drill block at: the full Bitcoin allowance.
// BF_STAMP_AHEAD_S shortens it for a smoke drive; the acceptance record uses the default.
const STAMP_AHEAD_S = Number(process.env.BF_STAMP_AHEAD_S || 7200)

/**
 * Build and start the family venue from an EXPLICIT build root, level its indexers with
 * the decoder, and return the rail beside it. `opts.armed` arms indexer indexes through
 * the fixture; `opts.armHubs` arms every hub child with the same lever so the producers
 * stamp admission maps (the venue's `hubExtraEnv` seam).
 *
 * @returns {Promise<{venue: object, evidence: object, btc: object}>}
 */
async function bootFamilyVenue (opts) {
    const o = opts || {}
    assert.ok(o.repoRoot, 'bootFamilyVenue: repoRoot is required (B4: the evidence names the tree that ran)')
    const btc = await createRail('bitcoin', 'regtest')
    const venueOpts = Object.assign({}, o.venue || {})
    // Port seam for concurrent stacks on one host: the rail runner gives each leg its own base (rail 2026-09-17, four stacks at once).
    if (process.env.AB_VENUE_BASE_PORT) venueOpts.basePort = Number(process.env.AB_VENUE_BASE_PORT)
    // Bounded XDEX rounds (5 s, 20 s terminal) and 1 s admission samples: the hub default 480 s terminal
    // window publishes no settled match height inside a case's 300 s commit budget (rail 2026-09-17, bf2/bf5).
    venueOpts.hubExtraEnv = Object.assign({
        XDEX_ROUND_TIMEOUT_MS: '5000',
        XDEX_ROUND_MAX_LIFETIME_MS: '20000',
        ADMISSION_WATERMARK_SAMPLE_MS: '1000',
    }, venueOpts.hubExtraEnv || {})
    if (o.indexerGraces) venueOpts.indexerGraces = o.indexerGraces
    if (o.indexerExtraEnv) venueOpts.indexerExtraEnv = Object.assign({}, venueOpts.indexerExtraEnv || {}, o.indexerExtraEnv)
    if (o.armHubs) venueOpts.hubExtraEnv = Object.assign({}, venueOpts.hubExtraEnv || {}, { [fixture.ARM_ENV]: fixture.ARM_VALUE })
    const built = fixture.buildFamilyVenue({
        repoRoot: o.repoRoot, armed: o.armed || [], hubRepoRoots: o.hubRepoRoots, label: o.label, venue: venueOpts,
    })
    const evidence = Object.assign(built.evidence, { armHubs: !!o.armHubs, stampAheadS: STAMP_AHEAD_S })
    console.log('BF EVIDENCE ' + JSON.stringify(evidence))
    const up = await built.venue.start()
    assert.ok(up, 'FAILED DRIVE (not a skip): the family venue did not come up: ' + String(built.venue.unavailable))
    await levelIndexers(built.venue, o.levelTimeoutMs)
    return { venue: built.venue, evidence, btc }
}

/** Every indexer level with the decoder before a leg breaks anything, so a hold is the leg's doing. */
async function levelIndexers (venue, timeoutMs) {
    const idx = venue.indexers.map((ix) => ix.index)
    const level = await untilOrClearDogeStall(async () => {
        const all = []
        // `start()` returns once an indexer's cloned schema exists, which can be before its
        // API listens, so a refused connection here is "not level yet" rather than a failure.
        for (const i of idx) {
            all.push(await statusSnapshot(venue, i).catch((e) => ({ height: null, decoder: null, unreachable: String(e && e.message) })))
        }
        return { ok: all.every((s) => s.height !== null && s.decoder !== null && s.height === s.decoder), all }
    }, { timeoutMs: timeoutMs || LEVEL_TIMEOUT_MS, tipProbe: venueTipProbe(venue, idx[idx.length - 1]) })
    assert.ok(level.ok, 'the venue indexers never caught the chain before the drill: ' + JSON.stringify(level.all))
    console.log('BF baseline: every indexer committed block ' + level.all[0].height)
    return level.all
}

/**
 * The stall facts of one indexer, off `/status`, in the fixture's snapshot shape plus the
 * counters and the mirror's height dimension. Absent fields stay `undefined`.
 */
async function statusSnapshot (venue, i) {
    const s = await venue.statusOf(i)
    const b = s.body || {}
    const mirror = b.hubMirror || {}
    return Object.assign(fixture.stallSnapshot(b), {
        httpStatus: s.httpStatus,
        height:   b.indexerBlock !== undefined ? Number(b.indexerBlock) : null,
        inFlight: b.inFlightBlock !== undefined && b.inFlightBlock !== null ? Number(b.inFlightBlock) : null,
        decoder:  b.decoderBlock !== undefined ? Number(b.decoderBlock) : null,
        // /status carries the mirror under `hubMirror`; the fixture's snapshot reads `mirror`.
        heights:          mirror.heights,
        heightShortfalls: mirror.heightShortfalls,
        heightsFrozenMs:  mirror.heightsFrozenMs,
        watermarkFrozenMs: mirror.watermarkFrozenMs,
        streamWatermark:  mirror.streamWatermark,
    })
}

/** The hold counters off the `health` JSON-RPC: barrierHoldMs, barrierHoldBlock, ceiling hits. */
async function holdSnapshot (venue, i) {
    const ix = venue.indexers[i]
    const conn = new XChainIndexerConnector('127.0.0.1', ix.apiPort, null)
    const b = await conn.health()
    assert.ok(b, 'indexer ' + i + ' did not answer the health call, so its hold cannot be read')
    return {
        barrierHoldMs: b.barrierHoldMs, barrierHoldBlock: b.barrierHoldBlock,
        barrierCeilingExceeded: b.barrierCeilingExceeded, barrierCeilingHits: b.barrierCeilingHits,
    }
}

/** Poll `/status` of indexer `i` until `pred(snapshot)` holds; returns the last snapshot either way. */
async function waitForStatus (venue, i, pred, timeoutMs) {
    const got = await until(async () => {
        const s = await statusSnapshot(venue, i)
        return { ok: !!pred(s), s }
    }, timeoutMs, POLL_MS)
    return Object.assign({ ok: false }, got, { s: got.s || null })
}

// How long a leg waits for the hub to publish the heights its drill block needs. The slowest
// rails settle a tip only once it is older than their round-abandon window (anchor and attest
// default 120 s, xchain-hub admission_height_watermark.js), counted from the hub's first tip
// read, so a venue booted a moment ago can still show none: two windows plus a margin.
const ADMISSION_HEIGHT_WAIT_MS = 5 * 60 * 1000

/**
 * Wait until indexer `i` holds a published admission height that satisfies every member
 * `tables` names at drill height `B` (`heights[table][coin] >= B - margin`, the indexer's own
 * comparison), and fail with the shortfalls named when it never does. An armed leg calls this
 * BEFORE mining the drill block: a height the hub has not published yet defers the block under
 * that member's reason, which is a venue that was not ready rather than the rule under test
 * (rail 2026-09-17: BF2's block 104 deferred on anchor_reward_attestations "at none, needs -40").
 */
async function waitForAdmissionHeights (venue, i, tables, coin, B, timeoutMs) {
    const budget = timeoutMs || ADMISSION_HEIGHT_WAIT_MS
    const got = await waitForStatus(venue, i, (s) =>
        rows.admissionHeightShortfalls(s.heights, tables, coin, B, fixture.admitMarginBlocks).length === 0, budget)
    const short = rows.admissionHeightShortfalls(got.s && got.s.heights, tables, coin, B, fixture.admitMarginBlocks)
    assert.ok(got.ok, 'the hub never published the admission heights drill block B=' + B + ' needs on indexer ' + i +
        ' inside ' + budget + ' ms: ' + short.map(rows.describeShortfall).join('; '))
    return got.s
}

/**
 * The most a member's admission height can reach at drill block B while a leg holds the chain
 * at B-1: the hub publishes its watermark at most one below its own observed tip, so B-2 is the
 * ceiling no matter how far a member's margin would otherwise let B - margin run (rail
 * 2026-09-17, BF2 block 104: a margin-1 member asked for B-1, which a held chain never reaches).
 */
function heldAdmissionCeiling (B, margin) {
    return Math.min(B - margin, B - 2)
}

/**
 * waitForAdmissionHeights for a leg that holds the chain at B-1 before mining the drill block:
 * each member in `tables` waits at heldAdmissionCeiling(B, its margin) instead of the plain
 * B - margin line, so a low-margin member's wait never asks for a height a held chain cannot
 * publish. Members that land on the same effective height share one poll.
 */
async function waitForHeldAdmissionHeights (venue, i, tables, coin, B, timeoutMs) {
    const groups = new Map()
    for (const t of tables) {
        const margin = fixture.admitMarginBlocks(t)
        const asB = heldAdmissionCeiling(B, margin) + margin
        if (!groups.has(asB)) groups.set(asB, [])
        groups.get(asB).push(t)
    }
    let got = null
    for (const [asB, group] of groups) got = await waitForAdmissionHeights(venue, i, group, coin, asB, timeoutMs)
    return got
}

/** The node's own record of block `height`: hash and stamp, never the pin the leg asked for. */
async function readBlockStamp (btc, height) {
    const node = btc.globals.nodeConnector
    const hash = await node.getBlockHash(height)
    const block = await node.getBlock(hash, 1)
    return { height: Number(height), hash: String(hash), blockTime: Number(block.time), mtp: Number(block.mediantime) }
}

/**
 * Mine ONE block with the node clock pinned at `stampS` (unpinned when null), the miner's
 * adaptive loop paused so nothing else lands in it, and read the stamp back from the node.
 * The pin is released in a finally so a failed leg never leaves the rail's clock pinned.
 *
 * `opts.resume === false` leaves the miner PAUSED after the block, for a leg whose next
 * drill block must be the very next height (BF5's B then B + 1 then B + 2, BF8's LTC run).
 * The leg's last `mineStamped` resumes, and its after hook calls `releaseChain` in case a
 * case failed in between. The clock pin is released either way.
 */
async function mineStamped (btc, stampS, opts) {
    const resume = !(opts && opts.resume === false)
    const miner = btc.globals.regtestMinerConnector
    const before = Number(await btc.globals.nodeConnector.getBlockCount())
    await miner.pauseMining()
    try {
        if (stampS !== null && stampS !== undefined) await miner.setMockTime(Number(stampS))
        await miner.generateBlocks(1)
    } finally {
        if (stampS !== null && stampS !== undefined) await miner.setMockTime(0).catch(() => {})
        if (resume) await miner.resumeMining().catch(() => {})
    }
    const after = Number(await btc.globals.nodeConnector.getBlockCount())
    assert.strictEqual(after, before + 1, 'mineStamped: expected exactly one block, tip went ' + before + ' to ' + after)
    return readBlockStamp(btc, after)
}

/** Mine `count` blocks under one pin, for the parent's spaced 144-block run. */
async function mineSpacedRun (btc, count, stampS) {
    const miner = btc.globals.regtestMinerConnector
    const from = Number(await btc.globals.nodeConnector.getBlockCount())
    await miner.pauseMining()
    try {
        await miner.setMockTime(Number(stampS))
        await miner.generateBlocks(Number(count))
    } finally {
        await miner.setMockTime(0).catch(() => {})
        await miner.resumeMining().catch(() => {})
    }
    const to = Number(await btc.globals.nodeConnector.getBlockCount())
    assert.strictEqual(to, from + Number(count), 'mineSpacedRun: tip went ' + from + ' to ' + to)
    return { from: from + 1, to, first: await readBlockStamp(btc, from + 1), last: await readBlockStamp(btc, to) }
}

/** The stamp a block mined now would have to carry at least: the tip's median-time-past plus one. */
async function minimumStamp (btc) {
    const tip = Number(await btc.globals.nodeConnector.getBlockCount())
    const s = await readBlockStamp(btc, tip)
    return { tip, mtp: s.mtp, floor: s.mtp + 1 }
}

/**
 * The parent's spaced chain (AB2, AB3, AB5): `count` blocks stamped BEHIND wall clock so
 * that the maturity horizon time(B - 144) sits `behindS` seconds back, as far as the
 * tip's median-time-past allows (a stamp at or below it is refused by consensus, so the
 * pin is clamped and the achieved spacing is what the caller asserts on, never the ask).
 *
 * @returns {Promise<{run: object, wantStamp: number, stamp: number, clamped: boolean}>}
 */
async function mineSpacedChain (btc, count, behindS) {
    const floor = await minimumStamp(btc)
    const now = Math.floor(Date.now() / 1000)
    const wantStamp = now - Number(behindS)
    const stamp = Math.max(floor.floor, wantStamp)
    const run = await mineSpacedRun(btc, count, stamp)
    return { run, wantStamp, stamp, clamped: stamp !== wantStamp, floor }
}

/**
 * Put ONE xchain transaction in the mempool so the next block reads price (members 1 to
 * 3 run only on a block that carries a transaction). A BROADCAST v0 from a freshly funded
 * address, driven with the rail's globals installed, is the cheapest one the harness has.
 *
 * Funding needs the adaptive miner RUNNING (the funding helper waits for its block), and
 * the marker needs it PAUSED (or it lands in a block of its own before the leg's pinned
 * block). So: fund, pause, broadcast. The caller mines the pinned block next; `mineStamped`
 * resumes the miner in its finally.
 *
 * A leg that holds the chain still across its setup (BF1) cannot fund here: funding MINES
 * at least two blocks (the funding transaction and the gas mint), and on BF1's walker any
 * block mined after the seed parks forever at the withheld snapshot member. Such a leg calls
 * `fundMarkerAddress` BEFORE `holdBaseline` and `broadcastMarker` after it instead.
 */
async function queueMarkerTransaction (btc, label) {
    const addr = await fundMarkerAddress(btc, label)
    return broadcastMarker(btc, addr, label)
}

/** Fund the marker's address with the miner RUNNING; the blocks this mines land now, not later. */
async function fundMarkerAddress (btc, label) {
    return withRail(btc, async () => {
        const cryptoHelper = require('../../cryptoHelper')
        return cryptoHelper.getNewFundedAddress(label, global.COIN, global.NETWORK, null, 'legacy', 0, 1)
    })
}

/** Broadcast the marker from a funded address with the miner PAUSED, so it waits for the drill block. */
async function broadcastMarker (btc, addr, label) {
    return withRail(btc, async () => {
        const transactionHelper = require('../../transactionHelper')
        // Idempotent when the leg already holds the chain; the pause is what keeps the marker
        // out of any block but the one `mineStamped` mines next.
        await btc.globals.regtestMinerConnector.pauseMining()
        const txid = await transactionHelper.createAndSendTransaction(addr, 'BROADCAST|0|' + label + '|1')
        return { address: addr.address, txid }
    })
}

// What a level wait allows on top of the longest grace a leg configured. A graced member
// opens once the hub's stream watermark passes stamp + grace, the watermark trails wall
// clock, and a held block is re-evaluated once per barrier cycle, so a rung can open up to a
// cycle late: three cycles for that, plus five minutes for a DOGE nudge and a slow poll.
const LEVEL_MARGIN_S = (3 * fixture.BARRIER_CYCLE_S) + 300

/**
 * How long every indexer may take to commit an ORDINARY block stamped `stampS` when one of
 * them carries `graces` (a venue grace object, such as BF1's ladder). The anchor-attest and
 * attest-response members have no escape, so every BTC block waits out their graces, which
 * are the top two rungs of BF1's ladder (630 s and 720 s at the default 90 s step): the
 * budget is the longest grace, plus however far the stamp sits ahead of `nowS`, plus
 * LEVEL_MARGIN_S. A five-minute drain, shorter than those rungs, is what a scratch BF1 drive
 * went red on.
 *
 * @returns {number} milliseconds
 */
function levelBudgetMs (graces, stampS, nowS) {
    const values = Object.values(graces || {}).map(Number).filter(Number.isFinite)
    const longest = values.length ? Math.max(0, ...values) : 0
    const ahead = Number.isFinite(Number(stampS)) && Number.isFinite(Number(nowS)) ? Math.max(0, Number(stampS) - Number(nowS)) : 0
    return (longest + ahead + LEVEL_MARGIN_S) * 1000
}

/**
 * Stop the chain moving: PAUSE the miner, and only then read the tip. Read-then-pause leaves
 * a window in which the adaptive loop lands a block after the read, and every leg that keys
 * rows or a withhold on "the next block" then keys them on a block that is already history.
 *
 * @returns {Promise<{tip: number, stamp: object}>}
 */
async function holdChain (rail) {
    await rail.globals.regtestMinerConnector.pauseMining()
    const tip = Number(await rail.globals.nodeConnector.getBlockCount())
    return { tip, stamp: await readBlockStamp(rail, tip) }
}

/**
 * The after-hook half of `holdChain`: resume the miner so a leg that failed between its hold
 * and its last `mineStamped` never hands the next leg a paused chain. Resuming a running
 * miner is a no-op, so it is safe unconditionally. Never throws: an after hook must still
 * stop the venue.
 */
async function releaseChain (rail) {
    if (!rail || !rail.globals || !rail.globals.regtestMinerConnector) return false
    try {
        await rail.globals.regtestMinerConnector.resumeMining()
        return true
    } catch (_) {
        return false
    }
}

/** The held chain did not move: a block that landed anyway is named here, not as a stall later. */
async function assertChainHeld (rail, tip, what) {
    const now = Number(await rail.globals.nodeConnector.getBlockCount())
    assert.strictEqual(now, Number(tip), (what || 'the held chain') + ' moved from ' + tip + ' to ' + now +
        ' while the miner was paused: a block landed between the baseline and the drill block')
    return now
}

/** Every indexer of `venue` has committed exactly `tip`, the DOGE remedy applied on the way. */
async function levelAtTip (venue, tip, timeoutMs, opts) {
    const idx = venue.indexers.map((ix) => ix.index)
    const want = Number(tip)
    const level = await untilOrClearDogeStall(async () => {
        const all = []
        for (const i of idx) all.push(await statusSnapshot(venue, i))
        return { ok: all.every((s) => s.height === want), all }
    }, Object.assign({ timeoutMs, tipProbe: venueTipProbe(venue, idx[idx.length - 1]) }, (opts && opts.intervalMs) ? { intervalMs: opts.intervalMs } : {}))
    assert.ok(level && level.ok, 'the venue indexers never committed the held baseline ' + want + ' inside ' + timeoutMs + ' ms: ' +
        JSON.stringify(level && level.all && level.all.map((s) => ({ height: s.height, stallReason: s.stallReason }))))
    return level.all
}

/**
 * The setup ORDER every leg that keys rows, a pin or a withhold on "the next block" follows,
 * in one place so it cannot drift per leg:
 *
 *   1. `opts.beforeHold()` runs with the miner RUNNING (funding a marker waits for blocks);
 *   2. the miner is paused, then the baseline tip is read (`holdChain`);
 *   3. every indexer commits exactly that tip, inside a budget sized from `opts.graces`
 *      (`levelBudgetMs`) unless `opts.levelTimeoutMs` names one;
 *   4. the tip is read again and must not have moved (`assertChainHeld`).
 *
 * The leg arms its withhold and seeds its rows only AFTER this returns. The pause is lifted by
 * the leg's drill `mineStamped` and, on a failed case, by `releaseChain` in its after hook.
 *
 * @returns {Promise<{tip: number, stamp: object, levelTimeoutMs: number, before: *}>}
 */
async function holdBaseline (rail, venue, opts) {
    const o = opts || {}
    const before = o.beforeHold ? await o.beforeHold() : undefined
    const held = await holdChain(rail)
    const levelTimeoutMs = Number(o.levelTimeoutMs) ||
        levelBudgetMs(o.graces, held.stamp.blockTime, Math.floor(Date.now() / 1000))
    await levelAtTip(venue, held.tip, levelTimeoutMs, { intervalMs: o.intervalMs })
    await assertChainHeld(rail, held.tip, o.label ? o.label + ' chain' : undefined)
    console.log('BF held baseline' + (o.label ? ' (' + o.label + ')' : '') + ': miner paused at tip ' + held.tip +
        ' stamped ' + held.stamp.blockTime + ', every indexer level, budget ' + levelTimeoutMs + ' ms')
    return Object.assign(held, { levelTimeoutMs, before })
}

/** Inject inert rows into every followed hub and let the followers re-page them. */
async function seedMirrors (venue, seeds) {
    const written = []
    for (const s of seeds) {
        const out = await venue.injectMirrorRow(s.row, { table: s.table, key: s.key, reconnect: false })
        written.push({ table: s.table, out })
    }
    for (const ix of venue.indexers) ix.mirrorProxy.dropSockets()
    return written
}

/** Wait until indexer `i`'s mirror holds `n` rows of `table` (the seeds arrived). */
async function waitForMirrorRows (venue, i, table, n, timeoutMs) {
    const ix = venue.indexers[i]
    const got = await until(async () => {
        try {
            const r = await queryDb(venue, ix.mirrorDbName, 'SELECT COUNT(*) AS n FROM `' + table + '`')
            return { ok: Number(r[0].n) >= n, n: Number(r[0].n) }
        } catch (e) { return { ok: false, error: String(e && e.message) } }
    }, timeoutMs || 5 * 60 * 1000, POLL_MS)
    assert.ok(got.ok, 'indexer ' + i + ' never mirrored ' + n + ' rows of ' + table + ': ' + JSON.stringify(got))
    return got
}

/**
 * Prove the federation stayed QUIET for a block stamped t(B): no finalized row in any
 * seeded table carries `effective_time >= t(B)` on the hub an indexer follows, so no
 * content escape could have opened a member early (family section 2).
 */
async function assertFederationQuiet (venue, hubIndex, coin, blockTime, tables) {
    const hub = venue.hubs[hubIndex]
    const found = {}
    for (const t of tables || Object.keys(rows.COIN_SCOPE)) {
        const q = rows.contentEscapeSql(t, coin, blockTime)
        const r = await queryDb(venue, hub.dbName, q.sql, q.args)
        found[t] = Number(r[0].n)
    }
    const loud = Object.keys(found).filter((t) => found[t] > 0)
    assert.deepStrictEqual(loud, [], 'the federation was not quiet: rows effective at or past t(B)=' + blockTime +
        ' landed on hub ' + hubIndex + ' in ' + JSON.stringify(found) + '; a full-hold assertion is not meaningful')
    return found
}

/** The keys of the rows readable at B on `chain` in indexer `i`'s MIRROR, by the IS NULL OR rule. */
async function mirrorReadableSet (venue, i, table, chain, blockHeight, blockTime) {
    const q = rows.readableRowsSql(table, chain, blockHeight, blockTime)
    const r = await queryDb(venue, venue.indexers[i].mirrorDbName, q.sql, q.args)
    return r.map((x) => String(x.k)).sort()
}

/** Every finalized row of `table` on hub `h`, for the fixture's expected set. */
async function hubRows (venue, h, table) {
    return queryDb(venue, venue.hubs[h].dbName, 'SELECT * FROM `' + table + '` WHERE ' + rows.finalizedClause(table) + ' ORDER BY id ASC')
}

/** The state and action hashes of indexer `i` at `height`, through its own API. */
async function blockHashesOf (venue, i, height) {
    const conn = new XChainIndexerConnector('127.0.0.1', venue.indexers[i].apiPort, null)
    const h = await conn.call('getblockhashes', { block_index: Number(height) })
    assert.ok(h && !h.error, 'indexer ' + i + ' would not report hashes at ' + height + ': ' + JSON.stringify(h))
    return h
}

/**
 * The parent's spaced chain, placed and PROVEN: 144 blocks whose horizon time(B - 144)
 * sits behind wall clock by the arrival margin plus the grace, so the horizon form
 * `min(t(B), horizon + margin) + grace` is already in the past when B arrives. When the
 * tip's median-time-past clamps the stamp, the leg waits for wall clock to pass the
 * window instead of asserting a spacing it did not get; then every indexer is levelled.
 */
async function spaceChainBehindMargin (btc, venue, marginS, graceS) {
    const maturity = 144
    const spaced = await mineSpacedChain(btc, maturity, Number(marginS) + Number(graceS) + 60)
    const horizonOpensAt = spaced.run.first.blockTime + Number(marginS) + Number(graceS)
    const waitS = horizonOpensAt + 5 - Math.floor(Date.now() / 1000)
    if (waitS > 0) {
        console.log('BF spaced chain clamped at the tip\'s median time; waiting ' + waitS + ' s for the horizon window to pass')
        // Bounded condition wait on the same clock test the assert below makes,
        // instead of a fixed sleep sized off a guess of how long that takes.
        await until(async () => ({ ok: Math.floor(Date.now() / 1000) >= horizonOpensAt }), (waitS + 10) * 1000, 1000)
    }
    await levelIndexers(venue)
    assert.ok(Math.floor(Date.now() / 1000) >= horizonOpensAt, 'the horizon window is still ahead of wall clock')
    return Object.assign(spaced, { horizonOpensAt, maturity })
}

/** The validator_rewards row count an indexer holds, the parent's second identity. */
async function rewardCount (venue, i) {
    const r = await queryDb(venue, venue.indexers[i].indexerDbName, 'SELECT COUNT(*) AS n FROM validator_rewards')
    return Number(r[0].n)
}

/** Committed-height watcher on the indexer's own blocks table, wrapped with the DOGE clear. */
async function waitCommitted (venue, i, height, timeoutMs) {
    const got = await untilOrClearDogeStall(async () => {
        const s = await statusSnapshot(venue, i)
        return { ok: s.height !== null && s.height >= Number(height), s }
    }, { timeoutMs: timeoutMs || 15 * 60 * 1000, tipProbe: venueTipProbe(venue, i) })
    return got
}

/**
 * Indexer i's mirror rows for one attestation request, with the admission column this
 * coin binds on (`admit_block_btc` for attestation responses on every chain) and the
 * signatures, the two facts that make a row a signed admission-era corpus row.
 * `deps` passes through to queryDb for the unit tier.
 */
async function readAdmissionRows (venue, requestId, coin, deps) {
    const column = fixture.admissionColumn('attestation_responses', coin)
    const out = []
    for (const ix of venue.indexers) {
        out.push(await queryDb(venue, ix.mirrorDbName,
            'SELECT id, response_hash, status, effective_time, signatures, `' + column + '` FROM attestation_responses ' +
            'WHERE request_id = ? ORDER BY id ASC', [String(requestId)], deps))
    }
    return { column, rows: out }
}

/**
 * Where indexer i's corpus lives, in the shape rows.replayWitnessCommand takes: the
 * decoder schema the venue borrowed, the mirror schema, the server both sit on, and
 * whether the mirror's server is a throwaway the venue removes at stop. The password
 * is named by its variable (the one disposableHubDb reads), never carried. `coinCode` is the
 * venue evidence's upper-case code.
 */
function corpusCoordinates (venue, i, coinCode) {
    const ix = venue.indexers[i]
    assert.ok(ix, 'corpusCoordinates: no indexer ' + i)
    // `_live` is the venue's resolved standing-stack record; the decoder schema has no public accessor.
    const decoder = (venue._live && venue._live.decoder) || {}
    return {
        coin: coinCode,
        network: venue.network,
        decoderDb: decoder.name,
        decoderServer: { host: decoder.host, port: decoder.port },
        mirrorDb: ix.mirrorDbName,
        db: { host: venue.hubDb.host, port: venue.hubDb.port, user: venue.hubDb.user },
        passEnv: 'HUB_DB_PASS',
        hubDbDisposable: !!venue.hubDb.disposable,
    }
}

/**
 * Why the build root's indexer cannot load the VM, or null when it can. The indexer
 * reaches it through `xchain-indexer/node_modules/xchain-vm`, a link to
 * `xchain-indexer/xchain-vm`, itself a link a worktree may point at an absolute path
 * on another host; a tree copied across hosts keeps that link and every venue indexer
 * then dies at boot on `Cannot find module 'xchain-vm'`. Named here, by link, before
 * the venue spends minutes booting children that cannot start.
 */
function vmLinkProblem (repoRoot) {
    const entry = path.join(repoRoot, 'xchain-indexer', 'node_modules', 'xchain-vm')
    try {
        if (fs.existsSync(path.join(fs.realpathSync(entry), 'package.json'))) return null
    } catch (_) { /* a dangling link lands here; the hops below name it */ }
    const hops = [entry, path.join(repoRoot, 'xchain-indexer', 'xchain-vm')].map((p) => {
        let target = null
        try { target = fs.readlinkSync(p) } catch (_) { target = fs.existsSync(p) ? '(not a link)' : '(missing)' }
        return path.relative(repoRoot, p) + ' -> ' + target
    })
    return 'the build root\'s indexer cannot load xchain-vm: ' + hops.join('; ') + '. Re-link it inside the tree: ' +
        'ln -sfn ../xchain-vm ' + path.join(repoRoot, 'xchain-indexer', 'xchain-vm')
}

module.exports = {
    STAMP_AHEAD_S,
    POLL_MS,
    LEG_FLOOR_MS,
    bootFamilyVenue,
    levelIndexers,
    statusSnapshot,
    holdSnapshot,
    waitForStatus,
    ADMISSION_HEIGHT_WAIT_MS,
    waitForAdmissionHeights,
    heldAdmissionCeiling,
    waitForHeldAdmissionHeights,
    readBlockStamp,
    mineStamped,
    mineSpacedRun,
    mineSpacedChain,
    spaceChainBehindMargin,
    rewardCount,
    minimumStamp,
    queueMarkerTransaction,
    fundMarkerAddress,
    broadcastMarker,
    LEVEL_MARGIN_S,
    levelBudgetMs,
    holdChain,
    releaseChain,
    assertChainHeld,
    levelAtTip,
    holdBaseline,
    seedMirrors,
    waitForMirrorRows,
    assertFederationQuiet,
    mirrorReadableSet,
    hubRows,
    blockHashesOf,
    waitCommitted,
    readAdmissionRows,
    corpusCoordinates,
    vmLinkProblem,
}
