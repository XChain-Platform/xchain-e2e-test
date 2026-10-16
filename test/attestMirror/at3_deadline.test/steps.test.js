'use strict'

const assert = require('assert')

const { AttestMirrorVenue } = require('../../helpers/attestMirrorVenue')
const {
    provisionDrillIdentities, waitForVenueIndexersAtTip, startAttestTestServer,
    deployRequestContract, readContractState, readAppliedResponse, mineWhile,
} = require('../helpers/mirrorDrillFixture')
const {
    untilOrClearDogeStall, waitForMirrorRowEverywhere, waitForAppliedEverywhere,
    readBlockWindow, readRequestRow, firstSatisfyingBlock, venueTipProbe,
    findEmittedAttestRequest, clearBeforeBroadcast, waitForHeightWithClear,
    attestRequestWatermark, settleOrReport,
} = require('../helpers/mirrorDrillWaits')
const vmHelper = require('../../helpers/vmHelper')

const FIXED_BODY = '{"score":3,"meta":"at3-deadline"}'
const FORWARD_S = 120
const BURIAL_BLOCKS = 6
const DEADLINE_BLOCKS = 30
const CONTRACT_CODE = `
module.exports = {
    meta: { name: 'Mirror Deadline Asker', description: 'Requests an attestation left to run past its mirror deadline.', version: '1.0.0' },
    ask: function(xchain) {
        return xchain.attestation.request(
            xchain.getInputParam(0), xchain.getInputParam(1),
            'handleResponse', [xchain.getInputParam(2)],
            { redundancy: 3, deadlineBlocks: ${DEADLINE_BLOCKS} }
        );
    },
    handleResponse: function(xchain) {
        var tag = xchain.getInputParam(4);
        xchain.state.set('request_' + tag, xchain.getInputParam(0));
        xchain.state.set('status_'  + tag, xchain.getInputParam(2));
        xchain.state.set('payload_' + tag, xchain.getInputParam(3));
    }
};
`

function newContext () {
    return { venue: null, testServer: null, testUrl: null, contract: null }
}

async function bringUp (ctx, mocha) {
    ctx.testServer = await startAttestTestServer({ body: FIXED_BODY })
    ctx.testUrl = ctx.testServer.url
    const staked = await provisionDrillIdentities({ label: 'at3', count: 5, redundancy: 3 })
    ctx.venue = new AttestMirrorVenue({
        label: 'at3', identities: staked.identities, forwardS: FORWARD_S,
        hubExtraEnv: ctx.testServer.hubEnv,
    })
    if (!(await ctx.venue.start())) {
        console.log('AT3 SKIPPED: ' + ctx.venue.unavailable)
        return mocha.skip()
    }
    await waitForVenueIndexersAtTip(ctx.venue)
    ctx.contract = await deployRequestContract({ label: 'at3', code: CONTRACT_CODE })
}

async function tearDown (ctx) {
    try { await regtestMinerConnector.resumeMining() } catch (error) {
        console.log('AT3 teardown: resumeMining failed (' + (error && error.message) + ')')
    }
    if (ctx.testServer) await ctx.testServer.close()
    if (ctx.venue) await ctx.venue.stop()
}

async function driveToMirrorRow (ctx, tag) {
    const sinceAction = await attestRequestWatermark(ctx.contract.contractIndex)
    await clearBeforeBroadcast()
    const exec = await mineWhile(() => vmHelper.sendExecuteV0(
        ctx.contract.owner, ctx.contract.contractIndex, 'ask', ['http_get', ctx.testUrl, tag]))
    assert.strictEqual(exec.execution.status, 'valid',
        tag + ': the EXECUTE that emits the request came back ' + exec.execution.status)
    const request = await findEmittedAttestRequest(
        ctx.contract.contractIndex, sinceAction + 1, { label: tag })
    await regtestMinerConnector.generateBlocks(BURIAL_BLOCKS)
    await settleOrReport('at3')
    const rows = await waitForMirrorRowEverywhere(ctx.venue, request.requestId)
    assert.strictEqual(String(rows[0].status), 'ok',
        tag + ': the round did not produce an ok response')
    return describeRequest(ctx, tag, request, rows[0])
}

