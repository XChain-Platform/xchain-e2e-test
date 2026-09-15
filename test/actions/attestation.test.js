// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const assert = require('assert')
const vmHelper = require('../helpers/vmHelper')
const attestationHelper = require('../helpers/attestationHelper')
const { skipIfResponseMirrorEra } = require('../helpers/attestLegacyResponsePath')
const { state, prepareAttestation } = require('./attestation.test/support/shared')

/**
 * Round-trip test for the External Attestation Framework.
 *
 * Flow:
 *   1. Stake a real validator pubkey with enough XCHAIN to qualify for the
 *      `attestation` capability (default min_stake = 1000 XCHAIN).
 *   2. Deploy a contract that emits xchain.attestation.request(...) and
 *      defines a handleResponse callback.
 *   3. Execute askOracle(). The indexer should create an attestation_requests
 *      row with status='pending'.
 *   4. Broadcast a real, signed ATTEST v1 (response). The indexer verifies the
 *      signature against the real `attestation` capability check, marks the
 *      request fulfilled, and injects a system EXECUTE that runs the callback.
 *   5. Assert callback executed and wrote the expected values to contract state.
 */

const TITLE = 'Attestation framework: round-trip request → response → callback'

describe(TITLE, function () {
    before(async function () { await prepareAttestation(this) })

    it('emits ATTEST v0 (request) on EXECUTE and stores it pending', async function () {
        const { operatorAddr, contractIndex } = state
        let exec = await vmHelper.sendExecuteV0(operatorAddr, contractIndex, 'askOracle', ['https://example.com/v1/score/123'])
        assert(exec.execution, 'execution row should exist')
        assert.strictEqual(exec.execution.status, 'valid', 'execute status: ' + exec.execution.status)

        let request = await indexerDatabase.waitForAttestationRequest({
            txHash:        exec.txHash,
            requestStatus: 'pending'
        })
        assert(request, 'attestation_requests row should exist with status=pending')
        assert.strictEqual(request.provider_id, 'http_get')
        assert.strictEqual(request.callback_method, 'handleResponse')
        assert.strictEqual(Number(request.redundancy), 1)
        let parsedParams = JSON.parse(request.callback_params_json)
        assert.strictEqual(parsedParams[0], 'ctx-42')

        // Stash for the next test
        state.requestId = request.request_id
    })
})

describe(TITLE, function () {
    before(async function () { await prepareAttestation(this) })
    it('accepts a signed ATTEST v1 (response), fulfills the request, and fires the callback', async function () {
        if (skipIfResponseMirrorEra(this, NETWORK)) return
        const { operatorAddr, validator, contractIndex } = state
        // Pick up requestId from the prior test
        let requestId = state.requestId
        if (!requestId) {
            // Fallback: look up the pending request
            let pending = await indexerDatabase.checkAttestationRequest({ requestStatus: 'pending' })
            assert(pending, 'a pending request should exist')
            requestId = pending.request_id
        }

        const responsePayload = '{"score":7}'
        let responseTxHash = await attestationHelper.broadcastAttestationResponse(operatorAddr, {
            requestId:       requestId,
            providerId:      'http_get',
            responsePayload: responsePayload,
            status:          'ok',
            meta:            '200',
            validators:      [validator]
        })

        // attestation_responses row with response_status='ok', validation status='valid'
        let response = await indexerDatabase.waitForAttestationResponse({
            requestId:      requestId,
            responseStatus: 'ok',
            status:         'valid'
        })
        assert(response, 'attestation_responses row should exist with response_status=ok and status=valid')
        assert.strictEqual(response.provider_id, 'http_get')

        // Verified signature row recorded
        let sigs = await indexerDatabase.getAttestationValidatorSignatures(response.action_index)
        assert.strictEqual(sigs.length, 1, 'should have exactly 1 verified signature')
        assert.strictEqual(String(sigs[0].validator_pubkey).toLowerCase(), validator.pubkey.toLowerCase())

        // Request status flipped to 'fulfilled'
        let updatedRequest = await indexerDatabase.checkAttestationRequest({
            requestId:     requestId,
            requestStatus: 'fulfilled'
        })
        assert(updatedRequest, 'request_status should flip to fulfilled')

        // Callback EXECUTE was injected and recorded on the response row
        assert(response.callback_execute_action_index, 'callback_execute_action_index should be set')

        // Contract state reflects the callback's writes
        let cbStatus  = await indexerDatabase.getContractState(contractIndex, 'callback_status')
        let cbPayload = await indexerDatabase.getContractState(contractIndex, 'callback_payload')
        let cbContext = await indexerDatabase.getContractState(contractIndex, 'callback_context')
        assert(cbStatus,  'callback_status state row should exist')
        assert(cbPayload, 'callback_payload state row should exist')
        assert(cbContext, 'callback_context state row should exist')
        assert.strictEqual(JSON.parse(cbStatus.state_value),  'ok')
        assert.strictEqual(JSON.parse(cbPayload.state_value), responsePayload)
        assert.strictEqual(JSON.parse(cbContext.state_value), 'ctx-42')
    })
})

