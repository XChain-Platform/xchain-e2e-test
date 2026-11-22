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
 **********************************************************************/

// The response-carrying case, one wait per function. See ../at5_batch_replay.test.js.

const assert = require('assert')

const vmHelper = require('../../helpers/vmHelper')
const { mineWhile } = require('../helpers/mirrorDrillFixture')
const {
    untilOrClearDogeStall, waitForMirrorRowEverywhere, venueTipProbe, findEmittedAttestRequest,
    clearBeforeBroadcast, allHubTails, attestRequestWatermark, settleOrReport, jsonSafe,
} = require('../helpers/mirrorDrillWaits')
const { oneValidHeadVerdict } = require('../helpers/batchWindowVerdicts')
const { recordHubsReading } = require('./hubs_reading.test.js')
const { readMarkers, nudgeDoge, readDogeBatchActions } = require('./chain_reads.test.js')
const {
    DEADLINE_BLOCKS, BURIAL_BLOCKS, LLM_PAYLOAD, BATCH_HEAD_VERSION, BATCH_CONTINUATION_VERSION,
} = require('./config.test.js')


/** Two EXECUTEs of `ask`; returns the two request ids. */
async function requestResponses (ctx) {
    const { contract, responseProvider, testServer } = ctx
    // Two responses in one window, so the head declares more than one row and
    // the batch carries a real set rather than a single value.
    //
    // TWO IDENTICAL PAYLOADS ARE STILL TWO REQUESTS: the request id is
    // sha256 over (txHash, rootActionIndex, callPath, contractIndex,
    // emissionIndex) and never over the payload (xchain-vm gateway.js), so two
    // EXECUTEs of `ask` with the same prompt get different ids. Identical
    // prompts are in fact the safer choice here, because every responsible hub
    // must converge byte for byte on each answer.
    const ids = []
    const responsePayload = responseProvider === 'http_get' ? testServer.url : LLM_PAYLOAD
    for (const tag of ['b1', 'b2']) {
        const sinceAction = await attestRequestWatermark(contract.contractIndex)
        await clearBeforeBroadcast()
        const exec = await mineWhile(() => vmHelper.sendExecuteV0(
            contract.owner, contract.contractIndex, 'ask', [responseProvider, responsePayload, tag]))
        assert.strictEqual(exec.execution.status, 'valid',
            tag + ': the EXECUTE that emits the request came back ' + exec.execution.status +
            '. A deadline above the provider\'s own window is rejected by the VM gateway at CALL ' +
            'time, and this drill requests ' + DEADLINE_BLOCKS + ' blocks, so this is the shape an over-long ' +
            'deadline takes as well as the shape a short responsible set takes.')
        // Correlated on the emitting action, never on the broadcast txid: for a
        // P2SH-encoded EXECUTE that hash is not the one recorded against the row.
        const request = await findEmittedAttestRequest(
            contract.contractIndex, sinceAction + 1, { label: tag })
        ids.push(request.requestId)
    }

    return ids
}

/** Bury the requests and wait for every responsible hub to mirror the finalized rows. */
async function awaitMirrored (ctx, ids) {
    const { venue } = ctx
    await regtestMinerConnector.generateBlocks(BURIAL_BLOCKS)
    await settleOrReport('at5')
    // NOTHING IS MINED UNDER THE MIRROR WAIT, and that is AT1's llm lesson
    // rather than a saving. The blocks would buy the widening ladder room to
    // climb, which this venue has never needed: the roster is adopted, every
    // draw is venue-only, and every finalized round on it has closed at widen 0.
    // What they DO buy is the request's own expiry, and at llm's 20-block
    // ceiling there is barely a ladder's worth of chain between the burial
    // blocks above and the deadline, so a wait that mines here spends the
    // window before the round can finish.
    for (const id of ids) await waitForMirrorRowEverywhere(venue, id)

    // AND THE DRILL STOPS AT THE MIRROR ROW, DELIBERATELY: it no longer waits
    // for the response to be APPLIED on the venue indexers, which the http_get
    // form of this drill did.
    //
    // The clause AT5 owns is that a window of responses reaches DOGE as a v5
    // head and the link comes back onto the mirrored row. Every step of that
    // reads `attestation_responses`, which the hub writes at FINALIZATION;
    // application is a BTC-indexer act on the far side of the mirror and is
    // AT1's subject, driven green there 2026-09-05. So the applied wait proved
    // nothing here and cost the whole block budget.
    //
    // At llm's deadline it could not be paid for in any case, and the
    // arithmetic is worth keeping because it is the thing that changed with the
    // provider. A row binds at the first block whose PROTOCOL time reaches its
    // signed effective_time; off mainnet protocol time is median-time-past, so
    // six of the last eleven blocks must be stamped past a signature set
    // FORWARD_S (90 s) in the future. At a 20-block deadline, minus the burial
    // blocks, there is no room to mine six blocks over ninety seconds of wall
    // clock before the expiry sweep fires. Pass 24 lost that race with five
    // times the budget.
    console.log('AT5: ' + ids.length + ' responses finalized and mirrored; waiting for their window to close')
}

