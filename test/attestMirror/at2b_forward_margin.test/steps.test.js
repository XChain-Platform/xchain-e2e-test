'use strict'

const assert = require('assert')

const { AttestMirrorVenue } = require('../../helpers/attestMirrorVenue')
const {
    provisionDrillIdentities, waitForVenueIndexersAtTip, startAttestTestServer,
    deployRequestContract, mineWhile,
} = require('../helpers/mirrorDrillFixture')
const {
    APPLIED_FIELDS, until, untilOrClearDogeStall, diffRows, diffStateHashes,
    waitForAppliedEverywhere, venueTipProbe, findEmittedAttestRequest,
    captureFederationState, clearBeforeBroadcast, allHubTails,
    attestRequestWatermark, settleOrReport, widenArithmetic,
} = require('../helpers/mirrorDrillWaits')
const { delayedDeliveryWindow } = require('../helpers/deliveryWindow')
const { BARRIER_REASON, isAttributedPark } = require('../helpers/barrierAttribution')
const vmHelper = require('../../helpers/vmHelper')
const XChainIndexerConnector = require('../../../src/XChainIndexerConnector.js')

const FIXED_BODY = '{"score":23,"meta":"at2b-margin"}'
const MIRROR_TABLE = 'attestation_responses'
const DEADLINE_BLOCKS = 60
const BURIAL_BLOCKS = 6
const FORWARD_S = 5
const DELIVERY_DELAY_MS = 10 * 60 * 1000
const BARRIER_GRACE_S = 100
const DELAYED = 1
const PROMPT = 0

const CONTRACT_CODE = `
module.exports = {
    meta: { name: 'Mirror Margin Asker', description: 'Requests an attestation used to measure the mirror forward margin.', version: '1.0.0' },
    ask: function(xchain) {
        return xchain.attestation.request(
            xchain.getInputParam(0), xchain.getInputParam(1),
            'handleResponse', ['ctx-at2b'],
            { redundancy: 3, deadlineBlocks: ${DEADLINE_BLOCKS} }
        );
    },
    handleResponse: function(xchain) {
        xchain.state.set('callback_status',  xchain.getInputParam(2));
        xchain.state.set('callback_payload', xchain.getInputParam(3));
    }
};
`

function newContext () {
    const ctx = {
        venue: null, testServer: null, testUrl: null, contract: null,
        delayArmedAtMs: null,
    }
    ctx.statusOf = async (index) => {
        const status = await ctx.venue.statusOf(index)
        return {
            height: status.body && status.body.indexerBlock !== undefined
                ? Number(status.body.indexerBlock) : null,
            decoder: status.body && status.body.decoderBlock !== undefined
                ? Number(status.body.decoderBlock) : null,
            reason: status.body && status.body.stallReason,
            klass: status.body && status.body.stallClass,
        }
    }
    return ctx
}

async function bringUp (ctx, mocha) {
    ctx.testServer = await startAttestTestServer({ body: FIXED_BODY })
    ctx.testUrl = ctx.testServer.url
    const staked = await provisionDrillIdentities({ label: 'at2b', count: 5, redundancy: 3 })
    ctx.venue = new AttestMirrorVenue({
        label: 'at2b', identities: staked.identities, forwardS: FORWARD_S,
        indexerGraces: { [DELAYED]: { attestResponse: BARRIER_GRACE_S } },
        hubExtraEnv: ctx.testServer.hubEnv,
    })
    if (!(await ctx.venue.start())) {
        console.log('AT2b SKIPPED: ' + ctx.venue.unavailable)
        return mocha.skip()
    }
    await waitForVenueIndexersAtTip(ctx.venue)
    ctx.contract = await deployRequestContract({ label: 'at2b', code: CONTRACT_CODE })
}

async function tearDown (ctx) {
    if (ctx.venue) {
        try { ctx.venue.releaseMirrorTable(DELAYED, MIRROR_TABLE) } catch (internal) { /* never armed */ }
        await ctx.venue.stop()
    }
    if (ctx.testServer) await ctx.testServer.close()
}

