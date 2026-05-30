/*********************************************************************
 * E2E test — Phase B live PBFT through MultiValidatorHub
 *
 * Drives an ATTEST v0 (request)(redundancy=3) end-to-end through three
 * real in-process xchain-hub instances (via MultiValidatorHub):
 *
 *   1. Stake each hub's pubkey on-chain so the attestation capability
 *      snapshot includes all three.
 *   2. Deploy a contract that calls xchain.attestation.request('http_get',
 *      url, 'handleResponse', [...], { redundancy: 3 }).
 *   3. EXECUTE the contract.
 *   4. The three hubs poll the indexer, detect the request, each fetches
 *      the body via http_get, broadcasts ATTEST_PROPOSE; PBFT runs
 *      PROPOSE → PREPARE → COMMIT; leader publishes ATTEST v1 (response)
 *      on-chain.
 *   5. Indexer processes the response, fires the callback EXECUTE,
 *      contract state records the response payload.
 *
 * Unlike test/actions/attestation.test.js (which uses MockAttestationValidator
 * and broadcasts a hand-signed response, bypassing the hub), this test
 * exercises the full validator-side pipeline.
 *
 * Spec: claude/reports/specs/2026-05-24_external-attestation-framework.md §16 Phase 3
 *
 ********************************************************************/

const dotenv = require('dotenv')
dotenv.config()

// MultiValidatorHub uses in-process hubs that fetch the test URL via
// the http_get provider. Test URL points at a local HTTP server, which
// the provider's https-only check rejects — patch the provider's fetch
// at module level (before any hub starts) so http:// is accepted.
// This affects only the test process; production code unchanged.
// Resolution mirrors multiValidatorHubHelper's loader: env override,
// then bundled (in-image) location, then monorepo-dev sibling.
const _path = require('path')
const _fs = require('fs')
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
const HUB_HTTP_GET_PATH = _hubBase + '/src/providers/http_get.js'
const http_get = require(HUB_HTTP_GET_PATH)
const _origFetch = http_get.fetch
http_get.fetch = async function _testPatchedFetch(payload, options) {
    if (typeof payload === 'string' && payload.startsWith('http://')) {
        const axios = require('axios')
        const res = await axios.get(payload, {
            responseType: 'arraybuffer',
            timeout: (options && options.timeoutMs) || 10000,
            maxRedirects: 0,
            validateStatus: () => true
        })
        return { body: Buffer.from(res.data), meta: String(res.status) }
    }
    return _origFetch(payload, options)
}

const assert = require('assert')
const http   = require('http')

const cryptoHelper = require('../cryptoHelper')
const stakeHelper = require('../helpers/stakeHelper')
const gasHelper = require('../helpers/gasHelper')
const vmHelper = require('../helpers/vmHelper')
const transactionHelper = require('../transactionHelper')
const { MultiValidatorHub } = require('../helpers/multiValidatorHubHelper')
const { requireFederationEnv, assertCleanValidatorSet } = require('../helpers/federationGuards')

async function _settleStack() {
    // Wait until mempool is empty + tracker is caught up, so subsequent
    // encoder UTXO lookups (with unconfirmed=false) see fully-confirmed
    // state instead of mid-flight mempool entries.
    await utxoTrackerConnector.quiesce({ timeoutMs: 30000, pollMs: 250, regtestMiner: regtestMinerConnector })
}

const FIXED_BODY = '{"score":42,"meta":"multihub"}'

