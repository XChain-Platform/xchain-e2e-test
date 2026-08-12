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
 * Phase 4 drill: LLM attestation outage resilience (regtest, 3 hubs).
 *
 * Exercises the 2026-07-09 outage-resilience slice end to end against a
 * LIVE regtest stack, with three real in-process hubs (MultiValidatorHub):
 *
 *   1. OUTAGE: Anthropic creds broken on every hub (present-but-invalid
 *      API key, the realistic vendor-outage shape: credential RESOLUTION
 *      succeeds so the capability self-test keeps the validators in the
 *      round, while the actual call 401s). A redundancy=3 llm request must
 *      produce EXACTLY ONE on-chain status='provider_error' ATTEST v1
 *      (throttle: once per request_id+status, federation-wide), leave the
 *      request pending, and finally expire + fire the callback with
 *      status='expired' (escrow refund path).
 *   2. RECOVERY: a second request sees the provider_error record, then the
 *      creds are restored mid-window and the SAME request is fulfilled
 *      (status='ok', 3 verified sigs, callback fires with the answer).
 *   3. LEADER ROTATION (wedged leader): slot-0's judge is broken (its
 *      agree() throws; fetch + signing still work, i.e. the hub is alive
 *      but cannot lead). The round publishes ONE no_quorum ATTEST v1,
 *      then the escalation ladder rotates the leader slot with chain
 *      height and a rotated leader's working judge fulfills the request.
 *   4. MODEL-FALLBACK LADDER (governance): an ATTESTATION_PROVIDER:llm
 *      governance change (block-anchored activation) sets approved_models
 *      ['claude-sonnet-4-6','gpt-5-mini'] + judge_fallback_models
 *      ['gpt-5-mini']. With Anthropic down in segment 1 the request logs
 *      provider_error; past the span midpoint every hub deterministically
 *      pins gpt-5-mini (openai vendor). With NO OpenAI key provisioned the
 *      request must KEEP FAILING even after Anthropic creds are restored
 *      (negative proof the ladder advanced + vendor routing engaged),
 *      while a fresh control request (its own segment 1 = sonnet)
 *      fulfills immediately.
 *   5. HARD-KILL (protocol backstop): slot-0 hub stopped outright. The
 *      indexer requires a signature from EVERY responsible validator
 *      (validSigs >= redundancy), so no v1 of any status can land; the
 *      request must simply expire + refund. Documents the economic
 *      backstop (missed_count) rather than a liveness rescue.
 *
 * Venue: a BTC regtest stack, freshly reset (clean validator set). Needs
 * HUB_CLAUDE_CONFIG_DIR (a `claude login`-populated dir) + the claude CLI
 * on PATH; the drill breaks/restores creds by manipulating process.env
 * (all three hubs run in this process and resolve creds per call).
 ********************************************************************/

const dotenv = require('dotenv')
dotenv.config()

const assert = require('assert')
const crypto = require('crypto')

const cryptoHelper = require('../cryptoHelper')
const stakeHelper = require('../helpers/stakeHelper')
const gasHelper = require('../helpers/gasHelper')
const vmHelper = require('../helpers/vmHelper')
const transactionHelper = require('../transactionHelper')
const { MultiValidatorHub } = require('../helpers/multiValidatorHubHelper')
const { requireFederationEnv, assertCleanValidatorSet } = require('../helpers/federationGuards')

function sleep(ms){ return new Promise(r => setTimeout(r, ms)) }

async function _settleStack() {
    await utxoTrackerConnector.quiesce({ timeoutMs: 30000, pollMs: 250, regtestMiner: regtestMinerConnector })
}

// ---------------------------------------------------------------------------
// Credential control. All hubs share this process's env; the llm provider
// resolves creds AT CALL TIME (hub-credentials.js), so flipping env vars is an
// immediate, fleet-wide outage/recovery switch.
// ---------------------------------------------------------------------------
const CRED_KEYS = ['HUB_CLAUDE_CONFIG_DIR', 'CLAUDE_CONFIG_DIR',
                   'HUB_CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN',
                   'ANTHROPIC_API_KEY']
