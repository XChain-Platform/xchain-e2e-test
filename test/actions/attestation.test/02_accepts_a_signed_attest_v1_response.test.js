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
const attestationHelper = require('../../helpers/attestationHelper')
const { skipIfResponseMirrorEra } = require('../../helpers/attestLegacyResponsePath')
const { state, prepareAttestation } = require('./support/shared')

const TITLE = 'Attestation framework: round-trip request → response → callback'

describe(TITLE, function () {
    before(async function () { await prepareAttestation(this) })

    it('accepts a signed ATTEST v1 (response), fulfills the request, and fires the callback', async function () {
        if (skipIfResponseMirrorEra(this, NETWORK)) return
        const { operatorAddr, validator, contractIndex } = state
        // Pick up requestId from the prior test
        let requestId = state.requestId
        if (!requestId) {
            // Fallback: look up the pending request
            const pending = await indexerDatabase.checkAttestationRequest({ requestStatus: 'pending' })
            assert(pending, 'a pending request should exist')
            requestId = pending.request_id
        }

        const responsePayload = '{"score":7}'
        const responseTxHash = await attestationHelper.broadcastAttestationResponse(operatorAddr, {
            requestId:       requestId,
            providerId:      'http_get',
            responsePayload: responsePayload,
            status:          'ok',
            meta:            '200',
            validators:      [validator]
        })

        // attestation_responses row with response_status='ok', validation status='valid'
        const response = await indexerDatabase.waitForAttestationResponse({
            requestId:      requestId,
            responseStatus: 'ok',
            status:         'valid'
        })
        assert(response, 'attestation_responses row should exist with response_status=ok and status=valid')
        assert.strictEqual(response.provider_id, 'http_get')

        // Verified signature row recorded
        const sigs = await indexerDatabase.getAttestationValidatorSignatures(response.action_index)
        assert.strictEqual(sigs.length, 1, 'should have exactly 1 verified signature')
        assert.strictEqual(String(sigs[0].validator_pubkey).toLowerCase(), validator.pubkey.toLowerCase())

        // Request status flipped to 'fulfilled'
        const updatedRequest = await indexerDatabase.checkAttestationRequest({
            requestId:     requestId,
            requestStatus: 'fulfilled'
        })
        assert(updatedRequest, 'request_status should flip to fulfilled')

        // Callback EXECUTE was injected and recorded on the response row
        assert(response.callback_execute_action_index, 'callback_execute_action_index should be set')

        // Contract state reflects the callback's writes
        const cbStatus  = await indexerDatabase.getContractState(contractIndex, 'callback_status')
        const cbPayload = await indexerDatabase.getContractState(contractIndex, 'callback_payload')
        const cbContext = await indexerDatabase.getContractState(contractIndex, 'callback_context')
        assert(cbStatus,  'callback_status state row should exist')
        assert(cbPayload, 'callback_payload state row should exist')
        assert(cbContext, 'callback_context state row should exist')
        assert.strictEqual(JSON.parse(cbStatus.state_value),  'ok')
        assert.strictEqual(JSON.parse(cbPayload.state_value), responsePayload)
        assert.strictEqual(JSON.parse(cbContext.state_value), 'ctx-42')
    })
})
