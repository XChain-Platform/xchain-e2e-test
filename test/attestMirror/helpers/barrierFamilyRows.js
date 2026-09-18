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
 * The PURE half of what the barrier-family legs need beyond the fixture: the
 * inert mirror rows that close each member's empty-mirror escape, the SQL shapes
 * a leg reads a hub or a mirror with, the grace ladder BF1 walks the family with,
 * and the log-line parser the "three identical timed-out lines" assertion reads.
 * For AT4 it also holds the request contract, the admitted-at-height apply check and
 * the replay witness invocation for a signed admission-era mirror corpus.
 *
 * Nothing here touches a venue, a database or the rail, so every function is
 * driven in the unit tier (test/unit/helpers/barrierFamilyRows.test.js) before a
 * leg spends two hours of rail time on it.
 *
 * WHY INERT ROWS. Members 4 to 7 (match, call, bridge, policy) and member 3
 * (oracle) are satisfied while their mirror holds NO row for this coin (family
 * section 2, "the empty-mirror escape"), so a fresh venue can never observe them
 * hold. A row written straight into the hub tables through the venue's
 * `injectMirrorRow` travels the ordinary mirror path and closes the escape. The
 * rows carry no verifiable signature on purpose: the BF1 to BF5 members read
 * `MAX(effective_time)`, the height watermark and the admission columns, never a
 * signature, and a row that could be APPLIED would change the ledger under test.
 ********************************************************************/

const crypto = require('crypto')
const path = require('path')

const { MIRROR_BARRIERS, gracedBarrierReason } = require('../../helpers/attestMirrorVenue')
const { FAMILY_REASONS_LOOP_ORDER, admissionColumn, ADMISSION_TABLES } = require('./barrierFamilyFixture')

// The four xdex-rail tables plus the two rails the legs also seed, with the
// column each keys on for the injector's read-back (attestMirrorVenue.injectMirrorRow).
const NATURAL_KEYS = Object.freeze({
    cross_chain_matches:   ['match_id'],
    cross_chain_calls:     ['call_id', 'phase'],
    bridge_transfers:      ['transfer_id'],
    policy_snapshots:      ['snapshot_id'],
    attestation_responses: ['request_id', 'network', 'effective_time'],
    oracle_prices:         ['source_chain', 'action_index'],
    capability_snapshots:  ['snapshot_block', 'capability', 'signing_pubkey'],
})

// An unsigned placeholder in the shape the hub writes: JSON [{pubkey, sig}]. Never
// verifiable, which is the point (see the header).
const INERT_SIGNATURES = JSON.stringify([{ pubkey: '00'.repeat(32), sig: '00'.repeat(64) }])

function sha256Hex (text) {
    return crypto.createHash('sha256').update(String(text)).digest('hex')
}

/** A deterministic 32-hex action index derived from a tag, so re-runs upsert rather than pile up. */
function tagIndex (tag) {
    return parseInt(sha256Hex(tag).slice(0, 12), 16)
}

/**
 * The admission columns a row of `table` carries, from the fixture's own map: NULL for
 * every chain not named in `admitBlocks`, which is exactly the LEGACY spelling the
 * section 5.5 rule binds by `effective_time`.
 */
function admissionColumns (table, admitBlocks) {
    const out = {}
    const kind = ADMISSION_TABLES[table]
    if (!kind) return out
    const chains = kind === 'mapped' ? ['BTC', 'LTC', 'DOGE'] : ['BTC']
    for (const c of chains) {
        const col = admissionColumn(table, c)
        const h = admitBlocks && admitBlocks[c]
        out[col] = (h === null || h === undefined) ? null : Number(h)
    }
    return out
}

function matchRow (s, tag) {
    return Object.assign({
        match_id: sha256Hex('match|' + tag).slice(0, 80), snapshot_block: s.snapshotBlock, network: s.network,
        a_chain: s.coin, a_action_index: tagIndex('a|' + tag), a_kind: 'swap', a_amount: '1', a_filled_before: '0',
        a_ownership: 0, a_payout_addr: 'bf-inert-a', b_chain: s.otherChain, b_action_index: tagIndex('b|' + tag),
        b_kind: 'swap', b_amount: '1', b_filled_before: '0', b_ownership: 0, b_payout_addr: 'bf-inert-b',
        effective_time: s.effectiveTime, finalizing_view: 0, validator_signatures: INERT_SIGNATURES,
        status: 'finalized', a_push_generation: 0, b_push_generation: 0,
    }, admissionColumns('cross_chain_matches', s.admitBlocks))
}