let savedCreds = null

function breakAnthropicCreds(){
    if (!savedCreds){
        savedCreds = {}
        for (const k of CRED_KEYS) savedCreds[k] = process.env[k]
    }
    for (const k of CRED_KEYS) delete process.env[k]
    // Present-but-invalid key: resolution succeeds (self-test keeps the hubs
    // in rounds; resolveHubLlmAuth stops at ANTHROPIC_API_KEY before the
    // default config-dir fallback) but the API call 401s -> fetch throws ->
    // the round proposes status='provider_error'.
    process.env.ANTHROPIC_API_KEY = 'sk-ant-api03-drill-invalid-0000000000000000'
}

function restoreAnthropicCreds(){
    if (!savedCreds) return
    for (const k of CRED_KEYS) delete process.env[k]
    for (const k of CRED_KEYS) if (savedCreds[k] !== undefined) process.env[k] = savedCreds[k]
}

// ---------------------------------------------------------------------------
// On-chain row counting (the throttle assertions). Counts ATTEST v1 rows for
// a request directly in the indexer DB; `valid` restricts to rows the indexer
// accepted (validSigs >= redundancy).
// ---------------------------------------------------------------------------
async function countV1Rows(requestId, responseStatus, onlyValid){
    const conn = await indexerDatabase.getConnection()
    try {
        let q = `SELECT COUNT(*) AS n FROM attests ar
                 LEFT JOIN index_statuses ist ON ist.id = ar.status_id
                 WHERE ar.version = 1 AND ar.request_id = ?`
        const v = [String(requestId).toLowerCase()]
        if (responseStatus){ q += ' AND ar.response_status = ?'; v.push(responseStatus) }
        if (onlyValid){ q += " AND ist.status = 'valid'" }
        const rows = await conn.query(q, v)
        return Number(rows[0].n)
    } finally { await conn.release() }
}

// Hash-rank the harness pubkeys for a request (same rule as the hub's
// AttestationRound / indexer's _computeResponsibleSet: SHA256(rid || pubkey)
// ascending) and return the mvh hub index sitting at slot 0.
function slot0HubIndex(mvh, requestId){
    const rid = String(requestId).toLowerCase()
    const ranked = mvh.getPubkeys().map((pk, i) => {
        const lower = String(pk).toLowerCase()
        const h = crypto.createHash('sha256').update(rid, 'utf8').update(lower, 'utf8').digest('hex')
        return { i, hash: h }
    }).sort((a, b) => (a.hash < b.hash) ? -1 : 1)
    return ranked[0].i
}

// Apply a finalized ATTESTATION_PROVIDER:llm governance change to every hub,
// through the same entry point the real governance finalizer uses
// (block-anchored history), plus the live def mirror for the non-anchored
// readers (judge fallback chain).
async function applyLlmGovernance(mvh, activationBlock, additionalConfig){
    for (const hub of mvh.hubs){
        await hub._applyProviderGovernanceChange({
            parameter:       'ATTESTATION_PROVIDER:llm',
            activationBlock: activationBlock,
            newValue:        JSON.stringify({ additional_config: additionalConfig })
        })
        const reg = hub.providerRegistry
        const def = Object.assign({}, reg.getDef('llm'), { additional_config: additionalConfig })
        reg.providers.set('llm', def)
        const mod = reg.getModule('llm')
        if (mod && typeof mod._setConfig === 'function') mod._setConfig(def)
    }
}

