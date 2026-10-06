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

const { untilOrClearDogeStall } = require('./miningAndStallRecovery')

const { standingTipProbe } = require('./mirrorAndApplyWaits')

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

module.exports = { findEmittedAttestRequest, attestRequestWatermark }