function callRow (s, tag) {
    return Object.assign({
        call_id: sha256Hex('call|' + tag).slice(0, 80), phase: 'dispatch', snapshot_block: s.snapshotBlock,
        network: s.network, source_chain: s.otherChain, source_action_index: tagIndex('src|' + tag),
        source_contract_index: 1, target_chain: s.coin, target_contract_index: 1, method: 'bfInert',
        params_json: '[]', gas_limit: 1, cross_hops: 0, effective_time: s.effectiveTime, finalizing_view: 0,
        status: 'finalized', validator_signatures: INERT_SIGNATURES, push_generation: 0,
    }, admissionColumns('cross_chain_calls', s.admitBlocks))
}

function bridgeRow (s, tag) {
    return Object.assign({
        transfer_id: sha256Hex('transfer|' + tag), snapshot_block: s.snapshotBlock, network: s.network,
        src_chain: s.otherChain, src_action_index: tagIndex('bsrc|' + tag), src_address: 'bf-inert-src',
        dest_chain: s.coin, dest_address: 'bf-inert-dest', tick: 'BFINERT', decimals: 8, amount: '1',
        effective_time: s.effectiveTime, finalizing_view: 0, validator_signatures: INERT_SIGNATURES,
        status: 'finalized', push_generation: 0,
    }, admissionColumns('bridge_transfers', s.admitBlocks))
}

function policyRow (s, tag) {
    // origin_chain is the OTHER chain: the policy member scopes on `origin_chain <> coin`.
    return Object.assign({
        snapshot_id: sha256Hex('policy|' + tag), snapshot_block: s.snapshotBlock, origin_chain: s.otherChain,
        tick: 'BFINERT', policy_seq: tagIndex('seq|' + tag), origin_block: s.snapshotBlock,
        policy_hash: sha256Hex('hash|' + tag), sleeping: 0, effective_time: s.effectiveTime, network: s.network,
        finalizing_view: 0, validator_signatures: INERT_SIGNATURES, status: 'finalized', push_generation: 0,
    }, admissionColumns('policy_snapshots', s.admitBlocks))
}

function attestRow (s, tag) {
    return Object.assign({
        network: s.network, request_id: sha256Hex('request|' + tag), request_action_index: null,
        request_block_index: null, provider_id: 'bf-inert', status: 'ok', response_payload: '{}',
        response_hash: sha256Hex('body|' + tag), meta: '', effective_time: s.effectiveTime,
        signer_pubkeys: '[]', signatures: '[]', widen: 0, batch_action_index: null,
    }, admissionColumns('attestation_responses', s.admitBlocks))
}

function oracleRow (s, tag) {
    return Object.assign({
        source_address: 'bf-inert-oracle', source_chain: s.coin, coin: s.coin, tick: 'BFINERT', fiat: 'USD',
        value: '1', block_time: s.effectiveTime, effective_at: s.effectiveTime, action_index: tagIndex('oracle|' + tag),
        push_generation: 0,
    }, admissionColumns('oracle_prices', s.admitBlocks))
}

function snapshotRow (s, tag) {
    return {
        snapshot_block: s.snapshotBlock, capability: 'cross_chain',
        signing_pubkey: sha256Hex('pubkey|' + tag).slice(0, 64), amount: '1', source: 'bf-inert',
    }
}

const ROW_BUILDERS = Object.freeze({
    cross_chain_matches: matchRow, cross_chain_calls: callRow, bridge_transfers: bridgeRow,
    policy_snapshots: policyRow, attestation_responses: attestRow, oracle_prices: oracleRow,
    capability_snapshots: snapshotRow,
})

/**
 * One inert row for `table`, plus the injector options that read it back.
 *
 * @param {string} table
 * @param {object} spec  {network, coin, otherChain?, effectiveTime, snapshotBlock, admitBlocks?, tag}
 * @returns {{table: string, row: object, key: string[]}}
 */
