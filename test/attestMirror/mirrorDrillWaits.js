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
 * The waiting, and the COMPARING, that every attest-mirror drill past AT1 does.
 *
 * WHY THE COMPARISONS LIVE HERE RATHER THAN IN EACH DRILL. AT2 through AT6 each
 * make some version of one claim: two nodes that took different routes to the
 * same response ended up holding the same thing. Spelled inline five times that
 * claim drifts, and it drifts in the direction that makes a test weaker, because
 * the easiest field to drop from a hand-written comparison is the one that
 * differs. Naming the field lists once means a drill cannot quietly compare
 * fewer columns than its neighbour, and the diff functions report EVERY
 * difference rather than the first, so one run says how far apart two nodes are
 * instead of only that they are.
 *
 * WHY THE WAITS LIVE HERE. There is exactly one `sleep` in this whole tree of
 * drills and it is the poll interval of `until` below. A drill that reaches for
 * a fixed settle instead ("give the applier a few seconds") passes or fails on
 * how loaded the venue is, and `scripts/check-sleep-flake.js` ratchets that
 * shape for precisely that reason. Every wait in a drill is therefore a
 * condition, and the condition's last observation comes back on timeout so the
 * failure message can say what the node actually looked like.
 *
 * The pure half (every diff and fingerprint function, and `firstSatisfyingBlock`)
 * is covered by test/unit/helpers/mirrorDrillWaits.test.js, which needs no venue.
 ********************************************************************/

const assert = require('assert')

// Safe to require at load even from the unit tier: the fixture reaches for the
// harness globals and the database driver only inside its functions, which is
// what lets test/unit/helpers/mirrorDrillFixture.test.js cover it at all.
const { queryVenueDb, readAppliedResponse } = require('./mirrorDrillFixture')

const DEFAULT_INTERVAL_MS = 2000

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

/**
 * The `attests` columns two nodes must agree on for one applied response.
 *
 * `action_index` is in the list deliberately, and it is the strongest entry: it
 * is minted locally by each node's own pipeline, so agreement is a statement
 * about the applier running at the same position in the same block on both, not
 * merely about the row's contents having been copied from one place.
 *
 * `tx_index` and `tx_hash` are here because they carry the tx-less claim: NULL
 * and the deterministic synthesis respectively.
 */
const APPLIED_FIELDS = Object.freeze([
    'action_index', 'block_index', 'tx_index', 'tx_hash',
    'response_status', 'response_payload', 'status_id',
    'callback_execute_action_index',
])

/**
 * The signed triple (plus the block merkle root) that `getblockhashes` answers.
 *
 * Two nodes agreeing on height is not agreement: they can commit different
 * ledgers to the same depth. These four are what a divergence shows up in, and
 * `state_root` is the one a missed or early-applied callback moves.
 */
const STATE_HASH_FIELDS = Object.freeze([
    'state_root', 'balances_root', 'stakes_root', 'block_merkle_root',
])

function sleep (ms) { return new Promise((r) => setTimeout(r, ms)) }

/**
 * Poll `fn` until it returns a truthy `ok`, then hand back its whole last
 * observation. On timeout the last observation comes back with `ok` falsy rather
 * than an exception, so the caller's assertion owns the message and can print
 * what the node looked like when the budget ran out.
 *
 * @param {function(): Promise<object>} fn         one observation, `{ok, ...}`
 * @param {number}                      timeoutMs  total budget
 * @param {number}                     [intervalMs] pause between observations
 */
async function until (fn, timeoutMs, intervalMs) {
    const deadline = Date.now() + Number(timeoutMs)
    let last = null
    while (Date.now() < deadline) {
        last = await fn()
        if (last && last.ok) return last
        await sleep(Number(intervalMs) || DEFAULT_INTERVAL_MS)
    }
    return last || { ok: false }
}

/**
 * Every field on which two rows differ, as readable strings.
 *
 * Compares STRINGIFIED values with null and undefined collapsed to a single
 * spelling, because the driver hands back a BIGINT column as a number on one
 * connection and a string on another depending on the column's width, and a
 * drill that reported that as a divergence would be crying fork over a driver
 * detail. A genuine difference survives the stringify; a type-only one does not.
 */
