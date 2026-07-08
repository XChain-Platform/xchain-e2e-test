// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md.

/**
 * REAL-URL attestation round-trip with a 3-validator quorum.
 *
 * Unlike test/actions/attestation.test.js (which hand-signs a HARDCODED body),
 * this test fetches a REAL public URL through the production http_get provider
 * (xchain-hub/src/providers/http_get.js) and signs THAT body. It is the
 * non-federation analogue of test/federation/multiHubAttestation.test.js: the
 * GET is 100% real; only the validator orchestration is in-test (3 staked
 * MockAttestationValidators sign the fetched body instead of 3 live hubs).
 *
 * Flow:
 *   1. Stake 3 attestation validators, each from its own funded source.
 *   2. Deploy a contract that emits attestation.request('http_get', url,
 *      'handleResponse', [...], { redundancy: 3 }).
 *   3. EXECUTE -> indexer writes a pending attests row (the real URL lands in
 *      the `payload` column).
 *   4. Fetch the real URL via the REAL http_get provider -> { body, meta }.
 *   5. Sign that real body with the request's responsible 3 validators and
 *      broadcast ATTEST v1. The indexer verifies 3/3, fulfills, fires callback.
 *   6. Assert the contract state holds the REAL body byte-for-byte.
 *
 * REQUIRES A CLEAN VALIDATOR SET: the indexer filters response signatures to
 * the deterministic responsible set (top-REDUNDANCY by SHA256(request_id||
 * pubkey) over ALL staked attestation validators). With pre-existing validators
 * we don't control, our 3 keys may not be selected and quorum fails. Run on a
 * freshly-reset regtest chain.
 *
 *   xchain-node reset all bitcoin regtest
 *   xchain-node e2etest bitcoin realUrlAttestation
 */

const assert = require('assert')
const _path = require('path')
const _fs = require('fs')

const cryptoHelper = require('../cryptoHelper')
const stakeHelper = require('../helpers/stakeHelper')
const gasHelper = require('../helpers/gasHelper')
const vmHelper = require('../helpers/vmHelper')
const attestationHelper = require('../helpers/attestationHelper')

// Resolve the REAL http_get provider from the bundled (in-image) xchain-hub,
// falling back to the monorepo sibling for local dev. Mirrors the loader in
// test/federation/multiHubAttestation.test.js.
const _hubBase = (function () {
    const candidates = [
        process.env.XCHAIN_HUB_PATH,
        _path.resolve(__dirname, '../../xchain-hub'),
        _path.resolve(__dirname, '../../../xchain-hub')
    ].filter(Boolean)
    for (const c of candidates) {
        if (_fs.existsSync(_path.join(c, 'src/providers/http_get.js'))) return c
    }
    return candidates[candidates.length - 1]
})()
const http_get = require(_hubBase + '/src/providers/http_get.js')

// Deterministic public endpoint: a fixed jsonplaceholder resource returns the
// same body byte-for-byte for the same path, so byte_equality consensus is
// satisfiable. (No time/price/counter fields.)
const REAL_URL = 'https://jsonplaceholder.typicode.com/todos/1'

