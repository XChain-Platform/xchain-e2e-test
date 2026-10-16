// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// Live three-hub regtest coverage for LLM attestation outage resilience:
// provider-error throttling and expiry, mid-window credential recovery,
// leader rotation after a judge wedges, governance-controlled cross-vendor
// model fallback, and expiry when one responsible validator is hard-stopped.
// The venue must begin with a clean validator set and a usable Claude config.
// All hubs run in this process, so the credential helpers can switch the whole
// federation between outage and recovery states at call time.

const dotenv = require('dotenv')
dotenv.config()

const assert = require('assert')

const cryptoHelper = require('../helpers/core/cryptoHelper')
const stakeHelper = require('../helpers/stakeHelper')
const gasHelper = require('../helpers/gasHelper')
const vmHelper = require('../helpers/vmHelper')
const transactionHelper = require('../helpers/core/transactionHelper')
const { MultiValidatorHub } = require('../helpers/multiValidatorHubHelper')
const { requireFederationEnv, assertCleanValidatorSet } = require('../helpers/federationGuards')
const { assertHoldsThroughout } = require('../helpers/consensusWait')
const {
    ENVELOPE, CONTRACT_CODE,
    internalSettleStack, breakAnthropicCreds, restoreAnthropicCreds,
    countV1Rows, slot0HubIndex, applyLlmGovernance
} = require('./multi_hub_llm_outage.test/support.test')

let mvh = null
let contractIndex = null
let owner = null

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

async function stakeOutageValidators(pubkeys) {
    for (let index = 0; index < pubkeys.length; index++) {
        const address = await cryptoHelper.getNewFundedAddress(
            'outage-staker-' + index, COIN, NETWORK, null, 'legacy', 0, 0.02)
        await internalSettleStack()
        await gasHelper.ensureGasBalance(address, '35000')
        await internalSettleStack()
        const result = await stakeHelper.sendStakeV1(address, '30000.00000000', pubkeys[index])
        assert.strictEqual(result.stake.status, 'valid', 'stake ' + index + ' should be valid')
    }
    await regtestMinerConnector.generateBlocks(stakeHelper.ATTESTATION_STAKE_VISIBLE_BLOCKS)
    await internalSettleStack()
}

async function deployOutageContract() {
    owner = await cryptoHelper.getNewFundedAddress(
        'outage-owner', COIN, NETWORK, null, 'legacy', 0, 0.02)
    await regtestMinerConnector.generateBlocks(2)
    await internalSettleStack()
    await gasHelper.ensureGasBalance(owner, '20000')
    const deploy = await vmHelper.sendDeployV0(owner, CONTRACT_CODE, 500000)
    assert.strictEqual(deploy.contract.status, 'valid', 'deploy should be valid')
    contractIndex = deploy.contract.action_index
}

async function startOutageFederation(mochaContext) {
        if (!requireFederationEnv(mochaContext, { needsClaudeConfig: true })) return
        await assertCleanValidatorSet(indexerDatabase)

        breakAnthropicCreds()

        mvh = new MultiValidatorHub({
            count: 3,
            extraP2pConfig: {
                ATTESTATION_POLL_MS:          5000,
                ATTESTATION_ROUND_TIMEOUT_MS: 60000
            }
        })
        await mvh.start()
        await stakeOutageValidators(mvh.getPubkeys())
        await deployOutageContract()

        const publisherAddr = await cryptoHelper.getNewFundedAddress(
            'outage-publisher', COIN, NETWORK, null, 'legacy', 0, 0.02
        )
        await regtestMinerConnector.generateBlocks(2)
        await internalSettleStack()
        mvh.setBroadcastHook(async (wirePayload) => {
            const txHash = await transactionHelper.createAndSendTransaction(publisherAddr, wirePayload)
            return { txid: txHash }
        })
}

async function stopOutageFederation() {
        restoreAnthropicCreds()
        if (mvh) {
            await mvh.stop()
            await mvh.dropDatabases()
        }
}

async function proveVendorOutage() {
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
        // Same 75s window, polled, so a second row fails the drill the moment it lands.
        await assertHoldsThroughout(async () => {
            const rows = await countV1Rows(rid, 'provider_error', false)
            return { ok: rows <= 1, saw: { providerErrorRows: rows } }
        }, { windowMs: 75000, intervalMs: 1000, what: 'at most one provider_error row' })
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
}

async function proveRecovery() {
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
}

