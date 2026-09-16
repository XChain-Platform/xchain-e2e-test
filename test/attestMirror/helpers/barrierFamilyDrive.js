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
        for (const i of idx) all.push(await statusSnapshot(venue, i))
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
 */
async function mineStamped (btc, stampS) {
    const miner = btc.globals.regtestMinerConnector
    const before = Number(await btc.globals.nodeConnector.getBlockCount())
    await miner.pauseMining()
    try {
        if (stampS !== null && stampS !== undefined) await miner.setMockTime(Number(stampS))
        await miner.generateBlocks(1)
    } finally {
        if (stampS !== null && stampS !== undefined) await miner.setMockTime(0).catch(() => {})
        await miner.resumeMining().catch(() => {})
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
 */
async function queueMarkerTransaction (btc, label) {
    return withRail(btc, async () => {
        const cryptoHelper = require('../../cryptoHelper')
        const transactionHelper = require('../../transactionHelper')
        const addr = await cryptoHelper.getNewFundedAddress(label, global.COIN, global.NETWORK, null, 'legacy', 0, 1)
        await btc.globals.regtestMinerConnector.pauseMining()
        const txid = await transactionHelper.createAndSendTransaction(addr, 'BROADCAST|0|' + label + '|1')
        return { address: addr.address, txid }
    })
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
        await new Promise((r) => setTimeout(r, waitS * 1000))
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

module.exports = {
    STAMP_AHEAD_S,
    POLL_MS,
    LEG_FLOOR_MS,
    bootFamilyVenue,
    levelIndexers,
    statusSnapshot,
    holdSnapshot,
    waitForStatus,
    readBlockStamp,
    mineStamped,
    mineSpacedRun,
    mineSpacedChain,
    spaceChainBehindMargin,
    rewardCount,
    minimumStamp,
    queueMarkerTransaction,
    seedMirrors,
    waitForMirrorRows,
    assertFederationQuiet,
    mirrorReadableSet,
    hubRows,
    blockHashesOf,
    waitCommitted,
}
