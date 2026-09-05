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
const { queryVenueDb } = require('./mirrorDrillFixture')

// The ladder's own constants, imported rather than retyped: a local copy would let
// this file disagree with the rule it is doing arithmetic about.
const { ATTEST_RESPONSIBLE_WIDENING } = require('../../../xchain-indexer/src/attest_responsible_widening_activation.js')

/**
 * Query one of the venue's databases, WITH THAT DATABASE SELECTED.
 *
 * WHY NOT THE FIXTURE'S `queryVenueDb`, which takes a database name. It validates
 * the name and then discards it: the connection is opened with host, port, user
 * and password and no `database`, so every unqualified table reference through it
 * fails with errno 1046, "No database selected". Nothing had noticed because no
 * drill had ever reached one of those reads, and the first thing to reach one was
 * the federation capture, where the failure was then MISCOUNTED as a hub holding
 * no row.
 *
 * Reported to the fixture's owner for `readAppliedResponse` and
 * `readContractState`; the readers below no longer depend on it either way.
 */
async function queryDb (venue, dbName, sql, params, deps) {
    // Injectable so the ONE thing that broke here is assertable without a venue:
    // that the connection is opened WITH a database. That is invisible to every
    // other kind of test and is exactly the class this guards.
    const mariadb = (deps && deps.mariadb) || require('mariadb')
    assert.ok(venue && venue.hubDb, 'mirrorDrillWaits: the venue has no hubDb; it is not started')
    assert.ok(/^[A-Za-z0-9_]+$/.test(String(dbName)),
        'mirrorDrillWaits: refusing an unsafe database identifier ' + dbName)
    let conn = null
    try {
        conn = await mariadb.createConnection({
            host: venue.hubDb.host, port: parseInt(venue.hubDb.port, 10),
            user: venue.hubDb.user, password: venue.hubDb.pass,
            database: String(dbName), connectTimeout: 10_000,
        })
        return await conn.query(sql, params || [])
    } finally {
        if (conn) await conn.end().catch(() => {})
    }
}

/**
 * The applied ATTEST v1 row joined to the action it hangs off, read with the
 * database selected. Same shape the fixture's reader returns.
 */
async function readAppliedResponse (venue, indexerIndex, requestId) {
    const ix = venue.indexers[indexerIndex]
    assert.ok(ix, 'mirrorDrillWaits: no indexer ' + indexerIndex)
    const rows = await queryDb(venue, ix.indexerDbName,
        // NO a.tx_hash AND NO a.source: neither column exists. `actions` spells it
        // `source_id`, and the transaction hash lives on `transactions` alone, which
        // a mirror-applied action deliberately has no row in. This is the SECOND
        // copy of this query in the drill tree, and fixing only the other one left
        // every caller that comes through the waits helper still running the
        // broken text.
        'SELECT a.action_index, a.block_index, a.tx_index, a.source_id, ' +
        '       r.request_id, r.response_status, r.response_payload, r.status_id, ' +
        '       r.response_hash, r.request_status, ' +
        '       r.callback_execute_action_index ' +
        'FROM attests r JOIN actions a ON a.action_index = r.action_index ' +
        'WHERE r.request_id = ? AND r.version = 1 ' +
        'ORDER BY a.action_index ASC LIMIT 1',
        [String(requestId)])
    return (rows && rows[0]) || null
}

/** Every state key a contract carries on one venue indexer, latest value per key. */
async function readContractState (venue, indexerIndex, contractIndex) {
    const ix = venue.indexers[indexerIndex]
    assert.ok(ix, 'mirrorDrillWaits: no indexer ' + indexerIndex)
    const rows = await queryDb(venue, ix.indexerDbName,
        'SELECT cs.state_key, cs.state_value FROM contract_state cs ' +
        'INNER JOIN (SELECT MAX(id) AS max_id FROM contract_state ' +
        '            WHERE contract_index = ? GROUP BY state_key) latest ' +
        '  ON latest.max_id = cs.id',
        [Number(contractIndex)])
    const out = {}
    for (const r of rows || []) out[String(r.state_key)] = r.state_value
    return out
}

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

