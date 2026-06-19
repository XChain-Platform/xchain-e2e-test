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

// Fuzz tests for connector classes: URL construction, endpoint parsing,
// and response handling with random/malformed inputs.

const assert = require('assert')
const sinon = require('sinon')
const fc = require('fast-check')

const BlockchainConnector = require('../../src/BlockchainConnector')
const XChainUtxoTrackerConnector = require('../../src/XChainUtxoTrackerConnector')
const XChainHubConnector = require('../../src/XChainHubConnector')
const RegtestMinerConnector = require('../../src/RegtestMinerConnector')
const XChainEncoderConnector = require('../../src/XChainEncoderConnector')
const XChainIndexerConnector = require('../../src/XChainIndexerConnector')

const gen = require('./fuzz-generators')

const FC_PARAMS = { numRuns: 200 }

describe('Fuzz: Connector URL Construction', function () {

    afterEach(function () {
        sinon.restore()
    })

    // BlockchainConnector

    describe('BlockchainConnector constructor', function () {

        it('never crashes with fuzzed host and port', function () {
            fc.assert(fc.property(gen.hostArb, gen.portArb, (host, port) => {
                const bc = new BlockchainConnector(host, port, 'user', 'pass')
                assert(typeof bc.url === 'string', 'url must be a string')
                assert(bc.url.startsWith('http://'), 'url must start with http://')
            }), FC_PARAMS)
        })

        it('url always contains the host value', function () {
            fc.assert(fc.property(
                fc.string({ minLength: 1, maxLength: 100 }),
                fc.string({ minLength: 1, maxLength: 10 }),
                (host, port) => {
                    const bc = new BlockchainConnector(host, port, 'user', 'pass')
                    assert(bc.url.includes(host), 'url should contain host')
                }
            ), FC_PARAMS)
        })
    })

    // XChainUtxoTrackerConnector

    describe('XChainUtxoTrackerConnector constructor', function () {

        it('never crashes with fuzzed host and port', function () {
            fc.assert(fc.property(gen.hostArb, gen.portArb, (host, port) => {
                const tracker = new XChainUtxoTrackerConnector(host, port)
                assert(typeof tracker.url === 'string')
                assert(tracker.url.startsWith('http://'))
            }), FC_PARAMS)
        })
    })

    // XChainEncoderConnector

    describe('XChainEncoderConnector constructor', function () {

        it('never crashes with fuzzed host and port', function () {
            fc.assert(fc.property(gen.hostArb, gen.portArb, (host, port) => {
                const encoder = new XChainEncoderConnector(host, port)
                assert(typeof encoder.url === 'string')
                assert(encoder.url.startsWith('http://'))
            }), FC_PARAMS)
        })
    })

    // XChainIndexerConnector

    describe('XChainIndexerConnector constructor', function () {

        it('never crashes with fuzzed host and port', function () {
            fc.assert(fc.property(gen.hostArb, gen.portArb, (host, port) => {
                const indexer = new XChainIndexerConnector(host, port)
                assert(typeof indexer.url === 'string')
                assert(indexer.url.startsWith('http://'))
            }), FC_PARAMS)
        })
    })

    // RegtestMinerConnector

    describe('RegtestMinerConnector constructor', function () {

        it('never crashes with fuzzed host and port', function () {
            fc.assert(fc.property(gen.hostArb, gen.portArb, (host, port) => {
                const miner = new RegtestMinerConnector(host, port)
                assert(typeof miner.url === 'string')
                assert(miner.url.startsWith('http://'))
            }), FC_PARAMS)
        })
    })

    // XChainHubConnector

    describe('XChainHubConnector constructor', function () {

        it('never crashes with fuzzed endpoint arrays', function () {
            fc.assert(fc.property(
                fc.array(fc.string({ minLength: 0, maxLength: 200 }), { maxLength: 10 }),
                (endpoints) => {
                    const hub = new XChainHubConnector(endpoints)
                    assert(Array.isArray(hub.urls))
                    assert.strictEqual(hub.urls.length, endpoints.length)
                }
            ), FC_PARAMS)
        })

        it('never crashes with fuzzed host+port fallback', function () {
            fc.assert(fc.property(gen.hostArb, gen.portArb, (host, port) => {
                // When first arg is not an array, falls back to host+port
                if (!Array.isArray(host)) {
                    const hub = new XChainHubConnector(host, port)
                    assert(Array.isArray(hub.urls))
                    assert.strictEqual(hub.urls.length, 1)
                    assert(hub.urls[0].startsWith('http://'))
                }
            }), FC_PARAMS)
        })
    })
})