function diffRows (a, b, fields) {
    const out = []
    const norm = (v) => (v === null || v === undefined) ? 'NULL' : String(v)
    for (const f of (fields || [])) {
        const av = norm(a ? a[f] : undefined)
        const bv = norm(b ? b[f] : undefined)
        if (av !== bv) out.push(f + ': ' + av + ' vs ' + bv)
    }
    return out
}

/** Every `getblockhashes` field on which two nodes differ at one block. */
function diffStateHashes (h0, h1) {
    return diffRows(h0, h1, STATE_HASH_FIELDS)
}

/**
 * A reward set reduced to something two nodes can be compared on.
 *
 * The local surrogate keys (`id`, `signing_pubkey_id`, `source_id`) are
 * per-database autoincrements and WILL differ between two indexers that indexed
 * the same chain, so a row-for-row comparison of the table would report a fork
 * on every honest run. What must match is which pubkey was paid how much for
 * what, at which block, so that is what this reduces to. Sorted, because the
 * two nodes have no reason to return the rows in the same order.
 */
function rewardFingerprint (rows) {
    return (rows || [])
        .map((r) => [
            String(r.reward_type),
            String(r.pubkey).toLowerCase(),
            String(r.amount),
            String(r.block_index),
        ].join('|'))
        .sort()
}

/**
 * The first block at which a mirrored response becomes applicable, per §4.1.
 *
 * ```
 * R is applicable at B  <=>  R.effective_time <= t(B)  and  B <= request.deadline_block
 * ```
 *
 * The predicate is signed data against protocol time and nothing else, which is
 * what makes the applying block a prediction a test can make BEFORE the fact
 * rather than a reading it takes afterwards. Returns null when no block in the
 * window satisfies it, which is the AT3 case: a row whose first satisfying block
 * would be past the deadline is never applicable at all, and the local expiry
 * sweep owns that request instead.
 *
 * `blocks` is `[{block_index, block_time}]` in any order; protocol time is not
 * assumed monotonic across the list because MTP is only non-decreasing over the
 * canonical chain and a caller may hand over a window read straight out of a
 * database.
 *
 * @param {Array}  blocks         `{block_index, block_time}` pairs
 * @param {number} effectiveTime  the row's signed effective time
 * @param {number} deadlineBlock  the request's deadline block
 * @returns {number|null} the applying block index, or null
 */
function firstSatisfyingBlock (blocks, effectiveTime, deadlineBlock) {
    // Refused BY NAME before any arithmetic, because `Number(null)` is 0 and 0 is
    // finite: a null effective time would otherwise satisfy every block and the
    // row would bind at the epoch. That is the same trap the hub's mirror writer
    // guards on the producing side for a legacy-era row.
    for (const v of [effectiveTime, deadlineBlock]) {
        if (v === null || v === undefined || v === '' || typeof v === 'boolean') return null
    }
    const et = Number(effectiveTime)
    const dl = Number(deadlineBlock)
    if (!Number.isFinite(et) || !Number.isFinite(dl)) return null
    const eligible = (blocks || [])
        .map((b) => ({ index: Number(b.block_index), time: Number(b.block_time) }))
        .filter((b) => Number.isFinite(b.index) && Number.isFinite(b.time))
        .filter((b) => b.time >= et && b.index <= dl)
        .sort((x, y) => x.index - y.index)
    return eligible.length === 0 ? null : eligible[0].index
}