function inertRow (table, spec) {
    const build = ROW_BUILDERS[table]
    if (!build) throw new Error('barrierFamilyRows: no inert row shape for ' + table)
    const s = Object.assign({ otherChain: 'LTC' }, spec || {})
    for (const f of ['network', 'coin', 'effectiveTime', 'snapshotBlock', 'tag']) {
        if (s[f] === undefined || s[f] === null) throw new Error('barrierFamilyRows: inertRow needs ' + f)
    }
    if (String(s.otherChain).toUpperCase() === String(s.coin).toUpperCase()) {
        throw new Error('barrierFamilyRows: otherChain must differ from coin, or the row names no read set')
    }
    return { table, row: build(s, String(s.tag)), key: NATURAL_KEYS[table] }
}

/**
 * The set BF1 seeds: one inert oracle price, one finalized row in each of the four xdex mirrors,
 * one attest response. The oracle row closes member 3's escape: without it the walker's first
 * corrected drive named eight reasons, not nine (rail 2026-09-17, v020-final-bf1-oracle-red.log).
 */
function familySeedRows (spec) {
    return ['oracle_prices', 'cross_chain_matches', 'cross_chain_calls', 'bridge_transfers', 'policy_snapshots', 'attestation_responses']
        .map((t) => inertRow(t, Object.assign({}, spec, { tag: spec.tag + '|' + t })))
}

/*
 * WHERE AN ARMED VENUE CANNOT TAKE A NULL-MAP ROW. A row whose era block is at or above the
 * producer activation and whose every admission column is NULL is a row no hub produces. The
 * canonical builders refuse it ("admission-era row at block N ... has no admit_blocks",
 * admissionCanonicalValue), and that refusal is a thrown error that stalls the block wherever the
 * apply pass reaches the canonical for a due row.
 *
 * These two tables reach it unconditionally: bridge_settle/transfer.js guardQuorumAndEscrow and
 * bridge_settle/policy.js guardQuorumAndCopy build the canonical as verifyQuorum's ARGUMENT, before the
 * capability set is read (rail 2026-09-17: BF2 stalled at block 104 on its legacy bridge row). The match
 * and call passes read the capability set first and defer while it is empty (cross_settle/quorum.js,
 * xexec/dispatch_quorum.js), and the attest pass selects mirror rows only for a pending request, so a
 * NULL-map row in those tables is never canonicalized on these venues.
 *
 * WHAT CHANGED, and why the table list is no longer a seeding rule. While the legs armed at genesis
 * this list doubled as a workaround: BF2 simply did not seed a legacy row in these two tables, because
 * on a venue armed at height 0 every era block is admission era and a "legacy" seed was really a modern
 * row missing its map (adjudicated 2026-09-18: the product is correct, the seed was the defect). The
 * legs now arm at a crossing and seed their legacy rows BELOW it, where the builder returns an empty
 * canonical and no pass throws, so every member table takes a legacy row. The list survives as the
 * SCOPE of the guard below, which is now keyed on the era rather than on the table alone.
 */
const CANONICAL_BEFORE_QUORUM_TABLES = Object.freeze(['bridge_transfers', 'policy_snapshots'])

// The column each table's era is fixed by, the one the canonical builder keys on. Only the tables
// the guard scopes over are listed: a table added here without an era column is a defect, not a pass.
const ERA_BLOCK_COLUMN = Object.freeze({ bridge_transfers: 'snapshot_block', policy_snapshots: 'snapshot_block' })

/**
 * The seeds an armed venue would stall on: finalized rows in a CANONICAL_BEFORE_QUORUM table whose
 * every admission column is NULL and whose ERA BLOCK is at or above the activation. A map naming any
 * chain builds its canonical and is not a hazard; nor is a NULL-map row below the activation, which is
 * an honest legacy row and builds an empty canonical tail.
 *
 * @param {Array<{table: string, row: object, key: string[]}>} seeds  inertRow results
 * @param {number} [armHeight]  the producer activation; omitted means the genesis form, where every
 *                              era block is admission era and every NULL-map seed is a hazard
 * @returns {string[]} one 'table|key' per offending seed; empty when the set is safe to seed armed
 */
