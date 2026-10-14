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
 * ZC1 driven case steps: the zero-confirmation flip, split into cohesive named
 * steps that share one `st` object (request, block, draw and measurement).
 ********************************************************************/

const assert = require('assert')

const vmHelper = require('../../helpers/vmHelper')
const {
    until, findEmittedAttestRequest, attestRequestWatermark,
    clearBeforeBroadcast, settleOrReport, allHubTails, jsonSafe,
} = require('./mirrorDrillWaits')
const { waitForLocalRequestAtBlock, mineOneBlockFor } = require('./zc1_fixture')
const {
    assertMirrorReadable, assertMinedToMirrored, mineBindBlock, assertBoundAtNext, assertBindEvidence,
} = require('./zc1_bind_steps')

/** Emit the request (miner already paused) and mine one block for the EXECUTE. */
async function emitRequest (ctx, sinceAction) {
    const contract = ctx.contract
    const exec = await mineOneBlockFor(() => vmHelper.sendExecuteV0(
        contract.owner, contract.contractIndex, 'ask', ['http_get', ctx.testUrl]))
    assert.strictEqual(exec.execution.status, 'valid',
        'the EXECUTE that emits the request came back ' + exec.execution.status +
        '. A responsible set smaller than redundancy is rejected at admission and rolls the ' +
        'EXECUTE back, so this is the shape a short stake roster takes.')

    const request   = await findEmittedAttestRequest(
        contract.contractIndex, sinceAction + 1, { label: 'zc1' })
    await settleOrReport('zc1')
    return request
}

/** Barrier on the request block and refuse a chain that moved past it. */
async function locateRequestBlock (ctx, request, st) {
    const local = await waitForLocalRequestAtBlock(ctx.venue, 0, request)
    st.N = Number(local.block_index)

    // THE PRECONDITION THE WHOLE CASE RESTS ON. The miner is paused precisely
    // so that nothing lands between the request and its round, and a tip above
    // N means the confirm wait mined past it: the round would then start at a
    // tip that is not the request's block and "binds at N+1" would be a claim
    // about a block that already exists with a time before the stamp. Refused
    // rather than weakened, because a pass under those conditions says nothing.
    const tipAfterRequest = Number(await nodeConnector.getBlockCount())
    assert.strictEqual(tipAfterRequest, st.N,
        'the chain sits at ' + tipAfterRequest + ' with the request at ' + st.N +
        ', so a block landed between the request and its round even with the shared miner ' +
        'paused. The EXECUTE confirm wait outran the one-block miner; re-run. ZC1 cannot ' +
        'assert a bind at N+1 on a chain that already reached it.')

    const block = await nodeConnector.getBlock(await nodeConnector.getBlockHash(st.N))
    st.minedAt = Number(block.time)
}

/** The hubs the draw names, taken while the request is still pending. */
async function drawResponsibleHubs (ctx, st) {
    const venue = ctx.venue
    const requestId = st.requestId
    // THE DRAW, taken while the request is still pending: only then does
    // `getattestationresponsibleset` answer at all. Full pubkeys, because the
    // line assertion below has to name a hub INDEX and only the whole key maps
    // back to one.
    let draw = null
    for (const hub of venue.hubs) {
        const got = await venue.responsibleSetFromHub(hub.index, requestId)
        if (!got.error) { draw = got; break }
    }
    assert.ok(draw, 'no venue hub could resolve the responsible set for ' + requestId +
        ' while it was still pending, so ZC1 cannot say which hubs owed a round.\n' +
        allHubTails(venue))
    st.responsibleHubs = draw.responsible
        .map((pk) => venue.hubIndexForPubkey(pk))
        .filter((i) => i >= 0)
    assert.strictEqual(st.responsibleHubs.length, draw.responsible.length,
        'the draw for ' + requestId + ' includes a key no venue hub signs with (' +
        jsonSafe(draw.responsible.map((p) => p.slice(0, 16))) + '). The venue adopts the ' +
        'roster precisely so this cannot happen, and a round drawing a foreign key can ' +
        'never finalize.')
    console.log('ZC1: request ' + requestId.slice(0, 12) + ' mined at ' + st.N +
        ', drawn hubs ' + jsonSafe(st.responsibleHubs) +
        ' (redundancy ' + draw.redundancy + ', widen ' + draw.widen + ')')
}

