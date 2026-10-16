'use strict'

const assert = require('assert')

const { AttestMirrorVenue } = require('../../helpers/attestMirrorVenue')
const {
    provisionDrillIdentities, waitForVenueIndexersAtTip, startAttestTestServer,
    deployRequestContract, readContractState, readAppliedResponse, mineWhile,
} = require('../helpers/mirrorDrillFixture')
const {
    APPLIED_FIELDS, untilOrClearDogeStall, diffRows,
    waitForMirrorRowEverywhere, waitForAppliedEverywhere,
    readRequestRow, venueTipProbe, findEmittedAttestRequest,
    clearBeforeBroadcast, waitForHeightWithClear, attestRequestWatermark,
    settleOrReport, jsonSafe,
} = require('../helpers/mirrorDrillWaits')
const vmHelper = require('../../helpers/vmHelper')
const cryptoHelper = require('../../helpers/core/cryptoHelper')

const FIXED_BODY = '{"score":11,"meta":"at4-reorg"}'
const DEADLINE_BLOCKS = 80
const BURIAL_BLOCKS = 4
const COMPETING_OVERSHOOT = 2
const TRACKER_UNDO_BLOCKS = 12

const CONTRACT_CODE = `
module.exports = {
    meta: { name: 'Mirror Reorg Asker', description: 'Requests an attestation whose mirror rows are rolled back by a reorg.', version: '1.0.0' },
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
    return {
        venue: null, testServer: null, testUrl: null, contract: null, minerAddr: null,
    }
}

async function bringUp (ctx, mocha) {
    ctx.testServer = await startAttestTestServer({ body: FIXED_BODY })
    ctx.testUrl = ctx.testServer.url
    const staked = await provisionDrillIdentities({ label: 'at4', count: 5, redundancy: 3 })
    ctx.venue = new AttestMirrorVenue({
        label: 'at4', identities: staked.identities, hubExtraEnv: ctx.testServer.hubEnv,
    })
    if (!(await ctx.venue.start())) {
        console.log('AT4 SKIPPED: ' + ctx.venue.unavailable)
        return mocha.skip()
    }
    await waitForVenueIndexersAtTip(ctx.venue)
    ctx.contract = await deployRequestContract({ label: 'at4', code: CONTRACT_CODE })
    ctx.minerAddr = (await cryptoHelper.getNewAddress(
        'at4-miner', COIN, NETWORK, null, 'legacy', 0)).address
}

async function tearDown (ctx) {
    try { await regtestMinerConnector.resumeMining() } catch (error) {
        console.log('AT4 teardown: resumeMining failed (' + (error && error.message) + ')')
    }
    if (ctx.testServer) await ctx.testServer.close()
    if (ctx.venue) await ctx.venue.stop()
}

async function emitRequest (ctx, tag) {
    const sinceAction = await attestRequestWatermark(ctx.contract.contractIndex)
    await clearBeforeBroadcast()
    const exec = await mineWhile(() => vmHelper.sendExecuteV0(
        ctx.contract.owner, ctx.contract.contractIndex, 'ask', ['http_get', ctx.testUrl, tag]))
    assert.strictEqual(exec.execution.status, 'valid',
        tag + ': the EXECUTE that emits the request came back ' + exec.execution.status)
    const request = await findEmittedAttestRequest(
        ctx.contract.contractIndex, sinceAction + 1, { label: tag })
    await regtestMinerConnector.generateBlocks(BURIAL_BLOCKS)
    await settleOrReport('at4')
    await waitForMirrorRowEverywhere(ctx.venue, request.requestId)
    return request
}

async function nudgeUntilApplied (ctx, tag, requestId) {
    const probe = venueTipProbe(ctx.venue, 0)
    const nudged = await untilOrClearDogeStall(async () => {
        const applied = await readAppliedResponse(ctx.venue, 0, requestId)
        if (applied) return { ok: true, applied: applied }
        const tip = Number(await nodeConnector.getBlockCount())
        const at = await probe().catch(() => null)
        if (at && Number(at.height) >= tip) await regtestMinerConnector.generateBlocks(1)
        return { ok: false, applied: null }
    }, { timeoutMs: 10 * 60 * 1000, intervalMs: 3000, tipProbe: probe })
    assert.ok(nudged.ok,
        tag + ': response never applied before the reorg could be staged\n' +
        ctx.venue.logTail('indexer0'))
}

async function driveToApplied (ctx, tag) {
    const request = await emitRequest(ctx, tag)
    await nudgeUntilApplied(ctx, tag, request.requestId)
    await settleOrReport('at4')
    const applied = await waitForAppliedEverywhere(ctx.venue, request.requestId)
    await waitForHeightWithClear(ctx.venue, 0, request.blockIndex)
    const local = await readRequestRow(ctx.venue, 0, request.requestId)
    return {
        tag: tag, requestId: request.requestId,
        requestBlock: Number(local.block_index),
        appliedBlock: Number(applied[0].block_index), applied: applied,
    }
}

async function orphanFrom (ctx, height, label) {
    const tipBefore = Number(await nodeConnector.getBlockCount())
    const depth = tipBefore - height + 1
    assert.ok(depth <= TRACKER_UNDO_BLOCKS,
        label + ': orphaning from ' + height + ' at tip ' + tipBefore + ' is ' + depth +
        ' blocks deep, past the tracker undo window of ' + TRACKER_UNDO_BLOCKS)
    const hash = await nodeConnector.getBlockHash(height)
    await nodeConnector.invalidateBlock(hash)
    assert.strictEqual(Number(await nodeConnector.getBlockCount()), height - 1,
        label + ': invalidation did not roll back to one below ' + height)
    const need = tipBefore - (height - 1) + COMPETING_OVERSHOOT
    for (let index = 0; index < need; index++) {
        await nodeConnector.generateBlock(ctx.minerAddr, [])
    }
    const tipAfter = Number(await nodeConnector.getBlockCount())
    assert.ok(tipAfter > tipBefore, label + ': competing chain did not overtake the old tip')
    assert.notStrictEqual(await nodeConnector.getBlockHash(height), hash,
        label + ': original block remains active after the reorg')
    return { tipBefore: tipBefore, tipAfter: tipAfter, orphanedHash: hash }
}

async function waitForReapplication (ctx, driven) {
    const result = await untilOrClearDogeStall(async () => {
        const rows = []
        for (const indexer of ctx.venue.indexers) {
            rows.push(await readAppliedResponse(ctx.venue, indexer.index, driven.requestId))
        }
        return {
            ok: rows.every((row) => row && Number(row.block_index) === driven.appliedBlock),
            rows: rows,
        }
    }, { timeoutMs: 15 * 60 * 1000, tipProbe: venueTipProbe(ctx.venue, 0) })
    assert.ok(result.ok,
        'keep: response did not return at block ' + driven.appliedBlock + ' on both nodes; rows ' +
        jsonSafe(result.rows.map((row) => row && row.block_index)) + '\n' +
        ctx.venue.logTail('indexer0') + '\n' + ctx.venue.logTail('indexer1'))
    return result.rows
}

async function assertReapplication (ctx, driven, rows) {
    const diffs = diffRows(rows[0], rows[1], APPLIED_FIELDS)
    assert.deepStrictEqual(diffs, [],
        'keep: the two nodes re-bound differently: ' + diffs.join('; '))
    for (const field of ['response_hash', 'action_index']) {
        assert.strictEqual(String(rows[0][field]), String(driven.applied[0][field]),
            'keep: ' + field + ' changed across the reorg')
    }
    const state = await readContractState(ctx.venue, 0, ctx.contract.contractIndex)
    assert.strictEqual(JSON.parse(state.status_keep), 'ok',
        'keep: callback did not re-fire after the reorg')
}

async function settleAfterReorg (label) {
    const status = await utxoTrackerConnector.quiesce({
        timeoutMs: 4 * 60 * 1000, pollMs: 500, regtestMiner: regtestMinerConnector,
    }).catch((error) => ({ ready: false, error: String(error && error.message) }))
    if (!status || !status.ready) {
        console.log('AT4 ' + label + ': stack did not settle after the reorg (' +
            JSON.stringify(status) + ')')
    }
}

async function proveRequestKept (ctx) {
    const driven = await driveToApplied(ctx, 'keep')
    await regtestMinerConnector.pauseMining()
    try {
        const reorg = await orphanFrom(ctx, driven.appliedBlock, 'keep')
        console.log('AT4 keep: orphaned applying block ' + driven.appliedBlock +
            ' and rebuilt to ' + reorg.tipAfter)
        const rows = await waitForReapplication(ctx, driven)
        await assertReapplication(ctx, driven, rows)
        console.log('AT4 keep: re-bound at block ' + driven.appliedBlock + ' on both nodes')
    } finally {
        await regtestMinerConnector.resumeMining()
        await settleAfterReorg('keep')
    }
}

async function waitForRollback (ctx, driven) {
    const rolled = await untilOrClearDogeStall(async () => {
        const applied = []
        const requests = []
        for (const indexer of ctx.venue.indexers) {
            applied.push(await readAppliedResponse(ctx.venue, indexer.index, driven.requestId))
            // request-row-wait-ok: absence after the request block was orphaned is the assertion.
            requests.push(await readRequestRow(ctx.venue, indexer.index, driven.requestId))
        }
        return {
            ok: applied.every((row) => row === null) && requests.every((row) => row === null),
            applied: applied, requests: requests,
        }
    }, { timeoutMs: 15 * 60 * 1000, tipProbe: venueTipProbe(ctx.venue, 0) })
    assert.ok(rolled.ok,
        'gone: reorg did not remove request and applied response on both nodes. applied ' +
        jsonSafe(rolled.applied) + ', requests ' + jsonSafe(rolled.requests))
}

async function assertEffectsRemoved (ctx) {
    const state = await readContractState(ctx.venue, 0, ctx.contract.contractIndex)
    assert.strictEqual(state.status_gone, undefined,
        'gone: contract still carries callback state from a rolled-back action')
}

async function assertMirrorSurvives (ctx, requestId) {
    for (const indexer of ctx.venue.indexers) {
        const rows = await ctx.venue.readMirrorRows(indexer.index, { requestId: requestId })
        assert.strictEqual(rows.length, 1,
            'gone: indexer ' + indexer.index + ' lost the mirror row during reorg')
    }
}

async function assertNothingRebinds (ctx, driven) {
    for (let index = 0; index < 4; index++) {
        await nodeConnector.generateBlock(ctx.minerAddr, [])
    }
    const tip = Number(await nodeConnector.getBlockCount())
    for (const indexer of ctx.venue.indexers) {
        await waitForHeightWithClear(ctx.venue, indexer.index, tip)
        const applied = await readAppliedResponse(ctx.venue, indexer.index, driven.requestId)
        assert.strictEqual(applied, null,
            'gone: indexer ' + indexer.index + ' re-bound without a local request')
    }
    return tip
}

async function proveRequestRemoved (ctx) {
    const driven = await driveToApplied(ctx, 'gone')
    await regtestMinerConnector.pauseMining()
    try {
        const reorg = await orphanFrom(ctx, driven.requestBlock, 'gone')
        console.log('AT4 gone: orphaned request block ' + driven.requestBlock +
            ' and rebuilt to ' + reorg.tipAfter)
        await waitForRollback(ctx, driven)
        await assertEffectsRemoved(ctx)
        await assertMirrorSurvives(ctx, driven.requestId)
        const tip = await assertNothingRebinds(ctx, driven)
        console.log('AT4 gone: request and response rolled back, mirror row inert across ' +
            (tip - driven.requestBlock) + ' further blocks')
    } finally {
        await regtestMinerConnector.resumeMining()
        await settleAfterReorg('gone')
    }
}

module.exports = { newContext, bringUp, tearDown, proveRequestKept, proveRequestRemoved }
