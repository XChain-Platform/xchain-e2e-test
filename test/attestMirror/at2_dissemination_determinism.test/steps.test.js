'use strict'

const assert = require('assert')

const { AttestMirrorVenue } = require('../../helpers/attestMirrorVenue')
const {
    provisionDrillIdentities, waitForVenueIndexersAtTip, startAttestTestServer,
    deployRequestContract, readContractState, mineWhile,
} = require('../helpers/mirrorDrillFixture')
const {
    APPLIED_FIELDS, STATE_HASH_FIELDS, until, diffRows, diffStateHashes,
    rewardFingerprint, waitForMirrorRowEverywhere, waitForAppliedEverywhere,
    readAttestRewards, happyPathVerdict, findEmittedAttestRequest,
    clearBeforeBroadcast, attestRequestWatermark, settleOrReport,
    widenArithmetic, jsonSafe, feeLines, rawAttestRewards,
} = require('../helpers/mirrorDrillWaits')
const vmHelper = require('../../helpers/vmHelper')
const XChainIndexerConnector = require('../../../src/XChainIndexerConnector.js')

const FIXED_BODY = '{"score":7,"meta":"at2-dissemination"}'
const DEADLINE_BLOCKS = 60
const OUTSIDE_ATTEMPTS = 6
const CONTRACT_CODE = `
module.exports = {
    meta: { name: 'Mirror Determinism Asker', description: 'Requests an attestation used to prove mirror dissemination is deterministic.', version: '1.0.0' },
    ask: function(xchain) {
        var requestId = xchain.attestation.request(
            xchain.getInputParam(0), xchain.getInputParam(1),
            'handleResponse', ['ctx-at2'],
            { redundancy: 3, deadlineBlocks: ${DEADLINE_BLOCKS}, feeTick: 'XCHAIN', feeAmount: '6' }
        );
        xchain.state.set('pending_request_id', requestId);
        return requestId;
    },
    handleResponse: function(xchain) {
        xchain.state.set('callback_request_id',  xchain.getInputParam(0));
        xchain.state.set('callback_provider_id', xchain.getInputParam(1));
        xchain.state.set('callback_status',      xchain.getInputParam(2));
        xchain.state.set('callback_payload',     xchain.getInputParam(3));
        xchain.state.set('callback_context',     xchain.getInputParam(4));
    }
};
`

function newContext () {
    return { venue: null, testServer: null, testUrl: null, contract: null }
}

async function bringUp (ctx, mocha) {
    ctx.testServer = await startAttestTestServer({ body: FIXED_BODY })
    ctx.testUrl = ctx.testServer.url
    const staked = await provisionDrillIdentities({ label: 'at2', count: 5, redundancy: 3 })
    ctx.venue = new AttestMirrorVenue({
        label: 'at2', identities: staked.identities, hubExtraEnv: ctx.testServer.hubEnv,
    })
    if (!(await ctx.venue.start())) {
        console.log('AT2 SKIPPED: ' + ctx.venue.unavailable)
        return mocha.skip()
    }
    await waitForVenueIndexersAtTip(ctx.venue)
    ctx.contract = await deployRequestContract({ label: 'at2', code: CONTRACT_CODE })
}

async function tearDown (ctx) {
    if (ctx.testServer) await ctx.testServer.close()
    if (ctx.venue) await ctx.venue.stop()
}

