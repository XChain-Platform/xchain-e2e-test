// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md.

/**
 * REAL-URL attestation FAILURE paths with a 3-validator quorum.
 *
 * Sibling of test/actions/realUrlAttestation.test.js (the happy `ok` path).
 * Same orchestration - 3 staked MockAttestationValidators sign over the real
 * http_get provider (xchain-hub/src/providers/http_get.js) - but here we cover
 * the two NON-`ok` terminal/retry paths the happy-path test does not:
 *
 *   1. EXPIRED   - the federation never lands a response before DEADLINE_BLOCK.
 *                  The indexer auto-expires the request and fires the callback
 *                  with status='expired', payload='' (spec §4.3). To make it a
 *                  true real-URL test we still perform the live GET (the bytes
 *                  the federation WOULD have signed) and log them, then simply
 *                  never broadcast the ATTEST v1 - modelling lost/late response
 *                  txs - and mine past the deadline.
 *
 *   2. NO_QUORUM - a non-deterministic live endpoint cannot satisfy
 *                  byte-equality consensus, so the federation signs a `no_quorum`
 *                  ATTEST v1 instead of `ok`. We DEMONSTRATE the divergence with
 *                  two real fetches (their bodies differ), then broadcast a
 *                  fully-signed no_quorum response. It lands status=valid but is
 *                  RETRYABLE: the request must stay `pending` and NO callback may
 *                  be injected (another round could still reach `ok`).
 *
 * REQUIRES A CLEAN VALIDATOR SET (same as realUrlAttestation.test.js): the
 * indexer filters response signatures to the deterministic responsible set
 * (top-REDUNDANCY by SHA256(request_id||pubkey) over ALL staked attestation
 * validators, source-deduped). With pre-existing validators we don't control,
 * our keys may not be selected and the no_quorum sig path fails. Run on a
 * freshly-reset regtest chain:
 *
 *   xchain-node reset all bitcoin regtest
 *   xchain-node e2etest bitcoin realUrlAttestationFailures
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
// falling back to the monorepo sibling for local dev. Mirrors realUrlAttestation.
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

// Deterministic public endpoint (same as the happy path): a fixed jsonplaceholder
// resource returns the same body byte-for-byte, so the expired test can show the
// real bytes the federation would have signed had its response landed in time.
const REAL_URL = 'https://jsonplaceholder.typicode.com/todos/1'

// Non-deterministic public endpoint: returns a fresh random UUID on every call,
// so two live fetches differ and byte-equality consensus is unreachable - the
// exact condition under which a real federation emits `no_quorum`.
const NONDET_URL = 'https://httpbin.org/uuid'

const CONTRACT_CODE = `
module.exports = {
    askExpiring: function(xchain) {
        var url = xchain.getInputParam(0);
        var requestId = xchain.attestation.request(
            'http_get',
            url,
            'handleExpiry',
            ['ctx-realurl-expire'],
            { redundancy: 3, deadlineBlocks: 2 }
        );
        xchain.state.set('expiring_request_id', requestId);
        return requestId;
    },
    askNoQuorum: function(xchain) {
        var url = xchain.getInputParam(0);
        var requestId = xchain.attestation.request(
            'http_get',
            url,
            'handleResponse',
            ['ctx-realurl-noquorum'],
            { redundancy: 3, deadlineBlocks: 20 }
        );
        xchain.state.set('noquorum_request_id', requestId);
        return requestId;
    },
    handleExpiry: function(xchain) {
        xchain.state.set('expiry_request_id',  xchain.getInputParam(0));
        xchain.state.set('expiry_provider_id', xchain.getInputParam(1));
        xchain.state.set('expiry_status',      xchain.getInputParam(2));
        xchain.state.set('expiry_payload',     xchain.getInputParam(3));
        xchain.state.set('expiry_context',     xchain.getInputParam(4));
    },
    handleResponse: function(xchain) {
        xchain.state.set('nq_callback_request_id', xchain.getInputParam(0));
        xchain.state.set('nq_callback_status',     xchain.getInputParam(2));
        xchain.state.set('nq_callback_payload',    xchain.getInputParam(3));
    }
};
`

describe('REAL-URL attestation FAILURE paths: expired + no_quorum over a 3-validator quorum', function () {
    this.timeout(10 * 60 * 1000)

    let operatorAddr  = null
    let contractIndex = null
    const stakedValidators = []   // full set, mirrors the indexer's responsible-set input

    // Stake a validator from its OWN distinct funded source (SWQ source-dedup
    // collapses same-source keys into one responsible-set slot).
    async function stakeValidatorFromOwnSource(v) {
        let stakeSource = await cryptoHelper.getNewFundedAddress(
            'realurl-fail-val', COIN, NETWORK, null, 'legacy', stakedValidators.length, 0.02
        )
        // 15000 clears BOTH the attestation capability min_stake (1000) and the
        // http_get PROVIDER floor (10000, XC-083), enforced on the responsible set
        // at/above STAKE_WEIGHTED_QUORUM (armed at genesis on regtest).
        await gasHelper.ensureGasBalance(stakeSource, '20000')
        await stakeHelper.sendStakeV1(stakeSource, '15000.00000000', v.pubkey)
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
            'realurl-fail-op', COIN, NETWORK, null, 'legacy', 0, 0.02
        )
        await gasHelper.ensureGasBalance(operatorAddr, '5000')

        // Stake exactly three source-distinct validators. On a clean chain these are
        // the only attestation-capable keys, so the responsible set for any request is
        // all three - our signatures meet a redundancy=3 quorum.
        for (let i = 0; i < 3; i++) {
            await stakeValidatorFromOwnSource(new attestationHelper.MockAttestationValidator())
        }
        await regtestMinerConnector.generateBlocks(7)

        const deploy = await vmHelper.sendDeployV0(operatorAddr, CONTRACT_CODE, 500000)
        assert.strictEqual(deploy.contract.status, 'valid', 'deploy status: ' + deploy.contract.status)
        contractIndex = deploy.contract.action_index
    })

    it('auto-expires a real-URL request when no federation response lands before DEADLINE_BLOCK', async function () {
        // 1. EXECUTE -> pending ATTEST v0 request (the real URL is the payload).
        const exec = await vmHelper.sendExecuteV0(operatorAddr, contractIndex, 'askExpiring', [REAL_URL])
        assert.strictEqual(exec.execution.status, 'valid', 'execute status: ' + exec.execution.status)

        const request = await indexerDatabase.waitForAttestationRequest({
            txHash:        exec.txHash,
            requestStatus: 'pending'
        })
        assert(request, 'pending attestation request row should exist')
        assert.strictEqual(request.provider_id, 'http_get')
        assert.strictEqual(Number(request.redundancy), 3)
        assert.strictEqual(request.payload, REAL_URL, 'the real URL should be stored as the request payload')
        const expiringRequestId = request.request_id

        // 2. REAL fetch through the production http_get provider - the bytes the
        //    federation WOULD have signed. We deliberately do NOT broadcast the
        //    ATTEST v1 (modelling a lost/late response tx), so the deadline lapses.
        try {
            const fetched = await http_get.fetch(REAL_URL, { maxResponseBytes: 32768, timeoutMs: 10000 })
            console.log('LIVE FETCH (will be dropped) status=' + String(fetched.meta) +
                '  bytes=' + Buffer.byteLength(fetched.body.toString('utf8'), 'utf8'))
        } catch (e) {
            console.log('Live fetch unavailable (' + e.message + '); irrelevant - the expiry path needs no response')
        }

        // 3. Advance past DEADLINE_BLOCK. deadlineBlocks=2 + margin so the per-block
        //    expiry pipeline definitely runs at deadline+1.
        await regtestMinerConnector.generateBlocks(5)

        // 4. Request status flips to 'expired'.
        const expired = await indexerDatabase.waitForAttestationRequest({
            requestId:     expiringRequestId,
            requestStatus: 'expired'
        }, 30000)
        assert(expired, 'request should auto-expire past its DEADLINE_BLOCK')

        // 5. Callback fired with status='expired', empty payload (spec §4.3),
        //    context preserved.
        const expiryStatus     = await indexerDatabase.getContractState(contractIndex, 'expiry_status')
        const expiryRequestId  = await indexerDatabase.getContractState(contractIndex, 'expiry_request_id')
        const expiryProviderId = await indexerDatabase.getContractState(contractIndex, 'expiry_provider_id')
        const expiryPayload    = await indexerDatabase.getContractState(contractIndex, 'expiry_payload')
        const expiryContext    = await indexerDatabase.getContractState(contractIndex, 'expiry_context')
        assert(expiryStatus,    'expiry_status state row should exist (callback fired)')
        assert(expiryRequestId, 'expiry_request_id state row should exist')
        assert.strictEqual(JSON.parse(expiryStatus.state_value),     'expired')
        assert.strictEqual(JSON.parse(expiryRequestId.state_value),  expiringRequestId)
        assert.strictEqual(JSON.parse(expiryProviderId.state_value), 'http_get')
        assert.strictEqual(JSON.parse(expiryPayload.state_value),    '')
        assert.strictEqual(JSON.parse(expiryContext.state_value),    'ctx-realurl-expire')
    })

    it('keeps a real-URL request pending under a no_quorum round from a non-deterministic source', async function () {
        // 1. EXECUTE -> pending request (the non-deterministic URL is the payload).
        const exec = await vmHelper.sendExecuteV0(operatorAddr, contractIndex, 'askNoQuorum', [NONDET_URL])
        assert.strictEqual(exec.execution.status, 'valid', 'execute status: ' + exec.execution.status)

        const request = await indexerDatabase.waitForAttestationRequest({
            txHash:        exec.txHash,
            requestStatus: 'pending'
        })
        assert(request, 'pending attestation request row should exist')
        assert.strictEqual(request.provider_id, 'http_get')
        assert.strictEqual(Number(request.redundancy), 3)
        assert.strictEqual(request.payload, NONDET_URL, 'the real URL should be stored as the request payload')
        const requestId = request.request_id

        // 2. DEMONSTRATE why quorum is unreachable: two live fetches of the
        //    non-deterministic endpoint return different bodies, so byte-equality
        //    consensus is impossible and the federation must report no_quorum.
        //    Best-effort - the core assertions below exercise the indexer's
        //    handling of the no_quorum SIGNAL and don't depend on the fetch.
        try {
            const a = await http_get.fetch(NONDET_URL, { maxResponseBytes: 8192, timeoutMs: 10000 })
            const b = await http_get.fetch(NONDET_URL, { maxResponseBytes: 8192, timeoutMs: 10000 })
            const bodyA = a.body.toString('utf8')
            const bodyB = b.body.toString('utf8')
            console.log('NONDET FETCH #1 ' + JSON.stringify(bodyA))
            console.log('NONDET FETCH #2 ' + JSON.stringify(bodyB))
            if (bodyA !== bodyB) {
                console.log('DIVERGENCE confirmed: two live fetches differ -> byte-equality quorum is unreachable -> no_quorum')
            } else {
                console.log('NOTE: endpoint returned identical bodies this round; proceeding with the no_quorum signal anyway')
            }
        } catch (e) {
            console.log('Non-deterministic endpoint unavailable (' + e.message + '); proceeding with the no_quorum signal regardless')
        }

        // 3. The federation signs a no_quorum ATTEST v1 (empty payload) with the
        //    request's responsible set (all 3 on a clean chain). The signatures are
        //    valid, so the RESPONSE row lands status='valid' - this is precisely the
        //    retryable case: a valid response that must NOT close the request.
        const signers = attestationHelper.computeResponsibleSigners(requestId, 3, stakedValidators)
        assert.strictEqual(signers.length, 3, 'expected 3 responsible signers on a clean chain')
        await attestationHelper.broadcastAttestationResponse(operatorAddr, {
            requestId:       requestId,
            providerId:      'http_get',
            responsePayload: '',
            status:          'no_quorum',
            meta:            '',
            validators:      signers
        })

        // 4. Response row lands valid with response_status='no_quorum'.
        const response = await indexerDatabase.waitForAttestationResponse({
            requestId:      requestId,
            responseStatus: 'no_quorum',
            status:         'valid'
        }, 120000)
        assert(response, 'response row should land response_status=no_quorum / status=valid')

        const sigs = await indexerDatabase.getAttestationValidatorSignatures(response.action_index)
        assert.strictEqual(sigs.length, 3, 'should have exactly 3 verified validator signatures, got ' + sigs.length)

        // 5. Invariant 1: the request stays pending (another round may still reach ok).
        const stillPending = await indexerDatabase.checkAttestationRequest({
            requestId:     requestId,
            requestStatus: 'pending'
        })
        assert(stillPending, 'request must remain pending after a retryable no_quorum response')

        // 6. Invariant 2: NO callback EXECUTE was injected (no terminal resolution).
        assert(!response.callback_execute_action_index,
            'no callback should be injected for retryable no_quorum; got callback_execute_action_index=' +
            response.callback_execute_action_index)

        // 7. And the contract callback state was never written.
        const nqCb = await indexerDatabase.getContractState(contractIndex, 'nq_callback_status')
        assert(!nqCb, 'handleResponse must NOT have run for a no_quorum round')
    })
})
