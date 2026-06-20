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

// Boundary tests for connector classes: BlockchainConnector, UtxoTracker,
// XChainHubConnector, RegtestMinerConnector, XChainEncoderConnector, XChainIndexerConnector.
// Tests constructor behavior with edge-case inputs, method responses at boundaries,
// and multi-endpoint fallback in HubConnector.

const assert = require('assert')
const sinon = require('sinon')

const BlockchainConnector = require('../../src/BlockchainConnector')
const XChainUtxoTrackerConnector = require('../../src/XChainUtxoTrackerConnector')
const XChainHubConnector = require('../../src/XChainHubConnector')
const RegtestMinerConnector = require('../../src/RegtestMinerConnector')
const XChainEncoderConnector = require('../../src/XChainEncoderConnector')
const XChainIndexerConnector = require('../../src/XChainIndexerConnector')

describe('Boundary: Connectors', function () {

    afterEach(function () {
        sinon.restore()
    })

    describe('BlockchainConnector', function () {

        describe('constructor URL building', function () {

            it('builds correct URL from host and port', function () {
                const bc = new BlockchainConnector('myhost', '18443', 'user', 'pass')
                assert.strictEqual(bc.url, 'http://myhost:18443')
            })

            it('handles empty host string', function () {
                const bc = new BlockchainConnector('', '18443', 'user', 'pass')
                assert.strictEqual(bc.url, 'http://:18443')
            })

            it('handles numeric port as number', function () {
                const bc = new BlockchainConnector('localhost', 18443, 'user', 'pass')
                assert.strictEqual(bc.url, 'http://localhost:18443')
            })
        })

        describe('waitForTx: polling boundary with error recovery', function () {

            it('returns true on first success even after initial errors', async function () {
                const bc = new BlockchainConnector('localhost', '8333', 'user', 'pass')
                bc.sleep = sinon.stub().resolves()

                bc.getTransactionHex = sinon.stub()
                bc.getTransactionHex.onFirstCall().rejects(new Error('not found'))
                bc.getTransactionHex.onSecondCall().rejects(new Error('not found'))
                bc.getTransactionHex.onThirdCall().resolves('deadbeef')

                const result = await bc.waitForTx('txid123', 30000)

                assert.strictEqual(result, true)
                assert.strictEqual(bc.getTransactionHex.callCount, 3)
                assert.strictEqual(bc.sleep.callCount, 2)
            })

            it('returns false when all attempts fail within timeMax', async function () {
                const bc = new BlockchainConnector('localhost', '8333', 'user', 'pass')
                bc.sleep = sinon.stub().resolves()
                bc.getTransactionHex = sinon.stub().rejects(new Error('not found'))

                const result = await bc.waitForTx('txid123', 100)

                assert.strictEqual(result, false)
            })
        })
    })

    describe('XChainUtxoTrackerConnector', function () {

        describe('constructor', function () {

            it('builds correct URL', function () {
                const tracker = new XChainUtxoTrackerConnector('myhost', '9090')
                assert.strictEqual(tracker.url, 'http://myhost:9090')
            })
        })

        describe('waitForUtxos: empty vs non-empty UTXO responses', function () {

            it('returns false when getUtxosFromAddress always returns empty utxos array', async function () {
                const tracker = new XChainUtxoTrackerConnector('localhost', '8080')
                tracker.sleep = sinon.stub().resolves()
                tracker.getUtxosFromAddress = sinon.stub().resolves({ utxos: [] })

                const result = await tracker.waitForUtxos('addr1', 100)

                assert.strictEqual(result, false)
            })

            it('returns true when getUtxosFromAddress returns exactly one UTXO', async function () {
                const tracker = new XChainUtxoTrackerConnector('localhost', '8080')
                tracker.sleep = sinon.stub().resolves()
                tracker.getUtxosFromAddress = sinon.stub().resolves({
                    utxos: [{ txid: 'tx1', vout: 0, value: 546 }]
                })

                const result = await tracker.waitForUtxos('addr1', 5000)

                assert.strictEqual(result, true)
                assert.strictEqual(tracker.getUtxosFromAddress.callCount, 1)
            })

            it('handles getUtxosFromAddress throwing errors gracefully', async function () {
                const tracker = new XChainUtxoTrackerConnector('localhost', '8080')
                tracker.sleep = sinon.stub().resolves()
                tracker.getUtxosFromAddress = sinon.stub()
                tracker.getUtxosFromAddress.onFirstCall().rejects(new Error('connection refused'))
                tracker.getUtxosFromAddress.onSecondCall().resolves({
                    utxos: [{ txid: 'tx1', vout: 0, value: 10000 }]
                })

                const result = await tracker.waitForUtxos('addr1', 30000)

                assert.strictEqual(result, true)
                assert(tracker.sleep.callCount >= 1, 'should sleep after error')
            })
        })
    })

    describe('XChainHubConnector', function () {

        describe('constructor: endpoint handling', function () {

            it('accepts an array of endpoints', function () {
                const hub = new XChainHubConnector(['http://hub1:10000', 'http://hub2:10000'])
                assert.deepStrictEqual(hub.urls, ['http://hub1:10000', 'http://hub2:10000'])
            })

            it('wraps single host+port into array', function () {
                const hub = new XChainHubConnector('myhub', '10000')
                assert.deepStrictEqual(hub.urls, ['http://myhub:10000'])
            })

            it('handles empty array', function () {
                const hub = new XChainHubConnector([])
                assert.deepStrictEqual(hub.urls, [])
            })

            it('handles single-element array', function () {
                const hub = new XChainHubConnector(['http://hub1:10000'])
                assert.deepStrictEqual(hub.urls, ['http://hub1:10000'])
            })
        })

        describe('parseEndpoints: env var parsing', function () {

            let savedEnv

            beforeEach(function () {
                savedEnv = {
                    HUB_VALIDATORS: process.env.HUB_VALIDATORS,
                    HUB_URL: process.env.HUB_URL,
                    HUB_API_HOST: process.env.HUB_API_HOST,
                    HUB_PORT: process.env.HUB_PORT,
                }
            })

            afterEach(function () {
                Object.entries(savedEnv).forEach(([key, val]) => {
                    if (val === undefined) delete process.env[key]
                    else process.env[key] = val
                })
            })

            it('parses comma-separated HUB_VALIDATORS', function () {
                process.env.HUB_VALIDATORS = 'http://hub1:10000,http://hub2:10000'
                delete process.env.HUB_URL
                delete process.env.HUB_API_HOST

                const endpoints = XChainHubConnector.parseEndpoints()

                assert.deepStrictEqual(endpoints, ['http://hub1:10000', 'http://hub2:10000'])
            })

            it('adds http:// prefix to endpoints missing protocol', function () {
                process.env.HUB_VALIDATORS = 'hub1:10000,http://hub2:10000'
                delete process.env.HUB_URL

                const endpoints = XChainHubConnector.parseEndpoints()

                assert.deepStrictEqual(endpoints, ['http://hub1:10000', 'http://hub2:10000'])
            })

            it('trims whitespace from HUB_VALIDATORS entries', function () {
                process.env.HUB_VALIDATORS = '  http://hub1:10000 , http://hub2:10000  '
                delete process.env.HUB_URL

                const endpoints = XChainHubConnector.parseEndpoints()

                assert.deepStrictEqual(endpoints, ['http://hub1:10000', 'http://hub2:10000'])
            })

            it('filters empty entries from HUB_VALIDATORS', function () {
                process.env.HUB_VALIDATORS = 'http://hub1:10000,,, ,http://hub2:10000'
                delete process.env.HUB_URL

                const endpoints = XChainHubConnector.parseEndpoints()

                assert.deepStrictEqual(endpoints, ['http://hub1:10000', 'http://hub2:10000'])
            })

            it('empty string HUB_VALIDATORS falls through to default (falsy check)', function () {
                process.env.HUB_VALIDATORS = ''
                delete process.env.HUB_URL
                delete process.env.HUB_API_HOST
                delete process.env.HUB_PORT

                const endpoints = XChainHubConnector.parseEndpoints()

                // Empty string is falsy in JS, so the if(HUB_VALIDATORS) check
                // fails and falls through to the default localhost:10000
                assert.deepStrictEqual(endpoints, ['http://localhost:10000'])
            })

            it('falls back to HUB_URL when HUB_VALIDATORS is not set', function () {
                delete process.env.HUB_VALIDATORS
                process.env.HUB_URL = 'myhub'
                process.env.HUB_PORT = '12345'

                const endpoints = XChainHubConnector.parseEndpoints()

                assert.deepStrictEqual(endpoints, ['http://myhub:12345'])
            })

            it('falls back to HUB_API_HOST when HUB_URL and HUB_VALIDATORS not set', function () {
                delete process.env.HUB_VALIDATORS
                delete process.env.HUB_URL
                process.env.HUB_API_HOST = 'apihost'
                process.env.HUB_PORT = '9999'

                const endpoints = XChainHubConnector.parseEndpoints()

                assert.deepStrictEqual(endpoints, ['http://apihost:9999'])
            })

            it('defaults to localhost:10000 when no env vars set', function () {
                delete process.env.HUB_VALIDATORS
                delete process.env.HUB_URL
                delete process.env.HUB_API_HOST
                delete process.env.HUB_PORT

                const endpoints = XChainHubConnector.parseEndpoints()

                assert.deepStrictEqual(endpoints, ['http://localhost:10000'])
            })
        })

        describe('ping: with empty endpoint list', function () {

            it('returns false when no endpoints configured', async function () {
                const hub = new XChainHubConnector([])
                const result = await hub.ping()

                assert.strictEqual(result, false)
            })
        })

        describe('getAllConfig: with empty endpoint list', function () {

            it('returns null when no endpoints configured', async function () {
                const hub = new XChainHubConnector([])
                const result = await hub.getAllConfig()

                assert.strictEqual(result, null)
            })
        })
    })

    describe('RegtestMinerConnector', function () {

        describe('constructor', function () {

            it('builds correct URL', function () {
                const miner = new RegtestMinerConnector('myhost', '18888')
                assert.strictEqual(miner.url, 'http://myhost:18888')
                assert.strictEqual(miner.port, '18888')
            })
        })
    })

    describe('XChainEncoderConnector', function () {

        describe('constructor', function () {

            it('builds correct URL ignoring unused rpcUser/rpcPassword', function () {
                const encoder = new XChainEncoderConnector('myhost', '5555', 'ignored_user', 'ignored_pass')
                assert.strictEqual(encoder.url, 'http://myhost:5555')
                assert.strictEqual(encoder.port, '5555')
            })
        })
    })

    describe('XChainIndexerConnector', function () {

        describe('constructor', function () {

            it('builds correct URL', function () {
                const indexer = new XChainIndexerConnector('myhost', '7777')
                assert.strictEqual(indexer.url, 'http://myhost:7777')
                assert.strictEqual(indexer.port, '7777')
            })
        })
    })
})