async function describeRequest (ctx, tag, request, row) {
    await waitForHeightWithClear(ctx.venue, 0, request.blockIndex)
    const local = await readRequestRow(ctx.venue, 0, request.requestId)
    assert.ok(local, tag + ': the venue indexer holds no request row for ' + request.requestId)
    assert.strictEqual(Number(local.block_index), Number(request.blockIndex),
        tag + ': venue and standing indexers disagree on the request block')
    const effectiveTime = Number(row.effective_time)
    assert.ok(Number.isFinite(effectiveTime) && effectiveTime > 0,
        tag + ': the mirror row carries no usable effective_time (' + row.effective_time + ')')
    return {
        requestId: request.requestId,
        effectiveTime: effectiveTime,
        deadlineBlock: Number(local.deadline_block),
        requestBlock: Number(local.block_index),
    }
}

async function chainHeight () { return Number(await nodeConnector.getBlockCount()) }

async function mineBefore (effectiveTime, count, label) {
    for (let index = 0; index < count; index++) {
        await regtestMinerConnector.generateBlocks(1)
        const now = Math.floor(Date.now() / 1000)
        assert.ok(now < effectiveTime,
            label + ': the forward margin elapsed after ' + index + ' of ' + count +
            ' blocks, so an intentionally unsatisfying block may satisfy the rule')
    }
}

async function minePastDeadline (driven, tag) {
    await regtestMinerConnector.pauseMining()
    try {
        const from = await chainHeight()
        const to = driven.deadlineBlock + 1
        assert.ok(to > from,
            tag + ': the chain is already at ' + from + ', past deadline ' + driven.deadlineBlock)
        await mineBefore(driven.effectiveTime, to - from, tag)
    } finally {
        await regtestMinerConnector.resumeMining()
    }
    await settleOrReport('at3')
}

async function assertNoEligibleBlock (ctx, driven, tag) {
    const window = await readBlockWindow(
        ctx.venue, 0, driven.requestBlock, driven.deadlineBlock)
    const wouldBind = firstSatisfyingBlock(
        window, driven.effectiveTime, driven.deadlineBlock)
    assert.strictEqual(wouldBind, null,
        tag + ': an eligible block reached effective_time, so this case did not test expiry')
}

async function assertExpiredRows (ctx, driven, tag) {
    for (const indexer of ctx.venue.indexers) {
        await waitForHeightWithClear(ctx.venue, indexer.index, driven.deadlineBlock + 1)
        const request = await readRequestRow(ctx.venue, indexer.index, driven.requestId)
        assert.strictEqual(String(request.request_status), 'expired',
            tag + ': indexer ' + indexer.index + ' reports ' + request.request_status)
        assert.strictEqual(Number(request.resolved_block), driven.deadlineBlock + 1,
            tag + ': expiry did not resolve at deadline_block + 1')
        const applied = await readAppliedResponse(ctx.venue, indexer.index, driven.requestId)
        assert.strictEqual(applied, null,
            tag + ': indexer ' + indexer.index + ' applied an expired response')
    }
}

async function assertExpiredCallback (ctx, tag) {
    const state = await readContractState(ctx.venue, 0, ctx.contract.contractIndex)
    assert.strictEqual(JSON.parse(state['status_' + tag]), 'expired',
        tag + ': callback status is not expired')
    assert.strictEqual(JSON.parse(state['payload_' + tag]), '',
        tag + ': the expired callback carried a payload')
}

async function waitPastEffectiveTime (ctx, driven, tag) {
    const elapsed = await untilOrClearDogeStall(
        async () => ({ ok: Math.floor(Date.now() / 1000) > driven.effectiveTime }),
        { timeoutMs: (FORWARD_S + 120) * 1000, intervalMs: 5000,
            tipProbe: venueTipProbe(ctx.venue, 0) })
    assert.ok(elapsed.ok, tag + ': wall clock never passed effective_time ' + driven.effectiveTime)
}

