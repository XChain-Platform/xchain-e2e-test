'use strict'

// Step functions for the above-height half of zc5_flag_day.test.js: a rollback
// across a bound zero-conf response, on the venue. Pure extraction: bodies are
// unchanged. `ctx` carries { venue, up, testServer, testUrl, contract, minerAddr }.

const assert = require('assert')

const { mineWhile } = require('./mirrorDrillFixture')
const {
    APPLIED_FIELDS, STATE_HASH_FIELDS, diffRows, diffStateHashes, untilOrClearDogeStall,
    waitForMirrorRowEverywhere, waitForAppliedEverywhere, waitForHeightWithClear,
    readAppliedResponse, readContractState, readRequestRow,
    venueTipProbe, findEmittedAttestRequest, attestRequestWatermark,
    clearBeforeBroadcast, settleOrReport, allHubTails, jsonSafe,
} = require('./mirrorDrillWaits')
const vmHelper               = require('../../helpers/vmHelper')
const { LEDGER_ROOT_FIELDS } = require('./zc5_fixture')
const { bootZc5, teardownZc5, rootsAt, orphanFrom, settleAfterReorg } = require('./zc5_venue_steps')

async function emitRequest (ctx) {
    const sinceAction = await attestRequestWatermark(ctx.contract.contractIndex)
    await clearBeforeBroadcast()
    const exec = await mineWhile(() => vmHelper.sendExecuteV0(
        ctx.contract.owner, ctx.contract.contractIndex, 'ask', ['http_get', ctx.testUrl]))
    assert.strictEqual(exec.execution.status, 'valid',
        'the EXECUTE that emits the request came back ' + exec.execution.status)

    const request = await findEmittedAttestRequest(
        ctx.contract.contractIndex, sinceAction + 1, { label: 'zc5' })
    await settleOrReport('zc5')
    return request
}

async function awaitAppliedOnIndexer0 (venue, requestId) {
    const probe  = venueTipProbe(venue, 0)
    const nudged = await untilOrClearDogeStall(async () => {
        const applied = await readAppliedResponse(venue, 0, requestId)
        if (applied) return { ok: true }
        const tip = Number(await nodeConnector.getBlockCount())
        const at  = await probe().catch(() => null)
        if (at && Number(at.height) >= tip) await regtestMinerConnector.generateBlocks(1)
        return { ok: false }
    }, { timeoutMs: 10 * 60 * 1000, intervalMs: 3000, tipProbe: probe })
    assert.ok(nudged.ok, 'the response never applied on indexer 0 before the reorg could be staged\n' +
        venue.logTail('indexer0') + '\n' + allHubTails(venue))
}

async function awaitBound (ctx, request) {
    const venue = ctx.venue
    const requestId = request.requestId
    // NO BURIAL AND NO MINING UNDER THE WAIT. Above the height the hub serves at the
    // tip and the ladder already carries its headroom slot at the request's own
    // block, so a still chain finalizes; and every block mined here is depth the
    // reorg below has to undo inside the tracker's twelve-block window.
    await waitForMirrorRowEverywhere(venue, requestId)
    await awaitAppliedOnIndexer0(venue, requestId)

    await settleOrReport('zc5')
    const beforeRows = await waitForAppliedEverywhere(venue, requestId)
    await waitForHeightWithClear(venue, 0, request.blockIndex)
    const local      = await readRequestRow(venue, 0, requestId)
    const B          = Number(beforeRows[0].block_index)
    console.log('ZC5: request at ' + local.block_index + ', response bound at ' + B)
    return { beforeRows: beforeRows, B: B }
}

async function readRootPair (ctx, B) {
    return {
        below: [await rootsAt(ctx, 0, B - 1), await rootsAt(ctx, 1, B - 1)],
        at:    [await rootsAt(ctx, 0, B),     await rootsAt(ctx, 1, B)],
    }
}

async function readPreRoots (ctx, B) {
    // BOTH NODES LEVEL AT B BEFORE ANYTHING IS READ. A root read off a node that has
    // not committed B yet is not a reading of B at all.
    for (const ix of ctx.venue.indexers) await waitForHeightWithClear(ctx.venue, ix.index, B)
    const pre = await readRootPair(ctx, B)
    const preFork = diffStateHashes(pre.at[0], pre.at[1])
    assert.deepStrictEqual(preFork, [],
        'the two indexers already disagreed at block ' + B + ' BEFORE the reorg: ' +
        preFork.join('; ') + '. Nothing this case does afterwards would be interpretable.')
    console.log('ZC5: pre-reorg state_root at ' + B + ' is ' +
        String(pre.at[0].state_root).slice(0, 16) + '... on both nodes')
    return pre
}

async function awaitReapplied (ctx, B, requestId) {
    const venue = ctx.venue
    const reapplied = await untilOrClearDogeStall(async () => {
        const rows = []
        for (const ix of venue.indexers) rows.push(await readAppliedResponse(venue, ix.index, requestId))
        return { ok: rows.every((r) => r && Number(r.block_index) === B), rows: rows }
    }, { timeoutMs: 15 * 60 * 1000, tipProbe: venueTipProbe(venue, 0) })
    assert.ok(reapplied.ok,
        'the response did not come back at block ' + B + ' on both nodes after the reorg; they ' +
        'hold ' + jsonSafe(reapplied.rows.map((r) => (r ? r.block_index : null))) + '\n' +
        venue.logTail('indexer0') + '\n' + venue.logTail('indexer1'))
    return reapplied
}

