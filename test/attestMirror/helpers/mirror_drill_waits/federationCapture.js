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

const { queryDb } = require('./databaseReads')

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

module.exports = { captureFederationState }
