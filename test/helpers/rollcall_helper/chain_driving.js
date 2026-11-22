/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 ********************************************************************/

'use strict'

const assert = require('assert')
const chainRail = require('../chainRail')
const {
    closeHeightOf,
    internalResolveSibling,
    rca,
} = require('./sibling_resolution')
const {
    tickAll,
    waitForGossip,
} = require('./venue_lifecycle')
const { rollcallRow } = require('./database_reads')

// ── the drive ────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

// Mine BTC to `height` and wait for the indexer to reach it. A close block that
// DEFERS never arrives, so the timeout says that rather than reporting an
// anonymous stall: this is the single most likely way an unseeded or
// half-configured venue fails, and it must never look like a mystery.
async function mineBtcTo(ctx, height, label){
    let tip = await ctx.btcTip()
    while (tip < height){
        const need = Math.min(height - tip, 25)
        await regtestMinerConnector.generateBlocks(need)
        await utxoTrackerConnector.quiesce({ timeoutMs: 60000, pollMs: 250, regtestMiner: regtestMinerConnector })
        const deadline = Date.now() + 180000
        let seen = tip
        let nudged = 0
        while (Date.now() < deadline){
            seen = await ctx.btcTip()
            if (seen >= Math.min(height, tip + need)) break
            // A stalled tip whose NEXT block is a close is usually not a
            // misconfiguration, it is a one-second cadence race: the close needs
            // doge.tip_block_time > btc.block_time(E + W), and on regtest both
            // stamps are wall clock, so mining BTC past the window end in the
            // same instant as the last DOGE block leaves the DOGE side short by
            // as little as ONE SECOND (measured on the venue: doge tip 1788142312
            // against a window end of 1788142313). It is also how a FAILED drive
            // wedges the venue for every later run - the epoch's BTC side is
            // mined and its DOGE follow-up never happens, so the next run stalls
            // on someone else's half-driven epoch.
            //
            // Mining DOGE distinguishes the two cases instead of guessing: the
            // race clears, while a missing DOGE_INDEXER_API_URL or an unreadable
            // manifest still stalls and still fails below with its real message.
            if (rca().rollcallEpochClosingAt(seen + 1, ctx.network) !== null && nudged < 6){
                nudged++
                await mineDoge(ctx, 2)
            }
            await sleep(1500)
        }
        assert.ok(seen > tip,
            'the BTC indexer stopped advancing at ' + seen + ' while mining toward ' + height + ' (' + label + '). ' +
            'A ROLLCALL close that cannot prove its DOGE evidence throws RollcallProofUnavailableError and the ' +
            'block is retried forever. Check whether block ' + (seen + 1) + ' is a close height, whether the BTC ' +
            'indexer has DOGE_INDEXER_API_URL set, and whether the DOGE indexer reports a real manifest_hash.')
        tip = seen
    }
    return tip
}

/**
 * Run `work` while mining BTC underneath it, and settle exactly as `work` does.
 *
 * A broadcast-then-wait helper (`sendSendV0`, `sendCollectV0`) polls for its row
 * on a fixed budget and extends that budget only when the indexer is visibly
 * behind or still writing. Neither signal fires when the transaction is simply
 * waiting for a BLOCK: the indexer is at the tip, idle, and correct. Measured
 * 2026-09-04: AT10's pool-funding SEND was refused as "never landed" after 60s
 * with `last indexer lag 1 blocks`, and the indexer logged the very same
 * transaction `SEND : XCHAIN : 108 : valid` moments later. The venue's own miner
 * cadence decided it, which is not something the drill should be losing to.
 *
 * Mining while waiting removes the dependency without touching the wait's own
 * budget or its diagnostics.
 */
async function mineWhile(ctx, work, everyMs){
    let settled = false
    const p = Promise.resolve(work()).finally(() => { settled = true })
    const miner = (async () => {
        while (!settled){
            await sleep(everyMs || 5000)
            if (settled) break
            try { await mineBtcTo(ctx, (await ctx.btcTip()) + 1, 'confirming an in-flight transaction') }
            catch (e) { /* the wait below reports the real failure */ }
        }
    })()
    try { return await p }
    finally { await miner }
}

// Land one ROLLCALL payload on DOGE, the only route this harness has to that
// chain. Every ROLLCALL is a two-phase P2SH action and transactionHelper drives
// exactly that pipeline, plus the native DOGE fee output the chain requires; the
// only thing the wrapper adds is the regtest block production a live chain
// supplies on its own.
//
// The hubs' broadcast hook calls this, and so does a drill that hand-builds an
// action the engine deliberately would not (a sweep, a self-publish, a validator
// naming a SHORTER gate list). One route, so the two can never differ in
// anything but the bytes, and every landed payload appears in ctx.publishedWires
// whoever built it.
async function publishWire(ctx, payload){
    const transactionHelper = require('../core/transactionHelper')
    return await chainRail.withRail(ctx.dogeRail, async () => {
        const txid = await transactionHelper.createAndSendTransaction(ctx.dogePublisher, payload)
        ctx.publishedWires.push({ payload, txid })
        await regtestMinerConnector.generateBlocks(1)
        await utxoTrackerConnector.quiesce({ timeoutMs: 60000, pollMs: 250, regtestMiner: regtestMinerConnector })
        return { txid }
    })
}

