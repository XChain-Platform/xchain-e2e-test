'use strict'

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
 **********************************************************************
 */

const assert = require('assert')

const { DEFAULT_INTERVAL_MS, sleep } = require('./arithmeticAndVerdicts')

// How long a BTC indexer may sit BEHIND ITS OWN DECODER without advancing before
// this module treats it as the roll-call wedge below and mines DOGE. Long enough
// that an ordinary slow block or a busy venue is not mistaken for it.
const ROLLCALL_STALL_AFTER_MS = 45_000

// DOGE blocks per nudge. Three cleared it when it was measured on this venue; the
// figure only has to carry the DOGE tip past the epoch window end, and mining more
// than needed changes what a batch-window drill measures.
const DOGE_NUDGE_BLOCKS = 3

// A bounded number of nudges, so a genuinely broken venue still fails with its own
// message instead of being mined at forever.
const MAX_DOGE_NUDGES = 6

// The ONE stall reason this remedy is for. Checked as well as the behind-its-decoder
// condition, and both are required, deliberately: a node stuck for any OTHER reason is
// a finding to report rather than something to mine DOGE at, and a predicate that
// swallowed every stall would hide exactly the defect a drill exists to find. This is
// the same pair `mirrorDrillFixture.withWedgeClear` tests, so the two halves of the
// remedy cannot drift into disagreeing about what the wedge is.
const ROLLCALL_STALL_REASON = 'rollcall_proof_unavailable'

// Beyond this many blocks behind its decoder, a node with no stated stall reason is
// taken to be catching up rather than stalled. A venue indexer starts at genesis, so
// early in a drill it is legitimately hundreds behind.
const CATCHUP_LAG_BLOCKS = 50

// BTC blocks per DOGE keep-up in a long mining run. The wedge was measured
// re-forming every 25 to 30 BTC blocks with DOGE still, so this sits comfortably
// inside that: often enough that a run cannot wedge itself, rare enough that the
// DOGE tip is not being advanced on a schedule.
const BTC_BLOCKS_PER_DOGE_KEEPUP = 12

// BTC blocks mined through this module since the other chain was last moved.
//
// MODULE-LEVEL AND CUMULATIVE, because the wedge does not care how a caller
// chunked its mining: it cares how many BTC blocks have landed since that chain
// last advanced. A per-call counter looks equivalent and is not, and the
// difference cost a release: a tool that mined 14 blocks and then ten more, six
// times, fired the keep-up ONCE, because every later call was a single chunk with
// no "between" in it. Seventy-four BTC blocks went by on three DOGE blocks and the
// wedge re-formed exactly as predicted.
let btcSinceDogeKeepUp = 0

function wedgeVerdict (sample, since, nowMs, opts) {
    const stallAfterMs = Number((opts || {}).stallAfterMs) || ROLLCALL_STALL_AFTER_MS
    // Refuses null and '' BY NAME rather than through Number(), which turns both
    // into 0. A booting node whose /status carries a null indexerBlock would
    // otherwise read as height 0, i.e. thousands of blocks behind its decoder, and
    // this would mine DOGE at a venue that is merely still starting up.
    const num = (v) => (v === null || v === undefined || v === '' || typeof v === 'boolean') ? NaN : Number(v)
    const height  = sample ? num(sample.height) : NaN
    const decoder = sample ? num(sample.decoder) : NaN
    if (!Number.isFinite(height)) return { nudge: false, why: 'no height reading yet' }
    if (since && Number.isFinite(Number(since.height)) && height > Number(since.height)) {
        return { nudge: false, why: 'advancing' }
    }
    if (!Number.isFinite(decoder)) return { nudge: false, why: 'no decoder reading to compare against' }
    if (height >= decoder) {
        return { nudge: false, why: 'level with its decoder, so it has nothing to process and is idle rather than wedged' }
    }
    const heldMs = nowMs - Number((since && since.atMs) || nowMs)
    if (!(heldMs >= stallAfterMs)) {
        return { nudge: false, why: 'behind its decoder for only ' + heldMs + 'ms, inside the ' + stallAfterMs + 'ms grace' }
    }
    // BOTH CONDITIONS, never either. A node stuck behind its decoder for some OTHER
    // reason is a finding, and mining DOGE at it would neither help nor be honest: it
    // would convert an unexplained stall into a slower unexplained stall while the
    // drill's own failure message pointed at whatever it happened to be waiting for.
    const reason = String((sample && sample.reason) || '')
    if (reason !== ROLLCALL_STALL_REASON) {
        // A LARGE LAG WITH NO STATED REASON IS ORDINARY CATCH-UP, not a finding. A
        // fresh venue indexer replays the chain from genesis and can sit tens of
        // seconds on one heavy block, which looks identical to "stuck" through a
        // height sample. Measured: a node 185 blocks behind, reported as a stall of
        // a shape nobody had seen, that was simply still syncing and reached the tip
        // on its own. What IS anomalous is a node close to its decoder, with nothing
        // left to do, that still will not advance and states no reason.
        const lag = decoder - height
        if (lag > CATCHUP_LAG_BLOCKS) {
            return {
                nudge: false,
                why: 'behind its decoder by ' + lag + ' blocks with no stall reason, which is ordinary ' +
                     'catch-up rather than a stall: a fresh indexer replaying the chain pauses on heavy ' +
                     'blocks and reaches the tip on its own',
            }
        }
        return {
            nudge: false,
            finding: true,
            why: 'STUCK at ' + height + ', only ' + (decoder - height) + ' block(s) behind its decoder ' +
                 'at ' + decoder + ', for ' + heldMs + 'ms, with the stall reason ' +
                 (reason || 'absent') + ' rather than ' + ROLLCALL_STALL_REASON + '. It is NOT catch-up ' +
                 'either, since there is almost nothing left to process, and it is not the wedge this ' +
                 'remedy is for, so nothing is mined and it is reported instead',
        }
    }
    return {
        nudge: true,
        why: 'held at ' + height + ' with its decoder at ' + decoder + ' for ' + heldMs +
             'ms on ' + reason + ', which is the roll-call wedge: the epoch cannot be decided until ' +
             'the DOGE tip passes the window end',
    }
}