/**
 * What a widen step COSTS IN BLOCKS, and why a drill mines while it waits.
 *
 * THE LADDER IS HEIGHT-DRIVEN, NOT TIME-DRIVEN. `widenSlots` computes
 *
 *     start   = requestBlock + confirmations
 *     span    = deadlineBlock - start
 *     segment = span / (maxSlots + 1)
 *     widen   = floor((atBlock - start) / segment)
 *
 * so the responsible set only grows as the CHAIN advances toward the deadline.
 * Nothing about round timeouts, round failures or elapsed wall time moves it. A
 * drill that mines its burial blocks and then waits therefore sits at widen 0 for
 * as long as it waits, and a draw containing a key no live hub holds can never
 * finalize: measured three times on this venue as a request that produced no row
 * while every hub reported NO ROW and the responsible set never changed.
 *
 * At `deadlineBlocks` 60 with confirmations 3 and maxSlots 2 that is a segment of
 * 19 blocks, so widen 1 arrives 19 blocks past the confirmation lag and widen 2 at
 * 38. THIS NUMBER IS WHY A WAIT MINES; a future reader who removes the mining as
 * noise reintroduces an unfinalizable drill.
 *
 * `safeCap` stops mining before the deadline, because the expiry sweep fires at
 * deadline + 1 and an expired request fails the drill for an unrelated reason.
 */
