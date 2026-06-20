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

const CryptoNetworks             = require('../../src/CryptoNetworks')
const XChainHubConnector         = require('../../src/XChainHubConnector')
const BlockchainConnector        = require('../../src/BlockchainConnector')
const XChainUtxoTrackerConnector = require('../../src/XChainUtxoTrackerConnector')
const XChainEncoderConnector     = require('../../src/XChainEncoderConnector')
const XChainIndexerConnector     = require('../../src/XChainIndexerConnector')
const RegtestMinerConnector      = require('../../src/RegtestMinerConnector')

const mockMariadb = require('../integration/fixtures/mockMariadb')
const Database    = require('../../src/db')

const PerfCollector = require('../perf/perfCollector')

describe('[regression:p2] Configuration & Cross-Chain', function () {

    it('[regression:p2] R-CFG-001: CryptoNetworks resolves correct BTC regtest config', function () {
        const network = CryptoNetworks.getBitcoinJsNetwork('bitcoin-regtest')
        assert.ok(network)
        assert.strictEqual(network.dustThreshold, 546)
        assert.ok(network.bip32)
    })

    it('[regression:p2] R-CFG-002: CryptoNetworks resolves correct LTC regtest config', function () {
        const network = CryptoNetworks.getBitcoinJsNetwork('litecoin-regtest')
        assert.ok(network)
        // Litecoin's dust relay fee is 10× Bitcoin's → 5460 litoshi floor
        assert.strictEqual(network.dustThreshold, 5460)
        assert.strictEqual(network.bech32, 'rltc')
        assert.strictEqual(network.pubKeyHash, 0x6f)
        assert.ok(network.messagePrefix.includes('Litecoin'))
    })

    it('[regression:p2] R-CFG-003: CryptoNetworks resolves correct DOGE regtest config', function () {
        const network = CryptoNetworks.getBitcoinJsNetwork('dogecoin-regtest')
        assert.ok(network)
        assert.strictEqual(network.dustThreshold, 546)
        assert.strictEqual(network.pubKeyHash, 0x71)
        assert.ok(network.messagePrefix.includes('Dogecoin'))
    })

    it('[regression:p2] R-CFG-004: hub config contains all required service keys', function () {
        const hubFixture = require('../integration/fixtures/hub')
        const config = hubFixture.validConfig
        const services = config.bitcoin.regtest

        assert.ok(services['node'], 'should have node config')
        assert.ok(services['database'], 'should have database config')
        assert.ok(services['xchain-utxo-tracker'], 'should have utxo-tracker config')
        assert.ok(services['xchain-encoder'], 'should have encoder config')
        assert.ok(services['xchain-indexer'], 'should have indexer config')
        assert.ok(services['xchain-regtest-miner'], 'should have miner config')
    })

    it('[regression:p2] R-CFG-005: getFirstBlock returns 0 for bitcoin-regtest', function () {
        assert.strictEqual(CryptoNetworks.getFirstBlock('bitcoin-regtest'), 0)
    })

    it('[regression:p2] R-CFG-005b: getFirstBlock returns 844000 for bitcoin-mainnet', function () {
        assert.strictEqual(CryptoNetworks.getFirstBlock('bitcoin-mainnet'), 844000)
    })

    it('[regression:p2] R-CFG-005c: getFirstBlock returns 0 for unknown networks', function () {
        assert.strictEqual(CryptoNetworks.getFirstBlock('dogecoin-regtest'), 0)
    })

    it('[regression:p2] R-CFG-001b: all network configs include required fields', function () {
        const combos = [
            'bitcoin-mainnet', 'bitcoin-testnet', 'bitcoin-regtest',
            'litecoin-mainnet', 'litecoin-testnet', 'litecoin-regtest',
            'dogecoin-mainnet', 'dogecoin-testnet', 'dogecoin-regtest'
        ]
        for (const combo of combos) {
            const n = CryptoNetworks.getBitcoinJsNetwork(combo)
            assert.ok(n.bip32, `${combo}: missing bip32`)
            assert.ok(n.bip32.public, `${combo}: missing bip32.public`)
            assert.ok(n.bip32.private, `${combo}: missing bip32.private`)
            assert.ok(n.pubKeyHash !== undefined, `${combo}: missing pubKeyHash`)
            assert.ok(n.wif !== undefined, `${combo}: missing wif`)
            assert.ok(n.messagePrefix, `${combo}: missing messagePrefix`)
        }
    })
})