describe('Phase B — multi-hub PBFT for ATTEST v0 (request) (redundancy=3)', function () {
    // Big budget: 3 hubs × (start + DB init) + on-chain staking + activation wait
    // + contract deploy/execute + PBFT round-trip + block confirmations.
    this.timeout(10 * 60 * 1000)

    let mvh           = null
    let httpServer    = null
    let testUrl       = null
    let contractIndex = null
    let owner         = null
    let stakers       = []   // [{addressInfo, pubkey}]

    const CONTRACT_CODE = `
module.exports = {
    askOracle: function(xchain) {
        var url = xchain.getInputParam(0);
        var requestId = xchain.attestation.request(
            'http_get',
            url,
            'handleResponse',
            ['ctx-mvh'],
            { redundancy: 3, deadlineBlocks: 30 }
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
        // Loud-fail (in CI / the federation phase) or graceful-skip (ad-hoc dev)
        // on missing prerequisites; never silently green.
        if (!requireFederationEnv(this)) return
        // Responsible-set selection spans ALL staked validators — a polluted
        // chain makes this test's hubs unreliable to select. Fail fast.
        await assertCleanValidatorSet(indexerDatabase)

        // 1) Start a local HTTP server returning a fixed body. All three hubs
        //    fetch the same URL; byte_equality consensus converges trivially.
        await new Promise((resolve) => {
            httpServer = http.createServer((_req, res) => {
                res.writeHead(200, { 'Content-Type': 'application/json' })
                res.end(FIXED_BODY)
            })
            httpServer.listen(0, '127.0.0.1', () => {
                const port = httpServer.address().port
                testUrl = 'http://127.0.0.1:' + port + '/score'
                resolve()
            })
        })

        // 2) Bring up three in-process hubs. Each gets its own DB + P2P port
        //    + Ed25519 signing key.
        mvh = new MultiValidatorHub({ count: 3 })
        await mvh.start()
        const pubkeys = mvh.getPubkeys()

        // 3) Fund three operator addresses and stake each hub's pubkey from
        //    a separate source. The hubs poll the indexer for stake state,
        //    so once stakes confirm + activate, capability snapshots include
        //    all three pubkeys. Quiesce between fund and mint each iteration
        //    so the encoder's unconfirmed=false UTXO lookup sees a clean
        //    confirmed view (otherwise it sporadically crashes when the
        //    tracker is mid-batch).
        for (let i = 0; i < pubkeys.length; i++) {
            const addr = await cryptoHelper.getNewFundedAddress(
                'mvh-staker-' + i, COIN, NETWORK, null, 'legacy', 0, 0.02
            )
            await _settleStack()
            await gasHelper.ensureGasBalance(addr, '1500')
            await _settleStack()
            const result = await stakeHelper.sendStakeV1(addr, '1200.00000000', pubkeys[i])
            assert.strictEqual(result.stake.status, 'valid', 'stake ' + i + ' should be valid')
            stakers.push({ addressInfo: addr, pubkey: pubkeys[i] })
        }

        // 4) Advance past the activation window so all three stakes show as
        //    active when the hubs query the capability snapshot. Then wait
        //    for the stack to fully settle so the owner's funding doesn't
        //    land into a contended mempool.
        await regtestMinerConnector.generateBlocks(7)
        await _settleStack()

        // 5) Fund a separate contract owner + deploy the request contract.
        owner = await cryptoHelper.getNewFundedAddress(
            'mvh-owner', COIN, NETWORK, null, 'legacy', 0, 0.02
        )
        // Make sure the funding tx is fully confirmed (not mempool-only)
        // before MINT — encoder's unconfirmed=false lookup needs confirmed
        // UTXOs. Quiesce after explicitly mining a block forces this.
        await regtestMinerConnector.generateBlocks(2)
        await _settleStack()
        await gasHelper.ensureGasBalance(owner, '5000')

        const deploy = await vmHelper.sendDeployV0(owner, CONTRACT_CODE, 500000)
        assert.strictEqual(deploy.contract.status, 'valid', 'deploy should be valid')
        contractIndex = deploy.contract.action_index

        // 6) Fund a publisher address and wire it as each hub's broadcast hook.
        //    Only the round leader actually invokes the hook (followers no-op),
        //    so a single shared funded address is safe across all 3 hubs.
        const publisherAddr = await cryptoHelper.getNewFundedAddress(
            'mvh-publisher', COIN, NETWORK, null, 'legacy', 0, 0.02
        )
        await regtestMinerConnector.generateBlocks(2)
        await _settleStack()
        mvh.setBroadcastHook(async (wirePayload) => {
            const txHash = await transactionHelper.createAndSendTransaction(publisherAddr, wirePayload)
            return { txid: txHash }
        })
    })

    after(async function () {
        if (httpServer) await new Promise((r) => httpServer.close(() => r()))
        if (mvh) {
            await mvh.stop()
            await mvh.dropDatabases()
        }
    })

    it('drives a redundancy=3 request through real PBFT and fires the callback', async function () {
        // EXECUTE the contract — emits ATTEST v0 (request)(redundancy=3).
        const exec = await vmHelper.sendExecuteV0(owner, contractIndex, 'askOracle', [testUrl])
        assert.strictEqual(exec.execution.status, 'valid', 'execute should be valid')

        const request = await indexerDatabase.waitForAttestationRequest({
            txHash:        exec.txHash,
            requestStatus: 'pending'
        })
        assert(request, 'pending attestation_requests row should exist')
        assert.strictEqual(Number(request.redundancy), 3)
        const requestId = request.request_id

        // Hubs need CONFIRMATIONS (default 3) blocks past the request before
        // they fetch. Mine extras so the round actually fires within polling.
        await regtestMinerConnector.generateBlocks(6)

        // The hubs poll the indexer every 15s for new pending requests, then
        // run PBFT and the leader publishes ATTEST v1 (response) on-chain.
        // Allow generous time for the full cycle: poll latency + fetch + PBFT
        // PROPOSE/PREPARE/COMMIT + on-chain broadcast + indexer-side response
        // handling + callback EXECUTE.
        const response = await indexerDatabase.waitForAttestationResponse({
            requestId:      requestId,
            responseStatus: 'ok',
            status:         'valid'
        }, 180_000)
        assert(response, 'attestation_responses row should land with status=ok')

        // The response must carry at least REDUNDANCY=3 verified signatures.
        const sigs = await indexerDatabase.getAttestationValidatorSignatures(response.action_index)
        assert(sigs.length >= 3, 'expected ≥3 verified validator signatures, got ' + sigs.length)
        const sigPubkeys = new Set(sigs.map(s => String(s.validator_pubkey).toLowerCase()))
        for (const pk of mvh.getPubkeys()) {
            assert(sigPubkeys.has(pk.toLowerCase()), 'expected sig from hub pubkey ' + pk.slice(0, 16) + '...')
        }

        // Request flipped to fulfilled
        const fulfilled = await indexerDatabase.checkAttestationRequest({
            requestId:     requestId,
            requestStatus: 'fulfilled'
        })
        assert(fulfilled, 'request_status should be fulfilled')

        // Callback EXECUTE was injected
        assert(response.callback_execute_action_index, 'callback_execute_action_index should be set')

        // Contract state reflects the fetched body
        const cbStatus  = await indexerDatabase.getContractState(contractIndex, 'callback_status')
        const cbPayload = await indexerDatabase.getContractState(contractIndex, 'callback_payload')
        const cbContext = await indexerDatabase.getContractState(contractIndex, 'callback_context')
        assert(cbStatus,  'callback_status state should exist')
        assert(cbPayload, 'callback_payload state should exist')
        assert.strictEqual(JSON.parse(cbStatus.state_value),  'ok')
        assert.strictEqual(JSON.parse(cbPayload.state_value), FIXED_BODY)
        assert.strictEqual(JSON.parse(cbContext.state_value), 'ctx-mvh')
    })
})
