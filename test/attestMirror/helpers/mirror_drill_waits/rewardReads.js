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

const { jsonSafe } = require('./arithmeticAndVerdicts')

const { queryDb } = require('./databaseReads')

/**
 * The fee-settlement lines a venue indexer logged, for a reward assertion.
 *
 * `settleRequestFee` says exactly what it did (`ATTEST fee : <amount> ... split
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

module.exports = { feeLines, rawAttestRewards, readAttestRewards }