describe('[regression:p2] Fuzz & Boundary Anchors', function () {

    afterEach(function () {
        sinon.restore()
    })

    it('[regression:p2] R-FUZZ-001: CryptoNetworks handles unknown network without crash', function () {
        const result = CryptoNetworks.getBitcoinJsNetwork('invalid-network')
        assert.strictEqual(result, undefined, 'should return undefined for unknown network')
    })

    it('[regression:p2] R-FUZZ-002: connector constructor handles numeric port as string', function () {
        const node = new BlockchainConnector('host', '1234', 'u', 'p')
        assert.strictEqual(node.url, 'http://host:1234')

        const tracker = new XChainUtxoTrackerConnector('host', '3030')
        assert.strictEqual(tracker.url, 'http://host:3030')
    })

    it('[regression:p2] R-FUZZ-003: db uses parameterized queries (SQL injection safe)', async function () {
        const conn = {
            query:   sinon.stub().resolves([]),
            release: sinon.stub().resolves()
        }
        const pool = { getConnection: sinon.stub().resolves(conn), end: sinon.stub() }
        mockMariadb.createPool.returns(pool)
        const db = new Database('localhost', 3306, 'test_db', 'user', 'pass')

        await db.checkIssue({ tick: "'; DROP TABLE issues; --", status: 'valid' })

        const sql = conn.query.firstCall.args[0]
        const params = conn.query.firstCall.args[1]

        assert.ok(!sql.includes('DROP TABLE'), 'SQL injection should not appear in query string')
        assert.ok(params.includes("'; DROP TABLE issues; --"), 'injection string should be in params array')
    })

    it('[regression:p2] R-FUZZ-004: isNullOrNullString with edge types', function () {
        const conn = { query: sinon.stub(), release: sinon.stub() }
        const pool = { getConnection: sinon.stub().resolves(conn), end: sinon.stub() }
        mockMariadb.createPool.returns(pool)
        const db = new Database('localhost', 3306, 'test_db', 'user', 'pass')

        assert.strictEqual(db.isNullOrNullString(null), true)
        assert.strictEqual(db.isNullOrNullString(undefined), true)
        assert.strictEqual(db.isNullOrNullString(''), true)

        // Note: 0 == "" is true in JS (loose equality), so 0 is treated as null-like
        // This is a known behavior documented in fuzz tests
        assert.strictEqual(db.isNullOrNullString(0), true, '0 == "" is true (JS loose equality)')

        assert.strictEqual(db.isNullOrNullString('hello'), false)
        assert.strictEqual(db.isNullOrNullString(123), false)
        assert.strictEqual(db.isNullOrNullString(' '), false)
    })

    it('[regression:p2] R-BNDRY-001: getConnection retries on pool exhaustion', async function () {
        const conn = {
            query:   sinon.stub().resolves([]),
            release: sinon.stub().resolves()
        }
        const pool = {
            getConnection: sinon.stub()
                .onCall(0).rejects(new Error('pool exhausted'))
                .onCall(1).rejects(new Error('pool exhausted'))
                .onCall(2).resolves(conn),
            end: sinon.stub()
        }
        mockMariadb.createPool.returns(pool)
        const db = new Database('localhost', 3306, 'test_db', 'user', 'pass')
        db.sleep = sinon.stub().resolves()

        const result = await db.getConnection()
        assert.ok(result, 'should eventually get a connection')
        assert.strictEqual(pool.getConnection.callCount, 3)
    })

    it('[regression:p2] R-BNDRY-002: waitForIssue handles query error mid-poll gracefully', async function () {
        const conn = {
            query: sinon.stub()
                .onFirstCall().rejects(new Error('connection lost'))
                .onSecondCall().resolves([{ tick: 'TOK', status: 'valid' }]),
            release: sinon.stub().resolves()
        }
        const pool = { getConnection: sinon.stub().resolves(conn), end: sinon.stub() }
        mockMariadb.createPool.returns(pool)
        const db = new Database('localhost', 3306, 'test_db', 'user', 'pass')
        db.sleep = sinon.stub().resolves()

        const result = await db.waitForIssue({ tick: 'TOK' }, 30000)
        assert.ok(result, 'should recover and return the row')
    })

    it('[regression:p2] R-FUZZ-002b: parseEndpoints handles empty HUB_VALIDATORS', function () {
        const orig = process.env.HUB_VALIDATORS
        try {
            process.env.HUB_VALIDATORS = ',,,  , '
            const endpoints = XChainHubConnector.parseEndpoints()
            assert.strictEqual(endpoints.length, 0, 'should filter out empty entries')
        } finally {
            if (orig !== undefined) process.env.HUB_VALIDATORS = orig
            else delete process.env.HUB_VALIDATORS
        }
    })
})

