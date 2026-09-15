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
const stakeHelper = require('../../helpers/stakeHelper')
const vmHelper = require('../../helpers/vmHelper')
const attestationHelper = require('../../helpers/attestationHelper')
const { skipIfResponseMirrorEra } = require('../../helpers/attestLegacyResponsePath')
const { state, prepareAttestation, stakeValidatorFromOwnSource } = require('./support/shared')

const TITLE = 'Attestation framework: round-trip request → response → callback'

async function prepareRedundancyValidators() {
    // Stake two additional validators (each from its OWN distinct source; see
    // stakeValidatorFromOwnSource) so the snapshot has 3 source-distinct validators at the
    // request block. With 3 validators and REDUNDANCY=3 the responsible set is all 3, so a
    // 3-signature response can reach quorum. (Staking both from the operator address would
    // collapse them under SWQ source-dedup and cap valid sigs at 1/3.)
    let v2 = new attestationHelper.MockAttestationValidator()
    let v3 = new attestationHelper.MockAttestationValidator()
    await stakeValidatorFromOwnSource(v2)
    await stakeValidatorFromOwnSource(v3)
    // Advance past activation delay AND the snapshot burial. This request asks for
    // redundancy=3, so ALL THREE stakes must be selectable at its block; mining only
    // the activation delay left the two just staked here invisible and the set at 2.
    await regtestMinerConnector.generateBlocks(stakeHelper.ATTESTATION_STAKE_VISIBLE_BLOCKS)
    await utxoTrackerConnector.waitForSync()
    return [v2, v3]
}

describe(TITLE, function () {
    before(async function () { await prepareAttestation(this) })

    it('accepts a redundancy=3 response with 3 valid signatures (PBFT quorum)', async function () {
        if (skipIfResponseMirrorEra(this, NETWORK)) return
        const { operatorAddr, validator, contractIndex } = state
        const [v2, v3] = await prepareRedundancyValidators()

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
        state.extraValidators = [v2, v3]
    })
})

describe(TITLE, function () {
    before(async function () { await prepareAttestation(this) })

    it('rejects a redundancy=3 response with only 2 valid signatures', async function () {
        const { operatorAddr, validator, contractIndex, extraValidators: extras } = state
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
// parseResponse across the full hub-to-indexer wire, guarding the
// no-callback / no-status-flip invariant against regression.
const RETRYABLE_STATUSES = ['no_quorum', 'timeout', 'provider_error']

RETRYABLE_STATUSES.forEach(function (retryStatus) {
    describe(TITLE, function () {
        before(async function () { await prepareAttestation(this) })

        it('leaves the request pending and injects no callback for a valid response with status=' + retryStatus, async function () {
            if (skipIfResponseMirrorEra(this, NETWORK)) return
            const { operatorAddr, contractIndex } = state
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
            let signers = attestationHelper.computeResponsibleSigners(requestId, 1, attestationHelper.getSessionStakedValidators())

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
})

describe(TITLE, function () {
    before(async function () { await prepareAttestation(this) })
    it('fulfills the request with a callback when an ok response follows an earlier retryable (no_quorum) response', async function () {
        if (skipIfResponseMirrorEra(this, NETWORK)) return
        const { operatorAddr, contractIndex } = state
        // Fresh pending request (deadlineBlocks=10 leaves comfortable room for two rounds)
        let exec = await vmHelper.sendExecuteV0(operatorAddr, contractIndex, 'askOracle', ['https://example.com/v1/retry-then-ok/abc'])
        assert.strictEqual(exec.execution.status, 'valid', 'execute status: ' + exec.execution.status)
        let request = await indexerDatabase.waitForAttestationRequest({ txHash: exec.txHash, requestStatus: 'pending' })
        assert(request, 'pending request should exist')
        let requestId = request.request_id

        // Both rounds must be signed by the request's responsible validator (top-1 over the
        // full staked set, source-deduped): the same key the indexer will accept for this
        // request_id. The two rounds target the SAME request_id, so they share one signer.
        let signers = attestationHelper.computeResponsibleSigners(requestId, 1, attestationHelper.getSessionStakedValidators())

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
