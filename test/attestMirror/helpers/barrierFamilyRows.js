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

/** The set BF1 seeds: one finalized row in each of the four xdex mirrors, one attest response. */
function familySeedRows (spec) {
    return ['cross_chain_matches', 'cross_chain_calls', 'bridge_transfers', 'policy_snapshots', 'attestation_responses']
        .map((t) => inertRow(t, Object.assign({}, spec, { tag: spec.tag + '|' + t })))
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

module.exports = {
    NATURAL_KEYS,
    INERT_SIGNATURES,
    COIN_SCOPE,
    finalizedClause,
    inertRow,
    familySeedRows,
    admissionColumns,
    contentEscapeSql,
    readableRowsSql,
    graceLadder,
    ladderReasons,
    inLoopOrder,
    distinctRuns,
    timedOutLines,
    sha256Hex,
}
