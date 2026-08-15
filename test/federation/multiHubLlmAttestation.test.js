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
 * Track C.2: Multi-hub LLM attestation under real PBFT (redundancy=3).
 *
 * llmAttestation.test.js covers the single-hub LLM path (redundancy=1, no PBFT;
 * the sole responsible hub self-agrees). multiHubAttestation.test.js covers
 * multi-hub PBFT but for the http_get provider. The gap is multi-hub LLM: N>=2
 * hubs each spawning their own `claude` CLI and reaching PBFT agreement over the
 * model responses. This closes it: a redundancy=3 ATTEST v0 (provider='llm')
 * driven through three real in-process hubs:
 *   1. stake all three hub pubkeys on-chain (attestation capability);
 *   2. deploy a contract that requests provider='llm', redundancy=3;
 *   3. EXECUTE -> each hub fetches via claude_spawn -> ATTEST_PROPOSE -> PBFT
 *      PROPOSE/PREPARE/COMMIT -> leader publishes ATTEST v1 on-chain;
 *   4. assert >=3 verified signatures (one per hub) + the callback fires with the
 *      model's answer ("4").
 *
 * Structure mirrors multiHubAttestation.test.js (staking loop, publisher hook);
 * the LLM provider + prompt mirror llmAttestation.test.js. Needs the live
 * federation stack (E2E_REQUIRE_FEDERATION=1) + HUB_CLAUDE_CONFIG_DIR (OAuth creds
 * for the spawned CLI) + the `claude` binary on PATH; Node 22 venue.
 ********************************************************************/

const dotenv = require('dotenv')
dotenv.config()

const assert = require('assert')

const cryptoHelper = require('../cryptoHelper')
const stakeHelper = require('../helpers/stakeHelper')
const gasHelper = require('../helpers/gasHelper')
const vmHelper = require('../helpers/vmHelper')
const transactionHelper = require('../transactionHelper')
const { MultiValidatorHub } = require('../helpers/multiValidatorHubHelper')
const { requireFederationEnv, assertCleanValidatorSet } = require('../helpers/federationGuards')

async function _settleStack() {
    await utxoTrackerConnector.quiesce({ timeoutMs: 30000, pollMs: 250, regtestMiner: regtestMinerConnector })
}