/**
 * Did this request take the HAPPY PATH, or did the widening ladder carry it?
 *
 * WHY A DRILL HAS TO ASK. The responsible set is drawn from every qualifying
 * staked key on the shared chain, not from the keys one drill staked, and that
 * pool is not this drill's to control. It currently carries keys belonging to no
 * running hub: a leaked fixture stake whose signing key died with the process that
 * minted it, so it can never be unstaked by hand and is cleared only when the
 * roll call evicts it for consecutive absences. A redundancy-3 set drawn from such
 * a pool will sometimes include a key nobody can sign with, and the widening
 * ladder then admits further keys until the round can finalize. THE ROUND STILL
 * SUCCEEDS, which is the point of the ladder, so this is not a failure. It just
 * means the request took a different path than the one an acceptance sentence
 * about set membership is talking about.
 *
 * THE DETECTOR IS THE ROW'S OWN `widen` COLUMN, not a count. A count of the
 * capability set is a claim about every other lane's hygiene and about where the
 * venue sits in its eviction cycle, and it is wrong in one direction or the other
 * most of the time. `widen` is what the leader actually used, recorded on the row.
 *
 * AND DO NOT WAIT FOR THE EVICTION EITHER, which is the shape a later reader will
 * reach for. The roll-call close does not thin the set at the close block: it
 * stamps the source's stake and every one of its delegations as deactivating at
 * `closeBlock + STAKING.ACTIVATION_DELAY_BLOCKS`, so the membership a drill reads
 * AT the close is still the old one and a wait pinned there concludes the eviction
 * failed. A drill that genuinely needs to wait for it must wait past the close plus
 * that delay, read from the coins registry the way `mirrorDrillFixture`'s stake
 * visibility arithmetic reads it, never hardcoded and never on a count. Skipping,
 * as below, is cheaper than any of that.
 *
 * WHY NON-SIGNERS ARE NOT AUTOMATICALLY OUTSIDE THE SET. With `widen` at 0 the
 * responsible set and the signer set are the same keys, so a hub that did not sign
 * is a hub that was never responsible and never ran the round. Once the ladder
 * widens, the admitted set is larger than the signatures collected, and a hub
 * outside the signer list may still have been inside the responsible set and taken
 * part. A dissemination claim rests on exactly that distinction, so a drill making
 * one must skip rather than proceed.
 *
 * @param {object} opts `{widen, signers, ownPubkeys}`
 * @returns {{happy: boolean, why: string}}
 */
function happyPathVerdict (opts) {
    const o = opts || {}
    const own = new Set((o.ownPubkeys || []).map((p) => String(p).toLowerCase()))
    const signers = (o.signers || []).map((s) => String(s).toLowerCase())
    if (signers.length === 0) return { happy: false, why: 'the row carries no signer_pubkeys at all' }

    const foreign = signers.filter((s) => !own.has(s))
    if (foreign.length > 0) {
        return {
            happy: false,
            why: 'the response was signed by ' + foreign.length + ' key(s) this drill did not stake (' +
                 foreign.map((f) => f.slice(0, 16)).join(', ') + '), so the federation under test is not the ' +
                 'one this drill built',
        }
    }
    const widen = Number(o.widen)
    if (Number.isFinite(widen) && widen > 0) {
        return {
            happy: false,
            why: 'the leader used widening step ' + widen + ', so the responsible set is WIDER than the ' +
                 'signatures on the row. That happens when the set drew a staked key belonging to no running ' +
                 'hub, which the shared chain currently carries and which the roll call evicts on its own ' +
                 'after two consecutive absences. Nothing is broken; a claim about who was responsible just ' +
                 'cannot be read off the signer list while it holds',
        }
    }
    return { happy: true, why: 'widen 0 and every signature from a key this drill staked' }
}

// ---------------------------------------------------------------------------
// The roll-call wedge, and the one thing that clears it
// ---------------------------------------------------------------------------