describe('[regression:p2] Performance & Observability', function () {

    beforeEach(function () {
        PerfCollector.reset()
    })

    it('[regression:p2] R-PERF-001: phase() records bootstrap phase with timing', async function () {
        await PerfCollector.phase('test-phase', async () => {
        })

        assert.strictEqual(PerfCollector.bootstrapPhases.length, 1)
        const phase = PerfCollector.bootstrapPhases[0]
        assert.strictEqual(phase.name, 'test-phase')
        assert.ok(phase.startMs > 0)
        assert.ok(phase.endMs >= phase.startMs)
        assert.ok(phase.durationMs >= 0)
    })

    it('[regression:p2] R-PERF-002: recordPoll records polling metrics', function () {
        PerfCollector.recordPoll({
            method: 'checkIssue',
            startMs: 1000,
            endMs: 3000,
            polls: 3,
            resolved: true
        })

        assert.strictEqual(PerfCollector.pollMetrics.length, 1)
        const metric = PerfCollector.pollMetrics[0]
        assert.strictEqual(metric.method, 'checkIssue')
        assert.strictEqual(metric.polls, 3)
        assert.strictEqual(metric.resolved, true)
        assert.strictEqual(metric.durationMs, 2000)
    })

    it('[regression:p2] R-PERF-003: toJSON serializes all collected data', async function () {
        PerfCollector.startRun()
        await PerfCollector.phase('p1', async () => {})
        PerfCollector.recordPoll({ method: 'checkSend', startMs: 1, endMs: 2, polls: 1, resolved: true })

        const json = PerfCollector.toJSON()
        assert.ok(json.meta, 'should have meta')
        assert.ok(json.meta.startedAt, 'meta should have startedAt')
        assert.ok(json.meta.nodeVersion, 'meta should have nodeVersion')
        assert.strictEqual(json.bootstrapPhases.length, 1)
        assert.strictEqual(json.pollMetrics.length, 1)
    })

    it('[regression:p2] R-PERF-001b: reset clears all collected metrics', async function () {
        await PerfCollector.phase('p1', async () => {})
        PerfCollector.recordPoll({ method: 'm', startMs: 1, endMs: 2, polls: 1, resolved: true })

        PerfCollector.reset()
        assert.strictEqual(PerfCollector.bootstrapPhases.length, 0)
        assert.strictEqual(PerfCollector.pollMetrics.length, 0)
    })

    it('[regression:p2] R-PERF-001c: phase returns the async function result', async function () {
        const result = await PerfCollector.phase('ret-test', async () => 42)
        assert.strictEqual(result, 42)
    })
})