/** Wait for a hub to publish a non-empty window; returns its marker. */
async function awaitPublished (ctx) {
    const { venue } = ctx
    // The window has to close, be elected, be signed and be broadcast. Several
    // windows of patience, because rank decides who publishes and when.
    const sent = await untilOrClearDogeStall(async () => {
        // One DOGE block per poll, IN SEQUENCE with everything else this drill
        // does (a timer-driven cadence raced the rail switch, pass 9). The
        // publisher pays each window out of the previous window's CHANGE and the
        // encoder spends confirmed outputs only; with nothing mining DOGE here,
        // pass 8 saw 8 of 22 windows fail `insufficient funds`, the responses'
        // window among them, and the publisher never retries a failed broadcast.
        await nudgeDoge()
        const markers = await readMarkers(venue)
        const hit = markers.filter((m) => Number(m.row_count) > 0 &&
            (String(m.status) === 'sent' || String(m.status) === 'landed'))
        return { ok: hit.length > 0, hit: hit, markers: markers }
    }, { timeoutMs: 30 * 60 * 1000, intervalMs: 5000, tipProbe: venueTipProbe(venue, 0) })
    assert.ok(sent.ok,
        'no hub ever published a non-empty window. Markers seen: ' + jsonSafe(sent.markers) +
        '. A window with rows that never reaches `sent` is either unelected, unsigned, unanchored or ' +
        'unfunded, and the hub logs say which. Publication is ELECTED, so the hub that should have ' +
        'published is not knowable here and every tail follows.\n' + allHubTails(venue))
    const marker = sent.hit[0]
    console.log('AT5: hub ' + marker.hub + ' published window ' + marker.window_start + '-' +
        marker.window_end + ' with ' + marker.row_count + ' row(s), status ' + marker.status)
    return marker
}

/** Wait for the window's VALID v5 head on DOGE. */
async function awaitLanded (ctx, marker) {
    const { venue, dogeVenue } = ctx
    const landed = await untilOrClearDogeStall(async () => {
        await nudgeDoge()
        const actions = await readDogeBatchActions(dogeVenue)
        const heads = actions.filter((a) => Number(a.version) === BATCH_HEAD_VERSION &&
            Number(a.batch_window_start) === Number(marker.window_start))
        // A VALID head, not the first head. The same window's head can sit on the
        // chain more than once and the indexer judges each arrival on what it holds
        // at that block: pass 18 (2026-09-05) recorded one `invalid: ATTEST_BATCH
        // (crc32-mismatch)` head, its continuations not yet all indexed, and two
        // valid ones for one window, and the lowest action index was the invalid
        // one. Coverage is provable the moment ONE valid head exists.
        const valid = heads.filter((h) => String(h.verdict) === 'valid')
        return { ok: valid.length > 0, heads: heads, valid: valid, actions: actions }
    }, { timeoutMs: 20 * 60 * 1000, intervalMs: 5000, tipProbe: venueTipProbe(venue, 0) })
    assert.ok(landed.ok,
        'the published window never appeared on DOGE as a VALID ATTEST v5. Heads seen for it: ' +
        jsonSafe((landed.heads || []).map((h) => ({ action: h.action_index, block: h.block_index, verdict: h.verdict }))) +
        '. All batch actions seen: ' + jsonSafe(landed.actions))
    if (landed.heads.length > landed.valid.length) {
        console.log('AT5 NOTE: window ' + marker.window_start + ' has ' + landed.heads.length + ' head row(s) on DOGE, ' +
            landed.valid.length + ' valid; the others: ' +
            landed.heads.filter((h) => String(h.verdict) !== 'valid').map((h) => h.action_index + '=' + h.verdict).join(', '))
    }

    return landed
}