/**
 * Mine DOGE regtest blocks, which is the whole remedy.
 *
 * Goes through `chainRail` rather than dialling the DOGE miner directly, because
 * the rail is what resolves that chain's node and miner credentials in the right
 * order (env, then the per-coin sidecar, then the hub, whose install-time copy
 * goes stale) and what puts the DOGE globals back afterwards.
 *
 * Deliberately NOT the miner's mine-empty heartbeat: a continuously advancing
 * DOGE tip would change what a batch-window drill measures, and that trade is an
 * operator decision rather than this module's.
 */
async function mineDogeBlocks (blocks) {
    const chainRail = require('../../../helpers/chainRail')
    const rail = await chainRail.createRail('dogecoin', 'regtest')
    return await chainRail.withRail(rail, async () => {
        await regtestMinerConnector.generateBlocks(Number(blocks) || DOGE_NUDGE_BLOCKS)
        await settleOrReport('the DOGE keep-up', { timeoutMs: 60_000 })
        return Number((await indexerConnector.call('getblockhashes', {})).block_index)
    })
}

/**
 * Mine BTC while keeping the OTHER chain's tip alive, deterministically.
 *
 * WHY REACTING IS NOT ENOUGH ON ITS OWN. The roll-call wedge is caused by mining
 * BTC hard while DOGE sits still: the epoch cannot be decided until the DOGE tip
 * passes the window end. Measured on this venue, it re-forms every 25 to 30 BTC
 * blocks, so anything that mines a long run of them MANUFACTURES the wedge it
 * then has to recover from. The teardown is the worst case and the most expensive:
 * it mines the settle distance, wedges itself, and then cannot broadcast the very
 * unstakes it exists to broadcast, which is how a failed drill turns into
 * permanent roster contamination.
 *
 * So a long BTC run is broken into chunks with a DOGE mine between them. This is
 * NOT a background heartbeat and must never become one: `mineDogeBlocks` swaps the
 * harness globals to Dogecoin through `chainRail` and restores them, so it is only
 * safe strictly BETWEEN operations, which is exactly where this puts it. A timer
 * firing it mid-operation would corrupt the run it is protecting.
 *
 * The reactive clear stays, and the two are complements rather than alternatives:
 * this stops a drill causing the wedge itself, while the clear recovers from one
 * caused by anything else, including another lane's mining.
 */
async function mineBtcKeepingDogeAlive (total, opts) {
    const o = opts || {}
    const want = Number(total)
    assert.ok(Number.isFinite(want) && want >= 0, 'mirrorDrillWaits: block count must be a number')
    const chunk = Number(o.chunk) || BTC_BLOCKS_PER_DOGE_KEEPUP
    let done = 0
    while (done < want) {
        // Never mine past the point the counter is due, so a long run keeps the
        // other chain alive throughout rather than only at its seams.
        const room = Math.max(1, chunk - btcSinceDogeKeepUp)
        const n = Math.min(room, want - done)
        await regtestMinerConnector.generateBlocks(n)
        done += n
        btcSinceDogeKeepUp += n
        if (btcSinceDogeKeepUp >= chunk) await keepDogeAlive()
    }
    return done
}

/**
 * Move the other chain and reset the counter. Strictly between operations.
 */