/**
 * Should a drill mine DOGE right now to clear a suspected roll-call wedge?
 *
 * THE FAULT THIS EXISTS FOR, because it does not look like what it is. Nothing
 * keeps the DOGE regtest chain ticking on this venue, and a BTC indexer cannot
 * DECIDE a roll-call epoch until the DOGE tip has passed the epoch's window end.
 * When DOGE stops advancing, the BTC indexer parks behind its own decoder,
 * retrying the same block every few seconds and logging that the epoch is
 * undecidable. Measured on this venue: BTC indexer 3823 against decoder 3834,
 * `isSynced false`, `stallClass wedged`, `stallReason rollcall_proof_unavailable`,
 * with DOGE itself perfectly healthy and simply frozen. A STALLED BTC TIP AT A
 * CLOSE BLOCK IS ORDINARY AND IS CLEARED BY MINING DOGE; it is not a consensus
 * fault, not an applier bug, and not a venue that needs recreating.
 *
 * Why this matters more to a drill than to a human: everything on chain still
 * works. Stakes, executes and requests all broadcast happily and then never
 * confirm in the indexer whose rows the assertions read, so the drill fails as a
 * condition that never became true, pointing at whatever it was waiting for.
 *
 * THE DISCRIMINATOR IS "BEHIND ITS OWN DECODER", not "the tip did not move". A
 * healthy drill spends minutes with a static tip on purpose, because nobody is
 * mining while a PBFT round finalizes; in that state the indexer is LEVEL with
 * its decoder and mining DOGE for it would be mining for no reason, and on the
 * batch rail it would also change what a window measures. Only an indexer that
 * has blocks in front of it and is not taking them is wedged.
 *
 * Pure, and unit-tested: the decision is the part worth pinning, the mining is
 * one call.
 *
 * @param {object} sample   this poll's reading, `{height, decoder}`
 * @param {object} since    `{height, atMs}` from when the height last changed
 * @param {number} nowMs    now
 * @param {object} [opts]   `{stallAfterMs}`
 * @returns {{nudge: boolean, why: string}}
 */
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
    return {
        nudge: true,
        why: 'held at ' + height + ' with its decoder at ' + decoder + ' for ' + heldMs +
             'ms, which is the roll-call wedge: the epoch cannot be decided until the DOGE tip passes ' +
             'the window end',
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
    const chainRail = require('../helpers/chainRail')
    const rail = await chainRail.createRail('dogecoin', 'regtest')
    return await chainRail.withRail(rail, async () => {
        await regtestMinerConnector.generateBlocks(Number(blocks) || DOGE_NUDGE_BLOCKS)
        await utxoTrackerConnector.quiesce({
            timeoutMs: 60_000, pollMs: 250, regtestMiner: regtestMinerConnector,
        })
        return Number((await indexerConnector.call('getblockhashes', {})).block_index)
    })
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
    const deadline   = Date.now() + timeoutMs
    let last    = null
    let since   = null
    let nudges  = 0

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
        await sleep(intervalMs)
    }
    return last || { ok: false }
}

// ---------------------------------------------------------------------------
// Venue reads shared by the drills. Not pure, and each says which node it asks.
// ---------------------------------------------------------------------------

/**
 * The `{height, decoder}` probe `untilOrClearDogeStall` wants for a venue indexer.
 *
 * Reads `/status`, which is where both counters live; a venue indexer that cannot
 * answer reads as "no height yet" and never provokes a nudge.
 */
function venueTipProbe (venue, indexerIndex) {
    return async () => {
        const s = await venue.statusOf(indexerIndex)
        return {
            height:  (s.body && s.body.indexerBlock !== undefined) ? Number(s.body.indexerBlock) : null,
            decoder: (s.body && s.body.decoderBlock !== undefined) ? Number(s.body.decoderBlock) : null,
            reason:  s.body && s.body.stallReason,
        }
    }
}

/**
 * The same probe for an indexer this process did not start: the STANDING one.
 *
 * Exported beside the venue probe because the wedge is a property of the chain
 * rather than of any one node, so a drill waiting on a row in the standing
 * indexer's database (every `indexerDatabase.waitForX`) is stalled by it too, and
 * a drill that has no venue yet, or none at all, still needs the remedy.
 *
 * `/status` answers 200 when healthy and 503 when degraded, and BOTH carry the
 * counters, so a degraded node still reports its own wedge rather than reading as
 * unreachable.
 */
function standingTipProbe (apiPort) {
    const axios = require('axios')
    const port = Number(apiPort) || 3024
    return async () => {
        const res = await axios.get('http://127.0.0.1:' + port + '/status',
            { timeout: 10_000, validateStatus: () => true })
        const body = (res.status === 200 || res.status === 503) ? res.data : null
        return {
            height:  (body && body.indexerBlock !== undefined) ? Number(body.indexerBlock) : null,
            decoder: (body && body.decoderBlock !== undefined) ? Number(body.decoderBlock) : null,
            reason:  body && body.stallReason,
        }
    }
}