async function armAndRequest (ctx) {
    await waitForVenueIndexersAtTip(ctx.venue, { maxLag: 0 })
    ctx.delayArmedAtMs = Date.now()
    ctx.venue.delayMirrorTable(DELAYED, MIRROR_TABLE, DELIVERY_DELAY_MS)
    console.log('AT2b: delaying ' + MIRROR_TABLE + ' by ' + DELIVERY_DELAY_MS +
        'ms on indexer ' + DELAYED + '; forward margin ' + FORWARD_S + 's')
    const sinceAction = await attestRequestWatermark(ctx.contract.contractIndex)
    await clearBeforeBroadcast()
    const exec = await mineWhile(() => vmHelper.sendExecuteV0(
        ctx.contract.owner, ctx.contract.contractIndex, 'ask', ['http_get', ctx.testUrl]))
    assert.strictEqual(exec.execution.status, 'valid',
        'the EXECUTE that emits the request came back ' + exec.execution.status)
    const request = await findEmittedAttestRequest(
        ctx.contract.contractIndex, sinceAction + 1, { label: 'at2b' })
    await regtestMinerConnector.generateBlocks(BURIAL_BLOCKS)
    await settleOrReport('at2b')
    return request.requestId
}

async function captureState (ctx, requestId, label) {
    try { return await captureFederationState(ctx.venue, requestId, label) }
    catch (error) {
        console.log('FEDERATION STATE (' + label + '): unreadable, ' + (error && error.message))
        return null
    }
}

async function waitForPromptRow (ctx, requestId) {
    await captureState(ctx, requestId, 'before the round settles')
    const prompt = await untilOrClearDogeStall(async () => {
        const rows = await ctx.venue.readMirrorRows(PROMPT, { requestId: requestId })
        return { ok: rows.length === 1, rows: rows }
    }, { timeoutMs: 10 * 60 * 1000, tipProbe: venueTipProbe(ctx.venue, PROMPT) })
    const after = await captureState(ctx, requestId,
        prompt.ok ? 'row present on the unfiltered indexer' : 'row MISSING')
    assert.ok(prompt.ok,
        'the unfiltered indexer never received the mirror row. Hub finalization: ' +
        (after ? after.verdict : 'capture did not run') + '.\n' + allHubTails(ctx.venue))
    console.log('AT2b: the unfiltered indexer holds the row; effective_time ' +
        prompt.rows[0].effective_time)
    return prompt.rows[0]
}

async function requireActiveDelay (ctx) {
    await waitForVenueIndexersAtTip(ctx.venue, { maxLag: 0 })
    const stats = ctx.venue.mirrorProxyStats(DELAYED)
    const window = delayedDeliveryWindow(
        ctx.delayArmedAtMs, Date.now(), DELIVERY_DELAY_MS, stats)
    assert.ok(window.ok,
        'the delayed indexer reached the tip outside an active delivery window. Elapsed ' +
        window.elapsedMs + 'ms; proxy ' + JSON.stringify(stats))
}

async function mineCrossingBlock (ctx, row) {
    const connector = new XChainIndexerConnector(
        '127.0.0.1', ctx.venue.indexers[PROMPT].apiPort, null)
    await regtestMinerConnector.generateBlocks(1)
    const crossing = await until(async () => {
        const tip = await connector.call('getblockhashes', {})
        const blockTime = Number(tip && tip.block_time)
        return { ok: Number.isFinite(blockTime) && blockTime >= Number(row.effective_time), tip: tip }
    }, 2 * 60 * 1000)
    assert.ok(crossing.ok,
        'the mined block did not cross response effective_time ' + row.effective_time +
        ': ' + JSON.stringify(crossing.tip))
    return connector
}