/**
 * Quiesce the stack and SAY SO when it did not.
 *
 * `quiesce` is a barrier whose failure is a return value, not a throw: on timeout
 * it hands back the last status carrying `ready: false`, and its own comment says
 * callers that are a barrier rather than a retry loop must inspect that. Every
 * settle in this tree discarded it, so thirty seconds of NON-settlement resolved as
 * success. The cost is not hypothetical: the encoder looks up UTXOs with
 * `unconfirmed=false`, so acting on an unsettled tracker is what produces the
 * intermittent mid-batch crash that reads as flake rather than as ordering.
 *
 * Warns rather than throwing, deliberately. A drill that failed outright on one
 * unsettled poll would red for a transient; what was missing is not severity but
 * VISIBILITY, so the next unexplained encoder error has this line above it.
 */
async function settleOrReport (label, opts) {
    const o = opts || {}
    const status = await utxoTrackerConnector.quiesce({
        timeoutMs: Number(o.timeoutMs) || 30000, pollMs: 250, regtestMiner: regtestMinerConnector,
    })
    if (!status || !status.ready) {
        console.log('mirrorDrillWaits: the stack did NOT quiesce for ' + label + ' (' +
            JSON.stringify(status) + '). Anything spending a UTXO after this is acting on a view ' +
            'that is neither the confirmed set nor the mempool set, which surfaces later as an ' +
            'encoder crash rather than here.')
    }
    return status
}

async function keepDogeAlive () {
    btcSinceDogeKeepUp = 0
    return await mineDogeBlocks(DOGE_NUDGE_BLOCKS).catch((e) => {
        console.log('mirrorDrillWaits: DOGE keep-up failed (' + (e && e.message) +
            '); the reactive clear will still catch a wedge if one forms')
        return null
    })
}

/**
 * Clear the wedge, if present, immediately BEFORE a broadcast that must not be
 * retried.
 *
 * WHY THIS EXISTS SEPARATELY FROM `withWedgeClear`. That wrapper runs an
 * operation, and on the wedge verdict runs it AGAIN. That is exactly right for an
 * idempotent step: `getNewFundedAddress` is keyed by label and returns the same
 * wallet, so a second attempt re-funds one identity rather than minting another.
 * It is exactly WRONG for a broadcast-and-wait. `sendExecuteV0` puts a
 * transaction on the chain and then waits for it to index at `status=valid`; a
 * wedged indexer fails the WAIT with the transaction already broadcast, so a retry
 * broadcasts a SECOND EXECUTE. Two EXECUTEs emit two attestation requests, and the
 * drill is then measuring a request it did not mean to make. The correlated lookup
 * refuses two candidates rather than picking, so this would surface as an
 * ambiguity failure instead of silent nonsense, but the right answer is not to
 * create the ambiguity.
 *
 * So for those calls the remedy goes BEFORE the broadcast rather than around it:
 * probe, clear if genuinely wedged, then broadcast once into an indexer that can
 * confirm it. Cheap, since it is one status read when nothing is wrong.
 */
async function clearBeforeBroadcast () {
    try {
        // Lazy: `stakeTeardown` already reaches back into this module for the same
        // remedy, so a top-level require here would close that cycle.
        const { clearWedgeIfPresent } = require('../../../helpers/stakeTeardown')
        if (typeof clearWedgeIfPresent !== 'function') return { cleared: false, reason: 'no clear available' }
        const verdict = await clearWedgeIfPresent(console.log)
        if (verdict && verdict.finding) console.log('mirrorDrillWaits: ' + verdict.reason)
        return verdict
    } catch (e) {
        return { cleared: false, reason: 'clear unavailable: ' + (e && e.message) }
    }
}

/**
 * `until`, plus the DOGE nudge when the BTC indexer is wedged behind its decoder.
 *
 * Every wait in a drill that reads an indexer row should come through here rather
 * than through `until` directly, because the wedge blocks EVERY such row and does
 * it silently. `tipProbe` returns `{height, decoder}` for the node whose rows the
 * condition reads.
 */