async function assertPermanentlyExpired (ctx, driven, tag) {
    await waitPastEffectiveTime(ctx, driven, tag)
    await regtestMinerConnector.generateBlocks(5)
    await settleOrReport('at3')
    for (const indexer of ctx.venue.indexers) {
        await waitForHeightWithClear(ctx.venue, indexer.index, driven.deadlineBlock + 6)
        const applied = await readAppliedResponse(ctx.venue, indexer.index, driven.requestId)
        assert.strictEqual(applied, null,
            tag + ': indexer ' + indexer.index + ' applied after the deadline')
        const request = await readRequestRow(ctx.venue, indexer.index, driven.requestId)
        assert.strictEqual(String(request.request_status), 'expired',
            tag + ': request left expired state on indexer ' + indexer.index)
    }
}

async function provePastDeadline (ctx) {
    const tag = 'expire'
    const driven = await driveToMirrorRow(ctx, tag)
    await minePastDeadline(driven, tag)
    for (const indexer of ctx.venue.indexers) {
        await waitForHeightWithClear(ctx.venue, indexer.index, driven.deadlineBlock + 1)
    }
    await assertNoEligibleBlock(ctx, driven, tag)
    await assertExpiredRows(ctx, driven, tag)
    await assertExpiredCallback(ctx, tag)
    await assertPermanentlyExpired(ctx, driven, tag)
    console.log('AT3: request ' + driven.requestId.slice(0, 12) + ' expired at block ' +
        (driven.deadlineBlock + 1) + ' and stayed unapplied past its effective time')
}

async function mineDeadlineBoundary (ctx, driven, tag) {
    await regtestMinerConnector.pauseMining()
    try {
        const from = await chainHeight()
        const need = driven.deadlineBlock - 1 - from
        assert.ok(need >= 0, tag + ': no room remains to place the boundary block')
        if (need > 0) await mineBefore(driven.effectiveTime, need, tag)
        assert.strictEqual(await chainHeight(), driven.deadlineBlock - 1,
            tag + ': chain is not one below the deadline')
        await waitPastEffectiveTime(ctx, driven, tag)
        await regtestMinerConnector.generateBlocks(1)
        assert.strictEqual(await chainHeight(), driven.deadlineBlock,
            tag + ': newly mined block is not the deadline block')
    } finally {
        await regtestMinerConnector.resumeMining()
    }
    await settleOrReport('at3')
}

async function assertBoundaryApplied (ctx, driven, tag) {
    const applied = await waitForAppliedEverywhere(ctx.venue, driven.requestId)
    const window = await readBlockWindow(
        ctx.venue, 0, driven.requestBlock, driven.deadlineBlock)
    const predicted = firstSatisfyingBlock(
        window, driven.effectiveTime, driven.deadlineBlock)
    assert.strictEqual(predicted, driven.deadlineBlock,
        tag + ': the first satisfying block is not the deadline')
    for (const indexer of ctx.venue.indexers) {
        await waitForHeightWithClear(ctx.venue, indexer.index, driven.requestBlock)
        assert.strictEqual(Number(applied[indexer.index].block_index), driven.deadlineBlock,
            tag + ': indexer ' + indexer.index + ' did not apply at the deadline')
        const request = await readRequestRow(ctx.venue, indexer.index, driven.requestId)
        assert.strictEqual(String(request.request_status), 'fulfilled')
    }
}

async function assertBoundaryCallback (ctx, tag) {
    const state = await readContractState(ctx.venue, 0, ctx.contract.contractIndex)
    assert.strictEqual(JSON.parse(state['status_' + tag]), 'ok',
        tag + ': callback did not fire with ok')
    assert.strictEqual(JSON.parse(state['payload_' + tag]), FIXED_BODY,
        tag + ': callback payload is not the provider body')
}

async function proveDeadlineBoundary (ctx) {
    const tag = 'boundary'
    const driven = await driveToMirrorRow(ctx, tag)
    await mineDeadlineBoundary(ctx, driven, tag)
    await assertBoundaryApplied(ctx, driven, tag)
    await assertBoundaryCallback(ctx, tag)
    console.log('AT3: request ' + driven.requestId.slice(0, 12) +
        ' bound at its deadline block ' + driven.deadlineBlock + ' on both indexers')
}

module.exports = { newContext, bringUp, tearDown, provePastDeadline, proveDeadlineBoundary }
