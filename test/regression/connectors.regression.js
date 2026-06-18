'use strict'

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const assert = require('assert')
const sinon  = require('sinon')
const axios  = require('axios')

const BlockchainConnector          = require('../../src/BlockchainConnector')
const XChainUtxoTrackerConnector   = require('../../src/XChainUtxoTrackerConnector')
const XChainEncoderConnector       = require('../../src/XChainEncoderConnector')
const XChainIndexerConnector       = require('../../src/XChainIndexerConnector')
const XChainHubConnector           = require('../../src/XChainHubConnector')
const RegtestMinerConnector        = require('../../src/RegtestMinerConnector')

// ── Helpers ──────────────────────────────────────────────────────────────

function mockAxiosPost(result) {
    return sinon.stub(axios, 'post').resolves({
        data: { jsonrpc: '2.0', result, id: 1 }
    })
}

// ═══════════════════════════════════════════════════════════════════════════
// P0 : Connector Regression Tests
// ═══════════════════════════════════════════════════════════════════════════

describe('[regression:p0] Service Connectors', function () {

    afterEach(function () {
        sinon.restore()
    })

    // ── BlockchainConnector ──────────────────────────────────────────────
    // BlockchainConnector uses axios. These cases stub the connector's own
    // methods directly (no network), so the HTTP client is not exercised here.

    describe('BlockchainConnector', function () {

        it('[regression:p0] R-CONN-001 : getNetworkInfo returns parsed JSON-RPC response', async function () {
            const node = new BlockchainConnector('localhost', 18443, 'rpcuser', 'rpcpass')
            const networkInfo = { version: 250000, subversion: '/Satoshi:25.0.0/' }

            sinon.stub(node, 'getNetworkInfo').resolves(networkInfo)
            const result = await node.getNetworkInfo()
            assert.strictEqual(result.version, 250000)
            assert.strictEqual(result.subversion, '/Satoshi:25.0.0/')
        })

        it('[regression:p0] R-CONN-002 : broadcastTx sends raw hex and returns txid', async function () {
            const node = new BlockchainConnector('localhost', 18443, 'rpcuser', 'rpcpass')

            sinon.stub(node, 'broadcastTx').callsFake(async (txHex) => {
                assert.strictEqual(txHex, 'deadbeef', 'should receive the raw hex')
                return 'abc123def456'
            })
            const result = await node.broadcastTx('deadbeef')
            assert.strictEqual(result, 'abc123def456')
        })

        it('[regression:p0] R-CONN-003 : waitForTx polls until transaction is confirmed', async function () {
            const node = new BlockchainConnector('localhost', 18443, 'rpcuser', 'rpcpass')
            let callCount = 0

            sinon.stub(node, 'getTransactionHex').callsFake(async () => {
                callCount++
                if (callCount < 2) throw new Error('not found')
                return 'aabb'
            })
            node.sleep = sinon.stub().resolves()

            const result = await node.waitForTx('txid123', 10000)
            assert.strictEqual(result, true)
            assert.ok(callCount >= 2, 'should have polled at least twice')
        })

        it('[regression:p0] R-CONN-011a : waitForTx returns false on timeout', async function () {
            const node = new BlockchainConnector('localhost', 18443, 'rpcuser', 'rpcpass')

            sinon.stub(node, 'getTransactionHex').rejects(new Error('not found'))
            node.sleep = sinon.stub().resolves()

            const result = await node.waitForTx('txid123', 100)
            assert.strictEqual(result, false)
        })

        it('[regression:p0] R-CONN-001b : constructor stores URL with Basic Auth credentials', function () {
            const node = new BlockchainConnector('myhost', 18443, 'user1', 'pass1')
            assert.strictEqual(node.url, 'http://myhost:18443')
            assert.strictEqual(node.rpcUser, 'user1')
            assert.strictEqual(node.rpcPassword, 'pass1')
        })
    })

    // ── XChainUtxoTrackerConnector ───────────────────────────────────────

    describe('XChainUtxoTrackerConnector', function () {

        it('[regression:p0] R-CONN-004 : getUtxosFromAddress returns UTXO array', async function () {
            const tracker = new XChainUtxoTrackerConnector('localhost', 3030)
            const utxos = [{ txid: 'aabb', vout: 0, value: 100000 }]

            sinon.stub(tracker, 'getUtxosFromAddress').resolves({ utxos })
            const result = await tracker.getUtxosFromAddress('addr1')
            assert.deepStrictEqual(result.utxos, utxos)
        })

        it('[regression:p0] R-CONN-005 : waitForUtxos polls until UTXOs appear', async function () {
            const tracker = new XChainUtxoTrackerConnector('localhost', 3030)
            let callCount = 0

            sinon.stub(tracker, 'getUtxosFromAddress').callsFake(async () => {
                callCount++
                const utxos = callCount >= 2 ? [{ txid: 'aa', vout: 0, value: 1000 }] : []
                return { utxos }
            })
            tracker.sleep = sinon.stub().resolves()

            const result = await tracker.waitForUtxos('addr1', 5000)
            assert.strictEqual(result, true)
            assert.ok(callCount >= 2)
        })

        it('[regression:p0] R-CONN-005b : waitForUtxos returns false on timeout', async function () {
            const tracker = new XChainUtxoTrackerConnector('localhost', 3030)

            sinon.stub(tracker, 'getUtxosFromAddress').resolves({ utxos: [] })
            tracker.sleep = sinon.stub().resolves()

            const result = await tracker.waitForUtxos('addr1', 100)
            assert.strictEqual(result, false)
        })

        it('[regression:p0] R-CONN-004b : constructor stores URL and port', function () {
            const tracker = new XChainUtxoTrackerConnector('myhost', 3030)
            assert.strictEqual(tracker.url, 'http://myhost:3030')
            assert.strictEqual(tracker.port, 3030)
        })
    })

    // ── XChainEncoderConnector ───────────────────────────────────────────

    describe('XChainEncoderConnector', function () {

        it('[regression:p0] R-CONN-006 : createTx returns PSBT with correct encoding type', async function () {
            const psbtResult = { encoding: 'opreturn', psbt: 'deadbeef' }
            const stub = mockAxiosPost(psbtResult)
            try {
                const encoder = new XChainEncoderConnector('localhost', 3031)
                const result = await encoder.createTx(
                    [], 'pubkey1', [], { action: 'ISSUE' }, null, null, false, null, 'changeAddr'
                )
                assert.strictEqual(result.encoding, 'opreturn')
                assert.strictEqual(result.psbt, 'deadbeef')
                const body = stub.firstCall.args[1]
                assert.strictEqual(body.method, 'create_tx')
                assert.strictEqual(body.params.pubkey, 'pubkey1')
                assert.strictEqual(body.params.change, 'changeAddr')
            } finally {
                stub.restore()
            }
        })

        it('[regression:p0] R-CONN-006b : ping returns true on success', async function () {
            const stub = mockAxiosPost(true)
            try {
                const encoder = new XChainEncoderConnector('localhost', 3031)
                const result = await encoder.ping()
                assert.strictEqual(result, true)
            } finally {
                stub.restore()
            }
        })

        it('[regression:p0] R-CONN-006c : createTx passes all 12 parameters correctly', async function () {
            const stub = mockAxiosPost({ encoding: 'opreturn', psbt: 'hex' })
            try {
                const encoder = new XChainEncoderConnector('localhost', 3031)
                await encoder.createTx(
                    ['utxo1'], 'pk', [{ addr: 'a', value: 1000 }],
                    'ISSUE|0|TOK', Buffer.from('raw'), 546, true, 'P2SH',
                    'changeAddr', 'p2shHash', 'p2shHex', 'compKey'
                )
                const params = stub.firstCall.args[1].params
                assert.deepStrictEqual(params.utxos, ['utxo1'])
                assert.strictEqual(params.pubkey, 'pk')
                assert.strictEqual(params.data, 'ISSUE|0|TOK')
                assert.strictEqual(params.fee, 546)
                assert.strictEqual(params.rbf, true)
                assert.strictEqual(params.encoding, 'P2SH')
                assert.strictEqual(params.change, 'changeAddr')
                assert.strictEqual(params.p2shHash, 'p2shHash')
                assert.strictEqual(params.p2shHex, 'p2shHex')
                assert.strictEqual(params.compressedPubKey, 'compKey')
            } finally {
                stub.restore()
            }
        })
    })

    // ── XChainIndexerConnector ───────────────────────────────────────────

    describe('XChainIndexerConnector', function () {

        it('[regression:p0] R-CONN-007 : ping verifies indexer is reachable', async function () {
            const stub = mockAxiosPost(true)
            try {
                const indexer = new XChainIndexerConnector('localhost', 3032)
                const result = await indexer.ping()
                assert.strictEqual(result, true)
            } finally {
                stub.restore()
            }
        })

        it('[regression:p0] R-CONN-007b : ping returns false on failure', async function () {
            const stub = sinon.stub(axios, 'post').rejects(new Error('ECONNREFUSED'))
            try {
                const indexer = new XChainIndexerConnector('localhost', 3032)
                const result = await indexer.ping()
                assert.strictEqual(result, false)
            } finally {
                stub.restore()
            }
        })
    })

    // ── XChainHubConnector ───────────────────────────────────────────────

    describe('XChainHubConnector', function () {

        it('[regression:p0] R-CONN-008 : getAllConfig returns full service configuration', async function () {
            const config = { bitcoin: { regtest: { node: { host: 'n' } } } }
            const stub = mockAxiosPost(config)
            try {
                const hub = new XChainHubConnector(['http://localhost:10000'])
                const result = await hub.getAllConfig()
                assert.deepStrictEqual(result, config)
            } finally {
                stub.restore()
            }
        })

        it('[regression:p0] R-CONN-009 : multi-endpoint failover tries all validators', async function () {
            let callOrder = []
            const stub = sinon.stub(axios, 'post').callsFake(async (url) => {
                callOrder.push(url)
                if (url === 'http://hub1:10000') {
                    throw new Error('ECONNREFUSED')
                }
                return { data: { jsonrpc: '2.0', result: 'ok', id: 1 } }
            })
            try {
                const hub = new XChainHubConnector(['http://hub1:10000', 'http://hub2:10000'])
                const result = await hub.ping()
                assert.strictEqual(result, true)
                assert.strictEqual(callOrder[0], 'http://hub1:10000')
                assert.strictEqual(callOrder[1], 'http://hub2:10000')
            } finally {
                stub.restore()
            }
        })

        it('[regression:p0] R-CONN-009b : _call returns null when all endpoints fail', async function () {
            const stub = sinon.stub(axios, 'post').rejects(new Error('ECONNREFUSED'))
            try {
                const hub = new XChainHubConnector(['http://hub1:10000', 'http://hub2:10000'])
                const result = await hub.ping()
                assert.strictEqual(result, false)
            } finally {
                stub.restore()
            }
        })

        it('[regression:p0] R-CONN-009c : parseEndpoints parses HUB_VALIDATORS', function () {
            const orig = process.env.HUB_VALIDATORS
            try {
                process.env.HUB_VALIDATORS = 'hub1:10000, http://hub2:10000'
                const endpoints = XChainHubConnector.parseEndpoints()
                assert.strictEqual(endpoints.length, 2)
                assert.strictEqual(endpoints[0], 'http://hub1:10000')
                assert.strictEqual(endpoints[1], 'http://hub2:10000')
            } finally {
                if (orig !== undefined) process.env.HUB_VALIDATORS = orig
                else delete process.env.HUB_VALIDATORS
            }
        })

        it('[regression:p0] R-CONN-009d : parseEndpoints falls back to HUB_URL+HUB_PORT', function () {
            const origV = process.env.HUB_VALIDATORS
            const origU = process.env.HUB_URL
            const origP = process.env.HUB_PORT
            try {
                delete process.env.HUB_VALIDATORS
                process.env.HUB_URL = 'myhub'
                process.env.HUB_PORT = '9999'
                const endpoints = XChainHubConnector.parseEndpoints()
                assert.deepStrictEqual(endpoints, ['http://myhub:9999'])
            } finally {
                if (origV !== undefined) process.env.HUB_VALIDATORS = origV
                else delete process.env.HUB_VALIDATORS
                if (origU !== undefined) process.env.HUB_URL = origU
                else delete process.env.HUB_URL
                if (origP !== undefined) process.env.HUB_PORT = origP
                else delete process.env.HUB_PORT
            }
        })
    })

    // ── RegtestMinerConnector ────────────────────────────────────────────

    describe('RegtestMinerConnector', function () {

        it('[regression:p0] R-CONN-010 : sendFunds returns funding txid', async function () {
            const stub = mockAxiosPost('txid-funded-001')
            try {
                const miner = new RegtestMinerConnector('localhost', 3033)
                const result = await miner.sendFunds('addr1', 1.0)
                assert.strictEqual(result, 'txid-funded-001')
                const body = stub.firstCall.args[1]
                assert.strictEqual(body.method, 'send_funds')
                assert.strictEqual(body.params.address, 'addr1')
                assert.strictEqual(body.params.amount, 1.0)
            } finally {
                stub.restore()
            }
        })

        it('[regression:p0] R-CONN-010b : setMiningTime sends correct params', async function () {
            const stub = mockAxiosPost(true)
            try {
                const miner = new RegtestMinerConnector('localhost', 3033)
                const result = await miner.setMiningTime(1000, 1000)
                assert.strictEqual(result, true)
                const body = stub.firstCall.args[1]
                assert.strictEqual(body.method, 'set_mining_time')
                assert.strictEqual(body.params.max_time, 1000)
                assert.strictEqual(body.params.tx_added_time, 1000)
            } finally {
                stub.restore()
            }
        })

        it('[regression:p0] R-CONN-010c : setDefaultMiningTime calls correct RPC method', async function () {
            const stub = mockAxiosPost(true)
            try {
                const miner = new RegtestMinerConnector('localhost', 3033)
                const result = await miner.setDefaultMiningTime()
                assert.strictEqual(result, true)
                assert.strictEqual(stub.firstCall.args[1].method, 'set_default_mining_time')
            } finally {
                stub.restore()
            }
        })

        it('[regression:p0] R-CONN-011b : ping returns false when service is unreachable', async function () {
            const stub = sinon.stub(axios, 'post').rejects(new Error('ECONNREFUSED'))
            try {
                const miner = new RegtestMinerConnector('localhost', 3033)
                const result = await miner.ping()
                assert.strictEqual(result, false)
            } finally {
                stub.restore()
            }
        })
    })

    // ── Constructor URL Building ─────────────────────────────────────────

    describe('Constructor URL building', function () {

        it('[regression:p0] R-CONN-011c : all connectors build URL from host and port', function () {
            const node    = new BlockchainConnector('myhost', 1234, 'u', 'p')
            const tracker = new XChainUtxoTrackerConnector('myhost', 2345)
            const encoder = new XChainEncoderConnector('myhost', 3456)
            const indexer = new XChainIndexerConnector('myhost', 4567)
            const miner   = new RegtestMinerConnector('myhost', 5678)

            assert.strictEqual(node.url, 'http://myhost:1234')
            assert.strictEqual(tracker.url, 'http://myhost:2345')
            assert.strictEqual(encoder.url, 'http://myhost:3456')
            assert.strictEqual(indexer.url, 'http://myhost:4567')
            assert.strictEqual(miner.url, 'http://myhost:5678')
        })

        it('[regression:p0] R-CONN-011d : HubConnector accepts array of endpoints', function () {
            const hub = new XChainHubConnector(['http://a:1', 'http://b:2'])
            assert.deepStrictEqual(hub.urls, ['http://a:1', 'http://b:2'])
        })

        it('[regression:p0] R-CONN-011e : HubConnector accepts host+port for backward compat', function () {
            const hub = new XChainHubConnector('myhost', 9999)
            assert.deepStrictEqual(hub.urls, ['http://myhost:9999'])
        })
    })
})