function armedLegacyApplyHazards (seeds, armHeight) {
    const activation = (armHeight === undefined || armHeight === null) ? 0 : Number(armHeight)
    if (!Number.isSafeInteger(activation) || activation < 0) throw new Error('barrierFamilyRows: bad arm height ' + armHeight)
    const out = []
    for (const s of seeds || []) {
        if (!s || !CANONICAL_BEFORE_QUORUM_TABLES.includes(s.table)) continue
        const r = s.row || {}
        // A retracted row is outside every apply select (status = 'finalized'), so it never reaches a canonical.
        if (r.status !== 'finalized') continue
        const cols = Object.keys(admissionColumns(s.table, null))
        if (!cols.every((c) => r[c] === null || r[c] === undefined)) continue
        // An unreadable era block fails CLOSED: the builder reads it as pre-activation, but a seed that
        // cannot say which era it is in is a harness defect and the leg should hear about it here.
        // NULL and the empty string are the trap, since Number() reads both as block 0.
        const raw = r[ERA_BLOCK_COLUMN[s.table]]
        const era = (raw === null || raw === undefined || raw === '') ? Number.NaN : Number(raw)
        if (Number.isSafeInteger(era) && era < activation) continue
        out.push(s.table + '|' + (s.key || []).map((k) => r[k]).join(','))
    }
    return out
}

/**
 * BF2's member rows against drill height B: per table one row admitted AT B, one PAST B, and one
 * LEGACY row seeded at `legacyBlock`, a block below the activation, where a NULL admission map is
 * what a pre-crossing hub really wrote. The legacy rule itself is BF4's to prove; BF2's spec asserts
 * the set with admit_blocks[BTC] <= B.
 *
 * @param {string[]} tables     the member tables
 * @param {object} base         inertRow spec without tag or admitBlocks
 * @param {number} B            the drill height
 * @param {string} tagTail      distinguishes re-runs (the leg passes the held tip)
 * @param {number} legacyBlock  the legacy seed's era block (barrierFamilyFixture.legacyEraBlock)
 */
function admissionSeedRows (tables, base, B, tagTail, legacyBlock) {
    if (!Number.isSafeInteger(Number(legacyBlock)) || Number(legacyBlock) < 0) {
        throw new Error('barrierFamilyRows: admissionSeedRows needs a legacyBlock below the activation, got ' + legacyBlock)
    }
    const seeds = []
    for (const t of tables) {
        seeds.push(inertRow(t, Object.assign({}, base, { tag: 'bf2|at|' + t + '|' + tagTail, admitBlocks: { BTC: B } })))
        seeds.push(inertRow(t, Object.assign({}, base, { tag: 'bf2|past|' + t + '|' + tagTail, admitBlocks: { BTC: B + 3 } })))
        seeds.push(inertRow(t, Object.assign({}, base, { tag: 'bf2|legacy|' + t + '|' + tagTail, snapshotBlock: Number(legacyBlock) })))
    }
    return seeds
}

// "Finalized" per table: the xdex rails carry a finalized/retracted lifecycle, the attest
// response rail carries only the TERMINAL vocabulary (ok/expired) and every row counts.
function finalizedClause (table) {
    return table === 'attestation_responses' ? '1 = 1' : "status = 'finalized'"
}

// The coin scope each member's refresh applies (hub_db_sync barriers, verbatim shapes),
// so a leg counting the rows that could fire a content escape counts what the member reads.
const COIN_SCOPE = Object.freeze({
    cross_chain_matches:   { where: '(a_chain = ? OR b_chain = ?)', args: (c) => [c, c] },
    cross_chain_calls:     { where: '(target_chain = ? OR source_chain = ?)', args: (c) => [c, c] },
    bridge_transfers:      { where: '(src_chain = ? OR dest_chain = ?)', args: (c) => [c, c] },
    policy_snapshots:      { where: 'origin_chain <> ?', args: (c) => [c] },
    attestation_responses: { where: '1 = 1', args: () => [] },
})

/**
 * The rows in `table` that could fire a member's CONTENT escape at t(B): finalized, in
 * this coin's scope, `effective_time >= t(B)`. A quiet federation has zero of them and
 * a full-hold assertion is only meaningful while that stays true.
 */
function contentEscapeSql (table, coin, blockTime) {
    const scope = COIN_SCOPE[table]
    if (!scope) throw new Error('barrierFamilyRows: no coin scope for ' + table)
    return {
        sql: 'SELECT COUNT(*) AS n FROM `' + table + '` WHERE ' + finalizedClause(table) + ' AND ' + scope.where +
             ' AND effective_time >= ?',
        args: scope.args(String(coin).toUpperCase()).concat([Number(blockTime)]),
    }
}

/**
 * The section 5.5 rule as SQL, in the IS NULL OR form and never a bare comparison on the
 * nullable column (C33): the rows of `table` readable at B on `chain`.
 */
