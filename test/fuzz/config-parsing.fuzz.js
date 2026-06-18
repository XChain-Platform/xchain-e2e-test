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

// Fuzz tests for configuration parsing: hub config destructuring,
// environment variable handling, and isNullOrNullString edge cases.

const assert = require('assert')
const sinon = require('sinon')
const fc = require('fast-check')

const gen = require('./fuzz-generators')

// Inject mock mariadb
const mockMariadb = require('../integration/fixtures/mockMariadb')
const Database = require('../../src/db')
const XChainHubConnector = require('../../src/XChainHubConnector')

const FC_PARAMS = { numRuns: 200 }

// ── Helpers ──────────────────────────────────────────────────────

function createDb() {
    const mockConn = { query: sinon.stub().resolves([]), release: sinon.stub().resolves() }
    const mockPool = { getConnection: sinon.stub().resolves(mockConn) }
    mockMariadb.createPool.returns(mockPool)
    return new Database('localhost', 3306, 'test_db', 'user', 'pass')
}

describe('Fuzz: Config Parsing', function () {

    afterEach(function () {
        sinon.restore()
        mockMariadb.createPool.resetHistory()
    })

    // ── Hub config destructuring ────────────────────────────────

    describe('Hub config response destructuring', function () {

        // Replicate the config destructuring pattern from initialCheck.test.js lines 113-140
        function extractNodeConfig(hubConfigs, coin, network) {
            return {
                nodeUrl: hubConfigs[coin][network]['node']['host'],
                nodePort: hubConfigs[coin][network]['node']['server_port'],
                nodeUser: hubConfigs[coin][network]['node']['user'],
                nodePass: hubConfigs[coin][network]['node']['pass'],
            }
        }

        function extractAllConfigs(hubConfigs, coin, network) {
            const cfg = hubConfigs[coin][network]
            return {
                nodeUrl: cfg['node']['host'],
                nodePort: cfg['node']['server_port'],
                nodeUser: cfg['node']['user'],
                nodePass: cfg['node']['pass'],
                dbUrl: cfg['database']['host'],
                dbPort: cfg['database']['port'],
                utxoUrl: cfg['xchain-utxo-tracker']['host'],
                utxoPort: cfg['xchain-utxo-tracker']['server_port'],
                encoderUrl: cfg['xchain-encoder']['host'],
                encoderPort: cfg['xchain-encoder']['server_port'],
                indexerUrl: cfg['xchain-indexer']['host'],
                indexerPort: cfg['xchain-indexer']['server_port'],
                indexerName: cfg['xchain-indexer']['name'],
                indexerUser: cfg['xchain-indexer']['user'],
                indexerPass: cfg['xchain-indexer']['pass'],
                minerUrl: cfg['xchain-regtest-miner']['host'],
                minerPort: cfg['xchain-regtest-miner']['server_port'],
            }
        }

        it('throws when hubConfigs is null or undefined', function () {
            fc.assert(fc.property(
                fc.constantFrom(null, undefined),
                (config) => {
                    try {
                        extractNodeConfig(config, 'bitcoin', 'regtest')
                        assert.fail('should throw on null/undefined config')
                    } catch (e) {
                        assert(e instanceof TypeError, `expected TypeError, got: ${e.constructor.name}`)
                    }
                }
            ))
        })

        it('throws when coin key is missing', function () {
            fc.assert(fc.property(
                fc.constantFrom({}, { litecoin: {} }, { bitcoin: null }),
                (config) => {
                    try {
                        extractNodeConfig(config, 'bitcoin', 'regtest')
                        assert.fail('should throw on missing coin key')
                    } catch (e) {
                        assert(e instanceof TypeError)
                    }
                }
            ))
        })

        it('throws when network key is missing', function () {
            fc.assert(fc.property(
                fc.constantFrom(
                    { bitcoin: {} },
                    { bitcoin: { mainnet: {} } },
                    { bitcoin: { regtest: null } }
                ),
                (config) => {
                    try {
                        extractNodeConfig(config, 'bitcoin', 'regtest')
                        assert.fail('should throw on missing network key')
                    } catch (e) {
                        assert(e instanceof TypeError)
                    }
                }
            ))
        })

        it('throws when service key is missing', function () {
            fc.assert(fc.property(
                fc.constantFrom(
                    { bitcoin: { regtest: {} } },
                    { bitcoin: { regtest: { node: null } } }
                ),
                (config) => {
                    try {
                        extractNodeConfig(config, 'bitcoin', 'regtest')
                        assert.fail('should throw on missing service key')
                    } catch (e) {
                        assert(e instanceof TypeError)
                    }
                }
            ))
        })

        it('succeeds with valid complete config', function () {
            const validConfig = {
                bitcoin: {
                    regtest: {
                        node: { host: 'h', server_port: 1, user: 'u', pass: 'p' },
                        database: { host: 'h', port: 2 },
                        'xchain-utxo-tracker': { host: 'h', server_port: 3 },
                        'xchain-encoder': { host: 'h', server_port: 4 },
                        'xchain-indexer': { host: 'h', server_port: 5, name: 'n', user: 'u', pass: 'p' },
                        'xchain-regtest-miner': { host: 'h', server_port: 6 }
                    }
                }
            }

            const result = extractAllConfigs(validConfig, 'bitcoin', 'regtest')
            assert.strictEqual(result.nodeUrl, 'h')
            assert.strictEqual(result.nodePort, 1)
            assert.strictEqual(result.minerPort, 6)
        })

        it('extracts values even when they are fuzzed types', function () {
            fc.assert(fc.property(gen.anyFuzzValue, gen.anyFuzzValue, (hostVal, portVal) => {
                const config = {
                    bitcoin: {
                        regtest: {
                            node: { host: hostVal, server_port: portVal, user: hostVal, pass: hostVal },
                            database: { host: hostVal, port: portVal },
                            'xchain-utxo-tracker': { host: hostVal, server_port: portVal },
                            'xchain-encoder': { host: hostVal, server_port: portVal },
                            'xchain-indexer': { host: hostVal, server_port: portVal, name: hostVal, user: hostVal, pass: hostVal },
                            'xchain-regtest-miner': { host: hostVal, server_port: portVal }
                        }
                    }
                }

                // Should not crash: destructuring always succeeds when keys exist
                const result = extractAllConfigs(config, 'bitcoin', 'regtest')
                assert(typeof result === 'object')
                // Values may be any type; that's what we're testing
            }), FC_PARAMS)
        })
    })

    // ── isNullOrNullString comprehensive fuzz ───────────────────

    describe('isNullOrNullString with all JS types', function () {

        it('always returns a boolean for any input', function () {
            const db = createDb()

            fc.assert(fc.property(gen.anyFuzzValue, (value) => {
                const result = db.isNullOrNullString(value)
                assert(typeof result === 'boolean',
                    `should return boolean, got ${typeof result} for input ${String(value)}`)
            }), { numRuns: 500 })
        })

        it('documents loose equality traps: values that are "null-like"', function () {
            const db = createDb()

            // These values are == null or == "" due to JavaScript loose equality
            const nullLikeValues = [null, undefined, '', 0, false, []]
            for (const val of nullLikeValues) {
                const result = db.isNullOrNullString(val)
                assert.strictEqual(result, true,
                    `${JSON.stringify(val)} should be null-like due to loose ==`)
            }
        })

        it('documents values that are NOT "null-like"', function () {
            const db = createDb()

            const notNullLike = [' ', 'null', '0', 'false', 'undefined', 1, -1, true, 'x', NaN, {}, [1]]
            for (const val of notNullLike) {
                const result = db.isNullOrNullString(val)
                assert.strictEqual(result, false,
                    `${JSON.stringify(val)} should NOT be null-like`)
            }
        })
    })

    // ── checkAllEnvironmentalVariables pattern fuzz ──────────────

    describe('Environment variable validation pattern', function () {

        // Replicate the check pattern from initialCheck.test.js
        function checkAllVars(vars) {
            return vars.every(v => v !== null && v !== undefined)
        }

        it('returns false when any variable is null or undefined', function () {
            fc.assert(fc.property(
                fc.array(fc.oneof(
                    fc.string(),
                    fc.constant(null),
                    fc.constant(undefined)
                ), { minLength: 1, maxLength: 20 }),
                (vars) => {
                    const hasNullOrUndefined = vars.some(v => v === null || v === undefined)
                    const result = checkAllVars(vars)
                    assert.strictEqual(result, !hasNullOrUndefined)
                }
            ), FC_PARAMS)
        })

        it('returns true for arrays of non-null strings (even empty)', function () {
            fc.assert(fc.property(
                fc.array(fc.string(), { minLength: 1, maxLength: 20 }),
                (vars) => {
                    assert.strictEqual(checkAllVars(vars), true)
                }
            ), FC_PARAMS)
        })

        it('empty string passes the check (not null/undefined)', function () {
            assert.strictEqual(checkAllVars(['']), true)
            assert.strictEqual(checkAllVars(['', '', '']), true)
        })

        it('0 and false pass the check (not null/undefined)', function () {
            assert.strictEqual(checkAllVars([0]), true)
            assert.strictEqual(checkAllVars([false]), true)
            assert.strictEqual(checkAllVars([0, false, '']), true)
        })
    })

    // ── Database constructor with fuzzed parameters ─────────────

    describe('Database constructor with fuzzed connection params', function () {

        it('never crashes during construction', function () {
            fc.assert(fc.property(
                gen.hostArb, gen.portArb,
                fc.string(), fc.string(), fc.string(),
                (host, port, dbName, user, pass) => {
                    mockMariadb.createPool.returns({
                        getConnection: sinon.stub().resolves({
                            query: sinon.stub().resolves([]),
                            release: sinon.stub().resolves(),
                        })
                    })

                    const db = new Database(host, port, dbName, user, pass)
                    assert(db.pool !== undefined, 'pool should be created')
                    assert.strictEqual(db.host, host)
                    assert.strictEqual(db.port, port)
                    assert.strictEqual(db.dbName, dbName)
                }
            ), { numRuns: 100 })
        })
    })
})