function widenArithmetic (deadlineBlocks) {
    const conf  = Number(ATTEST_RESPONSIBLE_WIDENING.confirmations)
    const slots = Number(ATTEST_RESPONSIBLE_WIDENING.maxSlots)
    const dl    = Number(deadlineBlocks)
    if (!Number.isFinite(dl) || dl <= conf) {
        return { span: 0, segment: 0, toFullWiden: 0, safeCap: 0, confirmations: conf, maxSlots: slots }
    }
    const span    = dl - conf
    const segment = span / (slots + 1)
    return {
        span: span,
        segment: segment,
        toFullWiden: Math.ceil(segment * slots),
        // Half a segment of headroom below the deadline: enough to reach full widen
        // and still leave room before the expiry sweep.
        safeCap: Math.max(0, Math.floor(span - segment / 2)),
        confirmations: conf,
        maxSlots: slots,
    }
}

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
// NO tx_hash. It is not a column of anything a mirror-applied action touches, so
// including it compared undefined against undefined on every node pair: a field
// that can never differ weakens a cross-node diff instead of strengthening it.
// `response_hash` replaces it and carries the same claim with real content.
const APPLIED_FIELDS = Object.freeze([
    'action_index', 'block_index', 'tx_index', 'response_hash',
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
 * `JSON.stringify` that survives a database row.
 *
 * mariadb returns BIGINT columns as BigInt, and `JSON.stringify` throws on one.
 * An assertion MESSAGE is built eagerly, on the pass path as well as the fail
 * path, so a message that serializes an applied row turns a passing wait into
 * `TypeError: Do not know how to serialize a BigInt`. Every message that
 * prints rows goes through this.
 */
function jsonSafe (value) {
    return JSON.stringify(value, (k, v) => (typeof v === 'bigint' ? Number(v) : v))
}

/**
 * The fee-settlement lines a venue indexer logged, for a reward assertion.
 *
 * `_settleRequestFee` says exactly what it did (`ATTEST fee : <amount> ... split
 * N way(s)`, or `fee left in escrow` with the reason), and it says it far enough
 * above the tail that a bare `logTail` misses it. A reward assertion that fails
 * without these lines cannot tell a settle that never ran from one that split to
 * an empty set, which is what AT6 could not tell on 2026-09-05.
 */
/**
 * The newest attest reward rows on one venue indexer, RAW and unjoined.
 *
 * `readAttestRewards` joins `index_pubkeys` and scopes by block or round; when
 * it returns nothing while the indexer log says `split 3 way(s)`, only the raw
 * rows say whether the writer skipped them (an unresolved stake `source_id`),
 * stamped a different `round_reference`, or wrote them under a pubkey id the
 * join cannot see. The venue databases are dropped at teardown, so this has to
 * be printed by the assertion that fails.
 */
async function rawAttestRewards (venue, indexerIndex, limit) {
    const ix = venue.indexers[indexerIndex]
    if (!ix) return '  (no indexer ' + indexerIndex + ')'
    try {
        const rows = await queryDb(venue, ix.indexerDbName,
            'SELECT id, reward_type, amount, block_index, round_reference, signing_pubkey_id, source_id ' +
            'FROM validator_rewards WHERE reward_type LIKE ? ORDER BY id DESC LIMIT ' + (Number(limit) || 8),
            ['attest%'])
        const total = await queryDb(venue, ix.indexerDbName,
            'SELECT COUNT(*) AS n FROM validator_rewards WHERE reward_type LIKE ?', ['attest%'])
        return '  raw attest reward rows on indexer ' + indexerIndex + ' (newest first, ' +
            String(total && total[0] ? total[0].n : '?') + ' total): ' + jsonSafe(rows)
    } catch (e) {
        return '  (raw reward read failed on indexer ' + indexerIndex + ': ' + (e && e.message) + ')'
    }
}

function feeLines (venue, which) {
    const tail = (venue && typeof venue.logTail === 'function') ? String(venue.logTail(which)) : ''
    // `createValidatorReward:` is the writer saying why it SKIPPED a row (unknown
    // pubkey, or no active stake/delegation at the block), which is the one
    // line that separates "settled to nobody" from "settled and unreadable".
    const hits = tail.split('\n').filter((l) =>
        /ATTEST fee|fee settle|fee left|fee_payer|REWARD pool|handleResponse|createValidatorReward/.test(l))
    return hits.length ? ('  fee-related lines from ' + which + ':\n' + hits.join('\n')) :
        ('  (no fee-related line in the last lines of ' + which + '; the settle either never logged or scrolled out)')
}

/**
 * EVERY hub's log tail, for an assertion whose cause can only be on a hub.
 *
 * WHY ALL OF THEM RATHER THAN ONE. Two questions a drill asks are answerable only
 * hub-side, and for both of them the relevant hub is not knowable in advance.
 * "Did the round finalize?" belongs to whichever hubs were in the responsible set,
 * which the hash ranking chose. "Why did no window publish?" belongs to whichever
 * hub the election picked, which is a different hash. Printing one hub's tail for
 * either question shows the wrong process most of the time, which is worse than
 * printing nothing because it reads as evidence.
 */
function allHubTails (venue) {
    return (venue.hubs || [])
        .map((h) => '--- hub ' + h.index + ' ---\n' + venue.logTail('hub' + h.index))
        .join('\n')
}

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
    const chainRail = require('../helpers/chainRail')
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
        const { clearWedgeIfPresent } = require('../helpers/stakeTeardown')
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
async function waitForMirrorRowEverywhere (venue, requestId, timeoutMs, opts) {
    // Fourth argument added, never a reordering: another lane calls this with three.
    const o = opts || {}
    // CAPTURED BEFORE THE ROUND SETTLES, because this is the only moment the
    // responsible set can be read: `getattestationresponsibleset` answers for
    // PENDING requests only, and by the time a row exists the request is not
    // pending. A capture failure must never mask the assertion below, so it is
    // swallowed with its reason printed.
    try { await captureFederationState(venue, requestId, 'before the round settles') }
    catch (e) { console.log('FEDERATION STATE (before): unreadable, ' + (e && e.message)) }

    const seen = await untilOrClearDogeStall(async () => {
        const rows = []
        for (const ix of venue.indexers) {
            rows.push(await venue.readMirrorRows(ix.index, { requestId: requestId }))
        }
        return { ok: rows.every((r) => r.length === 1), rows: rows }
    }, {
        timeoutMs: timeoutMs || 10 * 60 * 1000,
        tipProbe: venueTipProbe(venue, 0),
        // Mines while waiting when the caller says how far it may go, so the
        // height-driven widening ladder can climb; see widenArithmetic.
        mineWhileWaiting: o.mineWhileWaiting,
    })

    // AND AFTER, on pass as well as on failure. "0 mirror rows" has two competing
    // explanations that the count cannot separate: the mirror failed to deliver a
    // row that exists, or no row exists because the round never finalized. Which of
    // those it was is only readable from the hubs, and the hub databases are
    // disposable, so a reading taken after teardown cannot be taken at all.
    let after = null
    try {
        after = await captureFederationState(venue, requestId,
            seen.ok ? 'row present on both indexers' : 'row MISSING')
    } catch (e) { console.log('FEDERATION STATE (after): unreadable, ' + (e && e.message)) }

    // The VERDICT, never a count: it reads NO VERDICT when any hub was unreadable,
    // so an instrument failure can never be mistaken for a mirror failure.
    const verdict = after ? after.verdict : 'capture did not run'
    assert.ok(seen.ok,
        'the mirror row for ' + requestId + ' did not reach both indexers: counts ' +
        jsonSafe((seen.rows || []).map((r) => r.length)) + '. Hub finalization: ' +
        verdict + '. That is the reading that tells the two ' +
        'explanations apart: NO hub holding one means the round never finalized (a redundancy-sized ' +
        'draw that included a staked key belonging to no running hub does exactly this, and the ' +
        'responsible set printed above says whether that happened), while hubs holding one and an ' +
        'indexer without it is a mirror fault.\n' +
        responsibleHubTails(venue, after) + '\n' +
        venue.logTail('indexer0') + '\n' + venue.logTail('indexer1'))
    return seen.rows.map((r) => r[0])
}

/**
 * The log tails of the hubs that were RESPONSIBLE for a request.
 *
 * WHY THE HUB TAILS AND NOT JUST THE INDEXERS'. A missing mirror row has
 * two candidate explanations and the capture separates them: a draw
 * containing a key with no live signer, or a genuine mirror fault. Since the
 * venue adopts the roster, the first one is gone by construction, and the
 * capture now routinely reports a CLEAN draw with no hub holding a row. That
 * combination says the round did not finalize even though every drawn member
 * was live, and the reason for that is only ever in the hubs' own logs: a
 * provider fetch that failed, a body over the cap, a PREPARE nobody answered, a
 * round that timed out. The indexer tails, which is all a
 * bare failure prints, cannot contain it, and dumping them alone sent the last investigation
 * looking at block parsing while the answer sat in a hub buffer.
 *
 * Tails only the RESPONSIBLE hubs, because the other two are not participants
 * and their buffers would push the useful lines out of a terminal.
 */
function responsibleHubTails (venue, capture) {
    if (!venue || !Array.isArray(venue.hubs)) return '  (no venue hubs to tail)'

    // The capture reports pubkeys truncated to 16 chars, so match on that prefix
    // rather than re-deriving a full key that is not present.
    const drawn = new Set()
    for (const h of ((capture && capture.hubs) || [])) {
        if (Array.isArray(h.responsible)) for (const m of h.responsible) drawn.add(String(m))
    }
    if (drawn.size === 0) return '  (no responsible set was readable, so no hub could be tailed)'

    const parts = []
    for (const hub of venue.hubs) {
        if (!drawn.has(String(hub.pubkey).slice(0, 16))) continue
        // Labelled the way allHubTails labels, so the two are readable side by
        // side in one failure and a reader never has to work out which is which.
        parts.push('--- responsible hub ' + hub.index + ' (' + String(hub.pubkey).slice(0, 16) + ') ---\n' +
            venue.logTail('hub' + hub.index))
    }
    if (parts.length === 0) {
        // Every drawn member is foreign. Say so rather than printing nothing:
        // an empty section reads as "the hubs were quiet", which is the opposite
        // of what this means.
        return '  NONE of the drawn members is a hub this venue runs, so there are no logs to show ' +
               'and the round could never have finalized. Drawn: ' + [...drawn].join(', ')
    }
    return parts.join('\n')
}

/**
 * Wait until every venue indexer has APPLIED the response, and hand back the
 * joined rows in indexer order.
 *
 * A drill asserts on the returned rows rather than on this having resolved: an
 * applier that runs on one node and not the other is the interesting failure and
 * it must be reported as a difference between two nodes, not as a timeout.
 */
async function waitForAppliedEverywhere (venue, requestId, timeoutMs, opts) {
    // Fourth argument added, never a reordering: other callers pass three.
    const o = opts || {}
    const got = await untilOrClearDogeStall(async () => {
        const applied = []
        for (const ix of venue.indexers) {
            applied.push(await readAppliedResponse(venue, ix.index, requestId))
        }
        return { ok: applied.every((a) => a && a.action_index !== undefined), applied: applied }
    }, {
        timeoutMs: timeoutMs || 15 * 60 * 1000,
        tipProbe: venueTipProbe(venue, 0),
        // MINES WHILE WAITING when the caller allows it. The applier runs inside
        // the block loop, so on a chain nobody is mining the response can be
        // delivered, valid and applicable and still never applied: there is no
        // next block to apply it in. That times out at fifteen minutes and reads
        // as an applier that does not work.
        mineWhileWaiting: o.mineWhileWaiting,
    })
    assert.ok(got.ok,
        'the response for ' + requestId + ' was not applied on every venue indexer: applied ' +
        jsonSafe((got.applied || []).map((a) => (a ? a.block_index : null))) + '\n' +
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
    return await queryDb(venue, ix.indexerDbName,
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
    return await queryDb(venue, ix.indexerDbName,
        // a.tx_hash removed: the column does not exist, and a tx-less action has no
        // transactions row to carry one. The discriminator this reader documents is
        // tx_index, which does exist and is NULL exactly for the synthesized row.
        'SELECT a.action_index, a.block_index, a.tx_index, r.response_hash, ' +
        '       r.request_id, r.response_status, r.response_payload, r.validator_signatures, ' +
        '       r.callback_execute_action_index, r.batch_action_index, s.status AS verdict ' +
        'FROM attests r ' +
        'JOIN actions a ON a.action_index = r.action_index ' +
        'LEFT JOIN index_statuses s ON s.id = r.status_id ' +
        'WHERE r.request_id = ? AND r.version = 1 ' +
        'ORDER BY a.action_index ASC',
        [String(requestId)])
}

/**
 * The highest v0 request action index this contract has already emitted.
 *
 * TAKEN BEFORE THE EXECUTE, and it is what makes the correlation immune to the one
 * input it cannot otherwise trust. `sendExecuteV0`'s strict txHash wait misses a
 * P2SH-encoded EXECUTE, and its fallback searches on (contract, caller, method,
 * status=valid), which cannot tell two executions of the SAME method by the SAME
 * caller on the SAME contract apart. Measured on another lane's run: it returned
 * the EARLIER execution, so the second case silently measured the first case's
 * request. Correlating on the action index it hands back cannot help, because the
 * wrong index arrives as INPUT.
 *
 * A watermark read before the broadcast is not derived from that return value at
 * all: the request this EXECUTE emits is the only v0 row for the contract ABOVE it.
 * That is cheaper than a contract per execution (five of six drills here execute the
 * same method more than once, one of them up to six times) and it removes the
 * ambiguity rather than routing around it.
 *
 * REFUSES rather than defaulting to 0 on a read failure: a zero watermark would
 * re-admit every earlier request as a candidate, which is the ambiguity again.
 */
async function attestRequestWatermark (contractIndex) {
    let connection = null
    try {
        connection = await indexerDatabase.getConnection()
        const rows = await connection.query(
            'SELECT MAX(action_index) AS m FROM attests WHERE version = 0 AND contract_index = ?',
            [Number(contractIndex)])
        const m = rows && rows[0] ? rows[0].m : null
        return (m === null || m === undefined) ? 0 : Number(m)
    } catch (e) {
        assert.fail('mirrorDrillWaits: could not read the request watermark for contract ' +
            contractIndex + ' (' + (e && e.message) + '). Without it the request this drill is about ' +
            'to emit cannot be told apart from one it emitted earlier.')
    } finally {
        if (connection) await connection.release()
    }
}

/**
 * THE REQUEST MY OWN EXECUTE EMITTED, found without trusting a transaction hash.
 *
 * WHY NOT `waitForAttestationRequest({txHash})`, which is the obvious call and is
 * WRONG here. That filters on `index_transactions.hash`, the ON-CHAIN hash, and for
 * a P2SH-encoded EXECUTE the txid `sendrawtransaction` returned is not that hash.
 * `sendExecuteV0` documents the mismatch and works around it for its OWN row (a
 * short strict wait, then a no-txHash search on the contract, caller and method
 * tuple), but a drill looking up the ATTEST request afterwards inherits the problem
 * with no fallback. Which encoding is chosen varies, so the failure is
 * INTERMITTENT and presents at the request lookup as though admission had refused
 * the emission.
 *
 * WHY NOT A BARE `{requestStatus: 'pending'}` FALLBACK EITHER, which is the
 * tempting fix: that read is `LIMIT 1` over every pending request on a shared
 * chain, so it can hand back a STALE request from an earlier aborted run, and the
 * drill would then assert against a request the hubs never worked on. That is worse
 * than failing, because it looks like a pass.
 *
 * So the correlation is on identity: the emitting EXECUTE's own action index and
 * the contract it ran in. An emission is minted at or after its EXECUTE, so a v0
 * row for that contract at or above that index is this drill's request and nothing
 * else can be. More than one candidate is refused loudly rather than resolved by
 * picking, because two would mean this drill emitted twice and the caller must say
 * which it meant.
 */
async function findEmittedAttestRequest (contractIndex, sinceActionIndex, opts) {
    const o = opts || {}
    const label = String(o.label || 'request')
    const since = Number(sinceActionIndex)
    assert.ok(Number.isFinite(since),
        label + ': the emitting execution carried no action_index to correlate on, so this request ' +
        'cannot be identified without trusting a transaction hash that may not match')

    const read = async () => {
        let connection = null
        try {
            connection = await indexerDatabase.getConnection()
            return await connection.query(
                'SELECT ar.request_id, ar.request_status, ar.deadline_block, ar.action_index, ' +
                '       ar.provider_id, a.block_index ' +
                'FROM attests ar JOIN actions a ON a.action_index = ar.action_index ' +
                'WHERE ar.version = 0 AND ar.contract_index = ? AND ar.action_index >= ? ' +
                'ORDER BY ar.action_index ASC',
                [Number(contractIndex), since])
        } catch (e) {
            return []
        } finally {
            if (connection) await connection.release()
        }
    }

    const found = await untilOrClearDogeStall(async () => {
        const rows = await read()
        return { ok: rows.length > 0, rows: rows }
    }, {
        timeoutMs: Number(o.timeoutMs) || 5 * 60 * 1000,
        intervalMs: 2000,
        tipProbe: o.tipProbe || standingTipProbe(),
    })

    const rows = found.rows || []
    assert.ok(rows.length > 0,
        label + ': no ATTEST v0 request row for contract ' + contractIndex + ' at or above action ' +
        since + '. The EXECUTE came back valid, so either the emission was refused at admission (a ' +
        'responsible set shorter than the redundancy does exactly this) or the indexer has not written ' +
        'it yet.')
    assert.strictEqual(rows.length, 1,
        label + ': ' + rows.length + ' candidate request rows for contract ' + contractIndex +
        ' at or above action ' + since + ' (' + rows.map((r) => String(r.request_id).slice(0, 12)).join(', ') +
        '). This drill emitted more than one request from that point, so which one is under test is ' +
        'ambiguous and picking would be guessing.')

    const row = rows[0]
    assert.strictEqual(String(row.request_status), 'pending',
        label + ': the request landed with status ' + row.request_status + ' rather than pending, so no ' +
        'hub will ever work on it. `rejected` here means the emission failed structural validation.')
    return {
        requestId: String(row.request_id),
        requestStatus: String(row.request_status),
        deadlineBlock: Number(row.deadline_block),
        actionIndex: Number(row.action_index),
        blockIndex: Number(row.block_index),
        providerId: String(row.provider_id),
    }
}

/**
 * THE READING THAT TELLS A MIRROR DEFECT FROM A ROSTER PROBLEM, taken while the
 * venue is still up.
 *
 * WHY THIS IS UNCONDITIONAL AND PRINTED. "indexer 0 holds 0 mirror rows for this
 * request" has two competing explanations and the row count cannot separate them:
 * the mirror failed to deliver a row that exists, or no row exists because a
 * redundancy-3 draw included a staked key belonging to no running hub and the round
 * never finalized. The venue's hub databases are DISPOSABLE and go with the run, so
 * a reading taken after teardown cannot be taken at all, and every red without it
 * stays ambiguous forever. It therefore runs on pass as well as on failure.
 *
 * `getattestationresponsibleset` answers the first half, and only a VENUE hub can:
 * the standing stack predates the method and answers "Method not found". It also
 * answers for PENDING requests only, which is why a drill should capture it BEFORE
 * the round finalizes and the per-hub state afterwards.
 */
async function captureFederationState (venue, requestId, phase, deps) {
    // INJECTABLE, so the no-verdict rule can be falsified without a venue. A capture
    // exercised only against a healthy federation is exactly how the miscount shipped.
    const d = deps || {}
    const post = d.post || (async (url, body) => {
        const axios = require('axios')
        return await axios.post(url, body, { timeout: 8000, validateStatus: () => true })
    })
    const readRows = d.readRows || ((dbName, sql, params) => queryDb(venue, dbName, sql, params))
    const out = { phase: String(phase || ''), requestId: String(requestId), hubs: [], unreadable: 0 }

    for (const hub of venue.hubs) {
        const entry = { hub: hub.index, pubkey: String(hub.pubkey).slice(0, 16) }
        let readOk = true

        // THE RESPONSIBLE SET, over the hub's JSON-RPC. Through axios and not
        // `hub.connector`: `XChainHubConnector` exposes `_call`, `ping` and
        // `getAllConfig` and no public `call`, so the obvious spelling throws
        // "call is not a function" on every hub. This is the shape
        // `attestationHelper.resolveResponsibleSigners` already uses.
        if (!hub.proc) {
            entry.responsible = 'hub stopped'
            readOk = false
        } else {
            try {
                const res = await post(hub.apiUrl, {
                    jsonrpc: '2.0', id: Date.now(),
                    method: 'getattestationresponsibleset', params: { request_id: String(requestId) },
                })
                const result = res && res.data && res.data.result
                const rpcErr = res && res.data && res.data.error
                if (rpcErr) {
                    entry.responsible = 'rpc error: ' + JSON.stringify(rpcErr)
                    readOk = false
                } else if (result && Array.isArray(result.responsible)) {
                    entry.responsible = result.responsible.map((p) => String(p).slice(0, 16))
                    if (result.redundancy !== undefined) entry.redundancy = result.redundancy
                    if (result.widen !== undefined) entry.widen = result.widen
                } else {
                    entry.responsible = 'no responsible set in the answer: ' + JSON.stringify(result)
                    readOk = false
                }
            } catch (e) {
                entry.responsible = 'unreachable: ' + (e && e.message)
                readOk = false
            }
        }

        // FINALIZATION, from the hub's own table, with its database selected.
        try {
            const rows = await readRows(hub.dbName,
                'SELECT status, effective_time, widen, signer_pubkeys FROM attestation_responses ' +
                'WHERE request_id = ?', [String(requestId)])
            entry.finalized = rows.length === 0 ? 'NO ROW' : {
                status: String(rows[0].status),
                effective_time: Number(rows[0].effective_time),
                widen: rows[0].widen,
            }
        } catch (e) {
            entry.finalized = 'unreadable: ' + (e && e.message)
            readOk = false
        }

        entry.readOk = readOk
        if (!readOk) out.unreadable++
        out.hubs.push(entry)
    }

    // NEVER SUMMARISE OVER A FAILED READ, and this is the whole lesson of this
    // function. An earlier version counted hubs whose row it could not read as hubs
    // holding no row, and printed "0 of 5 hubs hold a finalized row" when the truth
    // was that ZERO HUBS WERE READ: the responsible-set probe threw on every hub and
    // the finalization query failed with "No database selected" on every hub. That
    // reads as strong evidence for exactly the hypothesis under test, which is the
    // most dangerous direction for an instrument to fail in. A count that cannot
    // tell "read it, and there is no row" from "could not read it" must not be
    // emitted at all.
    const total  = out.hubs.length
    const held   = out.hubs.filter((h) => h.readOk && h.finalized && typeof h.finalized === 'object').length
    out.total    = total
    out.held     = held
    out.verdict  = out.unreadable > 0 ? 'NO VERDICT' : (held + ' of ' + total + ' hubs hold a finalized row')

    const headline = out.unreadable > 0
        ? 'UNREADABLE on ' + out.unreadable + ' of ' + total + ' hubs, NO VERDICT: this says the ' +
          'instrument is broken, NOT that the mirror failed to deliver. Do not read a missing row ' +
          'from these lines.'
        : held + ' of ' + total + ' hubs hold a finalized row.'
    console.log('FEDERATION STATE (' + out.phase + ') for ' + out.requestId.slice(0, 12) + ': ' + headline + '\n' +
        out.hubs.map((h) => '  hub ' + h.hub + ' (' + h.pubkey + '...) read=' + (h.readOk ? 'ok' : 'FAILED') +
            ' responsible=' + JSON.stringify(h.responsible) +
            ' finalized=' + JSON.stringify(h.finalized)).join('\n'))
    return out
}

/**
 * Wait for a venue indexer to COMMIT a height, clearing the wedge if that is what
 * is holding it.
 *
 * WHY NOT `venue.waitForHeight`. It watches the indexer's own `blocks` table,
 * which is the right thing to watch, and it has no wedge clear: under the roll-call
 * wedge the indexer commits nothing, so that wait spends its entire budget and then
 * reports a height that never moved. Two drills mine long runs and then wait for
 * both nodes to reach a height, which is precisely the combination that forms the
 * wedge and then blocks on it.
 *
 * Watches the same table for the same reason: a health endpoint can report progress
 * a block transaction later rolls back, and after a reorg the committed height is
 * the only honest reading.
 */
async function waitForHeightWithClear (venue, indexerIndex, height, opts) {
    const o = opts || {}
    const ix = venue.indexers[indexerIndex]
    assert.ok(ix, 'mirrorDrillWaits: no indexer ' + indexerIndex)
    const target = Number(height)
    const got = await untilOrClearDogeStall(async () => {
        let at = null
        try {
            const rows = await queryDb(venue, ix.indexerDbName, 'SELECT MAX(block_index) AS h FROM blocks')
            at = (rows && rows[0] && rows[0].h !== null) ? Number(rows[0].h) : null
        } catch (e) { at = null }
        return { ok: at !== null && at >= target, at: at }
    }, {
        timeoutMs: Number(o.timeoutMs) || 30 * 60 * 1000,
        intervalMs: Number(o.intervalMs) || 2000,
        tipProbe: venueTipProbe(venue, indexerIndex),
    })
    assert.ok(got.ok,
        'indexer ' + indexerIndex + ' committed block ' + got.at + ' of ' + target +
        ' before the budget ran out. A height that does not move at all is the wedge rather than ' +
        'slowness, and the clear above says whether one was found.\n' + venue.logTail('indexer' + indexerIndex))
    return got
}

/** One venue indexer's `blocks` rows over a height window, for §4.1 arithmetic. */
async function readBlockWindow (venue, indexerIndex, fromHeight, toHeight) {
    const ix = venue.indexers[indexerIndex]
    assert.ok(ix, 'mirrorDrillWaits: no indexer ' + indexerIndex)
    return await queryDb(venue, ix.indexerDbName,
        'SELECT block_index, block_time FROM blocks WHERE block_index >= ? AND block_index <= ? ' +
        'ORDER BY block_index ASC',
        [Number(fromHeight), Number(toHeight)])
}

/** The request row as a venue indexer holds it: its status, deadline and block. */
async function readRequestRow (venue, indexerIndex, requestId) {
    const ix = venue.indexers[indexerIndex]
    assert.ok(ix, 'mirrorDrillWaits: no indexer ' + indexerIndex)
    const rows = await queryDb(venue, ix.indexerDbName,
        'SELECT r.request_id, r.request_status, r.deadline_block, r.provider_id, r.redundancy, ' +
        '       r.fee_amount, r.resolved_block, r.contract_index, r.callback_method, ' +
        '       a.block_index, a.action_index ' +
        'FROM attests r JOIN actions a ON a.action_index = r.action_index ' +
        'WHERE r.request_id = ? AND r.version = 0 LIMIT 1',
        [String(requestId)])
    return (rows && rows[0]) || null
}

module.exports = {
    jsonSafe,
    feeLines,
    rawAttestRewards,
    APPLIED_FIELDS,
    STATE_HASH_FIELDS,
    DEFAULT_INTERVAL_MS,
    ROLLCALL_STALL_AFTER_MS,
    ROLLCALL_STALL_REASON,
    DOGE_NUDGE_BLOCKS,
    BTC_BLOCKS_PER_DOGE_KEEPUP,
    MAX_DOGE_NUDGES,
    until,
    widenArithmetic,
    untilOrClearDogeStall,
    wedgeVerdict,
    mineDogeBlocks,
    mineBtcKeepingDogeAlive,
    keepDogeAlive,
    settleOrReport,
    clearBeforeBroadcast,
    venueTipProbe,
    allHubTails,
    responsibleHubTails,
    standingTipProbe,
    diffRows,
    diffStateHashes,
    rewardFingerprint,
    firstSatisfyingBlock,
    happyPathVerdict,
    waitForMirrorRowEverywhere,
    waitForAppliedEverywhere,
    waitForHeightWithClear,
    findEmittedAttestRequest,
    attestRequestWatermark,
    captureFederationState,
    queryDb,
    readAppliedResponse,
    readContractState,
    readAttestRewards,
    readResponseRows,
    readBlockWindow,
    readRequestRow,
}
