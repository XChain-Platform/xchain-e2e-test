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

const support = require('./support.test');
const {
    expect, submit, mine, submitOpts, attestationHelper, requireResponsibleValidator,
    AttestationHelpers, findAttestation, xchainEscrowSum, attestRewards
} = support;

// ---- E1: paid attestations (FEE_TICK|FEE_AMOUNT) ----------------------
    // The attestation FEE_PAYER is the EXECUTE caller (the operator), NOT the
    // contract (see execute.processEmission). The fee is escrowed from the
// caller; on fulfillment it is released to the REWARD pool and split into
// validator_rewards (COLLECTable by the staker); on expiry it is refunded.

// Federation seam: the staked validator signs an `ok` response.
async function fulfillPaidRequest(operator, validator, request) {
    await attestationHelper.broadcastAttestationResponse(operator, {
        requestId:       request.request_id,
        providerId:      'http_get',
        responsePayload: '{"score":9}',
        status:          'ok',
        meta:            '200',
        validators:      [validator]
    });
    return global.indexerDatabase.waitForAttestationRequest({
        requestId: request.request_id, requestStatus: 'fulfilled'
    });
}

// validator_rewards for the responsible set (N=1), keyed to the request's
// action_index and credited to the staker (operator, gated above).
//
// The settle splits the escrow in two: the elected broadcaster's flat
// reimbursement is carved out FIRST as `attest_bcast` (ATTEST_BROADCAST_FEE,
// armed at genesis on regtest) and the remainder is split across the
// responsible set as `attest_fee`. With REDUNDANCY=1 the sole responsible
// validator IS the elected broadcaster, so both rows credit this staker and
// the ledger-level invariant is that the WHOLE fee arrives as attestation
// rewards for this request. Asserting the total rather than one row's amount
// keeps the case honest across the regtest oracle price, which decides how
// the 2 XCHAIN divides between the two rows (the reimbursement is a native-coin
// allowance converted at the settle block, clamped to the escrow, and floored
// onto the GAS decimal grid, which is 0 dp for the regtest XCHAIN).
async function paidRewards(operator, request) {
    const rewards = await attestRewards(operator.address);
    const rewardsForThis = rewards.filter(r => String(r.round_reference) === String(request.action_index));
    const rewardTotal = rewardsForThis.reduce((sum, r) => sum + Number(r.amount), 0);
    return { rewardsForThis, rewardTotal };
}

async function test06() {
    const { sdk, operator, validator, contractIndex } = support.state;
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

        // Venue gate: the settlement half of this case needs a valid v1, which
        // only the elected responsible set can produce.
        if (!requireResponsibleValidator(this, request, validator.pubkey, 'paid request')) return;

        await mine(1);
        const escrowPending = await xchainEscrowSum(operator.address);
        expect(escrowPending - escrowBefore, 'fee should be escrowed from the caller').to.be.closeTo(2, 1e-9);

        const fulfilled = await fulfillPaidRequest(operator, validator, request);
        expect(fulfilled, 'paid request should be fulfilled').to.exist;
        await mine(1);

        const { rewardsForThis, rewardTotal } = await paidRewards(operator, request);
        expect(rewardsForThis.length, 'attestation validator_rewards row(s) for this request').to.be.gte(1);
        expect(rewardTotal, 'N=1, so the full fee accrues to the one validator (reimbursement + split)')
            .to.be.closeTo(2, 1e-9);

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
    }

support.addTest('a paid request escrows the fee from the caller, fulfillment credits validator_rewards, COLLECT pays the staker', test06, __filename);
