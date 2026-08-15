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
 * XChain Platform E2E - SDK-driven External Attestation Framework
 *
 * Drives the attestation round-trip the way a real dapp does, through
 * the public xchain-sdk API:
 *
 *   1. STAKE v1 (sdk.submitAction) qualifies a validator pubkey for the
 *      `attestation` capability (aggregate stake auto-qualifies; min
 *      1000 XCHAIN).
 *   2. DEPLOY (sdk.submitAction) a contract that calls
 *      xchain.attestation.request(...) and defines a callback.
 *   3. The request URL is validated/normalised with sdk.attestation.httpGet
 *      before being passed into EXECUTE (exactly the pre-flight a dapp does).
 *   4. EXECUTE (sdk.submitAction) emits ATTEST v0 (request); the dapp reads
 *      the pending request back via sdk.getAttestations(...).
 *   5. A signed ATTEST v1 (response) is injected. This is the ONE seam that
 *      is NOT an SDK user surface: responses are produced + broadcast by the
 *      hub federation (validators), never by a dapp. There is intentionally
 *      no ATTEST action in the SDK (v0 is VM-emitted, v1 hub-broadcast, v2
 *      system-synthesized). We use the connector-suite attestationHelper
 *      (a real Ed25519 validator signing the production canonical message)
 *      to stand in for the federation, then read the result back via the SDK.
 *   6. Callback results + request status flips are asserted through the SDK
 *      (getContractState / getAttestations).
 *
 * Attestation rides on STAKE + EXECUTE, which are BTC-only protocol
 * features. This suite skips on non-BTC chains.
 *
 ********************************************************************/

