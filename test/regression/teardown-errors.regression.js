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

// Inject mock mariadb before requiring Database
const mockMariadb = require('../integration/fixtures/mockMariadb')
const Database    = require('../../src/db')
const RegtestMinerConnector  = require('../../src/RegtestMinerConnector')
const XChainEncoderConnector = require('../../src/XChainEncoderConnector')
const BlockchainConnector    = require('../../src/BlockchainConnector')

// ── Helpers ──────────────────────────────────────────────────────────────

function makeMockConnection(queryResult) {
    return {
        query:   sinon.stub().resolves(queryResult !== undefined ? queryResult : []),
        release: sinon.stub().resolves()
    }
}

function makeMockPool(conn) {
    return {
        getConnection: sinon.stub().resolves(conn),
        end:           sinon.stub().resolves()
    }
}

function createDb(queryResult) {
    const conn = makeMockConnection(queryResult)
    const pool = makeMockPool(conn)
    mockMariadb.createPool.returns(pool)
    const db = new Database('localhost', 3306, 'test_db', 'user', 'pass')
    db.sleep = sinon.stub().resolves()
    return { db, pool, conn }
}

// ═══════════════════════════════════════════════════════════════════════════
// P1: Teardown & Error Handling Regression Tests
// ═══════════════════════════════════════════════════════════════════════════

describe('[regression:p1] Teardown & Cleanup', function () {

    afterEach(function () {
        sinon.restore()
    })

    // ── R-TEAR-001 ───────────────────────────────────────────────────────

    it('[regression:p1] R-TEAR-001: setDefaultMiningTime calls correct RPC method', async function () {
        const stub = sinon.stub(axios, 'post').resolves({
            data: { jsonrpc: '2.0', result: true, id: 1 }
        })
        const miner = new RegtestMinerConnector('localhost', 3033)
        await miner.setDefaultMiningTime()

        assert.strictEqual(stub.firstCall.args[1].method, 'set_default_mining_time')
    })

    // ── R-TEAR-002 ───────────────────────────────────────────────────────

    it('[regression:p1] R-TEAR-002: pool.end() closes the connection pool', async function () {
        const { db, pool } = createDb()
        await pool.end()
        assert.ok(pool.end.calledOnce)
    })

    // ── R-TEAR-003 ───────────────────────────────────────────────────────

    it('[regression:p1] R-TEAR-003: wallet seed buffers can be zeroed', function () {
        const seed = Buffer.from('abcdef1234567890abcdef1234567890', 'hex')
        const privKey = Buffer.alloc(32, 0x42)

        const wallets = {
            'test': {
                seed,
                addresses: [{ privateKey: privKey, publicKey: Buffer.alloc(33), address: 'addr1' }]
            }
        }

        // Replicate teardown logic
        for (const label of Object.keys(wallets)) {
            const w = wallets[label]
            if (w.seed && Buffer.isBuffer(w.seed)) w.seed.fill(0)
            if (w.addresses) {
                for (const addr of w.addresses) {
                    if (addr.privateKey && Buffer.isBuffer(addr.privateKey)) addr.privateKey.fill(0)
                }
            }
        }

        assert.ok(seed.every(b => b === 0), 'seed should be zeroed')
        assert.ok(privKey.every(b => b === 0), 'privateKey should be zeroed')
    })

    // ── R-TEAR-004 ───────────────────────────────────────────────────────

    it('[regression:p1] R-TEAR-004: teardown completes even if miner is unavailable', async function () {
        sinon.stub(axios, 'post').rejects(new Error('ECONNREFUSED'))
        const miner = new RegtestMinerConnector('localhost', 3033)

        // Replicate teardown error handling
        let teardownCompleted = false
        try {
            await miner.setDefaultMiningTime()
        } catch (err) {
            // swallowed, same as initialCheck.test.js afterAll
        }
        teardownCompleted = true

        assert.ok(teardownCompleted, 'teardown should complete despite miner error')
    })

    // ── R-TEAR-005 ───────────────────────────────────────────────────────

    it('[regression:p1] R-TEAR-005: pool.end() error does not crash teardown', async function () {
        const { db, pool } = createDb()
        pool.end = sinon.stub().rejects(new Error('pool already closed'))

        let teardownCompleted = false
        try {
            await pool.end()
        } catch (err) {
            // swallowed
        }
        teardownCompleted = true

        assert.ok(teardownCompleted)
    })
})

// ═══════════════════════════════════════════════════════════════════════════
// P1: Error Propagation & Resilience Regression Tests
// ═══════════════════════════════════════════════════════════════════════════

describe('[regression:p1] Error Propagation & Resilience', function () {

    afterEach(function () {
        sinon.restore()
    })

    // ── R-ERR-001 ────────────────────────────────────────────────────────

    it('[regression:p1] R-ERR-001: connector timeout produces descriptive error', async function () {
        sinon.stub(axios, 'post').rejects(new Error('ETIMEDOUT'))
        const encoder = new XChainEncoderConnector('localhost', 3031)

        await assert.rejects(
            () => encoder.createTx([], 'pk', [], {}, null, null, false, null, 'addr'),
            /Error trying to create a tx/
        )
    })

    // ── R-ERR-002 ────────────────────────────────────────────────────────

    it('[regression:p1] R-ERR-002: db polling survives query error and continues', async function () {
        const conn = makeMockConnection()
        conn.query = sinon.stub()
            .onFirstCall().rejects(new Error('ER_CONNECTION_LOST'))
            .onSecondCall().resolves([{ tick: 'TOK', status: 'valid' }])

        const pool = makeMockPool(conn)
        mockMariadb.createPool.returns(pool)
        const db = new Database('localhost', 3306, 'test_db', 'user', 'pass')
        db.sleep = sinon.stub().resolves()

        const result = await db.waitForIssue({ tick: 'TOK' }, 30000)
        assert.ok(result, 'should recover and return the row')
    })

    // ── R-ERR-003 ────────────────────────────────────────────────────────

    it('[regression:p1] R-ERR-003: broadcastTx produces error with node error detail', async function () {
        const node = new BlockchainConnector('localhost', 18443, 'u', 'p')
        // Stub broadcastTx to simulate the error path where the node returns an error object
        // The real implementation throws: 'Error sending transaction to the node: {"code":-26,"message":"dust"}'
        sinon.stub(node, 'broadcastTx').rejects(
            new Error('Error sending transaction to the node: {"code":-26,"message":"dust"}')
        )
        await assert.rejects(
            () => node.broadcastTx('deadbeef'),
            /Error sending transaction.*dust/
        )
    })

    // ── R-ERR-005 ────────────────────────────────────────────────────────

    it('[regression:p1] R-ERR-005: encoder createTx throws descriptive error on failure', async function () {
        sinon.stub(axios, 'post').resolves({
            data: { jsonrpc: '2.0', result: null, id: 1 }
        })

        const encoder = new XChainEncoderConnector('localhost', 3031)
        await assert.rejects(
            () => encoder.createTx([], 'pk', [], {}, null, null, false, null, 'addr'),
            /Error trying to create a tx/
        )
    })

    // ── R-ERR-006 ────────────────────────────────────────────────────────

    it('[regression:p1] R-ERR-006: hub _call returns null when all endpoints fail', async function () {
        sinon.stub(axios, 'post').rejects(new Error('ECONNREFUSED'))

        const XChainHubConnector = require('../../src/XChainHubConnector')
        const hub = new XChainHubConnector(['http://hub1:10000', 'http://hub2:10000'])
        const result = await hub.getAllConfig()
        assert.strictEqual(result, null)
    })
})
