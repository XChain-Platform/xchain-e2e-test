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

const { readAppliedResponse } = require('./databaseReads')

const { captureFederationState } = require('./federationCapture')

const { untilOrClearDogeStall } = require('./miningAndStallRecovery')

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
 * Wait until BOTH venue indexers hold at least one mirror row for a request.
 *
 * Both, because a single node holding it proves the hub wrote a row and proves
 * nothing about dissemination. At least one, not exactly one: a round that
 * finalized under two leader slots leaves two honestly signed rows differing
 * only in effective_time, and since 2026-09-06 the mirror keeps both by design
 * (the key is network, request_id, effective_time). Which of them binds is the
 * applier's §4.1 tie-break, and the applied wait is what proves that choice.
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
        return { ok: rows.every((r) => r.length >= 1), rows: rows }
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

module.exports = {
    venueTipProbe,
    allHubTails,
    responsibleHubTails,
    standingTipProbe,
    waitForMirrorRowEverywhere,
    waitForAppliedEverywhere,
}