/**
 * Wait until BOTH venue indexers hold exactly one mirror row for a request.
 *
 * Both, because a single node holding it proves the hub wrote a row and proves
 * nothing about dissemination, and exactly one because two rows for one request
 * is the double-finalize §4.1 tie-breaks and a drill must not average over it.
 */
async function waitForMirrorRowEverywhere (venue, requestId, timeoutMs) {
    const seen = await untilOrClearDogeStall(async () => {
        const rows = []
        for (const ix of venue.indexers) {
            rows.push(await venue.readMirrorRows(ix.index, { requestId: requestId }))
        }
        return { ok: rows.every((r) => r.length === 1), rows: rows }
    }, { timeoutMs: timeoutMs || 10 * 60 * 1000, tipProbe: venueTipProbe(venue, 0) })
    assert.ok(seen.ok,
        'the mirror row for ' + requestId + ' did not reach both indexers: counts ' +
        JSON.stringify((seen.rows || []).map((r) => r.length)) + '\n' +
        venue.logTail('indexer0') + '\n' + venue.logTail('indexer1'))
    return seen.rows.map((r) => r[0])
}

/**
 * Wait until every venue indexer has APPLIED the response, and hand back the
 * joined rows in indexer order.
 *
 * A drill asserts on the returned rows rather than on this having resolved: an
 * applier that runs on one node and not the other is the interesting failure and
 * it must be reported as a difference between two nodes, not as a timeout.
 */
async function waitForAppliedEverywhere (venue, requestId, timeoutMs) {
    const got = await untilOrClearDogeStall(async () => {
        const applied = []
        for (const ix of venue.indexers) {
            applied.push(await readAppliedResponse(venue, ix.index, requestId))
        }
        return { ok: applied.every((a) => a && a.action_index !== undefined), applied: applied }
    }, { timeoutMs: timeoutMs || 15 * 60 * 1000, tipProbe: venueTipProbe(venue, 0) })
    assert.ok(got.ok,
        'the response for ' + requestId + ' was not applied on every venue indexer: applied ' +
        JSON.stringify((got.applied || []).map((a) => (a ? a.block_index : null))) + '\n' +
        venue.logTail('indexer0') + '\n' + venue.logTail('indexer1'))
    return got.applied
}

/**
 * The `attest_fee` and `attest_bcast` rows one venue indexer wrote at a block,
 * with the signing pubkey resolved.
 *
 * The join to `index_pubkeys` is the whole reason this is a helper: the reward
 * row carries a local surrogate id for the pubkey, so the raw table cannot be
 * compared across two databases at all.
 */
async function readAttestRewards (venue, indexerIndex, opts) {
    const ix = venue.indexers[indexerIndex]
    assert.ok(ix, 'mirrorDrillWaits: no indexer ' + indexerIndex)
    const o = opts || {}
    // `round_reference` is the v0 REQUEST's action_index, not the response's and
    // not the 64-hex request id, so a drill scoping to one request scopes on that.
    // Keyed on whichever the caller gave, because AT2 compares a whole block across
    // two nodes while AT6 needs one request's split exactly.
    const where = []
    const params = []
    if (o.blockIndex !== undefined && o.blockIndex !== null) {
        where.push('vr.block_index = ?'); params.push(Number(o.blockIndex))
    }
    if (o.roundReference !== undefined && o.roundReference !== null) {
        where.push('vr.round_reference = ?'); params.push(Number(o.roundReference))
    }
    assert.ok(where.length > 0,
        'mirrorDrillWaits: readAttestRewards needs a blockIndex or a roundReference; an unscoped read ' +
        'would sweep every attestation the venue ever settled')
    return await queryVenueDb(venue, ix.indexerDbName,
        'SELECT vr.reward_type, vr.amount, vr.block_index, vr.round_reference, p.pubkey ' +
        'FROM validator_rewards vr JOIN index_pubkeys p ON p.id = vr.signing_pubkey_id ' +
        'WHERE ' + where.join(' AND ') + " AND vr.reward_type IN ('attest_fee', 'attest_bcast') " +
        'ORDER BY p.pubkey ASC, vr.reward_type ASC',
        params)
}