describe('Phase 4 drill: LLM attestation outage resilience (redundancy=3)', function () {
    this.timeout(45 * 60 * 1000)

    let mvh           = null
    let contractIndex = null
    let owner         = null

    const ENVELOPE = JSON.stringify({
        prompt: 'What is 2 plus 2? Reply with only the number, nothing else.',
        max_tokens: 16
    })

    // Callback state is keyed per request so sequential drills don't clobber
    // each other's assertions.
    const CONTRACT_CODE = `
module.exports = {
    askLlm: function(xchain) {
        var envelope = xchain.getInputParam(0);
        var requestId = xchain.attestation.request(
            'llm',
            envelope,
            'handleResponse',
            ['ctx-outage-drill'],
            { redundancy: 3, deadlineBlocks: 20 }
        );
        xchain.state.set('last_request_id', requestId);
        return requestId;
    },
    handleResponse: function(xchain) {
        var rid = String(xchain.getInputParam(0));
        var key = 'cb_' + rid.substring(0, 24);
        xchain.state.set(key + '_status',  xchain.getInputParam(2));
        xchain.state.set(key + '_payload', xchain.getInputParam(3));
    }
};
`

    // Submit one llm request through the contract and wait for its pending row.
    async function submitRequest(){
        const exec = await vmHelper.sendExecuteV0(owner, contractIndex, 'askLlm', [ENVELOPE])
        assert.strictEqual(exec.execution.status, 'valid', 'execute should be valid')
        const request = await indexerDatabase.waitForAttestationRequest({
            txHash:        exec.txHash,
            requestStatus: 'pending'
        })
        assert(request, 'pending attestation request row should exist')
        assert.strictEqual(Number(request.redundancy), 3)
        return request
    }

    async function callbackState(requestId, field){
        const key = 'cb_' + String(requestId).toLowerCase().substring(0, 24) + '_' + field
        return indexerDatabase.getContractState(contractIndex, key)
    }

    async function mineToPastDeadline(request){
        const tip = Number(await nodeConnector.getBlockCount())
        const deadline = Number(request.deadline_block)
        assert(Number.isFinite(deadline) && deadline > 0, 'request row should carry deadline_block')
        const need = deadline - tip + 2
        if (need > 0) await regtestMinerConnector.generateBlocks(need)
    }

    before(async function () {
        if (!requireFederationEnv(this, { needsClaudeConfig: true })) return
        await assertCleanValidatorSet(indexerDatabase)

        // Hubs start with creds ALREADY broken: drill 1 needs the outage in
        // place before the first poll, and resolution still succeeds so the
        // attestation capability self-test passes at startup.
        breakAnthropicCreds()

        mvh = new MultiValidatorHub({
            count: 3,
            extraP2pConfig: {
                // Tight drill cadence: 5s polls; 60s round timeout still
                // comfortably covers claude_spawn fetch + judge latency.
                ATTESTATION_POLL_MS:          5000,
                ATTESTATION_ROUND_TIMEOUT_MS: 60000
            }
        })
        await mvh.start()
        const pubkeys = mvh.getPubkeys()

        for (let i = 0; i < pubkeys.length; i++) {
            const addr = await cryptoHelper.getNewFundedAddress(
                'outage-staker-' + i, COIN, NETWORK, null, 'legacy', 0, 0.02
            )
            await _settleStack()
            await gasHelper.ensureGasBalance(addr, '1500')
            await _settleStack()
            const result = await stakeHelper.sendStakeV1(addr, '1200.00000000', pubkeys[i])
            assert.strictEqual(result.stake.status, 'valid', 'stake ' + i + ' should be valid')
        }

        await regtestMinerConnector.generateBlocks(7)
        await _settleStack()

        owner = await cryptoHelper.getNewFundedAddress(
            'outage-owner', COIN, NETWORK, null, 'legacy', 0, 0.02
        )
        await regtestMinerConnector.generateBlocks(2)
        await _settleStack()
        await gasHelper.ensureGasBalance(owner, '20000')

        const deploy = await vmHelper.sendDeployV0(owner, CONTRACT_CODE, 500000)
        assert.strictEqual(deploy.contract.status, 'valid', 'deploy should be valid')
        contractIndex = deploy.contract.action_index

        const publisherAddr = await cryptoHelper.getNewFundedAddress(
            'outage-publisher', COIN, NETWORK, null, 'legacy', 0, 0.02
        )
        await regtestMinerConnector.generateBlocks(2)
        await _settleStack()
        mvh.setBroadcastHook(async (wirePayload) => {
            const txHash = await transactionHelper.createAndSendTransaction(publisherAddr, wirePayload)
            return { txid: txHash }
        })
    })

    after(async function () {
        restoreAnthropicCreds()
        if (mvh) {
            await mvh.stop()
            await mvh.dropDatabases()
        }
    })

    it('1. vendor outage: exactly one on-chain provider_error, request stays pending, expiry refunds via callback', async function () {
        // Creds are broken (before()). Submit and cross the confirmation gate.
        const request = await submitRequest()
        const rid = request.request_id
        await regtestMinerConnector.generateBlocks(4)

        const errRow = await indexerDatabase.waitForAttestationResponse({
            requestId:      rid,
            responseStatus: 'provider_error',
            status:         'valid'
        }, 240000)
        assert(errRow, 'a valid provider_error ATTEST v1 should land on-chain')

        // Throttle proof: advance the chain across leader-rotation windows and
        // let several poll/retry cycles run; the (request_id, status) throttle
        // must keep the on-chain record at exactly one row, even though every
        // retry round keeps failing and the leader slot rotates.
        await regtestMinerConnector.generateBlocks(3)
        await sleep(75000)
        const total = await countV1Rows(rid, 'provider_error', false)
        assert.strictEqual(total, 1, 'provider_error must land EXACTLY once, got ' + total)

        const stillPending = await indexerDatabase.checkAttestationRequest({
            requestId: rid, requestStatus: 'pending'
        })
        assert(stillPending, 'request must stay pending after a provider_error (retryable)')

        // No callback yet: provider_error is an audit row, not a terminal state.
        assert(!(await callbackState(rid, 'status')), 'no callback may fire on provider_error')

        // Expiry backstop: cross deadline_block, indexer injects ATTEST v2
        // (expire), flips the request, refunds escrow, fires the callback.
        await mineToPastDeadline(request)
        const expired = await indexerDatabase.waitForAttestationRequest({
            requestId: rid, requestStatus: 'expired'
        }, 90000)
        assert(expired, 'request should expire past deadline_block')

        const cbStatus = await callbackState(rid, 'status')
        assert(cbStatus, 'expiry callback should have fired')
        assert.strictEqual(JSON.parse(cbStatus.state_value), 'expired')
    })

    it('2. recovery mid-window: provider_error recorded, creds restored, same request fulfilled', async function () {
        const request = await submitRequest()
        const rid = request.request_id
        await regtestMinerConnector.generateBlocks(4)

        const errRow = await indexerDatabase.waitForAttestationResponse({
            requestId:      rid,
            responseStatus: 'provider_error',
            status:         'valid'
        }, 240000)
        assert(errRow, 'outage should be recorded for the second request too')

        restoreAnthropicCreds()

        const okRow = await indexerDatabase.waitForAttestationResponse({
            requestId:      rid,
            responseStatus: 'ok',
            status:         'valid'
        }, 300000)
        assert(okRow, 'request must be fulfilled once creds are restored')

        const sigs = await indexerDatabase.getAttestationValidatorSignatures(okRow.action_index)
        assert(sigs.length >= 3, 'expected 3 verified validator signatures, got ' + sigs.length)

        const fulfilled = await indexerDatabase.checkAttestationRequest({
            requestId: rid, requestStatus: 'fulfilled'
        })
        assert(fulfilled, 'request_status should flip to fulfilled')

        const cbStatus  = await callbackState(rid, 'status')
        const cbPayload = await callbackState(rid, 'payload')
        assert(cbStatus && cbPayload, 'fulfillment callback should have fired')
        assert.strictEqual(JSON.parse(cbStatus.state_value), 'ok')
        assert(/4/.test(JSON.parse(cbPayload.state_value)),
            'payload should contain "4", got: ' + cbPayload.state_value)
    })

    it('3. leader rotation: wedged slot-0 judge publishes one no_quorum, a rotated leader then fulfills', async function () {
        // Creds valid (restored in drill 2). Submit, identify slot-0, and wedge
        // ONLY its judge: fetch and proposal signing keep working, so the hub is
        // alive-but-not-leading, the exact failure rotation exists for. (A hard
        // kill is drill 5: with a dead responsible validator no v1 can quorum.)
        const request = await submitRequest()
        const rid = request.request_id
        const idx = slot0HubIndex(mvh, rid)
        const reg = mvh.hubs[idx].providerRegistry
        const realMod = reg.getModule('llm')
        assert(realMod, 'llm module should be loadable')
        reg.modules.set('llm', Object.assign({}, realMod, {
            agree: async () => { throw new Error('drill: wedged judge on slot-0 leader') }
        }))

        try {
            // Serviceable at +confirmations; elapsed stays below one rotation
            // window, so slot-0 (the wedged hub) leads the first round: its
            // agree() throws -> the round publishes status='no_quorum'.
            await regtestMinerConnector.generateBlocks(4)
            const noqRow = await indexerDatabase.waitForAttestationResponse({
                requestId:      rid,
                responseStatus: 'no_quorum',
                status:         'valid'
            }, 240000)
            assert(noqRow, 'wedged leader should yield a valid no_quorum ATTEST v1')
            assert.strictEqual(await countV1Rows(rid, 'no_quorum', false), 1,
                'no_quorum must be throttled to one publication')

            const stillPending = await indexerDatabase.checkAttestationRequest({
                requestId: rid, requestStatus: 'pending'
            })
            assert(stillPending, 'request stays pending after no_quorum (retryable)')

            // Advance chain height so escalationStep rotates the leader slot off
            // the wedged hub; the next retry round is led by a working judge.
            // Slot-0 stays wedged throughout: fulfillment proves the ROTATED
            // leader ran the judge.
            await regtestMinerConnector.generateBlocks(3)
            const okRow = await indexerDatabase.waitForAttestationResponse({
                requestId:      rid,
                responseStatus: 'ok',
                status:         'valid'
            }, 300000)
            assert(okRow, 'a rotated leader must fulfill the request while slot-0 is wedged')

            const sigs = await indexerDatabase.getAttestationValidatorSignatures(okRow.action_index)
            assert(sigs.length >= 3, 'expected 3 verified sigs (wedged hub still co-signs), got ' + sigs.length)

            const cbStatus = await callbackState(rid, 'status')
            assert(cbStatus, 'callback should fire on rotated-leader fulfillment')
            assert.strictEqual(JSON.parse(cbStatus.state_value), 'ok')
        } finally {
            reg.modules.set('llm', realMod)
        }
    })

    it('4. governance model ladder: segment 2 pins the cross-vendor model deterministically', async function () {
        // Governance change (block-anchored activation): add gpt-5-mini as the
        // fallback fetch model + judge fallback. No OpenAI key is provisioned in
        // this venue, so the drill's proof is a negative + control pair:
        // once the span midpoint passes, the request is pinned to the openai
        // vendor and must keep failing EVEN THOUGH Anthropic creds come back,
        // while a fresh control request (its own segment 1 = sonnet) fulfills.
        breakAnthropicCreds()

        const tip = Number(await nodeConnector.getBlockCount())
        const activation = tip + 2
        await applyLlmGovernance(mvh, activation, {
            approved_models:             ['claude-sonnet-4-6', 'gpt-5-mini'],
            judge_model:                 'claude-haiku-4-5',
            judge_fallback_models:       ['gpt-5-mini'],
            model_vendors:               {},
            require_all_vendors:         false,
            judge_equivalence_threshold: 0.85,
            max_completion_tokens:       1024,
            default_temperature:         0,
            prompt_envelope_version:     1
        })
        await regtestMinerConnector.generateBlocks(3)

        const request = await submitRequest()
        const rid = request.request_id
        const reqBlock = Number(request.block_index)
        assert(reqBlock >= activation, 'request must land at/after the governance activation block')

        // Segment 1 (sonnet, anthropic broken): outage recorded once.
        await regtestMinerConnector.generateBlocks(4)
        const errRow = await indexerDatabase.waitForAttestationResponse({
            requestId:      rid,
            responseStatus: 'provider_error',
            status:         'valid'
        }, 240000)
        assert(errRow, 'segment-1 outage should be recorded')

        // Restore Anthropic AND cross into segment 2. Span is
        // [reqBlock+confirmations(3), deadline]; with 2 models the pin flips at
        // the midpoint; +12 blocks elapsed is safely inside segment 2.
        restoreAnthropicCreds()
        const tip2 = Number(await nodeConnector.getBlockCount())
        const target = reqBlock + 12
        if (target > tip2) await regtestMinerConnector.generateBlocks(target - tip2)

        // Ladder proof (negative): pinned model is now gpt-5-mini -> openai
        // vendor -> no credential -> fetch keeps failing, so the request must
        // NOT be fulfilled despite working Anthropic creds. (provider_error is
        // already throttled for this rid, so no new rows land either.)
        await sleep(90000)
        assert.strictEqual(await countV1Rows(rid, 'ok', false), 0,
            'segment-2 request must NOT fulfill: fetch is pinned to the openai model')
        const stillPending = await indexerDatabase.checkAttestationRequest({
            requestId: rid, requestStatus: 'pending'
        })
        assert(stillPending, 'ladder request should still be pending on the unprovisioned vendor')

        // Ladder proof (control): a fresh request starts its own span in
        // segment 1 (sonnet) and fulfills normally under the SAME governance
        // config, so the failure above is the pin, not the config.
        const control = await submitRequest()
        await regtestMinerConnector.generateBlocks(4)
        const okRow = await indexerDatabase.waitForAttestationResponse({
            requestId:      control.request_id,
            responseStatus: 'ok',
            status:         'valid'
        }, 300000)
        assert(okRow, 'control request must fulfill under the new governance config')
        if (okRow.meta) {
            assert(/claude-sonnet-4-6/.test(String(okRow.meta)),
                'control fetch should have served from the segment-1 model; meta=' + okRow.meta)
        }

        // Leave a clean chain: run the pinned request to its expiry refund.
        await mineToPastDeadline(request)
        const expired = await indexerDatabase.waitForAttestationRequest({
            requestId: rid, requestStatus: 'expired'
        }, 90000)
        assert(expired, 'ladder request should expire once the whole ladder window lapses')
    })

    it('5. hard-kill slot-0: no v1 can quorum without every responsible sig; expiry backstop refunds', async function () {
        // Creds valid. Kill the slot-0 hub outright BEFORE the round becomes
        // serviceable. Every responsible validator must sign a valid v1
        // (indexer: validSigs >= redundancy), so nothing can land on-chain;
        // the request must ride the expiry backstop (and the dead validator
        // accrues missed_count, the economic lever).
        const request = await submitRequest()
        const rid = request.request_id
        const idx = slot0HubIndex(mvh, rid)
        await mvh._stopOne(mvh.hubs[idx])

        await regtestMinerConnector.generateBlocks(4)
        await sleep(75000)

        const validRows = await countV1Rows(rid, null, true)
        assert.strictEqual(validRows, 0,
            'no VALID v1 may land with a dead responsible validator, got ' + validRows)
        const totalRows = await countV1Rows(rid, null, false)
        if (totalRows > 0) {
            console.warn('drill 5: ' + totalRows + ' non-valid v1 row(s) landed (under-quorum broadcast); acceptable but wasteful')
        }

        const stillPending = await indexerDatabase.checkAttestationRequest({
            requestId: rid, requestStatus: 'pending'
        })
        assert(stillPending, 'request should still be pending before the deadline')

        await mineToPastDeadline(request)
        const expired = await indexerDatabase.waitForAttestationRequest({
            requestId: rid, requestStatus: 'expired'
        }, 90000)
        assert(expired, 'request should expire + refund via the backstop')

        const cbStatus = await callbackState(rid, 'status')
        assert(cbStatus, 'expiry callback should have fired')
        assert.strictEqual(JSON.parse(cbStatus.state_value), 'expired')
    })
})