async function driveOneRequest (ctx, attempt) {
    const sinceAction = await attestRequestWatermark(ctx.contract.contractIndex)
    await clearBeforeBroadcast()
    const exec = await mineWhile(() => vmHelper.sendExecuteV0(
        ctx.contract.owner, ctx.contract.contractIndex, 'ask', ['http_get', ctx.testUrl]))
    assert.strictEqual(exec.execution.status, 'valid',
        'attempt ' + attempt + ': the EXECUTE that emits the request came back ' +
        exec.execution.status + '. A short responsible set is rejected at admission.')
    const request = await findEmittedAttestRequest(
        ctx.contract.contractIndex, sinceAction + 1, { label: 'attempt ' + attempt })
    await regtestMinerConnector.generateBlocks(6)
    await settleOrReport('at2')
    const rows = await waitForMirrorRowEverywhere(ctx.venue, request.requestId)
    rows.forEach((row, index) => assert.strictEqual(String(row.status), 'ok',
        'attempt ' + attempt + ': mirror row status is ' + row.status + ' on indexer ' + index))
    const signers = await ctx.venue.responsibleSetFromMirror(0, request.requestId)
    assert.ok(Array.isArray(signers) && signers.length > 0,
        'attempt ' + attempt + ': the mirror row carries no signer_pubkeys')
    return { requestId: request.requestId, signers: signers, rows: rows, widen: rows[0].widen }
}

function requireHappyPath (ctx, driven, mocha) {
    const path = happyPathVerdict({
        widen: driven.widen, signers: driven.signers, ownPubkeys: ctx.venue.getPubkeys(),
    })
    if (path.happy) return true
    console.log('AT2 SKIPPED on request ' + driven.requestId.slice(0, 12) + ': ' + path.why)
    mocha.skip()
    return false
}

async function chooseOutsideRequest (ctx, mocha) {
    const tried = []
    for (let attempt = 1; attempt <= OUTSIDE_ATTEMPTS; attempt++) {
        const driven = await driveOneRequest(ctx, attempt)
        tried.push(driven.requestId.slice(0, 12))
        if (!requireHappyPath(ctx, driven, mocha)) return null
        try {
            return {
                chosen: driven,
                outside: ctx.venue.pickIndexerOutsideResponsibleSet(driven.signers),
            }
        } catch (error) {
            console.log('AT2: request ' + driven.requestId.slice(0, 12) +
                ' put both followed hubs inside the responsible set; making another')
        }
    }
    assert.fail('AT2 drove ' + tried.length + ' requests (' + tried.join(', ') +
        ') and every one ranked both followed hubs into the responsible set')
}

function assertOutsidePremise (selection) {
    const { chosen, outside } = selection
    const signerSet = new Set(chosen.signers.map((signer) => String(signer).toLowerCase()))
    assert.ok(!signerSet.has(String(outside.hubPubkey).toLowerCase()),
        'the followed hub is in the signer set, so the row need not have arrived through gossip')
    console.log('AT2: request ' + chosen.requestId.slice(0, 12) + ' signed by ' +
        chosen.signers.length + ' hubs; indexer ' + outside.index + ' follows hub ' +
        outside.followsHub + ', which is OUTSIDE that set')
}

async function assertOutsideHubServes (ctx, selection) {
    const { chosen, outside } = selection
    const served = await until(async () => {
        const snap = await ctx.venue.hubSnapshot(outside.followsHub).catch(() => null)
        const row = snap && Array.isArray(snap.rows) &&
            snap.rows.find((candidate) => String(candidate.request_id) === chosen.requestId)
        return { ok: !!row, row: row }
    }, 5 * 60 * 1000)
    assert.ok(served.ok,
        'outside hub ' + outside.followsHub + ' does not serve the gossiped response\n' +
        ctx.venue.logTail('hub' + outside.followsHub))
    assert.strictEqual(String(served.row.response_hash), String(chosen.rows[0].response_hash),
        'the outside hub serves a different response hash than the round produced')
}

async function assertAppliedEqual (ctx, selection, inside) {
    const { chosen, outside } = selection
    const applied = await waitForAppliedEverywhere(ctx.venue, chosen.requestId, null,
        { mineWhileWaiting: { perPoll: 1, maxBlocks: widenArithmetic(DEADLINE_BLOCKS).safeCap } })
    const a0 = applied[outside.index]
    const a1 = applied[inside.index]
    const diffs = diffRows(a0, a1, APPLIED_FIELDS)
    assert.deepStrictEqual(diffs, [], 'the outside and inside indexers hold different applied rows: ' +
        diffs.join('; '))
    assert.strictEqual(a0.tx_index, null,
        'the outside indexer applied row carries tx_index ' + a0.tx_index + ' rather than NULL')
    console.log('AT2: both indexers applied ' + chosen.requestId.slice(0, 12) + ' as action ' +
        a0.action_index + ' at block ' + a0.block_index)
    return Number(a0.block_index)
}