const { expect } = require('chai');
const { makeSdk, submit, fundedGasAddress, mine, submitOpts, loadSDK } = require('./sdkHelper');
const attestationHelper = require('../helpers/attestationHelper');
// Reuse the harness's SDK resolver (sibling checkout or installed dep) to get
// the top-level AttestationHelpers builders (also exposed as sdk.attestation).
const { AttestationHelpers } = loadSDK();

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
    handleExpiry: function(xchain) {
        xchain.state.set('expiry_request_id', xchain.getInputParam(0));
        xchain.state.set('expiry_provider_id', xchain.getInputParam(1));
        xchain.state.set('expiry_status', xchain.getInputParam(2));
        xchain.state.set('expiry_payload', xchain.getInputParam(3));
        xchain.state.set('expiry_context', xchain.getInputParam(4));
    },
    // E1 paid attestations: the request carries a FEE_TICK|FEE_AMOUNT pair.
    // The fee is escrowed from the EXECUTE caller (FEE_PAYER = the EXECUTE
    // SOURCE, not the contract). Integer fee: the regtest GAS tick (XCHAIN) is
    // issued with decimals=0, so the ledger rounds fractional amounts.
    askOraclePaid: function(xchain) {
        var url = xchain.getInputParam(0);
        var requestId = xchain.attestation.request(
            'http_get',
            url,
            'handleResponse',
            ['ctx-paid'],
            { redundancy: 1, deadlineBlocks: 10, feeTick: 'XCHAIN', feeAmount: '2' }
        );
        xchain.state.set('paid_request_id', requestId);
        return requestId;
    },
    askOraclePaidExpiring: function(xchain) {
        var url = xchain.getInputParam(0);
        var requestId = xchain.attestation.request(
            'http_get',
            url,
            'handleExpiry',
            ['ctx-paid-expiry'],
            { redundancy: 1, deadlineBlocks: 2, feeTick: 'XCHAIN', feeAmount: '2' }
        );
        xchain.state.set('paid_expiring_request_id', requestId);
        return requestId;
    }
};
`;

function contractIndexOf(indexed) {
    const a = indexed && Array.isArray(indexed.actions) ? indexed.actions[0] : null;
    return a ? a.action_index : null;
}

// Pull the request_status for a given request_id out of an sdk.getAttestations
// result (the explorer wraps rows in { data: [...] }).
function findAttestation(result, requestId) {
    const rows = (result && result.data) || [];
    return rows.find(r => String(r.request_id) === String(requestId));
}

// Total escrowed XCHAIN for an address (sum of escrows rows; negative rows are
// releases). The attestation fee is escrowed from the FEE_PAYER, so this rises
// by the fee while a request is pending and returns to baseline on settlement.
async function xchainEscrowSum(address) {
    const conn = await global.indexerDatabase.getConnection();
    try {
        const rows = await conn.query(
            `SELECT e.amount AS amount FROM escrows e
               JOIN index_addresses ia ON ia.id = e.address_id
               JOIN index_tickers   it ON it.id = e.tick_id
              WHERE ia.address = ? AND it.tick = ?`,
            [address, 'XCHAIN']);
        return rows.reduce((sum, r) => sum + Number(r.amount), 0);
    } finally { await conn.release(); }
}

// attest_fee validator_rewards rows credited to a staker (source) address.
async function attestFeeRewards(sourceAddress) {
    const conn = await global.indexerDatabase.getConnection();
    try {
        return await conn.query(
            `SELECT vr.amount AS amount, vr.round_reference AS round_reference
               FROM validator_rewards vr
               JOIN index_addresses ia ON ia.id = vr.source_id
              WHERE vr.reward_type = 'attest_fee' AND ia.address = ?`,
            [sourceAddress]);
    } finally { await conn.release(); }
}

describe('[sdk] External Attestation Framework (request -> response -> callback)', function () {
    this.timeout(0);

    let sdk, operator, validator, contractIndex;

    before(async function () {
        // STAKE + EXECUTE (and thus the attestation framework) are BTC-only.
        const coinCode = global.COIN_CODE || 'BTC';
        if (coinCode !== 'BTC') {
            console.log('    [sdk] attestation requires BTC chain, skipping on ' + coinCode);
            this.skip();
            return;
        }

        sdk = makeSdk();

        // Fund the operator generously: it pays for the stake, the DEPLOY
        // (P2WSH two-phase), several EXECUTEs and (standing in for the
        // federation) the ATTEST v1 response broadcasts. Gas seeds the
        // protocol fees for STAKE/DEPLOY/EXECUTE.
        operator = await fundedGasAddress(sdk, 5);
        console.log('    [sdk] operator=' + operator.address);

        // A real Ed25519 validator running in-process. Its pubkey is staked
        // via the regular STAKE action so the indexer's hasCapability check +
        // signature verification exercise the production paths.
        validator = new attestationHelper.MockAttestationValidator();

        // STAKE v1 (capability staking): aggregate stake auto-qualifies the
        // pubkey for `attestation` (default min 1000 XCHAIN). 15000 also clears the
        // http_get PROVIDER floor (10000, XC-083), enforced on the responsible set
        // at/above STAKE_WEIGHTED_QUORUM (armed at genesis on regtest). Driven via SDK.
        const stakeRes = await submit(sdk,
            { action: 'STAKE', params: { version: 1, amount: '15000.00000000', signingPubkey: validator.pubkey } },
            { pubkey: operator.address, change: operator.address },
            submitOpts({ wif: operator.wif })
        );
        console.log('    [sdk] STAKE v1 version=' + stakeRes.version + ' status=' + stakeRes.indexed.status);
        expect(stakeRes.version, 'should select STAKE v1 (capability)').to.equal(1);
        expect(stakeRes.indexed.status).to.equal('valid');

        // Advance past the stake activation delay so the snapshot sees it.
        await mine(7);

        // DEPLOY the attestation contract through the SDK.
        const deployRes = await submit(sdk,
            { action: 'DEPLOY', params: { code: CONTRACT_CODE, gasLimit: 500000 } },
            { pubkey: operator.address, change: operator.address },
            submitOpts({ wif: operator.wif })
        );
        console.log('    [sdk] DEPLOY encoding=' + deployRes.encoding + ' status=' + deployRes.indexed.status);
        expect(deployRes.indexed.status).to.equal('valid');
        contractIndex = contractIndexOf(deployRes.indexed);
        expect(contractIndex, 'contract action_index').to.not.equal(null);
        console.log('    [sdk] contractIndex=' + contractIndex);
    });

    it('sdk.attestation builders validate + shape request payloads', function () {
        // http_get: https-only, returns the normalised URL.
        const url = 'https://example.com/v1/score/123';
        expect(AttestationHelpers.httpGet(url)).to.equal(url);
        expect(AttestationHelpers.httpGet({ url })).to.equal(url);
        expect(() => AttestationHelpers.httpGet('http://insecure.example.com')).to.throw(/https/i);
        expect(() => AttestationHelpers.httpGet('https://x.example.com/' + 'a'.repeat(2100))).to.throw(/2048/);

        // llm: builds a JSON envelope with prompt + optional fields.
        const env = JSON.parse(AttestationHelpers.llm({ prompt: 'Score this', maxTokens: 64, format: 'json_object' }));
        expect(env.prompt).to.equal('Score this');
        expect(env.max_tokens).to.equal(64);
        expect(env.format).to.equal('json_object');
        expect(() => AttestationHelpers.llm({})).to.throw(/prompt/i);

        // requestOptions: surfaces only the two fields the VM gateway reads.
        const opts = AttestationHelpers.requestOptions({ redundancy: 3, deadlineBlocks: 20, junk: 'x' });
        expect(opts).to.deep.equal({ redundancy: 3, deadlineBlocks: 20 });

        // The builder is also reachable on the instance (parity with
        // sdk.messaging / sdk.gatedFile).
        expect(sdk.attestation.httpGet(url)).to.equal(url);
    });

    it('EXECUTE emits ATTEST v0 (request), stored pending and readable via sdk.getAttestations', async function () {
        const url = AttestationHelpers.httpGet('https://example.com/v1/score/123');

        const exec = await submit(sdk,
            { action: 'EXECUTE', params: { contractActionIndex: contractIndex, method: 'askOracle', params: [url] } },
            { pubkey: operator.address, change: operator.address },
            submitOpts({ wif: operator.wif })
        );
        console.log('    [sdk] EXECUTE askOracle status=' + exec.indexed.status);
        expect(exec.indexed.status).to.equal('valid');

        const request = await global.indexerDatabase.waitForAttestationRequest({
            txHash:        exec.txid,
            requestStatus: 'pending'
        });
        expect(request, 'attestation_requests row should exist with status=pending').to.exist;
        expect(request.provider_id).to.equal('http_get');
        expect(request.callback_method).to.equal('handleResponse');
        expect(Number(request.redundancy)).to.equal(1);

        await mine(1);
        const viaSdk = await sdk.getAttestations(contractIndex, 'contract');
        const row = findAttestation(viaSdk, request.request_id);
        expect(row, 'sdk.getAttestations should surface the request row').to.exist;
        expect(row.provider_id).to.equal('http_get');
        expect(row.request_status).to.equal('pending');

        this.test.parent.ctx.requestId = request.request_id;
    });

    it('a signed ATTEST v1 (response) fulfills the request and fires the callback', async function () {
        let requestId = this.test.parent.ctx.requestId;
        expect(requestId, 'requestId from the prior test').to.exist;

        const responsePayload = '{"score":7}';

        // Federation seam: a staked validator signs + the response is broadcast.
        // (Responses are not an SDK user surface; see the file header.)
        await attestationHelper.broadcastAttestationResponse(operator, {
            requestId:       requestId,
            providerId:      'http_get',
            responsePayload: responsePayload,
            status:          'ok',
            meta:            '200',
            validators:      [validator]
        });

        const response = await global.indexerDatabase.waitForAttestationResponse({
            requestId:      requestId,
            responseStatus: 'ok',
            status:         'valid'
        });
        expect(response, 'attestation_responses row should be valid').to.exist;

        const sigs = await global.indexerDatabase.getAttestationValidatorSignatures(response.action_index);
        expect(sigs.length).to.equal(1);
        expect(String(sigs[0].validator_pubkey).toLowerCase()).to.equal(validator.pubkey.toLowerCase());

        await mine(1);
        const viaSdk = await sdk.getAttestations(contractIndex, 'contract');
        const row = findAttestation(viaSdk, requestId);
        expect(row, 'request row via SDK').to.exist;
        expect(row.request_status).to.equal('fulfilled');

        const stStatus  = await sdk.getContractState(contractIndex, 'callback_status');
        const stPayload = await sdk.getContractState(contractIndex, 'callback_payload');
        const stContext = await sdk.getContractState(contractIndex, 'callback_context');
        const getVal = (st, key) => {
            const r = ((st && st.data) || []).find(x => x.state_key === key);
            return r ? JSON.parse(r.state_value) : undefined;
        };
        expect(getVal(stStatus,  'callback_status')).to.equal('ok');
        expect(getVal(stPayload, 'callback_payload')).to.equal(responsePayload);
        expect(getVal(stContext, 'callback_context')).to.equal('ctx-42');
    });

    it('auto-expires a request past its DEADLINE_BLOCK, firing the callback with status=expired', async function () {
        const url = AttestationHelpers.httpGet('https://example.com/v1/expiring/789');
        const exec = await submit(sdk,
            { action: 'EXECUTE', params: { contractActionIndex: contractIndex, method: 'askOracleExpiring', params: [url] } },
            { pubkey: operator.address, change: operator.address },
            submitOpts({ wif: operator.wif })
        );
        expect(exec.indexed.status).to.equal('valid');

        const request = await global.indexerDatabase.waitForAttestationRequest({
            txHash:        exec.txid,
            requestStatus: 'pending'
        });
        expect(request, 'expiring request should be pending').to.exist;
        const expiringRequestId = request.request_id;

        // deadlineBlocks=2 + margin so the per-block expiry pipeline runs.
        await mine(5);

        const expired = await global.indexerDatabase.waitForAttestationRequest({
            requestId:     expiringRequestId,
            requestStatus: 'expired'
        }, 30000);
        expect(expired, 'request should auto-expire past DEADLINE_BLOCK').to.exist;

        const getVal = (st, key) => {
            const r = ((st && st.data) || []).find(x => x.state_key === key);
            return r ? JSON.parse(r.state_value) : undefined;
        };
        const stStatus  = await sdk.getContractState(contractIndex, 'expiry_status');
        const stContext = await sdk.getContractState(contractIndex, 'expiry_context');
        const stPayload = await sdk.getContractState(contractIndex, 'expiry_payload');
        expect(getVal(stStatus,  'expiry_status')).to.equal('expired');
        expect(getVal(stContext, 'expiry_context')).to.equal('ctx-expiry');
        expect(getVal(stPayload, 'expiry_payload')).to.equal('');
    });

    it('rejects a response signed by an unstaked validator (request stays pending)', async function () {
        const badValidator = new attestationHelper.MockAttestationValidator();

        const url = AttestationHelpers.httpGet('https://example.com/v1/score/456');
        const exec = await submit(sdk,
            { action: 'EXECUTE', params: { contractActionIndex: contractIndex, method: 'askOracle', params: [url] } },
            { pubkey: operator.address, change: operator.address },
            submitOpts({ wif: operator.wif })
        );
        expect(exec.indexed.status).to.equal('valid');
        const request = await global.indexerDatabase.waitForAttestationRequest({
            txHash: exec.txid, requestStatus: 'pending'
        });
        expect(request, 'fresh pending request').to.exist;

        // Response signed only by the unstaked validator; must not validate.
        await attestationHelper.broadcastAttestationResponse(operator, {
            requestId:       request.request_id,
            providerId:      'http_get',
            responsePayload: '{"score":1}',
            status:          'ok',
            meta:            '200',
            validators:      [badValidator]
        });

        const resp = await global.indexerDatabase.waitForAttestationResponse({
            requestId: request.request_id
        }, 10000);
        if (resp) {
            expect(resp.status, 'unstaked-validator response must not be valid').to.not.equal('valid');
        }

        const stillPending = await global.indexerDatabase.checkAttestationRequest({
            requestId:     request.request_id,
            requestStatus: 'pending'
        });
        expect(stillPending, 'request should remain pending after an invalid-sig response').to.exist;
    });

    // ---- E1: paid attestations (FEE_TICK|FEE_AMOUNT) ----------------------
    // The attestation FEE_PAYER is the EXECUTE caller (the operator), NOT the
    // contract (see execute.processEmission). The fee is escrowed from the
    // caller; on fulfillment it is released to the REWARD pool and split into
    // validator_rewards (COLLECTable by the staker); on expiry it is refunded.

    it('a paid request escrows the fee from the caller, fulfillment credits validator_rewards, COLLECT pays the staker', async function () {
        const escrowBefore = await xchainEscrowSum(operator.address);

        const url = AttestationHelpers.httpGet('https://example.com/v1/paid/100');
        const exec = await submit(sdk,
            { action: 'EXECUTE', params: { contractActionIndex: contractIndex, method: 'askOraclePaid', params: [url] } },
            { pubkey: operator.address, change: operator.address },
            submitOpts({ wif: operator.wif })
        );
        expect(exec.indexed.status).to.equal('valid');

        const request = await global.indexerDatabase.waitForAttestationRequest({
            txHash: exec.txid, requestStatus: 'pending'
        });
        expect(request, 'paid request should be pending').to.exist;
        expect(String(request.fee_amount), 'fee_amount persisted on the request').to.equal('2');

        await mine(1);
        const escrowPending = await xchainEscrowSum(operator.address);
        expect(escrowPending - escrowBefore, 'fee should be escrowed from the caller').to.be.closeTo(2, 1e-9);

        // Federation seam: the staked validator signs an `ok` response.
        await attestationHelper.broadcastAttestationResponse(operator, {
            requestId:       request.request_id,
            providerId:      'http_get',
            responsePayload: '{"score":9}',
            status:          'ok',
            meta:            '200',
            validators:      [validator]
        });
        const fulfilled = await global.indexerDatabase.waitForAttestationRequest({
            requestId: request.request_id, requestStatus: 'fulfilled'
        });
        expect(fulfilled, 'paid request should be fulfilled').to.exist;
        await mine(1);

        // validator_rewards: one attest_fee row for the responsible set (N=1),
        // keyed to the request's action_index, credited to the staker (operator).
        // NOTE: requires a fresh chain. The responsible set is computed
        // deterministically across ALL staked attestation validators, so a
        // regtest chain reused across runs routes the reward to a stale
        // validator. `reset all bitcoin regtest` before running this suite.
        const rewards = await attestFeeRewards(operator.address);
        const rewardForThis = rewards.find(r => String(r.round_reference) === String(request.action_index));
        expect(rewardForThis, 'attest_fee validator_rewards row for this request').to.exist;
        expect(String(rewardForThis.amount), 'N=1, so the full fee accrues to the one validator').to.equal('2');

        const escrowAfter = await xchainEscrowSum(operator.address);
        expect(escrowAfter - escrowBefore, 'fulfillment releases the escrow').to.be.closeTo(0, 1e-9);

        const collect = await submit(sdk,
            { action: 'COLLECT', params: { version: 0 } },
            { pubkey: operator.address, change: operator.address },
            submitOpts({ wif: operator.wif })
        );
        expect(collect.indexed.status).to.equal('valid');
        await mine(1);

        const claim = await global.indexerDatabase.waitForRewardClaim({
            source: operator.address, txHash: collect.txid, status: 'valid'
        });
        expect(claim, 'COLLECT should record a valid reward claim').to.exist;
        expect(Number(claim.amount), 'COLLECT should pay at least the attest fee').to.be.gte(2);
    });

    it('a paid request that expires past its DEADLINE_BLOCK refunds the fee to the caller', async function () {
        const escrowBefore = await xchainEscrowSum(operator.address);

        const url = AttestationHelpers.httpGet('https://example.com/v1/paid-expire/200');
        const exec = await submit(sdk,
            { action: 'EXECUTE', params: { contractActionIndex: contractIndex, method: 'askOraclePaidExpiring', params: [url] } },
            { pubkey: operator.address, change: operator.address },
            submitOpts({ wif: operator.wif })
        );
        expect(exec.indexed.status).to.equal('valid');

        const request = await global.indexerDatabase.waitForAttestationRequest({
            txHash: exec.txid, requestStatus: 'pending'
        });
        expect(request, 'expiring paid request should be pending').to.exist;
        expect(String(request.fee_amount)).to.equal('2');

        await mine(1);
        const escrowPending = await xchainEscrowSum(operator.address);
        expect(escrowPending - escrowBefore, 'fee should be escrowed while pending').to.be.closeTo(2, 1e-9);

        // deadlineBlocks=2 + margin so the per-block expiry pipeline fires v2.
        await mine(5);
        const expired = await global.indexerDatabase.waitForAttestationRequest({
            requestId: request.request_id, requestStatus: 'expired'
        }, 30000);
        expect(expired, 'paid request should auto-expire').to.exist;
        await mine(1);

        // Escrow released + refunded: caller's escrow returns to baseline.
        // Unlike fulfillment, NO validator reward is created for the request.
        const escrowAfter = await xchainEscrowSum(operator.address);
        expect(escrowAfter - escrowBefore, 'expiry releases the escrow (refund to caller)').to.be.closeTo(0, 1e-9);

        const rewards = await attestFeeRewards(operator.address);
        expect(rewards.find(r => String(r.round_reference) === String(request.action_index)),
            'an expired request must NOT create a validator reward').to.equal(undefined);
    });
});