describe(TITLE, function () {
    before(async function () { await prepareAttestation(this) })

    it('auto-expires a request whose DEADLINE_BLOCK passes without a response, firing the callback with status=expired', async function () {
        const { operatorAddr, contractIndex } = state
        // Fire a fresh request with a short deadline (deadlineBlocks=2)
        let exec = await vmHelper.sendExecuteV0(operatorAddr, contractIndex, 'askOracleExpiring', ['https://example.com/v1/expiring/789'])
        assert.strictEqual(exec.execution.status, 'valid', 'execute status: ' + exec.execution.status)

        let request = await indexerDatabase.waitForAttestationRequest({
            txHash:        exec.txHash,
            requestStatus: 'pending'
        })
        assert(request, 'expiring-request row should exist with status=pending')
        let expiringRequestId = request.request_id

        // Advance past DEADLINE_BLOCK. deadlineBlocks=2 + comfortable margin so the
        // per-block expiry pipeline definitely runs at deadline+1.
        await regtestMinerConnector.generateBlocks(5)
        await utxoTrackerConnector.waitForSync()

        // Request status should flip to 'expired'
        let expired = await indexerDatabase.waitForAttestationRequest({
            requestId:     expiringRequestId,
            requestStatus: 'expired'
        }, 30000)
        assert(expired, 'request should auto-expire past its DEADLINE_BLOCK')

        // Callback should have fired with status='expired' (per spec §4.3)
        let expiryStatus     = await indexerDatabase.getContractState(contractIndex, 'expiry_status')
        let expiryRequestId  = await indexerDatabase.getContractState(contractIndex, 'expiry_request_id')
        let expiryProviderId = await indexerDatabase.getContractState(contractIndex, 'expiry_provider_id')
        let expiryPayload    = await indexerDatabase.getContractState(contractIndex, 'expiry_payload')
        let expiryContext    = await indexerDatabase.getContractState(contractIndex, 'expiry_context')
        assert(expiryStatus,    'expiry_status state row should exist')
        assert(expiryRequestId, 'expiry_request_id state row should exist')
        assert.strictEqual(JSON.parse(expiryStatus.state_value),     'expired')
        assert.strictEqual(JSON.parse(expiryRequestId.state_value),  expiringRequestId)
        assert.strictEqual(JSON.parse(expiryProviderId.state_value), 'http_get')
        assert.strictEqual(JSON.parse(expiryPayload.state_value),    '')
        assert.strictEqual(JSON.parse(expiryContext.state_value),    'ctx-expiry')
    })
})

describe(TITLE, function () {
    before(async function () { await prepareAttestation(this) })

    it('rejects a signature from an unstaked pubkey', async function () {
        const { operatorAddr } = state
        // Fresh validator with no stake; sig verification should drop their signature
        let badValidator = new attestationHelper.MockAttestationValidator()

        // Need a fresh pending request to test against
        let exec = await vmHelper.sendExecuteV0(operatorAddr, contractIndex, 'askOracle', ['https://example.com/v1/score/456'])
        assert.strictEqual(exec.execution.status, 'valid')
        let request = await indexerDatabase.waitForAttestationRequest({ txHash: exec.txHash, requestStatus: 'pending' })
        assert(request, 'second pending request should exist')

        // Broadcast a response signed only by the unstaked validator; should land as 'invalid'
        await attestationHelper.broadcastAttestationResponse(operatorAddr, {
            requestId:       request.request_id,
            providerId:      'http_get',
            responsePayload: '{"score":1}',
            status:          'ok',
            meta:            '200',
            validators:      [badValidator]
        })

        // Either no row at all, or status != 'valid'. We'll poll briefly:
        let invalidResp = await indexerDatabase.waitForAttestationResponse({
            requestId: request.request_id
        }, 10000)

        if (invalidResp) {
            assert.notStrictEqual(invalidResp.status, 'valid',
                'response from unstaked validator should NOT be marked valid; got status=' + invalidResp.status)
        }
        // Request should still be pending (not flipped to fulfilled)
        let stillPending = await indexerDatabase.checkAttestationRequest({
            requestId:     request.request_id,
            requestStatus: 'pending'
        })
        assert(stillPending, 'request from invalid-sig response should remain pending')
    })
})