function readableRowsSql (table, chain, blockHeight, blockTime) {
    const col = admissionColumn(table, chain)
    const keyCol = NATURAL_KEYS[table][0]
    return {
        sql: 'SELECT `' + keyCol + '` AS k FROM `' + table + '` WHERE ' + finalizedClause(table) + ' AND ((`' + col +
             '` IS NULL AND effective_time <= ?) OR (`' + col + '` IS NOT NULL AND `' + col + '` <= ?)) ORDER BY `' +
             keyCol + '` ASC',
        args: [Number(blockTime), Number(blockHeight)],
        column: col,
    }
}

/**
 * BF1's grace ladder: each graced member's grace one step ABOVE the member before it in
 * loop order, so a block stamped ahead of the hub's clock is released by the members one
 * at a time and `/status` names each in turn. Returns a venue `graces` object keyed by the
 * venue's grace keys. The ungraced member (snapshot) is not here: it is content-keyed.
 */
function graceLadder (stepS) {
    const step = Number(stepS)
    if (!Number.isInteger(step) || step <= 0) throw new Error('barrierFamilyRows: graceLadder needs a positive step')
    const byReason = {}
    for (const key of MIRROR_BARRIERS) byReason[gracedBarrierReason(key)] = key
    const out = {}
    let rung = 0
    for (const reason of FAMILY_REASONS_LOOP_ORDER) {
        const key = byReason[reason]
        if (!key) continue
        rung += 1
        out[key] = rung * step
    }
    return out
}

/** The reasons the ladder can name, in loop order: every family reason the venue can grace. */
function ladderReasons () {
    const graced = new Set(MIRROR_BARRIERS.map(gracedBarrierReason))
    return FAMILY_REASONS_LOOP_ORDER.filter((r) => graced.has(r))
}

/**
 * Whether an observed sequence of reasons is the family in LOOP ORDER: every entry a family
 * reason, strictly increasing loop position, no repeats. A leg de-duplicates consecutive
 * repeats before asking (a member is observed many times while it holds).
 */
function inLoopOrder (observed) {
    let last = -1
    for (const r of observed || []) {
        const at = FAMILY_REASONS_LOOP_ORDER.indexOf(r)
        if (at <= last) return false
        last = at
    }
    return true
}

/**
 * What BF1 may assert about the CLASS of each walker observation, and where it fails.
 *
 * `/status` keeps naming the member that last deferred until the next member's own wait times
 * out (a reason is written on a defer and cleared on a commit), so for about one barrier cycle
 * after a rung opens the walker still reads that rung's reason with a `stallClearsAt` already in
 * the past, and the health verdict for it is `barrier_defer` or `wedged`, never a future wait
 * (rail 2026-09-17: oracle, stamp + 180 s at 09:03:55Z, read `wedged` until match deferred at
 * 09:04:58Z). So the class is asserted only where it is decidable from the harness clock:
 *
 *   - every graced observation carries `stallClearsAt == (stamp + its own rung) * 1000`;
 *   - one RETURNED before that instant (`at`) must read `future_block_wait`, since the node's
 *     clock read happened earlier still;
 *   - one REQUESTED at or after it (`askedAt`) must NOT read `future_block_wait`, or the
 *     deadline is not real;
 *   - one straddling the instant is not judged;
 *   - every graced member observed needs at least one pre-deadline future wait, or the class
 *     assertion above is vacuous for that member.
 *
 * `skip` names reasons with no clock deadline to judge (price's height case, snapshot).
 *
 * @param {Array<{askedAt?: number, at: number, stallReason: string, stallClass: string, stallClearsAt: *}>} walk
 * @param {object} ladderByReason  reason -> grace seconds
 * @param {number} stampS          the walker block's stamp, seconds
 * @param {string[]} [skip]
 * @returns {string[]} one line per fault; empty when the walk satisfies every rule
 */