async function mineDoge(ctx, n){
    return await chainRail.withRail(ctx.dogeRail, async () => {
        await regtestMinerConnector.generateBlocks(n)
        await utxoTrackerConnector.quiesce({ timeoutMs: 60000, pollMs: 250, regtestMiner: regtestMinerConnector })
        return Number((await indexerConnector.call('getblockhashes', {})).block_index)
    })
}

/**
 * Drive one epoch from its first signable tick through its close.
 *
 * `opts.silentHubs`  hub indexes that must NOT sign this epoch. Their engine is
 *                    stopped before the round is created, so they neither sign
 *                    nor gossip, exactly as a stopped hub would not.
 * `opts.beforePublish` optional hook run after the signing tick and before the
 *                    publishing tick, so a suite can hold a signature back.
 * `opts.expectClose` when false, the epoch's close is NOT mined to and no
 *                    `rollcalls` row is awaited (the proof-barrier suite drives
 *                    the close itself).
 */
// Per-hub round state, printed on demand. Opt-in via XC_ROLLCALL_TRACE=1 so a
// normal run stays readable.
//
// WHY THIS EXISTS: when an epoch closes with fewer present sources than the hubs
// that signed, the log says only that a publish happened with N pairs, and every
// candidate explanation (gossip had not crossed the mesh, the rank ladder had
// not unlocked, the DOGE read was undecidable so a sweeper deferred, the elected
// leader was the hub the test silenced) produces the SAME single line. The
// engines already hold the answer; this prints it rather than making the next
// reader guess between four theories, which is what cost this lane a session.
async function traceRounds(ctx, label){
    if (process.env.XC_ROLLCALL_TRACE !== '1') return
    const tip = await ctx.btcTip()
    const rows = ctx.rounds.map((eng, i) => {
        const s = (eng && eng.getStatus && eng.getStatus()) || {}
        return '      hub ' + i + ' epoch=' + s.epoch + ' signed=' + s.signed +
               ' gossiped=' + s.gossiped_count + ' onchain=' + s.on_chain_count +
               ' rank=' + s.our_rank + ' leader=' + String(s.leader || '').slice(0, 12) +
               ' txids=' + (Array.isArray(s.txids) ? s.txids.length : 0)
    })
    console.log('    [trace] ' + label + ' (btc tip ' + tip + ', since=' + (tip - Number(ctx['_traceEpoch'] || 0)) + ')')
    for (const r of rows) console.log(r)
}

// The rank ladder climbs with BTC HEIGHT, so a publish phase that ticks at a
// fixed height cannot exercise it.
//
// Measured on the venue: with hub 2 silenced, the elected LEADER was hub 2
// (rank 0, never publishes), the hub holding BOTH signatures was rank 3, and the
// only unlocked hub held just its own. rankUnlocked allows rank <= floor(since /
// ELECTION_TOLERANCE), so at since = 6 with a regtest tolerance of 3 only ranks
// 0..2 can ever publish - and every tick happened at since = 6. One signature
// reached the chain, the epoch closed UNROLLED at present 1/4, and it read as a
// protocol failure when it was the harness holding the chain still.
//
// So mine FORWARD through the publish phase, which is also what a real venue
// does, and stop as soon as the DOGE side actually holds every signature we
// expect rather than after a fixed number of ticks.
function electionTolerance(network){
    const mod = require(internalResolveSibling('xchain-hub', 'src/rollcall/round.js'))
    const t = mod.ELECTION_TOLERANCE_DEFAULTS && mod.ELECTION_TOLERANCE_DEFAULTS[network]
    assert.ok(Number.isFinite(Number(t)) && Number(t) > 0,
        'cannot read ELECTION_TOLERANCE_DEFAULTS.' + network + ' from the shipped RollcallRound; the ladder ' +
        'arithmetic here must come from the engine rather than be re-derived')
    return Number(t)
}