/** Let a further window close, then require exactly one valid head for this one. */
async function awaitSingleHead (ctx, marker) {
    const { venue, dogeVenue } = ctx
    // Let one further window close before judging uniqueness, so another hub's
    // age-based turn has passed and a duplicate valid head cannot hide behind
    // an assertion made as soon as the first head lands.
    const oneHead = await untilOrClearDogeStall(async () => {
        const markers = await readMarkers(venue)
        const later = markers.filter((m) => Number(m.window_start) >= Number(marker.window_end))
        if (later.length === 0) return { ok: false, markers: markers }
        await nudgeDoge()
        const actions = await readDogeBatchActions(dogeVenue)
        return {
            ok: true,
            markers: markers,
            actions: actions,
            verdict: oneValidHeadVerdict(actions, marker.window_start),
        }
    }, { timeoutMs: 30 * 60 * 1000, intervalMs: 5000, tipProbe: venueTipProbe(venue, 0) })
    assert.ok(oneHead.ok,
        'no further window closed after response window ' + marker.window_start +
        '. Markers seen: ' + jsonSafe(oneHead.markers))
    assert.ok(oneHead.verdict.ok,
        'response window ' + marker.window_start + ' did not carry exactly one valid v5 head ' +
        'after a further window closed. Heads seen: ' + jsonSafe(oneHead.verdict.heads) +
        '. All batch actions seen: ' + jsonSafe(oneHead.actions))
    await recordHubsReading(venue, marker, () => readMarkers(venue), nudgeDoge)
}

/** The head's declared rows and chunks against the marker and the continuations that landed. */
function assertHeadCoverage (ctx, landed, marker) {
    const { responseProvider } = ctx
    const head = landed.valid[0]
    assert.strictEqual(Number(head.batch_row_count), Number(marker.row_count),
        'the head declares ' + head.batch_row_count + ' rows and the publisher recorded ' +
        marker.row_count)

    const total = Number(head.batch_total_chunks)
    assert.ok(total >= 1, 'the head declares no chunk total')
    if (total > 1) {
        const conts = landed.actions.filter((a) => Number(a.version) === BATCH_CONTINUATION_VERSION)
        assert.ok(conts.length >= total - 1,
            'the head declares ' + total + ' chunks but only ' + conts.length +
            ' continuation(s) landed, so the window cannot be reassembled from chain alone')
        console.log('AT5: window landed as a v5 head plus ' + conts.length + ' v6 continuation(s)')
    } else {
        // Said out loud rather than passed over. Both deterministic response
        // modes intentionally use a small body, because this reading is about
        // one batch head and publisher reconcile rather than chunk capacity.
        console.log('AT5 NOTE: the window fitted in ONE wire, so no v6 continuation was produced ' +
            'and the continuation half of this clause was NOT exercised by provider ' + responseProvider + '.')
    }
}

/** The link comes back onto every carried mirror row. */
async function awaitLinked (ctx, ids) {
    const { venue } = ctx
    // AND THE LINK COMES BACK. The DOGE side pushes the batch to the hub, the hub
    // stamps batch_action_index on its mirror row and re-broadcasts it, and the BTC
    // indexer writes it onto the applied response. That whole road is what this
    // single column proves.
    const linked = await untilOrClearDogeStall(async () => {
        // The link travels DOGE parse to hub push to mirror stream, so the DOGE
        // side has to keep confirming for any of it to happen.
        await nudgeDoge()
        // EVERY row the request holds, not the first: a round that finalized under
        // two leader slots leaves two honest rows differing only in effective_time,
        // and each one rides a window and gets its own link.
        const rows = []
        for (const id of ids) {
            const r = await venue.readMirrorRows(0, { requestId: id })
            rows.push(r.length ? r.map((x) => x.batch_action_index) : [null])
        }
        return { ok: rows.flat().every((v) => v !== null && v !== undefined), rows: rows }
    }, { timeoutMs: 20 * 60 * 1000, intervalMs: 5000, tipProbe: venueTipProbe(venue, 0) })
    assert.ok(linked.ok,
        'batch_action_index was never set on the mirrored rows: ' + jsonSafe(linked.rows) +
        '. The batch landed, so the gap is on the DOGE-parse to hub-push to mirror road.')
    console.log('AT5: batch_action_index set on every carried row')
}

/** The whole case, in the order the clause reads. */
async function runResponseWindowCase (ctx) {
    const ids = await requestResponses(ctx)
    await awaitMirrored(ctx, ids)
    const marker = await awaitPublished(ctx)
    const landed = await awaitLanded(ctx, marker)
    await awaitSingleHead(ctx, marker)
    assertHeadCoverage(ctx, landed, marker)
    await awaitLinked(ctx, ids)
}

module.exports = { runResponseWindowCase }