function enumerationClassFaults (walk, ladderByReason, stampS, skip) {
    const skipped = new Set(skip || [])
    const faults = []
    const preDeadlineWait = {}
    for (const obs of walk || []) {
        const reason = obs.stallReason
        if (skipped.has(reason) || !Object.prototype.hasOwnProperty.call(ladderByReason || {}, reason)) continue
        if (!(reason in preDeadlineWait)) preDeadlineWait[reason] = false
        const want = (Number(stampS) + Number(ladderByReason[reason])) * 1000
        if (obs.stallClearsAt !== want) {
            faults.push(reason + ' clears at ' + obs.stallClearsAt + ', not stamp + its own grace ' + ladderByReason[reason] + ' = ' + want)
            continue
        }
        const askedAt = Number.isFinite(obs.askedAt) ? obs.askedAt : obs.at
        if (obs.at < want) {
            if (obs.stallClass === 'future_block_wait') preDeadlineWait[reason] = true
            else faults.push(reason + ' reported ' + obs.stallClass + ' at ' + obs.at + ', before its deadline ' + want)
        } else if (askedAt >= want && obs.stallClass === 'future_block_wait') {
            faults.push(reason + ' still reported future_block_wait when asked at ' + askedAt + ', past its deadline ' + want)
        }
    }
    for (const reason of Object.keys(preDeadlineWait)) {
        if (!preDeadlineWait[reason]) faults.push(reason + ' was never observed in future_block_wait before its deadline')
    }
    return faults
}

/**
 * The published admission heights a drill block B still lacks on one indexer: for each table,
 * the height `/status` shows for `coin` against the barrier's line `B - marginOf(table)`. A
 * missing or non-integer entry is a shortfall with `have: null`, never a zero, matching the
 * indexer's publishedHeight (xchain-indexer hub_db_sync/watermarks.js).
 *
 * @param {object} heights   the `/status` hubMirror.heights map, table -> chain -> height
 * @param {string[]} tables
 * @param {string} coin      upper-case chain code
 * @param {number} B         the drill height
 * @param {function} marginOf table -> ADMIT_MARGIN_BLOCKS[table]
 * @returns {Array<{table: string, chain: string, have: number|null, need: number}>}
 */
function admissionHeightShortfalls (heights, tables, coin, B, marginOf) {
    const out = []
    for (const table of tables || []) {
        const need = Number(B) - Number(marginOf(table))
        const entry = heights && heights[table]
        const h = entry && typeof entry === 'object' ? entry[coin] : undefined
        const have = (typeof h === 'number' && Number.isSafeInteger(h) && h >= 0) ? h : null
        if (have === null || have < need) out.push({ table, chain: coin, have, need })
    }
    return out
}

/** One shortfall in the indexer's own heightTail spelling, so a harness failure greps like the node's log. */
function describeShortfall (s) {
    return 'admission height ' + s.table + '.' + s.chain + ' at ' + (s.have === null ? 'none' : s.have) + ', needs ' + s.need
}

/** Collapse consecutive repeats: the distinct reasons in the order they were first seen. */
function distinctRuns (observed) {
    const out = []
    for (const r of observed || []) if (out.length === 0 || out[out.length - 1] !== r) out.push(r)
    return out
}

// The indexer's deferral line for one member on one block: `Deferring block N (<member>): `.
const DEFER_LINE = /Deferring block (\d+) \(([^)]+)\):/
// The one part of a timed-out line that moves between two otherwise identical cycles: the
// hub's stream watermark, a wall clock the member re-reads on every attempt.
const WATERMARK_TAIL = /stream watermark at \d+/g

/**
 * The timed-out deferral lines a log tail carries for `blockHeight`, grouped by their
 * text with the log timestamp and the moving watermark value stripped, so "three
 * identical timed-out lines" is a count on one key rather than a regex match that a
 * differently worded retry would satisfy.
 *
 * @returns {{lines: number, distinct: string[], identical: number}} identical is the
 *          largest run of one line text
 */
function timedOutLines (logText, blockHeight) {
    const counts = new Map()
    for (const raw of String(logText || '').split('\n')) {
        const m = DEFER_LINE.exec(raw)
        if (!m || Number(m[1]) !== Number(blockHeight)) continue
        const key = raw.slice(m.index).replace(WATERMARK_TAIL, 'stream watermark at N').replace(/\s+/g, ' ').trim()
        counts.set(key, (counts.get(key) || 0) + 1)
    }
    let identical = 0
    for (const n of counts.values()) identical = Math.max(identical, n)
    return { lines: Array.from(counts.values()).reduce((a, b) => a + b, 0), distinct: Array.from(counts.keys()), identical }
}

// ---------------------------------------------------------------------------
// AT4: the signed admission-era corpus the replay witness reads
// ---------------------------------------------------------------------------

/**
 * The request contract the AT4 corpus drive deploys: AT1's asker, one `ask` that emits
 * a redundancy-3 attestation request and one callback that records what arrived. The
 * context tag is what tells this drive's callback apart from AT1's in contract state.
 */