function assertReappliedRows (beforeRows, reapplied) {
    const rowDiffs = diffRows(reapplied.rows[0], reapplied.rows[1], APPLIED_FIELDS)
    assert.deepStrictEqual(rowDiffs, [],
        'the two nodes re-bound the response differently: ' + rowDiffs.join('; '))
    const acrossDiffs = diffRows(beforeRows[0], reapplied.rows[0], APPLIED_FIELDS)
    assert.deepStrictEqual(acrossDiffs, [],
        'the re-applied row differs from the pre-reorg one: ' + acrossDiffs.join('; ') +
        '. Everything in it is derived from the request id, the tag and the network, none of ' +
        'which a reorg touches, so a difference means something chain-dependent is leaking in.')
}

function assertNoFork (post, B) {
    // NO FORK: the two nodes agree on every signed root at the re-applied block,
    // block_merkle_root included, because they indexed the same chain.
    const postFork = diffStateHashes(post.at[0], post.at[1])
    assert.deepStrictEqual(postFork, [],
        'the two indexers disagree at block ' + B + ' after the re-apply: ' + postFork.join('; ') +
        '. That is a fork rather than lag: both committed the same block of the same chain and ' +
        'the applier is a pure function of the mirror row and local state.')
}

function assertBelowUnmoved (pre, post, B) {
    // THE CONTROL: nothing below the reorg point moved. A rollback that reached
    // too far would show here first, and without it a restored root at B could be
    // a restored root on a ledger that lost something underneath it.
    for (const i of [0, 1]) {
        const drift = diffRows(pre.below[i], post.below[i], STATE_HASH_FIELDS)
        assert.deepStrictEqual(drift, [],
            'indexer ' + i + ' changed its roots at block ' + (B - 1) + ', BELOW the orphan ' +
            'point: ' + drift.join('; ') + '. That block was never orphaned, so the rollback ' +
            'reached further than the reorg did.')
    }
}

function assertLedgerRestored (pre, post, B) {
    // AND THE LEDGER IS RESTORED at the re-applied block. `block_merkle_root` is
    // excluded on purpose (see the header): the replacement block is a different
    // block by construction, and comparing it would be comparing the block rather
    // than the state the response wrote into it.
    for (const i of [0, 1]) {
        const restored = diffRows(pre.at[i], post.at[i], LEDGER_ROOT_FIELDS)
        assert.deepStrictEqual(restored, [],
            'indexer ' + i + ' committed different ledger roots at block ' + B + ' after the ' +
            're-apply: ' + restored.join('; ') + '. The same response bound at the same block ' +
            'from the same rollback-exempt mirror row, so state_root, balances_root and ' +
            'stakes_root must come back byte for byte. The one legitimate way they can differ ' +
            'is a replacement block carrying transactions the original did not; the competing ' +
            'chain here is mined EMPTY precisely so it cannot.')
    }
    console.log('ZC5: ledger roots at ' + B + ' restored on both nodes (state_root ' +
        String(post.at[0].state_root).slice(0, 16) + '...), block_merkle_root ' +
        (String(pre.at[0].block_merkle_root) === String(post.at[0].block_merkle_root)
            ? 'unchanged' : 'replaced with the block, as expected'))
}

async function assertPostReorg (ctx, bound, pre, reapplied) {
    const { B, beforeRows } = bound
    assertReappliedRows(beforeRows, reapplied)

    for (const ix of ctx.venue.indexers) await waitForHeightWithClear(ctx.venue, ix.index, B)
    const post = await readRootPair(ctx, B)
    assertNoFork(post, B)
    assertBelowUnmoved(pre, post, B)
    assertLedgerRestored(pre, post, B)
}

async function reorgAndVerify (ctx, requestId, bound, pre) {
    const B = bound.B
    const reorg = await orphanFrom(ctx, B, 'zc5')
    console.log('ZC5: orphaned the applying block ' + B + ' and rebuilt to ' + reorg.tipAfter)

    const reapplied = await awaitReapplied(ctx, B, requestId)
    await assertPostReorg(ctx, bound, pre, reapplied)

    const state = await readContractState(ctx.venue, 0, ctx.contract.contractIndex)
    assert.strictEqual(JSON.parse(state.callback_status), 'ok',
        'the callback did not re-fire after the reorg (state ' + state.callback_status + ')')
    console.log('ZC5 GREEN: re-applied at ' + B + ' with the ledger restored and no divergence')
}

async function rollbackRestoresLedger (ctx) {
    const request   = await emitRequest(ctx)
    const requestId = request.requestId
    const bound     = await awaitBound(ctx, request)
    const pre       = await readPreRoots(ctx, bound.B)

    await regtestMinerConnector.pauseMining()
    try {
        await reorgAndVerify(ctx, requestId, bound, pre)
    } finally {
        await regtestMinerConnector.resumeMining()
        await settleAfterReorg('zc5')
    }
}

module.exports = { bootZc5, teardownZc5, rollbackRestoresLedger }