async function untilOrClearDogeStall (observe, opts) {
    const o = opts || {}
    const timeoutMs  = Number(o.timeoutMs) || 15 * 60 * 1000
    const intervalMs = Number(o.intervalMs) || DEFAULT_INTERVAL_MS
    const tipProbe   = o.tipProbe
    // Mining WHILE waiting, because the widening ladder is height-driven: see
    // widenArithmetic. Off unless a caller asks, and bounded so a wait cannot mine
    // a request past its own deadline.
    // A MALFORMED ASK IS LOUD, because the quiet version of this cost AT1 ten
    // sessions. The option is read as `{perPoll, maxBlocks}`; passing the bare
    // number a reader would naturally write leaves `.perPoll` undefined,
    // `Number(undefined) || 0` is 0, and mining is then OFF while the call site
    // plainly says it is on. AT1 passed `mineWhileWaiting: 40` at both its waits
    // and every sibling drill passed the object, so AT1 alone waited on a chain
    // nobody was mining and read the missing block as an applier that does not
    // work. Refusing the wrong shape is the whole fix: a caller that wants no
    // mining omits the option.
    if (o.mineWhileWaiting !== undefined &&
        (typeof o.mineWhileWaiting !== 'object' || o.mineWhileWaiting === null ||
         !(Number(o.mineWhileWaiting.perPoll) > 0))) {
        throw new Error('mirrorDrillWaits: mineWhileWaiting must be {perPoll, maxBlocks} with a positive ' +
            'perPoll, got ' + JSON.stringify(o.mineWhileWaiting) + '. A bare number silently disables mining, ' +
            'and a wait that does not mine on an otherwise idle chain can never see a response applied: there ' +
            'is no next block to apply it in. Omit the option to wait without mining.')
    }
    const minePerPoll = Number((o.mineWhileWaiting || {}).perPoll) || 0
    const mineCap     = Number((o.mineWhileWaiting || {}).maxBlocks) || 0
    let mined         = 0
    const deadline   = Date.now() + timeoutMs
    let last    = null
    let since   = null
    let nudges  = 0
    let reportedFinding = false

    while (Date.now() < deadline) {
        last = await observe()
        if (last && last.ok) return last

        if (tipProbe) {
            const sample = await tipProbe().catch(() => null)
            const height = sample ? Number(sample.height) : NaN
            if (Number.isFinite(height) && (!since || height !== Number(since.height))) {
                since = { height: height, atMs: Date.now() }
            }
            const verdict = wedgeVerdict(sample, since, Date.now(), o)
            // Said out loud ONCE, because an unexplained stall that nobody reports is
            // the one that gets rediscovered.
            if (verdict.finding && !reportedFinding) {
                reportedFinding = true
                console.log('mirrorDrillWaits: the indexer is ' + verdict.why)
            }
            if (verdict.nudge && nudges < MAX_DOGE_NUDGES) {
                nudges++
                console.log('mirrorDrillWaits: the BTC indexer is ' + verdict.why + '. This is ORDINARY on ' +
                    'this venue and is cleared by mining DOGE, not by anything about the code under test; ' +
                    'mining ' + DOGE_NUDGE_BLOCKS + ' DOGE blocks (nudge ' + nudges + ' of ' +
                    MAX_DOGE_NUDGES + ').')
                const dogeTip = await mineDogeBlocks(DOGE_NUDGE_BLOCKS).catch((e) => 'unavailable: ' + (e && e.message))
                console.log('mirrorDrillWaits: DOGE tip now ' + dogeTip + '; the BTC indexer should resume within a minute.')
                // The clock restarts so a nudge is given time to work before the next.
                since = { height: Number((sample && sample.height)), atMs: Date.now() }
            }
        }

        // MINE, which until 2026-09-05 this loop only CLAIMED to do. `minePerPoll`,
        // `mineCap` and `mined` were parsed at the top and then never read again:
        // the option was dead code behind three paragraphs of comment describing
        // its behaviour, and every caller that asked for it - all six drills -
        // waited on a chain nobody was moving. On an otherwise idle regtest chain
        // that is fatal rather than slow: a mirror response can be delivered,
        // valid and applicable, and still never apply, because applying happens
        // inside the block loop and there is no next block. AT1 read that as
        // `applied [null,null]` for ten sessions.
        //
        // Capped, because the cap is what keeps a wait from mining a request past
        // its own deadline_block (widenArithmetic's safeCap is that bound).
        if (minePerPoll > 0 && (mineCap <= 0 || mined < mineCap)) {
            const want = mineCap > 0 ? Math.min(minePerPoll, mineCap - mined) : minePerPoll
            try {
                await regtestMinerConnector.generateBlocks(want)
                mined += want
            } catch (e) {
                // A miner that cannot be reached is the caller's failure to
                // report, not this loop's: the wait below will time out and say
                // what it was waiting for.
            }
        }
        await sleep(intervalMs)
    }
    return last || { ok: false }
}

module.exports = {
    ROLLCALL_STALL_AFTER_MS,
    ROLLCALL_STALL_REASON,
    DOGE_NUDGE_BLOCKS,
    BTC_BLOCKS_PER_DOGE_KEEPUP,
    MAX_DOGE_NUDGES,
    untilOrClearDogeStall,
    wedgeVerdict,
    mineDogeBlocks,
    mineBtcKeepingDogeAlive,
    keepDogeAlive,
    settleOrReport,
    clearBeforeBroadcast,
}
