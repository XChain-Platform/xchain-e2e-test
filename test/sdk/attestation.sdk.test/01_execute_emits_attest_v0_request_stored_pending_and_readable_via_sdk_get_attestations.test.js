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

const support = require('./support.sdk.test');
const {
    expect, submit, mine, submitOpts, attestationHelper, requireResponsibleValidator,
    AttestationHelpers, findAttestation, xchainEscrowSum, attestRewards
} = support;

async function testRequestPersistence() {
    const { sdk, operator, validator, contractIndex } = support.state;
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

        support.state.requestId = request.request_id;
        // Carry the pinned election through to the fulfillment case below, which
        // can only be run when this suite's validator is in it.
        support.state.requestRow = request;
    }

support.addTest('EXECUTE emits ATTEST v0 (request), stored pending and readable via sdk.getAttestations', testRequestPersistence, __filename);
