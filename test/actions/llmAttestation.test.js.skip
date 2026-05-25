/*********************************************************************
 * E2E test — LLM attestation provider, redundancy=1
 *
 * Drives an ATTESTATION_REQUEST(provider='llm', redundancy=1) through a
 * single in-process xchain-hub via the LLM provider's `claude_spawn`
 * transport. Single-validator means no PBFT — the one responsible hub
 * fetches via the spawned `claude` CLI and publishes the on-chain
 * ATTESTATION_RESPONSE directly.
 *
 * Auth: HUB_CLAUDE_CONFIG_DIR points at a dir populated by a prior
 *   `CLAUDE_CONFIG_DIR=<dir> claude login`. The hub's `claude-spawn`
 *   inherits that dir into the spawned CLI's env, which finds the
 *   stored OAuth token + refresh token in `.credentials.json`.
 *
 * Spec: claude/reports/specs/2026-05-24_llm-attestation-provider.md
 *
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

async function _settleStack() {
    await utxoTrackerConnector.quiesce({ timeoutMs: 30000, pollMs: 250, regtestMiner: regtestMinerConnector })
}

describe('LLM attestation provider — redundancy=1 via claude_spawn', function () {
    this.timeout(10 * 60 * 1000)

    let mvh           = null
    let contractIndex = null
    let owner         = null

    // The contract embeds a deterministic arithmetic prompt — a model that
    // answers anything else than "4" is broken. The single-hub path runs the
    // provider's `agree([proposal])` (which trivially returns that proposal
    // when redundancy=1), so we don't need exact-string equivalence across
    // multiple model calls.
    const CONTRACT_CODE = `
module.exports = {
    askLlm: function(xchain) {
        var envelope = xchain.getInputParam(0);
        var requestId = xchain.attestation.request(
            'llm',
            envelope,
            'handleResponse',
            ['ctx-llm'],
            { redundancy: 1, deadlineBlocks: 20 }
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
        if (COIN_CODE !== 'BTC') { this.skip(); return }
        if (!process.env.HUB_DB_USER || !process.env.HUB_DB_PASS) {
            console.log('LLM attestation test requires HUB_DB_USER/HUB_DB_PASS — skipping')
            this.skip(); return
        }
        if (!process.env.HUB_CLAUDE_CONFIG_DIR && !process.env.CLAUDE_CONFIG_DIR) {
            console.log('LLM attestation test requires HUB_CLAUDE_CONFIG_DIR (or CLAUDE_CONFIG_DIR) pointing at a `claude login`-populated dir — skipping')
            this.skip(); return
        }

        mvh = new MultiValidatorHub({ count: 1 })
        await mvh.start()
        const pubkey = mvh.getPubkeys()[0]

        // Stake the single hub. min_stake for the `attestation` capability is
        // 1000 XCHAIN (see xchain-indexer/src/configs/BTC.js). Use 1200 to
        // mirror A2's pattern.
        const staker = await cryptoHelper.getNewFundedAddress(
            'llm-staker', COIN, NETWORK, null, 'legacy', 0, 0.02
        )
        await _settleStack()
        await gasHelper.ensureGasBalance(staker, '1500')
        await _settleStack()
        const stakeResult = await stakeHelper.sendStakeV1(staker, '1200.00000000', pubkey)
        assert.strictEqual(stakeResult.stake.status, 'valid', 'stake should be valid')

        // Activation window
        await regtestMinerConnector.generateBlocks(7)
        await _settleStack()

        // Fund + deploy
        owner = await cryptoHelper.getNewFundedAddress(
            'llm-owner', COIN, NETWORK, null, 'legacy', 0, 0.02
        )
        await regtestMinerConnector.generateBlocks(2)
        await _settleStack()
        await gasHelper.ensureGasBalance(owner, '5000')

        const deploy = await vmHelper.sendDeployV0(owner, CONTRACT_CODE, 500000)
        assert.strictEqual(deploy.contract.status, 'valid', 'deploy should be valid')
        contractIndex = deploy.contract.action_index

        // Publisher address for the broadcast hook.
        const publisherAddr = await cryptoHelper.getNewFundedAddress(
            'llm-publisher', COIN, NETWORK, null, 'legacy', 0, 0.02
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

    it('fetches via claude_spawn and fires the callback', async function () {
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
        assert.strictEqual(Number(request.redundancy), 1)
        const requestId = request.request_id

        // Past CONFIRMATIONS
        await regtestMinerConnector.generateBlocks(6)

        // Generous wait — claude CLI cold-start + completion + on-chain broadcast.
        const response = await indexerDatabase.waitForAttestationResponse({
            requestId:      requestId,
            responseStatus: 'ok',
            status:         'valid'
        }, 240_000)
        assert(response, 'attestation_responses row should land with status=ok')

        // Single validator → single signature
        const sigs = await indexerDatabase.getAttestationValidatorSignatures(response.action_index)
        assert(sigs.length >= 1, 'expected ≥1 verified validator signature, got ' + sigs.length)
        const sigPubkey = String(sigs[0].validator_pubkey).toLowerCase()
        assert.strictEqual(sigPubkey, mvh.getPubkeys()[0].toLowerCase(), 'sig pubkey should match the hub')

        // Request fulfilled
        const fulfilled = await indexerDatabase.checkAttestationRequest({
            requestId:     requestId,
            requestStatus: 'fulfilled'
        })
        assert(fulfilled, 'request_status should be fulfilled')

        // Callback fired
        assert(response.callback_execute_action_index, 'callback_execute_action_index should be set')
        const cbStatus  = await indexerDatabase.getContractState(contractIndex, 'callback_status')
        const cbPayload = await indexerDatabase.getContractState(contractIndex, 'callback_payload')
        const cbContext = await indexerDatabase.getContractState(contractIndex, 'callback_context')
        assert(cbStatus,  'callback_status state should exist')
        assert(cbPayload, 'callback_payload state should exist')
        assert.strictEqual(JSON.parse(cbStatus.state_value), 'ok')
        assert.strictEqual(JSON.parse(cbContext.state_value), 'ctx-llm')
        // Body sanity: the model's answer should contain "4"
        const payloadStr = JSON.parse(cbPayload.state_value)
        assert(/4/.test(payloadStr), 'callback payload should contain "4", got: ' + JSON.stringify(payloadStr))
    })
})