async function proveLeaderRotation() {
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
}

async function activateModelLadder() {
    const activation = Number(await nodeConnector.getBlockCount()) + 2
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
    return activation
}

async function provePinnedFailure(request) {
    const rid = request.request_id
    restoreAnthropicCreds()
    const target = Number(request.block_index) + 12
    const tip = Number(await nodeConnector.getBlockCount())
    if (target > tip) await regtestMinerConnector.generateBlocks(target - tip)
    await assertHoldsThroughout(async () => {
        const okRows = await countV1Rows(rid, 'ok', false)
        const pending = await indexerDatabase.checkAttestationRequest({ requestId: rid, requestStatus: 'pending' })
        return { ok: okRows === 0 && !!pending, saw: { okRows, pending: !!pending } }
    }, { windowMs: 90000, intervalMs: 1000, what: 'the pinned request staying unfulfilled and pending' })
    assert.strictEqual(await countV1Rows(rid, 'ok', false), 0,
        'segment-2 request must NOT fulfill: fetch is pinned to the openai model')
    assert(await indexerDatabase.checkAttestationRequest({ requestId: rid, requestStatus: 'pending' }),
        'ladder request should still be pending on the unprovisioned vendor')
}

async function proveModelLadderControl() {
    const control = await submitRequest()
    await regtestMinerConnector.generateBlocks(4)
    const okRow = await indexerDatabase.waitForAttestationResponse({
        requestId: control.request_id, responseStatus: 'ok', status: 'valid'
    }, 300000)
    assert(okRow, 'control request must fulfill under the new governance config')
    if (okRow.meta) assert(/claude-sonnet-4-6/.test(String(okRow.meta)),
        'control fetch should have served from the segment-1 model; meta=' + okRow.meta)
}

async function proveGovernanceModelLadder() {
        breakAnthropicCreds()
        const activation = await activateModelLadder()
        const request = await submitRequest()
        assert(Number(request.block_index) >= activation,
            'request must land at/after the governance activation block')
        await regtestMinerConnector.generateBlocks(4)
        const errRow = await indexerDatabase.waitForAttestationResponse({
            requestId: request.request_id, responseStatus: 'provider_error', status: 'valid'
        }, 240000)
        assert(errRow, 'segment-1 outage should be recorded')
        await provePinnedFailure(request)
        await proveModelLadderControl()
        await mineToPastDeadline(request)
        const expired = await indexerDatabase.waitForAttestationRequest({
            requestId: request.request_id, requestStatus: 'expired'
        }, 90000)
        assert(expired, 'ladder request should expire once the whole ladder window lapses')
}

async function proveHardKill() {
        // Creds valid. Kill the slot-0 hub outright BEFORE the round becomes
        // serviceable. Every responsible validator must sign a valid v1
        // (indexer: validSigs >= redundancy), so nothing can land on-chain;
        // the request must ride the expiry backstop (and the dead validator
        // accrues missed_count, the economic lever).
        const request = await submitRequest()
        const rid = request.request_id
        const idx = slot0HubIndex(mvh, rid)
        await mvh['_stopOne'](mvh.hubs[idx])

        await regtestMinerConnector.generateBlocks(4)
        // Same 75s window, polled, so a valid row fails the drill the moment it lands.
        await assertHoldsThroughout(async () => {
            const rows = await countV1Rows(rid, null, true)
            return { ok: rows === 0, saw: { validRows: rows } }
        }, { windowMs: 75000, intervalMs: 1000, what: 'no valid v1 row with slot-0 dead' })

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
}

function registerOutageSuite() {
    this.timeout(45 * 60 * 1000)
    before(function () { return startOutageFederation(this) })
    after(stopOutageFederation)
    it('1. vendor outage: exactly one on-chain provider_error, request stays pending, expiry refunds via callback',
        proveVendorOutage)
    it('2. recovery mid-window: provider_error recorded, creds restored, same request fulfilled', proveRecovery)
    it('3. leader rotation: wedged slot-0 judge publishes one no_quorum, a rotated leader then fulfills',
        proveLeaderRotation)
    it('4. governance model ladder: segment 2 pins the cross-vendor model deterministically',
        proveGovernanceModelLadder)
    it('5. hard-kill slot-0: no v1 can quorum without every responsible sig; expiry backstop refunds',
        proveHardKill)
}

describe('Phase 4 drill: LLM attestation outage resilience (redundancy=3)', registerOutageSuite)
