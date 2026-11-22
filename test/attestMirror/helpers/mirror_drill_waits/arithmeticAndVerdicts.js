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

const { ATTEST_RESPONSIBLE_WIDENING } = require('../../../../../xchain-indexer/src/consensus/gates/attest_responsible_widening_gate.js')

const DEFAULT_INTERVAL_MS = 2000

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

module.exports = {
    APPLIED_FIELDS,
    STATE_HASH_FIELDS,
    DEFAULT_INTERVAL_MS,
    until,
    sleep,
    jsonSafe,
    widenArithmetic,
    diffRows,
    diffStateHashes,
    rewardFingerprint,
    firstSatisfyingBlock,
    happyPathVerdict,
}
