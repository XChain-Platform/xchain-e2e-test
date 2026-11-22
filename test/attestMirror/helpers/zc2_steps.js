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
 * ZC2 steps, first half: the fetch baseline, driving one request to applied and
 * reading the draw. The drill itself lives in zc2_remine.test.js.
 ********************************************************************/

const assert = require('assert')

const {
    mineWhile,
} = require('./mirrorDrillFixture')
const {
    untilOrClearDogeStall, waitForMirrorRowEverywhere, waitForAppliedEverywhere, waitForHeightWithClear,
    readAppliedResponse, readRequestRow, venueTipProbe, findEmittedAttestRequest, attestRequestWatermark,
    clearBeforeBroadcast, settleOrReport, allHubTails, jsonSafe,
} = require('./mirrorDrillWaits')
const vmHelper = require('../../helpers/vmHelper')

// ---- the baseline, before this request can exist ----------------------
//
// A DELTA, NOT AN ABSOLUTE, and this is a measurement rather than a hedge.
// `fetch_count` is monotonic for the hub process's life and counts every paid
// provider call it made, including calls for STALE pending requests the shared
// regtest chain carries from earlier aborted runs: the venue's own log-buffer
// note records those being retried every poll for the rest of their deadlines.
// An absolute of 1 is therefore a statement about what else happens to be on
// the chain today, while the delta is the property ZC2 names: the re-mine did
// not re-pay the provider. Both are printed so the absolute is on the record.
async function readBaseline (ctx) {
    const before = {}
    for (const hub of ctx.venue.hubs) {
        const s = await ctx.venue.attestationStatsOf(hub.index)
        assert.ok(!s.error, 'hub ' + hub.index + ' would not answer getattestationstats before the ' +
            'request was made (' + s.error + '), so the fetch baseline cannot be taken and the ' +
            'assertion below would be reading half a measurement')
        before[hub.index] = Number(s.fetch_count)
        assert.ok(Number.isFinite(before[hub.index]),
            'hub ' + hub.index + ' reports no fetch_count in getattestationstats: ' + jsonSafe(s))
    }
    console.log('ZC2 baseline fetch_count per hub: ' + jsonSafe(before))
    return before
}

// ---- drive one request all the way to applied -------------------------
async function emitRequest (ctx) {
    const sinceAction = await attestRequestWatermark(ctx.contract.contractIndex)
    await clearBeforeBroadcast()
    const exec = await mineWhile(() => vmHelper.sendExecuteV0(
        ctx.contract.owner, ctx.contract.contractIndex, 'ask', ['http_get', ctx.testUrl]))
    assert.strictEqual(exec.execution.status, 'valid',
        'the EXECUTE that emits the request came back ' + exec.execution.status)

    const request = await findEmittedAttestRequest(
        ctx.contract.contractIndex, sinceAction + 1, { label: 'zc2' })
    await settleOrReport('zc2')
    return request
}

// THE DRAW, while the request is still pending: `getattestationresponsibleset`
// answers for pending requests only, and the fetch assertion below is about the
// hubs that owed a round rather than about all five.
async function readResponsibleHubs (ctx, requestId) {
    const venue = ctx.venue
    let draw = null
    for (const hub of venue.hubs) {
        const got = await venue.responsibleSetFromHub(hub.index, requestId)
        if (!got.error) { draw = got; break }
    }
    assert.ok(draw, 'no venue hub could resolve the responsible set for ' + requestId +
        ' while it was pending, so ZC2 cannot say which hubs owed a fetch\n' + allHubTails(venue))
    const responsibleHubs = draw.responsible
        .map((pk) => venue.hubIndexForPubkey(pk))
        .filter((i) => i >= 0)
    assert.strictEqual(responsibleHubs.length, draw.responsible.length,
        'the draw includes a key no venue hub signs with: ' +
        jsonSafe(draw.responsible.map((p) => p.slice(0, 16))))
    console.log('ZC2: request ' + requestId.slice(0, 12) + ', drawn hubs ' +
        jsonSafe(responsibleHubs) + ' (redundancy ' + draw.redundancy + ', widen ' + draw.widen + ')')
    return responsibleHubs
}

// ONE BLOCK AT A TIME, AND ONLY ONCE INDEXER 0 HAS PARSED THE LAST ONE. Mining
// on a fixed cadence outruns the venue indexer and piles up depth between the
// request and the reorg, which is what blows the tracker window.
async function nudgeUntilApplied (ctx, requestId) {
    const venue  = ctx.venue
    const probe  = venueTipProbe(venue, 0)
    const nudged = await untilOrClearDogeStall(async () => {
        const applied = await readAppliedResponse(venue, 0, requestId)
        if (applied) return { ok: true, applied: applied }
        const tip = Number(await nodeConnector.getBlockCount())
        const at  = await probe().catch(() => null)
        if (at && Number(at.height) >= tip) await regtestMinerConnector.generateBlocks(1)
        return { ok: false, applied: null }
    }, { timeoutMs: 10 * 60 * 1000, intervalMs: 3000, tipProbe: probe })
    assert.ok(nudged.ok, 'the response never applied on indexer 0 before the reorg could be staged\n' +
        venue.logTail('indexer0'))
}

async function awaitApplied (ctx, request) {
    const venue     = ctx.venue
    const requestId = request.requestId
    // NO MINING UNDER THIS WAIT. Above the zero-conf height the ladder already
    // carries its headroom slot at the request's own block, so a still chain
    // finalizes; and every block mined here is depth the reorg below has to undo
    // inside the tracker's twelve-block window.
    await waitForMirrorRowEverywhere(venue, requestId)
    await nudgeUntilApplied(ctx, requestId)

    await settleOrReport('zc2')
    const beforeRows   = await waitForAppliedEverywhere(venue, requestId)
    await waitForHeightWithClear(venue, 0, request.blockIndex)
    const local        = await readRequestRow(venue, 0, requestId)
    const requestBlock = Number(local.block_index)
    const appliedBlock = Number(beforeRows[0].block_index)
    const roundRef     = Number(local.action_index)
    console.log('ZC2: request at ' + requestBlock + ', response bound at ' + appliedBlock +
        ', round_reference ' + roundRef)
    return { beforeRows, appliedBlock, roundRef }
}

module.exports = { readBaseline, emitRequest, readResponsibleHubs, awaitApplied }
