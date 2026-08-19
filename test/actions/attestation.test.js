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
const cryptoHelper = require('../cryptoHelper')
const stakeHelper = require('../helpers/stakeHelper')
const gasHelper = require('../helpers/gasHelper')
const vmHelper = require('../helpers/vmHelper')
const attestationHelper = require('../helpers/attestationHelper')

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

describe('Attestation framework: round-trip request → response → callback', function () {

    let operatorAddr  = null
    let validator     = null
    let contractIndex = null

    // Full set of attestation validators staked on this chain, in stake order. The
    // indexer's responsible-set computation runs over EVERY staked attestation key at
    // the request's block, so the test must mirror that whole set to predict which keys
    // are responsible for a given request_id (see computeResponsibleSigners).
    const stakedValidators = []

    // Stake a validator from its OWN distinct funded source. SWQ source-dedup (active on
    // regtest at block 0) collapses every key sharing a staking source into ONE slot in a
    // request's responsible set, so staking all validators from one operator address would
    // leave only a single survivor (the redundancy=3 cap-at-1/3 bug). A distinct source per
    // validator keeps them all eligible. Does NOT advance blocks; the caller mines past the
    // activation delay once after staking a batch.
    async function stakeValidatorFromOwnSource(v) {
        // Distinct HD address index per validator (0,1,2,…). cryptoHelper caches ONE
        // wallet/mnemonic per label, so reusing label 'attest-val' at addressIndex 0 every
        // time would derive the SAME address → same staking source → SWQ dedup collapses
        // them back to one slot (the exact bug this fix targets). Indexing by the current
        // count gives each validator a genuinely distinct source address.
        let stakeSource = await cryptoHelper.getNewFundedAddress(
            'attest-val', COIN, NETWORK, null, 'legacy', stakedValidators.length, 0.02
        )
        // Enough XCHAIN to stake 15000 + cover the STAKE protocol fee. 15000 clears BOTH
        // the attestation capability min_stake (1000) and the http_get PROVIDER floor
        // (10000), which the responsible-set derivation enforces at/above
        // STAKE_WEIGHTED_QUORUM (armed at genesis on regtest).
        await gasHelper.ensureGasBalance(stakeSource, '20000')
        await stakeHelper.sendStakeV1(stakeSource, '15000.00000000', v.pubkey)
        v.source = stakeSource.address
        stakedValidators.push(v)
        return v
    }

    const CONTRACT_CODE = `
module.exports = {
    askOracle: function(xchain) {
        var url = xchain.getInputParam(0);
        var requestId = xchain.attestation.request(
            'http_get',
            url,
            'handleResponse',
            ['ctx-42'],
            { redundancy: 1, deadlineBlocks: 10 }
        );
        xchain.state.set('pending_request_id', requestId);
        return requestId;
    },
    handleResponse: function(xchain) {
        xchain.state.set('callback_request_id', xchain.getInputParam(0));
        xchain.state.set('callback_provider_id', xchain.getInputParam(1));
        xchain.state.set('callback_status', xchain.getInputParam(2));
        xchain.state.set('callback_payload', xchain.getInputParam(3));
        xchain.state.set('callback_context', xchain.getInputParam(4));
    },
    askOracleExpiring: function(xchain) {
        var url = xchain.getInputParam(0);
        var requestId = xchain.attestation.request(
            'http_get',
            url,
            'handleExpiry',
            ['ctx-expiry'],
            { redundancy: 1, deadlineBlocks: 2 }
        );
        xchain.state.set('expiring_request_id', requestId);
        return requestId;
    },
    askOracleQuorum: function(xchain) {
        var url = xchain.getInputParam(0);
        var requestId = xchain.attestation.request(
            'http_get',
            url,
            'handleResponse',
            ['ctx-quorum'],
            { redundancy: 3, deadlineBlocks: 20 }
        );
        xchain.state.set('quorum_request_id', requestId);
        return requestId;
    },
    handleExpiry: function(xchain) {
        xchain.state.set('expiry_request_id', xchain.getInputParam(0));
        xchain.state.set('expiry_provider_id', xchain.getInputParam(1));
        xchain.state.set('expiry_status', xchain.getInputParam(2));
        xchain.state.set('expiry_payload', xchain.getInputParam(3));
        xchain.state.set('expiry_context', xchain.getInputParam(4));
    }
};
`

    before(async function () {
        // Attestation framework rides on STAKE + EXECUTE (both BTC-only protocol features).
        if (COIN_CODE !== 'BTC') {
            console.log('Attestation framework requires BTC chain; skipping on ' + COIN_CODE)
            this.skip()
            return
        }

        // Fund an operator address that'll own the contract AND broadcast the response actions.
        // (Validators are staked from their OWN distinct sources; see stakeValidatorFromOwnSource.)
        operatorAddr = await cryptoHelper.getNewFundedAddress(
            'attest-op', COIN, NETWORK, null, 'legacy', 0, 0.02
        )
        // Enough XCHAIN for: DEPLOY gas + many EXECUTE gas + response-broadcast fees
        await gasHelper.ensureGasBalance(operatorAddr, '5000')

        // Spin up an in-process validator (real keypair) and stake its pubkey from its own
        // funded source so the indexer's hasCapability('attestation', ...) check passes and
        // it survives SWQ source-dedup into request responsible sets.
        validator = new attestationHelper.MockAttestationValidator()
        await stakeValidatorFromOwnSource(validator)
        // Advance past activation delay so the stake is observable
        await regtestMinerConnector.generateBlocks(7)
        // The encoder refuses UTXO selection while the tracker trails the node, so the
        // next tx build races these blocks unless the tracker is caught up first.
        await utxoTrackerConnector.waitForSync()

        // Deploy the test contract
        let deploy = await vmHelper.sendDeployV0(operatorAddr, CONTRACT_CODE, 500000)
        assert(deploy.contract, 'contract should deploy')
        assert.strictEqual(deploy.contract.status, 'valid', 'deploy status: ' + deploy.contract.status)
        contractIndex = deploy.contract.action_index
    })

    it('emits ATTEST v0 (request) on EXECUTE and stores it pending', async function () {
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
        this.test.parent.ctx.requestId = request.request_id
    })

    it('accepts a signed ATTEST v1 (response), fulfills the request, and fires the callback', async function () {
        // Pick up requestId from the prior test
        let requestId = this.test.parent.ctx.requestId
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

    it('auto-expires a request whose DEADLINE_BLOCK passes without a response, firing the callback with status=expired', async function () {
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

    it('rejects a signature from an unstaked pubkey', async function () {
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

    it('accepts a redundancy=3 response with 3 valid signatures (PBFT quorum)', async function () {
        // Stake two additional validators (each from its OWN distinct source; see
        // stakeValidatorFromOwnSource) so the snapshot has 3 source-distinct validators at the
        // request block. With 3 validators and REDUNDANCY=3 the responsible set is all 3, so a
        // 3-signature response can reach quorum. (Staking both from the operator address would
        // collapse them under SWQ source-dedup and cap valid sigs at 1/3.)
        let v2 = new attestationHelper.MockAttestationValidator()
        let v3 = new attestationHelper.MockAttestationValidator()
        await stakeValidatorFromOwnSource(v2)
        await stakeValidatorFromOwnSource(v3)
        // Advance past activation delay
        await regtestMinerConnector.generateBlocks(7)
        await utxoTrackerConnector.waitForSync()

        // Fire a request with redundancy=3
        let exec = await vmHelper.sendExecuteV0(operatorAddr, contractIndex, 'askOracleQuorum', ['https://example.com/v1/quorum/abc'])
        assert.strictEqual(exec.execution.status, 'valid', 'execute status: ' + exec.execution.status)

        let request = await indexerDatabase.waitForAttestationRequest({
            txHash:        exec.txHash,
            requestStatus: 'pending'
        })
        assert(request, 'quorum-request row should exist with status=pending')
        assert.strictEqual(Number(request.redundancy), 3)

        // Broadcast a response signed by all 3 validators
        const responsePayload = '{"quorum":3,"ok":true}'
        await attestationHelper.broadcastAttestationResponse(operatorAddr, {
            requestId:       request.request_id,
            providerId:      'http_get',
            responsePayload: responsePayload,
            status:          'ok',
            meta:            '200',
            validators:      [validator, v2, v3]
        })

        // Response should land as valid with all 3 sigs recorded
        let response = await indexerDatabase.waitForAttestationResponse({
            requestId:      request.request_id,
            responseStatus: 'ok',
            status:         'valid'
        })
        assert(response, 'attestation_responses row should exist with response_status=ok and status=valid (3-sig path)')

        let sigs = await indexerDatabase.getAttestationValidatorSignatures(response.action_index)
        assert.strictEqual(sigs.length, 3, 'should have exactly 3 verified signatures')

        // Request flipped to fulfilled
        let updatedRequest = await indexerDatabase.checkAttestationRequest({
            requestId:     request.request_id,
            requestStatus: 'fulfilled'
        })
        assert(updatedRequest, 'request_status should flip to fulfilled')

        // Callback fired (writes to the shared callback_* state keys)
        let cbStatus  = await indexerDatabase.getContractState(contractIndex, 'callback_status')
        let cbContext = await indexerDatabase.getContractState(contractIndex, 'callback_context')
        assert(cbStatus,  'callback_status state row should exist')
        assert.strictEqual(JSON.parse(cbStatus.state_value),  'ok')
        assert.strictEqual(JSON.parse(cbContext.state_value), 'ctx-quorum')

        // Stash the extra validators for the next test
        this.test.parent.ctx.extraValidators = [v2, v3]
    })

    it('rejects a redundancy=3 response with only 2 valid signatures', async function () {
        let extras = this.test.parent.ctx.extraValidators
        // Skip if the prior test didn't run (e.g. user used --grep)
        if (!extras || extras.length < 1) {
            console.log('Skipping insufficient-sigs test: prior 3-stake setup missing')
            this.skip()
            return
        }

        let exec = await vmHelper.sendExecuteV0(operatorAddr, contractIndex, 'askOracleQuorum', ['https://example.com/v1/quorum/def'])
        assert.strictEqual(exec.execution.status, 'valid')
        let request = await indexerDatabase.waitForAttestationRequest({
            txHash:        exec.txHash,
            requestStatus: 'pending'
        })
        assert(request, 'insufficient-sigs request should exist as pending')

        // Sign with only 2 of the 3 staked validators
        await attestationHelper.broadcastAttestationResponse(operatorAddr, {
            requestId:       request.request_id,
            providerId:      'http_get',
            responsePayload: '{"quorum":3,"ok":true}',
            status:          'ok',
            meta:            '200',
            validators:      [validator, extras[0]]
        })

        // Either no row (broadcast failed at validation) or row exists with non-valid status
        let resp = await indexerDatabase.waitForAttestationResponse({
            requestId: request.request_id
        }, 10000)
        if (resp) {
            assert.notStrictEqual(resp.status, 'valid',
                '2-of-3 sig response should NOT be marked valid; got status=' + resp.status)
        }

        // Request remains pending
        let stillPending = await indexerDatabase.checkAttestationRequest({
            requestId:     request.request_id,
            requestStatus: 'pending'
        })
        assert(stillPending, 'request should remain pending after under-quorum response')
    })

    // Non-`ok` response statuses (retryable).
    //
    // ATTEST v1 carries one of ['ok','timeout','no_quorum','provider_error',
    // 'expired']. The three RETRYABLE statuses (timeout / no_quorum /
    // provider_error) are NOT terminal: even a fully valid-signature response
    // carrying one of them must leave the originating request `pending` (another
    // federation round may still reach `ok` before the deadline) and must NOT
    // inject a callback EXECUTE. Only `ok` (fulfilled) closes the request and
    // fires the callback. These tests exercise the RETRYABLE_STATUSES branch of
    // _parseResponse across the full hub-to-indexer wire, guarding the
    // no-callback / no-status-flip invariant against regression.
    const RETRYABLE_STATUSES = ['no_quorum', 'timeout', 'provider_error']

    RETRYABLE_STATUSES.forEach(function (retryStatus) {
        it('leaves the request pending and injects no callback for a valid response with status=' + retryStatus, async function () {
            // Fresh pending request (redundancy=1; a single staked validator sig suffices)
            let exec = await vmHelper.sendExecuteV0(operatorAddr, contractIndex, 'askOracle', ['https://example.com/v1/retry/' + retryStatus])
            assert.strictEqual(exec.execution.status, 'valid', 'execute status: ' + exec.execution.status)
            let request = await indexerDatabase.waitForAttestationRequest({ txHash: exec.txHash, requestStatus: 'pending' })
            assert(request, 'pending request should exist for status=' + retryStatus)
            let requestId = request.request_id

            // Sign with the request's deterministic responsible validator (top-1 by
            // SHA256(request_id||pubkey) over the full staked set, source-deduped). Once
            // 3 validators are staked (the redundancy=3 test above), a hard-coded
            // `validator` is often NOT the responsible signer for a given request_id, so
            // its sig is filtered out → 0/1. Picking the responsible key makes the sig
            // count (1) meet redundancy (1).
            let signers = attestationHelper.computeResponsibleSigners(requestId, 1, stakedValidators)

            // Broadcast a properly-signed response carrying the retryable status. The
            // responsible validator's signature is valid (validSigs=1 >= redundancy=1), so
            // the response row itself lands status='valid': this is exactly the
            // RETRYABLE_STATUSES case: a valid response that must still leave the
            // request open (distinct from an invalid-sig response, covered above).
            await attestationHelper.broadcastAttestationResponse(operatorAddr, {
                requestId:       requestId,
                providerId:      'http_get',
                responsePayload: '',
                status:          retryStatus,
                meta:            '',
                validators:      signers
            })

            // Response row lands valid with response_status = the retryable value
            let response = await indexerDatabase.waitForAttestationResponse({
                requestId:      requestId,
                responseStatus: retryStatus,
                status:         'valid'
            })
            assert(response, 'response row should exist with response_status=' + retryStatus + ' and status=valid')

            // Invariant 1: the request must NOT flip: it stays pending for a retry
            let stillPending = await indexerDatabase.checkAttestationRequest({
                requestId:     requestId,
                requestStatus: 'pending'
            })
            assert(stillPending, 'request must remain pending after a retryable status=' + retryStatus + ' response')

            // Invariant 2: no callback EXECUTE was injected (no terminal resolution)
            assert(!response.callback_execute_action_index,
                'no callback should be injected for retryable status=' + retryStatus +
                '; got callback_execute_action_index=' + response.callback_execute_action_index)
        })
    })

    it('fulfills the request with a callback when an ok response follows an earlier retryable (no_quorum) response', async function () {
        // Fresh pending request (deadlineBlocks=10 leaves comfortable room for two rounds)
        let exec = await vmHelper.sendExecuteV0(operatorAddr, contractIndex, 'askOracle', ['https://example.com/v1/retry-then-ok/abc'])
        assert.strictEqual(exec.execution.status, 'valid', 'execute status: ' + exec.execution.status)
        let request = await indexerDatabase.waitForAttestationRequest({ txHash: exec.txHash, requestStatus: 'pending' })
        assert(request, 'pending request should exist')
        let requestId = request.request_id

        // Both rounds must be signed by the request's responsible validator (top-1 over the
        // full staked set, source-deduped): the same key the indexer will accept for this
        // request_id. The two rounds target the SAME request_id, so they share one signer.
        let signers = attestationHelper.computeResponsibleSigners(requestId, 1, stakedValidators)

        // Round 1: a valid no_quorum response leaves the request pending
        await attestationHelper.broadcastAttestationResponse(operatorAddr, {
            requestId:       requestId,
            providerId:      'http_get',
            responsePayload: '',
            status:          'no_quorum',
            meta:            '',
            validators:      signers
        })
        let firstResp = await indexerDatabase.waitForAttestationResponse({
            requestId:      requestId,
            responseStatus: 'no_quorum',
            status:         'valid'
        })
        assert(firstResp, 'no_quorum response row should land valid')
        assert(!firstResp.callback_execute_action_index, 'no_quorum round must not inject a callback')
        let stillPending = await indexerDatabase.checkAttestationRequest({ requestId: requestId, requestStatus: 'pending' })
        assert(stillPending, 'request should remain pending after the no_quorum round')

        // Round 2: a subsequent ok response on the SAME request fulfills it and fires the callback
        const okPayload = '{"score":9}'
        await attestationHelper.broadcastAttestationResponse(operatorAddr, {
            requestId:       requestId,
            providerId:      'http_get',
            responsePayload: okPayload,
            status:          'ok',
            meta:            '200',
            validators:      signers
        })
        let okResp = await indexerDatabase.waitForAttestationResponse({
            requestId:      requestId,
            responseStatus: 'ok',
            status:         'valid'
        })
        assert(okResp, 'ok response row should land valid after the earlier no_quorum round')

        // Request is now terminal: fulfilled
        let fulfilled = await indexerDatabase.checkAttestationRequest({ requestId: requestId, requestStatus: 'fulfilled' })
        assert(fulfilled, 'request should flip to fulfilled once a valid ok response arrives')

        // Callback EXECUTE injected on the ok response row
        assert(okResp.callback_execute_action_index,
            'ok response after a retryable round should inject the callback EXECUTE')
    })
})