const CONTRACT_CODE = `
module.exports = {
    askOracleQuorum: function(xchain) {
        var url = xchain.getInputParam(0);
        var requestId = xchain.attestation.request(
            'http_get',
            url,
            'handleResponse',
            ['ctx-realurl'],
            { redundancy: 3, deadlineBlocks: 20 }
        );
        xchain.state.set('quorum_request_id', requestId);
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

describe('REAL-URL attestation: 3-validator quorum over a live https GET', function () {
    this.timeout(10 * 60 * 1000)

    let operatorAddr  = null
    let contractIndex = null
    const stakedValidators = []   // full set, mirrors the indexer's responsible-set input

    // Stake a validator from its OWN distinct funded source (SWQ source-dedup
    // collapses same-source keys into one responsible-set slot).
    async function stakeValidatorFromOwnSource(v) {
        let stakeSource = await cryptoHelper.getNewFundedAddress(
            'realurl-val', COIN, NETWORK, null, 'legacy', stakedValidators.length, 0.02
        )
        await gasHelper.ensureGasBalance(stakeSource, '2000')
        await stakeHelper.sendStakeV1(stakeSource, '1500.00000000', v.pubkey)
        v.source = stakeSource.address
        stakedValidators.push(v)
        return v
    }

    before(async function () {
        if (COIN_CODE !== 'BTC') {
            console.log('Attestation rides on BTC-only STAKE + EXECUTE; skipping on ' + COIN_CODE)
            this.skip()
            return
        }

        operatorAddr = await cryptoHelper.getNewFundedAddress(
            'realurl-op', COIN, NETWORK, null, 'legacy', 0, 0.02
        )
        await gasHelper.ensureGasBalance(operatorAddr, '5000')

        // Stake exactly three validators. On a clean chain these are the only
        // attestation-capable keys, so the responsible set for any request is
        // all three - our signatures meet the redundancy=3 quorum.
        for (let i = 0; i < 3; i++) {
            await stakeValidatorFromOwnSource(new attestationHelper.MockAttestationValidator())
        }
        await regtestMinerConnector.generateBlocks(7)

        const deploy = await vmHelper.sendDeployV0(operatorAddr, CONTRACT_CODE, 500000)
        assert.strictEqual(deploy.contract.status, 'valid', 'deploy status: ' + deploy.contract.status)
        contractIndex = deploy.contract.action_index
    })

    it('fetches the real URL, reaches 3/3 quorum, and writes the live body to state', async function () {
        // 1. EXECUTE -> pending ATTEST v0 request (the real URL is the payload).
        const exec = await vmHelper.sendExecuteV0(operatorAddr, contractIndex, 'askOracleQuorum', [REAL_URL])
        assert.strictEqual(exec.execution.status, 'valid', 'execute status: ' + exec.execution.status)

        const request = await indexerDatabase.waitForAttestationRequest({
            txHash:        exec.txHash,
            requestStatus: 'pending'
        })
        assert(request, 'pending attestation request row should exist')
        assert.strictEqual(request.provider_id, 'http_get')
        assert.strictEqual(Number(request.redundancy), 3)
        assert.strictEqual(request.payload, REAL_URL, 'the real URL should be stored as the request payload')
        const requestId = request.request_id

        // 2. REAL fetch through the production http_get provider. This is the
        //    actual outbound HTTPS GET - no mock, no local server.
        const fetched = await http_get.fetch(REAL_URL, { maxResponseBytes: 32768, timeoutMs: 10000 })
        const realBody = fetched.body.toString('utf8')
        const realMeta = String(fetched.meta)   // HTTP status code, part of the signing message
        console.log('LIVE FETCH  status=' + realMeta + '  bytes=' + Buffer.byteLength(realBody, 'utf8'))
        console.log('LIVE BODY   ' + JSON.stringify(realBody))
        assert.strictEqual(realMeta, '200', 'expected HTTP 200 from the live endpoint')

        // 3. Sign the REAL body with the request's responsible validators (on a
        //    clean chain that is all three) and broadcast the ATTEST v1.
        const signers = attestationHelper.computeResponsibleSigners(requestId, 3, stakedValidators)
        assert.strictEqual(signers.length, 3, 'expected 3 responsible signers on a clean chain')
        await attestationHelper.broadcastAttestationResponse(operatorAddr, {
            requestId:       requestId,
            providerId:      'http_get',
            responsePayload: realBody,
            status:          'ok',
            meta:            realMeta,
            validators:      signers
        })

        // 4. Indexer accepts 3/3, response lands valid.
        const response = await indexerDatabase.waitForAttestationResponse({
            requestId:      requestId,
            responseStatus: 'ok',
            status:         'valid'
        }, 120000)
        assert(response, 'attestation response row should land status=ok / valid')
        assert.strictEqual(response.response_payload, realBody, 'on-chain response_payload should be the live body')

        const sigs = await indexerDatabase.getAttestationValidatorSignatures(response.action_index)
        assert.strictEqual(sigs.length, 3, 'should have exactly 3 verified validator signatures, got ' + sigs.length)

        // 5. Request flips to fulfilled and the callback fires.
        const fulfilled = await indexerDatabase.checkAttestationRequest({
            requestId:     requestId,
            requestStatus: 'fulfilled'
        })
        assert(fulfilled, 'request_status should flip to fulfilled')
        assert(response.callback_execute_action_index, 'callback_execute_action_index should be set')

        // 6. Contract state holds the REAL body byte-for-byte.
        const cbStatus  = await indexerDatabase.getContractState(contractIndex, 'callback_status')
        const cbPayload = await indexerDatabase.getContractState(contractIndex, 'callback_payload')
        const cbContext = await indexerDatabase.getContractState(contractIndex, 'callback_context')
        assert.strictEqual(JSON.parse(cbStatus.state_value),  'ok')
        assert.strictEqual(JSON.parse(cbPayload.state_value), realBody)
        assert.strictEqual(JSON.parse(cbContext.state_value), 'ctx-realurl')

        // Sanity: the live body really is the todos/1 resource.
        const obj = JSON.parse(realBody)
        assert.strictEqual(obj.id, 1)
        assert.strictEqual(obj.userId, 1)
        assert.strictEqual(obj.title, 'delectus aut autem')
        assert.strictEqual(obj.completed, false)
    })
})