async function waitForNamedHold (ctx) {
    const held = await until(async () => {
        const status = await ctx.statusOf(DELAYED)
        return { ok: isAttributedPark(status), a: status }
    }, 6 * 60 * 1000)
    assert.ok(held.ok,
        'indexer ' + DELAYED + ' never reported ' + BARRIER_REASON + '. Last status ' +
        JSON.stringify(held.a) + '; proxy ' + JSON.stringify(ctx.venue.mirrorProxyStats(DELAYED)) +
        '\n' + ctx.venue.logTail('indexer' + DELAYED))
    console.log('AT2b: indexer ' + DELAYED + ' waiting at block ' + held.a.height +
        ' of ' + held.a.decoder + ' on ' + held.a.reason + ' (' + held.a.klass + ')')
}

function assertInjectionFired (ctx) {
    const stats = ctx.venue.mirrorProxyStats(DELAYED)
    assert.ok(stats.framesHeld > 0 || stats.snapshotRowsHeld > 0,
        'the mirror proxy reports holding nothing, so the delay never applied: ' + JSON.stringify(stats))
    console.log('AT2b: proxy held ' + stats.framesHeld + ' stream frame(s) and ' +
        stats.snapshotRowsHeld + ' snapshot row(s)')
}

async function assertAppliedTogether (ctx, requestId, promptConnector) {
    ctx.venue.releaseMirrorTable(DELAYED, MIRROR_TABLE)
    const applied = await waitForAppliedEverywhere(ctx.venue, requestId, 20 * 60 * 1000,
        { mineWhileWaiting: { perPoll: 1, maxBlocks: widenArithmetic(DEADLINE_BLOCKS).safeCap } })
    const diffs = diffRows(applied[PROMPT], applied[DELAYED], APPLIED_FIELDS)
    assert.deepStrictEqual(diffs, [],
        'the delayed indexer bound the response differently from its peer: ' + diffs.join('; '))
    const at = Number(applied[PROMPT].block_index)
    console.log('AT2b: both nodes bound at block ' + at + ' past a ' + FORWARD_S + 's margin')
    await assertLedgerConverged(ctx, at, promptConnector)
}

async function assertLedgerConverged (ctx, at, promptConnector) {
    const delayedConnector = new XChainIndexerConnector(
        '127.0.0.1', ctx.venue.indexers[DELAYED].apiPort, null)
    const h0 = await promptConnector.call('getblockhashes', { block_index: at })
    const h1 = await delayedConnector.call('getblockhashes', { block_index: at })
    assert.ok(h0 && !h0.error, 'the prompt indexer would not report hashes at ' + at)
    assert.ok(h1 && !h1.error, 'the delayed indexer would not report hashes at ' + at)
    const diffs = diffStateHashes(h0, h1)
    assert.deepStrictEqual(diffs, [],
        'the two nodes disagree at the applying block ' + at + ': ' + diffs.join('; '))
    console.log('AT2b: no divergence at block ' + at + '; state_root ' +
        String(h0.state_root).slice(0, 16) + '... identical')
}

async function proveForwardMargin (ctx) {
    const requestId = await armAndRequest(ctx)
    const row = await waitForPromptRow(ctx, requestId)
    await requireActiveDelay(ctx)
    const promptConnector = await mineCrossingBlock(ctx, row)
    await waitForNamedHold(ctx)
    assertInjectionFired(ctx)
    await assertAppliedTogether(ctx, requestId, promptConnector)
}

async function proveBarrierClears (ctx) {
    await regtestMinerConnector.generateBlocks(2)
    await settleOrReport('at2b')
    const clear = await untilOrClearDogeStall(async () => {
        const a = await ctx.statusOf(DELAYED)
        const b = await ctx.statusOf(PROMPT)
        return { ok: a.height !== null && b.height !== null && a.height >= b.height, a: a, b: b }
    }, { timeoutMs: 15 * 60 * 1000, tipProbe: venueTipProbe(ctx.venue, PROMPT) })
    assert.ok(clear.ok,
        'the delayed indexer never caught its peer after release: ' + JSON.stringify(clear) +
        '\n' + ctx.venue.logTail('indexer' + DELAYED))
    console.log('AT2b: released; indexer ' + DELAYED + ' caught up to ' + clear.a.height +
        ' with stallReason ' + String(clear.a.reason))
}

module.exports = { newContext, bringUp, tearDown, proveForwardMargin, proveBarrierClears }