function attestRequestContractCode (deadlineBlocks, contextTag) {
    const d = Number(deadlineBlocks)
    if (!Number.isSafeInteger(d) || d <= 0) throw new Error('barrierFamilyFixture: bad deadline ' + deadlineBlocks)
    if (!/^[A-Za-z0-9-]+$/.test(String(contextTag))) throw new Error('barrierFamilyFixture: bad context tag ' + contextTag)
    return `
module.exports = {
    meta: { name: 'Admission Corpus Asker', description: 'Requests an attestation whose response is admitted by height through the hub mirror.', version: '1.0.0' },
    ask: function(xchain) {
        var requestId = xchain.attestation.request(xchain.getInputParam(0), xchain.getInputParam(1), 'handleResponse', ['${contextTag}'], { redundancy: 3, deadlineBlocks: ${d} });
        xchain.state.set('pending_request_id', requestId);
        return requestId;
    },
    handleResponse: function(xchain) {
        xchain.state.set('callback_request_id',  xchain.getInputParam(0));
        xchain.state.set('callback_provider_id', xchain.getInputParam(1));
        xchain.state.set('callback_status',      xchain.getInputParam(2));
        xchain.state.set('callback_payload',     xchain.getInputParam(3));
        xchain.state.set('callback_context',     xchain.getInputParam(4));
    }
};
`
}

/** A signatures cell that carries at least one signature (JSON text or an array). */
function hasSignatures (cell) {
    if (cell === null || cell === undefined) return false
    if (Array.isArray(cell)) return cell.length > 0
    const s = String(cell).trim()
    return s !== '' && s !== '[]' && s !== 'null' && s !== '{}'
}

/**
 * JSON for a console line or an assertion message, safe over a raw mariadb row or any
 * value nested under it. The driver hands back BIGINT columns (an admission height, a
 * block or action index) as BigInt, and plain JSON.stringify throws on those; the AT4
 * corpus drive prints exactly such rows on every finalize and apply step.
 *
 * Walks the value itself rather than leaning on a JSON.stringify replacer: replacer
 * only runs after JSON.stringify's own toJSON lookup, and another loaded module can
 * define BigInt.prototype.toJSON (the SDK does, for its own amount serialization),
 * which would hand the replacer an already-stringified value and hide the BigInt.
 */
function bigintSafe (value) {
    if (typeof value === 'bigint') return Number(value)
    if (Array.isArray(value)) return value.map(bigintSafe)
    if (value && typeof value === 'object') {
        const out = {}
        for (const k of Object.keys(value)) out[k] = bigintSafe(value[k])
        return out
    }
    return value
}

function bigintSafeStringify (value) {
    return JSON.stringify(bigintSafe(value))
}

/**
 * What stops one signed response from being an admission-era corpus row, as findings
 * (empty means it is one). `mirrorRows[i]` is indexer i's mirror rows for the request,
 * `applied[i]` its applied v1 row. The claims: every mirror row is signed and carries an
 * admission height in `column`; both mirrors agree on the earliest one; each indexer
 * applied the response with no transaction AT that height; and the two applies agree.
 *
 * @returns {{findings: string[], admitHeight: number|null}}
 */
function admitHeightApplyFindings (column, mirrorRows, applied) {
    const findings = []
    const perIndexer = mirrorRows.map((rowsOf, i) => {
        if (!rowsOf || rowsOf.length === 0) { findings.push('indexer ' + i + ' holds no mirror row'); return null }
        for (const r of rowsOf) {
            const tag = String(r.response_hash).slice(0, 16)
            if (r[column] === null || r[column] === undefined) findings.push('indexer ' + i + ': mirror row ' + tag + ' carries no ' + column + ', a legacy-era row')
            if (!hasSignatures(r.signatures)) findings.push('indexer ' + i + ': mirror row ' + tag + ' carries no signatures')
        }
        const heights = rowsOf.map((r) => r[column]).filter((h) => h !== null && h !== undefined).map(Number)
        return heights.length ? Math.min(...heights) : null
    })
    if (new Set(perIndexer.map(String)).size !== 1) findings.push('the mirrors disagree on the admission height: ' + JSON.stringify(perIndexer))
    const admitHeight = perIndexer[0]
    applied.forEach((a, i) => {
        if (!a) { findings.push('indexer ' + i + ' has not applied the response'); return }
        if (a.tx_index !== null) findings.push('indexer ' + i + ' applied it with tx_index ' + a.tx_index + ', not NULL')
        if (perIndexer[i] !== null && Number(a.block_index) !== perIndexer[i]) {
            findings.push('indexer ' + i + ' applied it at block ' + a.block_index + ', not at its admission height ' + perIndexer[i])
        }
    })
    const [first, ...others] = applied
    for (const [k, other] of others.entries()) {
        for (const f of ['action_index', 'block_index', 'response_hash']) {
            if (first && other && String(first[f]) !== String(other[f])) findings.push('indexer ' + (k + 1) + ' applied ' + f + '=' + other[f] + ' while indexer 0 applied ' + first[f])
        }
    }
    return { findings, admitHeight }
}