/**
 * EVERY v1 row a venue indexer holds for one request, with its verdict resolved.
 *
 * WHY THIS EXISTS BESIDE `readAppliedResponse`. Above the activation height a
 * request can end up with TWO v1 rows: the audit row a rejected on-chain v1
 * leaves behind, and the row the mirror applier writes. The fixture's reader takes
 * the lowest `action_index` and returns one row, which is the on-chain one
 * whenever a stale hub broadcast first, so a drill that asserted "the mirror row
 * applied" through it would be reading the rejection. This returns both, in
 * action order, with `index_statuses.status` joined in so the verdict string is
 * readable, and the caller decides which row is which.
 *
 * The discriminator between them is not the status text but `tx_index`: the
 * on-chain row has a transaction position, the synthesized one is NULL there.
 */
async function readResponseRows (venue, indexerIndex, requestId) {
    const ix = venue.indexers[indexerIndex]
    assert.ok(ix, 'mirrorDrillWaits: no indexer ' + indexerIndex)
    return await queryVenueDb(venue, ix.indexerDbName,
        'SELECT a.action_index, a.block_index, a.tx_index, a.tx_hash, ' +
        '       r.request_id, r.response_status, r.response_payload, r.validator_signatures, ' +
        '       r.callback_execute_action_index, r.batch_action_index, s.status AS verdict ' +
        'FROM attests r ' +
        'JOIN actions a ON a.action_index = r.action_index ' +
        'LEFT JOIN index_statuses s ON s.id = r.status_id ' +
        'WHERE r.request_id = ? AND r.version = 1 ' +
        'ORDER BY a.action_index ASC',
        [String(requestId)])
}

/** One venue indexer's `blocks` rows over a height window, for §4.1 arithmetic. */
async function readBlockWindow (venue, indexerIndex, fromHeight, toHeight) {
    const ix = venue.indexers[indexerIndex]
    assert.ok(ix, 'mirrorDrillWaits: no indexer ' + indexerIndex)
    return await queryVenueDb(venue, ix.indexerDbName,
        'SELECT block_index, block_time FROM blocks WHERE block_index >= ? AND block_index <= ? ' +
        'ORDER BY block_index ASC',
        [Number(fromHeight), Number(toHeight)])
}

/** The request row as a venue indexer holds it: its status, deadline and block. */
async function readRequestRow (venue, indexerIndex, requestId) {
    const ix = venue.indexers[indexerIndex]
    assert.ok(ix, 'mirrorDrillWaits: no indexer ' + indexerIndex)
    const rows = await queryVenueDb(venue, ix.indexerDbName,
        'SELECT r.request_id, r.request_status, r.deadline_block, r.provider_id, r.redundancy, ' +
        '       r.fee_amount, r.resolved_block, r.contract_index, r.callback_method, ' +
        '       a.block_index, a.action_index ' +
        'FROM attests r JOIN actions a ON a.action_index = r.action_index ' +
        'WHERE r.request_id = ? AND r.version = 0 LIMIT 1',
        [String(requestId)])
    return (rows && rows[0]) || null
}

module.exports = {
    APPLIED_FIELDS,
    STATE_HASH_FIELDS,
    DEFAULT_INTERVAL_MS,
    ROLLCALL_STALL_AFTER_MS,
    DOGE_NUDGE_BLOCKS,
    MAX_DOGE_NUDGES,
    until,
    untilOrClearDogeStall,
    wedgeVerdict,
    mineDogeBlocks,
    venueTipProbe,
    standingTipProbe,
    diffRows,
    diffStateHashes,
    rewardFingerprint,
    firstSatisfyingBlock,
    happyPathVerdict,
    waitForMirrorRowEverywhere,
    waitForAppliedEverywhere,
    readAttestRewards,
    readResponseRows,
    readBlockWindow,
    readRequestRow,
}
