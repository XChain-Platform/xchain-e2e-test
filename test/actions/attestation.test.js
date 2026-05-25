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
 *   3. Execute askOracle() — indexer should create an attestation_requests
 *      row with status='pending'.
 *   4. Broadcast a real, signed ATTESTATION_RESPONSE — indexer verifies the
 *      signature against the real `attestation` capability check, marks the
 *      request fulfilled, and injects a system EXECUTE that runs the callback.
 *   5. Assert callback executed and wrote the expected values to contract state.
 *
 * Spec: claude/reports/specs/2026-05-24_external-attestation-framework.md
 */

describe('Attestation framework — round-trip request → response → callback', function () {

    let operatorAddr  = null
    let validator     = null
    let contractIndex = null

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
    }
};
`

    before(async function () {
        // Attestation framework rides on STAKE + EXECUTE (both BTC-only protocol features).
        if (COIN_CODE !== 'BTC') {
            console.log('Attestation framework requires BTC chain — skipping on ' + COIN_CODE)
            this.skip()
            return
        }

        // Fund an operator address that'll own the stake AND broadcast the response action
        operatorAddr = await cryptoHelper.getNewFundedAddress(
            'attest-op', COIN, NETWORK, null, 'legacy', 0, 0.02
        )
        // Enough XCHAIN for: stake (≥1000 for attestation capability) + DEPLOY gas + EXECUTE gas
        await gasHelper.ensureGasBalance(operatorAddr, '5000')

        // Spin up an in-process validator (real keypair). Stake its pubkey so the
        // indexer's hasCapability('attestation', ...) check passes during sig verify.
        validator = new attestationHelper.MockAttestationValidator()
        await stakeHelper.sendStakeV1(operatorAddr, '1500.00000000', validator.pubkey)
        // Advance past activation delay so the stake is observable
        await regtestMinerConnector.generateBlocks(7)

        // Deploy the test contract
        let deploy = await vmHelper.sendDeployV0(operatorAddr, CONTRACT_CODE, 500000)
        assert(deploy.contract, 'contract should deploy')
        assert.strictEqual(deploy.contract.status, 'valid', 'deploy status: ' + deploy.contract.status)
        contractIndex = deploy.contract.action_index
    })

    it('emits ATTESTATION_REQUEST on EXECUTE and stores it pending', async function () {
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

    it('accepts a signed ATTESTATION_RESPONSE, fulfills the request, and fires the callback', async function () {
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

    it('rejects a signature from an unstaked pubkey', async function () {
        // Fresh validator with no stake — sig verification should drop their signature
        let badValidator = new attestationHelper.MockAttestationValidator()

        // Need a fresh pending request to test against
        let exec = await vmHelper.sendExecuteV0(operatorAddr, contractIndex, 'askOracle', ['https://example.com/v1/score/456'])
        assert.strictEqual(exec.execution.status, 'valid')
        let request = await indexerDatabase.waitForAttestationRequest({ txHash: exec.txHash, requestStatus: 'pending' })
        assert(request, 'second pending request should exist')

        // Broadcast a response signed only by the unstaked validator — should land as 'invalid'
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