async function assertCallbackEqual (ctx, selection, inside) {
    const state0 = await readContractState(
        ctx.venue, selection.outside.index, ctx.contract.contractIndex)
    const state1 = await readContractState(ctx.venue, inside.index, ctx.contract.contractIndex)
    for (const key of ['callback_request_id', 'callback_provider_id', 'callback_status',
        'callback_payload', 'callback_context']) {
        assert.strictEqual(String(state0[key]), String(state1[key]),
            'the two indexers disagree about contract state ' + key)
    }
    assert.strictEqual(JSON.parse(state0.callback_status), 'ok')
    assert.strictEqual(JSON.parse(state0.callback_payload), FIXED_BODY)
}

async function assertRewardsEqual (ctx, selection, inside, appliedBlock) {
    const outsideIndex = selection.outside.index
    const rewards0 = rewardFingerprint(await readAttestRewards(
        ctx.venue, outsideIndex, { blockIndex: appliedBlock }))
    const rewards1 = rewardFingerprint(await readAttestRewards(
        ctx.venue, inside.index, { blockIndex: appliedBlock }))
    const rawRewards = rewards0.length > 0 ? '' : await rawAttestRewards(ctx.venue, outsideIndex)
    assert.ok(rewards0.length > 0,
        'no attest_fee rows at block ' + appliedBlock + '\n' +
        feeLines(ctx.venue, 'indexer' + outsideIndex) + '\n' + rawRewards)
    assert.deepStrictEqual(rewards0, rewards1,
        'the two indexers paid different rewards at block ' + appliedBlock)
}

async function assertHashesEqual (ctx, selection, inside, appliedBlock) {
    const conn0 = new XChainIndexerConnector(
        '127.0.0.1', ctx.venue.indexers[selection.outside.index].apiPort, null)
    const conn1 = new XChainIndexerConnector(
        '127.0.0.1', ctx.venue.indexers[inside.index].apiPort, null)
    const h0 = await conn0.call('getblockhashes', { block_index: appliedBlock })
    const h1 = await conn1.call('getblockhashes', { block_index: appliedBlock })
    assert.ok(h0 && !h0.error, 'outside indexer would not report hashes: ' + jsonSafe(h0))
    assert.ok(h1 && !h1.error, 'inside indexer would not report hashes: ' + jsonSafe(h1))
    const diffs = diffStateHashes(h0, h1)
    assert.deepStrictEqual(diffs, [], 'the indexers disagree at the applying block: ' + diffs.join('; '))
    console.log('AT2: no divergence at block ' + appliedBlock + '; ' +
        STATE_HASH_FIELDS.length + ' hash fields identical, state_root ' +
        String(h0.state_root).slice(0, 16) + '...')
}

async function proveDissemination (ctx, mocha) {
    const selection = await chooseOutsideRequest(ctx, mocha)
    if (!selection) return
    const inside = ctx.venue.indexers.find((indexer) => indexer.index !== selection.outside.index)
    assert.ok(inside, 'the venue stood up fewer than two indexers')
    assertOutsidePremise(selection)
    await assertOutsideHubServes(ctx, selection)
    const appliedBlock = await assertAppliedEqual(ctx, selection, inside)
    await assertCallbackEqual(ctx, selection, inside)
    await assertRewardsEqual(ctx, selection, inside, appliedBlock)
    await assertHashesEqual(ctx, selection, inside, appliedBlock)
}

module.exports = { newContext, bringUp, tearDown, proveDissemination }
