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
 * VENUE DEPENDENCE, settled by an operator ruling. Two of these cases
 * need the suite's own validator to be the ELECTED responder for their request.
 * Election is top-REDUNDANCY by SHA256(request_id || pubkey) across every staked
 * attestation validator on the chain, and the shared BTC regtest venue carries a
 * deliberately preserved rollcall federation seed, so some request-ids route to a
 * stake that never answers and those requests expire by design. The indexer pins
 * the elected set on the request row (attests.responsible_set_json), so the two
 * cases read the election result and report PENDING, naming the elected pubkey,
 * rather than failing on a venue fact. Everything else here is deterministic and
 * runs on any venue. Run with E2E_REQUIRE_FEDERATION=1 on a freshly reset chain
 * to make a non-election a hard failure and prove 7/7.
 *
 ********************************************************************/

const { expect } = require('chai');
const { makeSdk, submit, fundedGasAddress, mine, submitOpts, loadSDK } = require('../sdkHelper');
const attestationHelper = require('../../helpers/attestationHelper');
const { requireResponsibleValidator } = require('../../helpers/federationGuards');
// Reuse the harness's SDK resolver (sibling checkout or installed dep) to get
// the top-level AttestationHelpers builders (also exposed as sdk.attestation).
const { AttestationHelpers } = loadSDK();

const CONTRACT_CODE = `
module.exports = {
    meta: { name: 'SDK Attest Asker', description: 'Requests a URL attestation through the SDK.', version: '1.0.0' },
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

// Attestation validator_rewards rows credited to a staker (source) address.
//
// A fulfilled paid request settles into TWO reward types, not one: the elected
// broadcaster's flat reimbursement (`attest_bcast`, carved out of the escrow
// first and capped by it) and the equal split of what is left across the
// responsible set (`attest_fee`). Both are queried here so the assertions can
// speak about the fee as a whole; see the settlement comment in the paid case.
async function attestRewards(sourceAddress) {
    const conn = await global.indexerDatabase.getConnection();
    try {
        return await conn.query(
            `SELECT vr.amount AS amount, vr.round_reference AS round_reference,
                    vr.reward_type AS reward_type
               FROM validator_rewards vr
               JOIN index_addresses ia ON ia.id = vr.source_id
              WHERE vr.reward_type IN ('attest_fee', 'attest_bcast') AND ia.address = ?`,
            [sourceAddress]);
    } finally { await conn.release(); }
}

let sdk, operator, validator, contractIndex;
const state = { requestId: null, requestRow: null };
Object.defineProperties(state, {
    sdk: { get() { return sdk; } },
    operator: { get() { return operator; } },
    validator: { get() { return validator; } },
    contractIndex: { get() { return contractIndex; } }
});

async function setup() {
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
        // http_get PROVIDER floor (10000), enforced on the responsible set
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
    }

const sharedSuite = describe('[sdk] External Attestation Framework (request -> response -> callback)', function () {
    this.timeout(0);
    before(async function () { await setup.call(this); });
});

function addTest(title, callback, file) {
    const test = new (require('mocha').Test)(title, callback);
    test.file = file;
    sharedSuite.addTest(test);
}

module.exports = {
    state, setup, addTest, expect, submit, mine, submitOpts, attestationHelper,
    requireResponsibleValidator, AttestationHelpers, findAttestation, xchainEscrowSum, attestRewards
};