const SQL_NAME = /^[A-Za-z0-9_]+$/
const sameServer = (a, b) => String(a.host).replace(/^localhost$/, '127.0.0.1') === String(b.host).replace(/^localhost$/, '127.0.0.1') && String(a.port) === String(b.port)

/**
 * The replay witness invocation for a corpus the AT4 drive built, or the refusals that
 * make the corpus unreadable by it. The activation height H sits strictly above the
 * admission height and at or below the corpus tip, so BOUNDARY replays the admitting
 * block in the legacy era (A1 covers it) while ON applies it there (A2 has a difference).
 * The password is passed by the NAME of its variable, never by value.
 *
 * @param {{indexerRoot: string, coin: string, network: string, decoderDb: string,
 *          decoderServer: {host, port}, mirrorDb: string, db: {host, port, user},
 *          passEnv: string, hubDbDisposable: boolean, admitHeight: number, corpusTip: number}} o
 * @returns {{refusals: string[], activationHeight: number|null, argv: string[], line: string}}
 */
function replayWitnessCommand (o) {
    const refusals = []
    for (const k of ['decoderDb', 'mirrorDb']) if (!SQL_NAME.test(String(o[k]))) refusals.push(k + ' ' + o[k] + ' is not a plain schema name')
    if (!/^[A-Z_][A-Z0-9_]*$/.test(String(o.passEnv))) refusals.push('passEnv ' + o.passEnv + ' is not an environment variable name')
    if (!sameServer(o.decoderServer, o.db)) refusals.push('the decoder schema is on ' + o.decoderServer.host + ':' + o.decoderServer.port + ' and the mirror on ' + o.db.host + ':' + o.db.port + '; the witness reads both from one server')
    if (o.hubDbDisposable) refusals.push('the mirror lives in a disposable database that the venue removes at stop, so no witness can read it afterwards')
    const admit = Number(o.admitHeight)
    const tip = Number(o.corpusTip)
    const valid = Number.isSafeInteger(admit) && Number.isSafeInteger(tip) && tip > admit
    if (!valid) refusals.push('the corpus tip ' + o.corpusTip + ' is not above the admission height ' + o.admitHeight + ', so no H inside the corpus sits above it')
    const H = valid ? Math.floor((admit + 1 + tip) / 2) : null
    const argv = [path.join(o.indexerRoot, 'bin', 'verify-mirror-admission-replay-equivalence.js'),
        '--coin', String(o.coin), '--network', String(o.network), '--decoder-db', String(o.decoderDb),
        '--mirror-db', String(o.mirrorDb), '--activation-height', String(H),
        '--db-host', String(o.db.host), '--db-port', String(o.db.port), '--db-user', String(o.db.user), '--db-pass-env', String(o.passEnv)]
    return { refusals, activationHeight: H, argv, line: 'node ' + argv.join(' ') }
}

module.exports = {
    NATURAL_KEYS,
    INERT_SIGNATURES,
    COIN_SCOPE,
    finalizedClause,
    inertRow,
    familySeedRows,
    admissionColumns,
    CANONICAL_BEFORE_QUORUM_TABLES,
    armedLegacyApplyHazards,
    admissionSeedRows,
    contentEscapeSql,
    readableRowsSql,
    graceLadder,
    ladderReasons,
    inLoopOrder,
    enumerationClassFaults,
    admissionHeightShortfalls,
    describeShortfall,
    distinctRuns,
    timedOutLines,
    sha256Hex,
    attestRequestContractCode,
    bigintSafeStringify,
    admitHeightApplyFindings,
    replayWitnessCommand,
}
