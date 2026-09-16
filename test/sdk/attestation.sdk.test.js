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

const support = require('./attestation.sdk.test/support.test');
const { expect, AttestationHelpers } = support;

function testBuilders() {
    const { sdk } = support.state;
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
    }

support.addTest('sdk.attestation builders validate + shape request payloads', testBuilders, __filename);

require('./attestation.sdk.test/01_execute_emits_attest_v0_request_stored_pending_and_readable_via_sdk_get_attestations.test');
require('./attestation.sdk.test/02_a_signed_attest_v1_response_fulfills_the_request_and_fires_the_callback.test');
require('./attestation.sdk.test/03_auto_expires_a_request_past_its_deadline_block_firing_the_callback_with_status_expired.test');
require('./attestation.sdk.test/04_rejects_a_response_signed_by_an_unstaked_validator_request_stays_pending.test');
require('./attestation.sdk.test/05_a_paid_request_escrows_the_fee_from_the_caller_fulfillment_credits_validator_rewards_collect_pays_the_staker.test');
require('./attestation.sdk.test/06_a_paid_request_that_expires_past_its_deadline_block_refunds_the_fee_to_the_caller.test');