// Which pubkeys the DOGE side already carries for this epoch.
async function onChainSigners(ctx, epoch, pubkeys){
    const res = await ctx.dogeRail.globals.indexerConnector.call('getrollcallsigners', {
        network: ctx.network, epoch_height: epoch, max_block_time: 9999999999,
        pubkeys: pubkeys, publishers: [],
    })
    if (!res || res.error) return new Set()
    // The read echoes EVERY pubkey it was asked about and puts null against the
    // ones it has no signature for, so Object.keys() counts absences as
    // presences. Measured: a bounded ask for three keys with one on chain comes
    // back as three keys, two of them null - and taking the key list made this
    // helper report full coverage after a single publish, which ended the ladder
    // climb before it began.
    return new Set(Object.entries(res.signers || {})
        .filter(([, v]) => v && v.sig)
        .map(([k]) => String(k).toLowerCase()))
}

// Wait until the DOGE side actually HOLDS `pubkeys` for `epoch`, mining DOGE
// while it waits. A ROLLCALL rides the two-phase P2SH lane, so a publish is not
// on chain when the call returns: both legs have to confirm and the DOGE indexer
// has to index them. Every read-after-publish in the acceptance suites needs
// this, and the two that used a fixed `mineDoge(3)` instead both failed for the
// same reason on 2026-09-03: a sweeper that ticks before the leader's action is
// visible sees nothing on chain to filter and republishes the whole set
// (SIG_COUNT 3 where the test asserts 1), and a self-publish asserted too early
// reads as never stored. Neither was a protocol fault; both were the harness
// racing its own publish.
async function waitForOnChainSigners(ctx, epoch, pubkeys, timeoutMs){
    const want = pubkeys.map(k => String(k).toLowerCase())
    const deadline = Date.now() + (timeoutMs || 120000)
    let have = new Set()
    while (Date.now() < deadline){
        have = await onChainSigners(ctx, epoch, want)
        if (want.every(k => have.has(k))) return have
        await mineDoge(ctx, 2)
        await sleep(2000)
    }
    const missing = want.filter(k => !have.has(k))
    // This wait mines DOGE and nothing else, so it can only ever finish a
    // publish that some hub already SENT. A signature nobody published never
    // arrives here however long it runs, and that is the likelier cause on this
    // rail than a lost leg: rank unlock is a function of BTC HEIGHT, so a caller
    // that ticks at a fixed height leaves every rank above floor(since /
    // ELECTION_TOLERANCE) locked forever. Measured 2026-09-04, epoch 5700: all
    // three hubs signed, ranks 0 and 2 published, rank 3 never did, and this
    // message blamed the DOGE lane for it. Say both causes, and say the
    // arithmetic, because only one of them is fixed by waiting.
    let sinceText = ''
    try {
        const tip = await ctx.btcTip()
        sinceText = ' BTC tip ' + tip + ', so since = ' + (tip - epoch) + ' and ranks up to ' +
                    Math.floor(Math.max(0, tip - epoch) / electionTolerance(ctx.network)) + ' are unlocked.'
    } catch (e) { sinceText = '' }
    throw new Error(
        'epoch ' + epoch + ': the DOGE side never stored signature(s) ' +
        missing.map(k => k.slice(0, 12)).join(', ') + ' within ' + (timeoutMs || 120000) + 'ms, after mining DOGE ' +
        'throughout.' + sinceText + ' Either no hub ever PUBLISHED that pair (climb the rank ladder with ' +
        'climbPublishLadder rather than ticking in place), or a published leg never confirmed - a ROLLCALL rides ' +
        'the two-phase P2SH lane, so check the run\'s publish.spend.jsonl for a `sent` line carrying the key ' +
        'before reading the DOGE indexer log.')
}

/**
 * Drive the publish phase as a CLIMB, and stop as soon as the DOGE side holds
 * every expected signature.
 *
 * Rank unlock is `rank <= floor(sinceBlocks / ELECTION_TOLERANCE)` with
 * `sinceBlocks = btcTip - epoch` (`RollcallRound.rankUnlocked`), so which hubs
 * may publish is decided by BTC HEIGHT and not by how many times the harness
 * ticks. Ticking in place therefore publishes the low ranks and leaves the high
 * ones locked for the life of the run - the run-5 failure, and again on
 * 2026-09-04 in AT9, which ticked twice at `E + 6` (ranks 0..2 with the regtest
 * tolerance of 3), got ranks 0 and 2 on chain, and then waited two minutes for a
 * rank-3 signature no hub was allowed to send.
 *
 * `maxHeight` caps the climb. It defaults to the window end; a caller that must
 * mine the window end itself under its own preconditions (AT9 freezes DOGE
 * first) passes `windowEnd - 1` so the ladder never reaches it. Returns the keys
 * still off chain, so a caller can decide whether that is fatal.
 */