/** (a) the round started at the tip the request was mined in. */
async function assertRoundStarted (ctx, st) {
    const venue = ctx.venue
    const N = st.N
    const responsibleHubs = st.responsibleHubs
    // WAITED FOR, not read once: the hub polls every POLL_MS and the line is
    // written when the round starts, so a bare read a second after the block
    // asks the question before there is an answer. Budgeted at several poll
    // intervals plus the capability read behind it.
    const wantLine = 'AttestationRound: starting ' + st.requestId.slice(0, 16) +
        '... tip=' + N + ' conf=0 widen=1'
    st.wantLine = wantLine
    const lines = await until(async () => {
        const missing = responsibleHubs.filter((i) => !venue.logTail('hub' + i).includes(wantLine))
        return { ok: missing.length === 0, missing: missing }
    }, 3 * 60 * 1000, 2000)
    assert.deepStrictEqual(lines.missing, [],
        'hub(s) ' + jsonSafe(lines.missing) + ' never logged "' + wantLine + '". ' +
        'That line is the only place the EFFECTIVE confirmation count is visible, and it ' +
        'is written once per started round on a responsible hub. tip=' + N + ' says the ' +
        'round started in the block the request was mined in; conf=0 says confirmationsFor ' +
        'resolved the zero-conf branch; widen=1 says the V2 headroom slot was drawn at ' +
        'elapsed 0, which is the branch §4.1 exists for.\n' + allHubTails(venue))
    console.log('ZC1: every responsible hub logged "' + wantLine + '"')
}

function assertNoOutsiderLogged (ctx, st) {
    const venue = ctx.venue
    // The line is written AFTER the `amResponsible` guard, so a hub outside
    // the draw must not carry it. Asserted because a line every hub logs
    // would make the assertion above true for the wrong reason.
    const outsiders = venue.hubs
        .map((h) => h.index)
        .filter((i) => !st.responsibleHubs.includes(i))
        .filter((i) => venue.logTail('hub' + i).includes(st.wantLine))
    assert.deepStrictEqual(outsiders, [],
        'hub(s) ' + jsonSafe(outsiders) + ' logged the round-start line without being in ' +
        'the responsible set. The line sits below the amResponsible guard, so this is a ' +
        'hub running a round it was not drawn for.')
}

async function drivenCase (ctx, sinceAction) {
    const st = {}
    const request = await emitRequest(ctx, sinceAction)
    st.requestId = request.requestId
    await locateRequestBlock(ctx, request, st)
    await drawResponsibleHubs(ctx, st)
    await assertRoundStarted(ctx, st)
    assertNoOutsiderLogged(ctx, st)
    await assertMirrorReadable(ctx, st)
    await assertMinedToMirrored(ctx, st)
    await mineBindBlock(ctx, st)
    await assertBoundAtNext(ctx, st)
    await assertBindEvidence(ctx, st)
    console.log('ZC1 GREEN: request at ' + st.N + ', round started at tip ' + st.N +
        ' conf=0 widen=1 on hubs ' + jsonSafe(st.responsibleHubs) +
        ', mirrored in ' + st.minedToMirrored + ' s, bound at ' + (st.N + 1))
}

/** Run the driven case with the shared miner paused, and always resume it. */
async function zeroConfFlipCase (ctx) {
    // Watermark FIRST: see attestRequestWatermark for why the execute's own
    // action index cannot be trusted as the correlation input.
    const sinceAction = await attestRequestWatermark(ctx.contract.contractIndex)
    await clearBeforeBroadcast()

    await regtestMinerConnector.pauseMining()
    try {
        await drivenCase(ctx, sinceAction)
    } finally {
        await regtestMinerConnector.resumeMining()
    }
}

module.exports = { zeroConfFlipCase }