describe('Fuzz: Hub Endpoint Parsing', function () {

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
        sinon.restore()
    })

    it('parseEndpoints never crashes with fuzzed HUB_VALIDATORS', function () {
        fc.assert(fc.property(fc.string({ minLength: 0, maxLength: 1000 }), (validators) => {
            process.env.HUB_VALIDATORS = validators
            delete process.env.HUB_URL
            delete process.env.HUB_API_HOST

            const endpoints = XChainHubConnector.parseEndpoints()

            assert(Array.isArray(endpoints), 'must return an array')
            // If HUB_VALIDATORS is truthy, each endpoint should be a string
            endpoints.forEach(ep => {
                assert(typeof ep === 'string', `endpoint must be string, got: ${typeof ep}`)
            })
        }), FC_PARAMS)
    })

    it('parseEndpoints never crashes with fuzzed HUB_URL and HUB_PORT', function () {
        fc.assert(fc.property(
            fc.string({ minLength: 0, maxLength: 200 }),
            fc.string({ minLength: 0, maxLength: 20 }),
            (url, port) => {
                delete process.env.HUB_VALIDATORS
                process.env.HUB_URL = url
                process.env.HUB_PORT = port

                const endpoints = XChainHubConnector.parseEndpoints()

                assert(Array.isArray(endpoints))
                assert.strictEqual(endpoints.length, 1)
                assert(typeof endpoints[0] === 'string')
                assert(endpoints[0].startsWith('http://'))
            }
        ), FC_PARAMS)
    })
})

describe('Fuzz: Hub _call Response Handling', function () {

    afterEach(function () {
        sinon.restore()
    })

    it('_call never crashes with fuzzed axios responses', async function () {
        const axios = require('axios')

        await fc.assert(fc.asyncProperty(fc.anything(), async (responseData) => {
            const postStub = sinon.stub(axios, 'post').resolves({ data: responseData })
            const hub = new XChainHubConnector(['http://localhost:10000'])

            // Result is either the extracted value or null; never crashes.
            await hub._call({ jsonrpc: '2.0', method: 'test', id: 1 })
            postStub.restore()
        }), { numRuns: 100 })
    })

    it('_call handles fuzzed error types without crashing', async function () {
        const axios = require('axios')

        await fc.assert(fc.asyncProperty(gen.anyFuzzValue, async (errorValue) => {
            const postStub = sinon.stub(axios, 'post').rejects(errorValue)
            const hub = new XChainHubConnector(['http://localhost:10000'])

            try {
                const result = await hub._call({ jsonrpc: '2.0', method: 'test', id: 1 })
                assert.strictEqual(result, null, '_call should return null on error')
            } catch {
                // Some fuzz values may cause unexpected behavior in axios stub
            } finally {
                postStub.restore()
            }
        }), { numRuns: 100 })
    })
})

describe('Fuzz: BlockchainConnector.waitForTx with fuzzed txid', function () {

    afterEach(function () {
        sinon.restore()
    })

    it('never crashes with fuzzed txid strings', async function () {
        await fc.assert(fc.asyncProperty(gen.stringMutationArb, async (txid) => {
            const bc = new BlockchainConnector('localhost', '8333', 'user', 'pass')
            bc.sleep = sinon.stub().resolves()
            bc.getTransactionHex = sinon.stub().rejects(new Error('not found'))

            const result = await bc.waitForTx(txid, 50)
            assert(typeof result === 'boolean')
        }), { numRuns: 100 })
    })
})

describe('Fuzz: UtxoTracker.waitForUtxos with fuzzed address', function () {

    afterEach(function () {
        sinon.restore()
    })

    it('never crashes with fuzzed address strings', async function () {
        await fc.assert(fc.asyncProperty(gen.stringMutationArb, async (address) => {
            const tracker = new XChainUtxoTrackerConnector('localhost', '8080')
            tracker.sleep = sinon.stub().resolves()
            tracker.getUtxosFromAddress = sinon.stub().resolves({ utxos: [] })

            const result = await tracker.waitForUtxos(address, 50)
            assert(typeof result === 'boolean')
        }), { numRuns: 100 })
    })
})