describe('Phase B: multi-hub PBFT for LLM attestation (redundancy=3)', function () {
    this.timeout(15 * 60 * 1000)

    let mvh           = null
    let contractIndex = null
    let owner         = null
    let stakers       = []

    // Deterministic arithmetic prompt: every hub's model must answer "4", so
    // the PBFT byte-equality consensus over the responses converges.
    const CONTRACT_CODE = `
module.exports = {
    askLlm: function(xchain) {
        var envelope = xchain.getInputParam(0);
        var requestId = xchain.attestation.request(
            'llm',
            envelope,
            'handleResponse',
            ['ctx-llm-mvh'],
            { redundancy: 3, deadlineBlocks: 20 }
        );
        xchain.state.set('pending_request_id', requestId);
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

    before(async function () {
        if (!requireFederationEnv(this, { needsClaudeConfig: true })) return
        // Responsible-set selection spans ALL staked validators; a polluted chain
        // makes the three hubs unreliable to select. Fail fast.
        await assertCleanValidatorSet(indexerDatabase)

        mvh = new MultiValidatorHub({ count: 3 })
        await mvh.start()
        const pubkeys = mvh.getPubkeys()

        // Stake each hub's pubkey from a separate funded source. 30000 clears BOTH the
        // attestation capability min_stake (1000 XCHAIN) and the llm PROVIDER floor
        // (25000, XC-083), which the responsible-set derivation enforces at/above
        // STAKE_WEIGHTED_QUORUM (armed at genesis on regtest).
        for (let i = 0; i < pubkeys.length; i++) {
            const addr = await cryptoHelper.getNewFundedAddress(
                'llm-mvh-staker-' + i, COIN, NETWORK, null, 'legacy', 0, 0.02
            )
            await _settleStack()
            await gasHelper.ensureGasBalance(addr, '35000')
            await _settleStack()
            const result = await stakeHelper.sendStakeV1(addr, '30000.00000000', pubkeys[i])
            assert.strictEqual(result.stake.status, 'valid', 'stake ' + i + ' should be valid')
            stakers.push({ addressInfo: addr, pubkey: pubkeys[i] })
        }

        await regtestMinerConnector.generateBlocks(7)
        await _settleStack()

        owner = await cryptoHelper.getNewFundedAddress(
            'llm-mvh-owner', COIN, NETWORK, null, 'legacy', 0, 0.02
        )
        await regtestMinerConnector.generateBlocks(2)
        await _settleStack()
        await gasHelper.ensureGasBalance(owner, '5000')

        const deploy = await vmHelper.sendDeployV0(owner, CONTRACT_CODE, 500000)
        assert.strictEqual(deploy.contract.status, 'valid', 'deploy should be valid')
        contractIndex = deploy.contract.action_index

        // Publisher hook (only the round leader invokes it; followers no-op, so a
        // single shared funded address is safe across all 3 hubs).
        const publisherAddr = await cryptoHelper.getNewFundedAddress(
            'llm-mvh-publisher', COIN, NETWORK, null, 'legacy', 0, 0.02
        )
        await regtestMinerConnector.generateBlocks(2)
        await _settleStack()
        mvh.setBroadcastHook(async (wirePayload) => {
            const txHash = await transactionHelper.createAndSendTransaction(publisherAddr, wirePayload)
            return { txid: txHash }
        })
    })

    after(async function () {
        if (mvh) {
            await mvh.stop()
            await mvh.dropDatabases()
        }
    })

    it('drives a redundancy=3 LLM attestation through real PBFT and fires the callback', async function () {
        const envelope = JSON.stringify({
            prompt: 'What is 2 plus 2? Reply with only the number, nothing else.',
            max_tokens: 16
        })
        const exec = await vmHelper.sendExecuteV0(owner, contractIndex, 'askLlm', [envelope])
        assert.strictEqual(exec.execution.status, 'valid', 'execute should be valid')

        const request = await indexerDatabase.waitForAttestationRequest({
            txHash:        exec.txHash,
            requestStatus: 'pending'
        })
        assert(request, 'pending attestation_requests row should exist')
        assert.strictEqual(Number(request.redundancy), 3)
        const requestId = request.request_id

        // Past CONFIRMATIONS so the hubs fetch.
        await regtestMinerConnector.generateBlocks(6)

        // Generous wait: 3x claude CLI cold-start + PBFT + on-chain broadcast.
        const response = await indexerDatabase.waitForAttestationResponse({
            requestId:      requestId,
            responseStatus: 'ok',
            status:         'valid'
        }, 300_000)
        assert(response, 'attestation_responses row should land with status=ok')

        // >=3 verified signatures, one per hub: the multi-hub PBFT proof.
        const sigs = await indexerDatabase.getAttestationValidatorSignatures(response.action_index)
        assert(sigs.length >= 3, 'expected >=3 verified validator signatures, got ' + sigs.length)
        const sigPubkeys = new Set(sigs.map(s => String(s.validator_pubkey).toLowerCase()))
        for (const pk of mvh.getPubkeys()) {
            assert(sigPubkeys.has(pk.toLowerCase()), 'expected sig from hub pubkey ' + pk.slice(0, 16) + '...')
        }

        const fulfilled = await indexerDatabase.checkAttestationRequest({
            requestId:     requestId,
            requestStatus: 'fulfilled'
        })
        assert(fulfilled, 'request_status should be fulfilled')

        assert(response.callback_execute_action_index, 'callback_execute_action_index should be set')
        const cbStatus  = await indexerDatabase.getContractState(contractIndex, 'callback_status')
        const cbPayload = await indexerDatabase.getContractState(contractIndex, 'callback_payload')
        const cbContext = await indexerDatabase.getContractState(contractIndex, 'callback_context')
        assert(cbStatus,  'callback_status state should exist')
        assert(cbPayload, 'callback_payload state should exist')
        assert.strictEqual(JSON.parse(cbStatus.state_value), 'ok')
        assert.strictEqual(JSON.parse(cbContext.state_value), 'ctx-llm-mvh')
        const payloadStr = JSON.parse(cbPayload.state_value)
        assert(/4/.test(payloadStr), 'callback payload should contain "4", got: ' + JSON.stringify(payloadStr))
    })
})