async function climbPublishLadder(ctx, epoch, pubkeys, opts){
    const o          = opts || {}
    const silentHubs = o.silentHubs || []
    const wantKeys   = pubkeys.map(k => String(k).toLowerCase())
    const tolerance  = electionTolerance(ctx.network)
    const windowEnd  = rca().rollcallWindowEndHeight(epoch, ctx.network)
    const ceiling    = Number.isFinite(Number(o.maxHeight)) ? Number(o.maxHeight) : windowEnd

    for (let round = 0; ; round++){
        await tickAll(ctx.mvh, silentHubs)
        await mineDoge(ctx, 3)
        await tickAll(ctx.mvh, silentHubs)
        await traceRounds(ctx, 'publish round ' + round)

        const on = await onChainSigners(ctx, epoch, wantKeys)
        const missing = wantKeys.filter(k => !on.has(k))
        if (missing.length === 0){
            console.log('    epoch ' + epoch + ': all ' + wantKeys.length + ' expected signature(s) on chain')
            return []
        }
        const tip = await ctx.btcTip()
        if (tip + tolerance > ceiling){
            console.log('    epoch ' + epoch + ': height ceiling ' + ceiling + ' reached with ' + missing.length +
                        ' signature(s) still off chain (' + missing.map(k => k.slice(0, 12)).join(', ') + ')')
            return missing
        }
        await mineBtcTo(ctx, tip + tolerance, 'unlocking the next rank for epoch ' + epoch)
    }
}

async function driveEpoch(ctx, epoch, opts){
    const o = opts || {}
    const silentHubs = o.silentHubs || []
    const network    = ctx.network
    const closeBlock = closeHeightOf(epoch, network)
    const windowEnd  = rca().rollcallWindowEndHeight(epoch, network)
    console.log('    epoch ' + epoch + ': window end ' + windowEnd + ', close ' + closeBlock +
                (silentHubs.length ? ', silent hub(s) ' + silentHubs.join(',') : ''))

    for (const i of silentHubs) await ctx.rounds[i].stop()

    // A round exists only once the epoch block is buried by
    // CANONICAL_REORG_BUFFER (RollcallRound.newestSignableEpoch), so mine past
    // it before the first tick or every engine skips the epoch entirely.
    await mineBtcTo(ctx, epoch + 6, 'burying epoch ' + epoch)

    const want = ctx.rounds.length - silentHubs.length
    ctx['_traceEpoch'] = epoch
    const gossiped = await waitForGossip(ctx.mvh, epoch, want, 120000, silentHubs, ctx)
    await traceRounds(ctx, 'after gossip')
    assert.ok(gossiped >= want,
        'epoch ' + epoch + ': expected ' + want + ' gossiped signature(s) across the mesh, saw ' + gossiped +
        '. Every hub signs regardless of whether it can publish, so a short count is a signing or gossip ' +
        'failure, not a publish failure.')

    if (typeof o.beforePublish === 'function') await o.beforePublish()

    // Climb the rank ladder instead of ticking in place: which hub may publish
    // is a function of BTC height, not of tick count. One implementation, shared
    // with the AT9 leg, because the two drifted apart once already and the copy
    // that ticked in place could never publish the top rank.
    const wantKeys  = ctx.roster.slice(0, ctx.rounds.length)
        .filter((internal, i) => !silentHubs.map(Number).includes(i))
        .map(r => r.pubkey)
    await climbPublishLadder(ctx, epoch, wantKeys, { silentHubs, maxHeight: windowEnd })

    if (typeof o.afterPublish === 'function') await o.afterPublish()

    // The window-end block_time is the cut basis and must exist as a STORED
    // header stamp before the close reads it.
    await mineBtcTo(ctx, windowEnd, 'window end for epoch ' + epoch)

    if (o.expectClose === false) return { closeBlock, windowEnd }

    // The DOGE side must then pass that stamp and bury the cut by
    // ROLLCALL_DOGE_MATURITY. DOGE is mined AFTER the BTC window end so its
    // header stamps are strictly later than the cut basis.
    await mineDoge(ctx, 2 + Number(rca().ROLLCALL_DOGE_MATURITY[network]) + 2)
    await mineBtcTo(ctx, closeBlock, 'close of epoch ' + epoch)

    const deadline = Date.now() + 180000
    let row = null
    while (Date.now() < deadline){
        row = await rollcallRow(ctx, epoch)
        if (row) break
        await sleep(2000)
    }
    assert.ok(row,
        'epoch ' + epoch + ' wrote no `rollcalls` row even though the BTC indexer reached its close block ' +
        closeBlock + '. The close writes a row on every path it can reach, including the unrolled ones, so no ' +
        'row means the close never ran on this indexer.')

    for (const i of silentHubs) await ctx.rounds[i].start()
    return row
}

module.exports = {
    sleep,
    mineBtcTo,
    mineDoge,
    mineWhile,
    publishWire,
    driveEpoch,
    waitForOnChainSigners,
    climbPublishLadder,
    onChainSigners,
    electionTolerance,
}
