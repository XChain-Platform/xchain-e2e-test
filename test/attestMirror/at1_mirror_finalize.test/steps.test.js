'use strict'

const assert = require('assert')

const {
    AttestMirrorVenue, assertLlmAvailable, llmProbes, hubCredentialEnv,
} = require('../../helpers/attestMirrorVenue')
const {
    provisionDrillIdentities, waitForVenueIndexersAtTip, startAttestTestServer,
    deployRequestContract, settleStack, readContractState, mineWhile,
} = require('../helpers/mirrorDrillFixture')
const {
    findEmittedAttestRequest, waitForMirrorRowEverywhere,
    waitForAppliedEverywhere, widenArithmetic,
} = require('../helpers/mirrorDrillWaits')
const vmHelper = require('../../helpers/vmHelper')

const FIXED_BODY = '{"score":42,"meta":"at1-mirror"}'
const DEADLINE_BLOCKS = Object.freeze({ http_get: 60, llm: 20 })
const BURIAL_BLOCKS = 6

function contractCode (deadlineBlocks) {
    return `
module.exports = {
    meta: { name: 'Mirror Finalize Asker', description: 'Requests an attestation whose response is finalized through the hub mirror.', version: '1.0.0' },
    ask: function(xchain) {
        var requestId = xchain.attestation.request(
            xchain.getInputParam(0),
            xchain.getInputParam(1),
            'handleResponse',
            ['ctx-at1'],
            { redundancy: 3, deadlineBlocks: ${deadlineBlocks} }
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
}

function forwardedHubCredentialEnv () {
    return process.env.HUB_CLAUDE_CODE_OAUTH_TOKEN
        ? { HUB_CLAUDE_CODE_OAUTH_TOKEN: process.env.HUB_CLAUDE_CODE_OAUTH_TOKEN } : {}
}

function llmRunnableHere () {
    const dir = process.env.HUB_CLAUDE_CONFIG_DIR || null
    try {
        assertLlmAvailable({
            claudeConfigDir: dir,
            pathEnv: process.env.PATH,
            hubEnv: hubCredentialEnv(dir, forwardedHubCredentialEnv()),
        }, llmProbes())
        return { ok: true, why: null }
    } catch (error) {
        return { ok: false, why: (error && error.message) || String(error) }
    }
}

function newContext () {
    return {
        venue: null, testServer: null, testUrl: null, contracts: null,
        llm: { ok: false, why: 'not probed' },
    }
}

async function deployContracts (ctx) {
    ctx.contracts = {
        http_get: await deployRequestContract({
            label: 'at1http', code: contractCode(DEADLINE_BLOCKS.http_get),
        }),
        llm: await deployRequestContract({
            label: 'at1llm', code: contractCode(DEADLINE_BLOCKS.llm),
        }),
    }
}

async function bringUp (ctx, mocha) {
    ctx.llm = llmRunnableHere()
    if (!ctx.llm.ok) console.log('AT1: the llm case will SKIP on this box.\n' + ctx.llm.why)
    ctx.testServer = await startAttestTestServer({ body: FIXED_BODY })
    ctx.testUrl = ctx.testServer.url
    const staked = await provisionDrillIdentities({ label: 'at1', count: 5, redundancy: 3 })
    ctx.venue = new AttestMirrorVenue({
        label: 'at1', identities: staked.identities, needsLlm: ctx.llm.ok,
        hubExtraEnv: Object.assign({}, ctx.testServer.hubEnv, forwardedHubCredentialEnv()),
    })
    if (!(await ctx.venue.start())) {
        console.log('AT1 SKIPPED: ' + ctx.venue.unavailable)
        return mocha.skip()
    }
    await waitForVenueIndexersAtTip(ctx.venue)
    await deployContracts(ctx)
}

async function tearDown (ctx) {
    if (ctx.testServer) await ctx.testServer.close()
    if (ctx.venue) await ctx.venue.stop()
}

async function emitRequest (ctx, providerId, payload) {
    const contract = ctx.contracts[providerId]
    assert.ok(contract, 'AT1: no contract deployed for provider ' + providerId)
    const exec = await mineWhile(() => vmHelper.sendExecuteV0(
        contract.owner, contract.contractIndex, 'ask', [providerId, payload]))
    assert.strictEqual(exec.execution.status, 'valid',
        providerId + ': the EXECUTE that emits the request came back ' + exec.execution.status +
        '. A responsible set smaller than redundancy is rejected at admission.')
    const request = await findEmittedAttestRequest(
        contract.contractIndex, exec.execution.action_index, { label: providerId })
    await regtestMinerConnector.generateBlocks(BURIAL_BLOCKS)
    await settleStack()
    return { contract: contract, requestId: request.requestId }
}

function assertMirrorRows (providerId, rows) {
    for (const [index, row] of rows.entries()) {
        assert.strictEqual(String(row.status), 'ok',
            providerId + ': mirror row status is ' + row.status + ' on indexer ' + index +
            ', so the round finalized a non-ok outcome rather than failing to deliver.')
    }
    assert.strictEqual(rows[0].response_hash, rows[1].response_hash,
        providerId + ': the two indexers hold different response hashes, so the federation ' +
        'did not converge on one response')
}

async function assertNoChainTransaction (providerId, requestId) {
    const onChain = await indexerDatabase.checkAttestationResponse({ requestId }).catch(() => null)
    assert.strictEqual(onChain, null,
        providerId + ': the standing indexer holds an on-chain ATTEST v1 row for ' + requestId +
        ' (action ' + (onChain && onChain.action_index) + ').')
}

async function waitForApplied (ctx, providerId, requestId) {
    const cap = Math.max(1,
        widenArithmetic(DEADLINE_BLOCKS[providerId]).safeCap - BURIAL_BLOCKS)
    return waitForAppliedEverywhere(ctx.venue, requestId, null,
        { mineWhileWaiting: { perPoll: 1, maxBlocks: cap } })
}

function assertAppliedRows (providerId, appliedRows) {
    const applieds = appliedRows.map((applied, index) => ({ index: index, applied: applied }))
    for (const entry of applieds) {
        assert.strictEqual(entry.applied.tx_index, null,
            providerId + ': the synthesized action on indexer ' + entry.index +
            ' carries tx_index ' + entry.applied.tx_index + ' rather than NULL')
    }
    const first = applieds[0]
    for (const other of applieds.slice(1)) {
        for (const field of ['action_index', 'block_index', 'response_hash', 'response_payload']) {
            assert.strictEqual(String(other.applied[field]), String(first.applied[field]),
                providerId + ': indexer ' + other.index + ' applied ' + field + '=' +
                other.applied[field] + ' while indexer ' + first.index + ' applied ' +
                first.applied[field] + '. The applier diverged between mirror readers.')
        }
    }
}

async function assertCallback (ctx, providerId, contract, expectBody) {
    const state = await readContractState(
        ctx.venue, ctx.venue.indexers[0].index, contract.contractIndex)
    assert.strictEqual(JSON.parse(state.callback_status), 'ok',
        providerId + ': callback_status is ' + state.callback_status)
    assert.strictEqual(JSON.parse(state.callback_context), 'ctx-at1')
    assert.strictEqual(JSON.parse(state.callback_provider_id), providerId)
    expectBody(JSON.parse(state.callback_payload))
}

async function driveAndAssert (ctx, providerId, payload, expectBody) {
    const request = await emitRequest(ctx, providerId, payload)
    const rows = await waitForMirrorRowEverywhere(ctx.venue, request.requestId)
    assertMirrorRows(providerId, rows)
    await assertNoChainTransaction(providerId, request.requestId)
    const appliedRows = await waitForApplied(ctx, providerId, request.requestId)
    assertAppliedRows(providerId, appliedRows)
    await assertCallback(ctx, providerId, request.contract, expectBody)
}

async function settleHttpGet (ctx) {
    await driveAndAssert(ctx, 'http_get', ctx.testUrl, (body) => {
        assert.strictEqual(body, FIXED_BODY,
            'the callback payload is not the body the provider served')
    })
}

async function settleLlm (ctx, mocha) {
    if (!ctx.llm.ok) return mocha.skip()
    const payload = JSON.stringify({ prompt: 'What is 2+2? Reply with only the number.' })
    await driveAndAssert(ctx, 'llm', payload, (body) => {
        assert.ok(/4/.test(String(body)),
            'the model answer does not contain 4, so the round converged on something else: ' + body)
    })
}

module.exports = { newContext, bringUp, tearDown, settleHttpGet, settleLlm }
