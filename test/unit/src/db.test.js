// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// mariadb is an ESM package that cannot be require()'d directly. We inject a
// synthetic CJS module into require.cache at the resolved mariadb path before
// requiring db.js so that db.js picks up our mock instead of the real ESM module.

'use strict'

const assert  = require('assert')
const sinon   = require('sinon')
const path    = require('path')
const Module  = require('module')

const mariadbPath = require.resolve('mariadb')

const mockMariadb = {
    createPool: sinon.stub()
}

const mariadbModule = new Module(mariadbPath, module)
mariadbModule.exports = mockMariadb
mariadbModule.loaded  = true
require.cache[mariadbPath] = mariadbModule

const Database = require('../../../src/db')

let mockPool
let mockConnection
let db

function makeMockConnection(queryResult) {
    return {
        query:   sinon.stub().resolves(queryResult !== undefined ? queryResult : [{ id: 1 }]),
        release: sinon.stub().resolves()
    }
}

function countPlaceholders(sql) {
    return (sql.match(/\?/g) || []).length
}

beforeEach(function () {
    mockConnection = makeMockConnection([{ id: 1 }])
    mockPool = { getConnection: sinon.stub().resolves(mockConnection) }

    // Reset and reconfigure the createPool stub for each test
    mockMariadb.createPool.reset()
    mockMariadb.createPool.returns(mockPool)

    db = new Database('localhost', 3306, 'testdb', 'user', 'pass')
    db.sleep = sinon.stub().resolves()
})

afterEach(function () {
    sinon.restore()
})

describe('isNullOrNullString()', function () {
    it('returns true for null', function () {
        assert.strictEqual(db.isNullOrNullString(null), true)
    })

    it('returns true for undefined', function () {
        assert.strictEqual(db.isNullOrNullString(undefined), true)
    })

    it('returns true for empty string ""', function () {
        assert.strictEqual(db.isNullOrNullString(''), true)
    })

    it('returns true for 0 (due to loose equality: 0 == "")', function () {
        assert.strictEqual(db.isNullOrNullString(0), true)
    })

    it('returns true for false (due to loose equality: false == "")', function () {
        assert.strictEqual(db.isNullOrNullString(false), true)
    })

    it('returns false for "text"', function () {
        assert.strictEqual(db.isNullOrNullString('text'), false)
    })

    it('returns false for " " (single space)', function () {
        assert.strictEqual(db.isNullOrNullString(' '), false)
    })
})

describe('getConnection()', function () {
    it('returns transactionConnection when set', async function () {
        const fakeTxConn = { query: sinon.stub(), release: sinon.stub() }
        db.transactionConnection = fakeTxConn
        const conn = await db.getConnection()
        assert.strictEqual(conn, fakeTxConn)
        assert.ok(!mockPool.getConnection.called, 'pool.getConnection should not be called')
    })

    it('returns pool connection when transactionConnection is null', async function () {
        db.transactionConnection = null
        const conn = await db.getConnection()
        assert.strictEqual(conn, mockConnection)
        assert.ok(mockPool.getConnection.calledOnce)
    })

    it('retries when pool.getConnection() throws once then succeeds', async function () {
        db.transactionConnection = null
        const goodConn = makeMockConnection([{ id: 1 }])
        mockPool.getConnection
            .onFirstCall().rejects(new Error('Connection refused'))
            .onSecondCall().resolves(goodConn)

        const conn = await db.getConnection()
        assert.strictEqual(conn, goodConn)
        assert.strictEqual(mockPool.getConnection.callCount, 2)
    })
})

describe('ping()', function () {
    it('returns true when query returns rows', async function () {
        mockConnection.query.resolves([{ '1 + 1': 2 }])
        const result = await db.ping()
        assert.strictEqual(result, true)
    })

    it('returns false when query returns empty array', async function () {
        mockConnection.query.resolves([])
        const result = await db.ping()
        assert.strictEqual(result, false)
    })

    it('returns false when query throws; releases connection', async function () {
        mockConnection.query.rejects(new Error('DB error'))
        const result = await db.ping()
        assert.strictEqual(result, false)
        assert.ok(mockConnection.release.calledOnce)
    })

    it('releases connection on successful query', async function () {
        mockConnection.query.resolves([{ '1 + 1': 2 }])
        await db.ping()
        assert.ok(mockConnection.release.calledOnce)
    })
})

describe('checkIssue()', function () {
    it('all-fields: builds SQL with 9 ? placeholders and correct column aliases', async function () {
        const result = await db.checkIssue({
            source: 'addr1', tick: 'TICK', txHash: 'hash1',
            maxSupply: '1000', maxMint: '100', decimals: 8,
            description: 'desc', mintSupply: '500', status: 'valid'
        })
        const sql    = mockConnection.query.firstCall.args[0]
        const params = mockConnection.query.firstCall.args[1]
        assert.strictEqual(countPlaceholders(sql), 9)
        assert.strictEqual(params.length, 9)
        assert.ok(sql.includes('ia.address = ?'))
        assert.ok(sql.includes('itick.tick = ?'))
        assert.ok(sql.includes('itx.hash = ?'))
        assert.ok(sql.includes('i.max_supply = ?'))
        assert.ok(sql.includes('ist.status = ?'))
        assert.deepStrictEqual(result, { id: 1 })
    })

    it('single-field: only one WHERE condition when only source passed', async function () {
        await db.checkIssue({ source: 'addr1' })
        const sql = mockConnection.query.firstCall.args[0]
        assert.strictEqual(countPlaceholders(sql), 1)
        assert.ok(sql.includes('ia.address = ?'))
    })

    it('returns null when query returns empty array', async function () {
        mockConnection.query.resolves([])
        const result = await db.checkIssue({ tick: 'TICK' })
        assert.strictEqual(result, null)
    })
})

describe('checkSend()', function () {
    it('all-fields: 7 placeholders with correct aliases', async function () {
        await db.checkSend({
            source: 'addr1', destination: 'addr2', tick: 'TICK',
            amount: '100', txHash: 'hash1', memo: 'memo1', status: 'valid'
        })
        const sql    = mockConnection.query.firstCall.args[0]
        const params = mockConnection.query.firstCall.args[1]
        assert.strictEqual(countPlaceholders(sql), 7)
        assert.strictEqual(params.length, 7)
        assert.ok(sql.includes('ia.address = ?'))
        assert.ok(sql.includes('ia2.address = ?'))
        assert.ok(sql.includes('im.memo = ?'))
        assert.ok(sql.includes('amount = ?'))
    })

    it('single-field: only destination condition', async function () {
        await db.checkSend({ destination: 'addr2' })
        const sql = mockConnection.query.firstCall.args[0]
        assert.strictEqual(countPlaceholders(sql), 1)
        assert.ok(sql.includes('ia2.address = ?'))
    })

    it('returns null when query returns empty array', async function () {
        mockConnection.query.resolves([])
        const result = await db.checkSend({ tick: 'TICK' })
        assert.strictEqual(result, null)
    })
})

describe('checkCredit()', function () {
    it('all-fields: 5 placeholders including block_index and amount', async function () {
        await db.checkCredit({
            blockIndex: 100, txHash: 'hash1', tick: 'TICK',
            address: 'addr1', amount: '50'
        })
        const sql    = mockConnection.query.firstCall.args[0]
        const params = mockConnection.query.firstCall.args[1]
        assert.strictEqual(countPlaceholders(sql), 5)
        assert.strictEqual(params.length, 5)
        assert.ok(sql.includes('tr.block_index = ?'))
        assert.ok(sql.includes('ia.address = ?'))
        assert.ok(sql.includes('amount = ?'))
        assert.ok(sql.includes('itick.tick = ?'))
    })

    it('single-field: only txHash condition', async function () {
        await db.checkCredit({ txHash: 'hash1' })
        const sql = mockConnection.query.firstCall.args[0]
        assert.strictEqual(countPlaceholders(sql), 1)
        assert.ok(sql.includes('itx.hash = ?'))
    })

    it('returns null when query returns empty array', async function () {
        mockConnection.query.resolves([])
        const result = await db.checkCredit({ address: 'addr1' })
        assert.strictEqual(result, null)
    })
})

describe('checkDebit()', function () {
    it('all-fields: 5 placeholders with block_index', async function () {
        await db.checkDebit({
            blockIndex: 100, txHash: 'hash1', tick: 'TICK',
            address: 'addr1', amount: '50'
        })
        const sql    = mockConnection.query.firstCall.args[0]
        const params = mockConnection.query.firstCall.args[1]
        assert.strictEqual(countPlaceholders(sql), 5)
        assert.strictEqual(params.length, 5)
        assert.ok(sql.includes('tr.block_index = ?'))
        assert.ok(sql.includes('amount = ?'))
    })

    it('single-field: only address condition', async function () {
        await db.checkDebit({ address: 'addr1' })
        const sql = mockConnection.query.firstCall.args[0]
        assert.strictEqual(countPlaceholders(sql), 1)
        assert.ok(sql.includes('ia.address = ?'))
    })

    it('returns null when query returns empty array', async function () {
        mockConnection.query.resolves([])
        const result = await db.checkDebit({ tick: 'TICK' })
        assert.strictEqual(result, null)
    })
})

describe('checkMint()', function () {
    it('all-fields with non-empty memo: 7 placeholders', async function () {
        await db.checkMint({
            blockIndex: 100, txHash: 'hash1', tick: 'TICK',
            destination: 'addr1', amount: '50', memo: 'mymemo', status: 'valid'
        })
        const sql    = mockConnection.query.firstCall.args[0]
        const params = mockConnection.query.firstCall.args[1]
        assert.strictEqual(countPlaceholders(sql), 7)
        assert.strictEqual(params.length, 7)
        assert.ok(sql.includes('im.memo = ?'))
        assert.ok(sql.includes('ia.address = ?'))
    })

    it('memo="" produces IS NULL clause with no extra placeholder', async function () {
        await db.checkMint({ memo: '' })
        const sql    = mockConnection.query.firstCall.args[0]
        const params = mockConnection.query.firstCall.args[1]
        assert.ok(sql.includes('im.memo IS NULL'))
        assert.strictEqual(countPlaceholders(sql), 0)
        assert.strictEqual(params.length, 0)
    })

    it('returns null when query returns empty array', async function () {
        mockConnection.query.resolves([])
        const result = await db.checkMint({ tick: 'TICK' })
        assert.strictEqual(result, null)
    })
})

describe('checkBroadcast()', function () {
    it('all-fields: 9 placeholders with correct aliases', async function () {
        await db.checkBroadcast({
            blockIndex: 100, txHash: 'hash1', source: 'addr1',
            message: 'msg', value: '1.0', fee: '0.001',
            memo: 'memo1', broadcastActionIndex: 5, status: 'valid'
        })
        const sql    = mockConnection.query.firstCall.args[0]
        const params = mockConnection.query.firstCall.args[1]
        assert.strictEqual(countPlaceholders(sql), 9)
        assert.strictEqual(params.length, 9)
        assert.ok(sql.includes('b.message = ?'))
        assert.ok(sql.includes('b.broadcast_action_index = ?'))
        assert.ok(sql.includes('b.value = ?'))
        assert.ok(sql.includes('b.fee = ?'))
    })

    it('single-field: only source condition', async function () {
        await db.checkBroadcast({ source: 'addr1' })
        const sql = mockConnection.query.firstCall.args[0]
        assert.strictEqual(countPlaceholders(sql), 1)
        assert.ok(sql.includes('ia.address = ?'))
    })

    it('returns null when query returns empty array', async function () {
        mockConnection.query.resolves([])
        const result = await db.checkBroadcast({ txHash: 'hash1' })
        assert.strictEqual(result, null)
    })
})

describe('checkAirdrop()', function () {
    it('all-fields: 8 placeholders with list_action_index', async function () {
        await db.checkAirdrop({
            blockIndex: 100, txHash: 'hash1', source: 'addr1',
            tick: 'TICK', amount: '50', listActionIndex: 10,
            memo: 'memo1', status: 'valid'
        })
        const sql    = mockConnection.query.firstCall.args[0]
        const params = mockConnection.query.firstCall.args[1]
        assert.strictEqual(countPlaceholders(sql), 8)
        assert.strictEqual(params.length, 8)
        assert.ok(sql.includes('a.list_action_index = ?'))
        assert.ok(sql.includes('ia.address = ?'))
        assert.ok(sql.includes('a.amount = ?'))
    })

    it('single-field: only tick condition', async function () {
        await db.checkAirdrop({ tick: 'TICK' })
        const sql = mockConnection.query.firstCall.args[0]
        assert.strictEqual(countPlaceholders(sql), 1)
        assert.ok(sql.includes('itick.tick = ?'))
    })

    it('returns null when query returns empty array', async function () {
        mockConnection.query.resolves([])
        const result = await db.checkAirdrop({ source: 'addr1' })
        assert.strictEqual(result, null)
    })
})

describe('checkDispenser()', function () {
    it('getAddress non-null: adds get_ia.address = ? placeholder (uses isNullOrNullString)', async function () {
        await db.checkDispenser({
            blockIndex: 100, txHash: 'hash1', source: 'addr1',
            giveCoin: 'BTC', giveTick: 'TICK', giveAmount: '100',
            giveEscrow: '50', getCoin: 'LTC', getTick: 'LTICK',
            getAmount: '200', getAddress: 'getaddr', fiatCode: null,
            fiatAmount: null, expiration: null, allowList: null,
            blockList: null, memo: null, status: 'valid'
        })
        const sql = mockConnection.query.firstCall.args[0]
        assert.ok(sql.includes('get_ia.address = ?'))
        assert.ok(!sql.includes('get_ia.address = ias.address'))
    })

    it('when getAddress is null, adds get_ia.address = ias.address clause (no placeholder)', async function () {
        await db.checkDispenser({ txHash: 'hash1', getAddress: null })
        const sql = mockConnection.query.firstCall.args[0]
        assert.ok(sql.includes('get_ia.address = ias.address'))
    })

    it('empty-string getAddress treated as null, uses ias.address clause', async function () {
        await db.checkDispenser({ txHash: 'hash1', getAddress: '' })
        const sql = mockConnection.query.firstCall.args[0]
        assert.ok(sql.includes('get_ia.address = ias.address'))
    })

    it('returns null when query returns empty array', async function () {
        mockConnection.query.resolves([])
        const result = await db.checkDispenser({ txHash: 'hash1' })
        assert.strictEqual(result, null)
    })
})

describe('checkDispense()', function () {
    it('all-fields: 11 placeholders using isNullOrNullString', async function () {
        await db.checkDispense({
            blockIndex: 100, txHash: 'hash1', source: 'addr1',
            giveCoin: 'BTC', giveTick: 'TICK', giveAmount: '100',
            getCoin: 'LTC', getTick: 'LTICK', getAmount: '200',
            destination: 'dest1', status: 'valid'
        })
        const sql    = mockConnection.query.firstCall.args[0]
        const params = mockConnection.query.firstCall.args[1]
        assert.strictEqual(countPlaceholders(sql), 11)
        assert.strictEqual(params.length, 11)
        assert.ok(sql.includes('iad.address = ?'))
        assert.ok(sql.includes('ias.address = ?'))
    })

    it('empty-string source is excluded (treated as null by isNullOrNullString)', async function () {
        await db.checkDispense({ txHash: 'hash1', source: '' })
        const sql    = mockConnection.query.firstCall.args[0]
        const params = mockConnection.query.firstCall.args[1]
        // Only txHash should produce a placeholder; source='' is excluded
        assert.strictEqual(countPlaceholders(sql), 1)
        assert.strictEqual(params.length, 1)
        // ias.address still appears in SELECT; check only the WHERE portion
        const wherePart = sql.split('WHERE')[1] || ''
        assert.ok(!wherePart.includes('ias.address'))
    })

    it('returns null when query returns empty array', async function () {
        mockConnection.query.resolves([])
        const result = await db.checkDispense({ txHash: 'hash1' })
        assert.strictEqual(result, null)
    })
})

describe('checkDispenserStatus()', function () {
    it('returns null immediately when no params provided (w.length === 0)', async function () {
        const result = await db.checkDispenserStatus({})
        assert.strictEqual(result, null)
        assert.ok(!mockConnection.query.called)
    })

    it('builds correct SQL when dispenserActionIndex provided', async function () {
        await db.checkDispenserStatus({ dispenserActionIndex: 5 })
        const sql    = mockConnection.query.firstCall.args[0]
        const params = mockConnection.query.firstCall.args[1]
        assert.ok(sql.includes('ds.dispenser_action_index = ?'))
        assert.strictEqual(countPlaceholders(sql), 1)
        assert.deepStrictEqual(params, [5])
    })

    it('returns null when query returns empty array', async function () {
        mockConnection.query.resolves([])
        const result = await db.checkDispenserStatus({ status: 'open' })
        assert.strictEqual(result, null)
    })
})

describe('checkAddressOption()', function () {
    it('all-fields: 5 placeholders with fee_preference and require_memo', async function () {
        await db.checkAddressOption({
            txHash: 'hash1', source: 'addr1',
            feePreference: 1, requireMemo: 0, status: 'valid'
        })
        const sql    = mockConnection.query.firstCall.args[0]
        const params = mockConnection.query.firstCall.args[1]
        assert.strictEqual(countPlaceholders(sql), 5)
        assert.strictEqual(params.length, 5)
        assert.ok(sql.includes('ao.fee_preference = ?'))
        assert.ok(sql.includes('ao.require_memo = ?'))
    })

    it('single-field: only status condition', async function () {
        await db.checkAddressOption({ status: 'valid' })
        const sql = mockConnection.query.firstCall.args[0]
        assert.strictEqual(countPlaceholders(sql), 1)
        assert.ok(sql.includes('ist.status = ?'))
    })

    it('returns null when query returns empty array', async function () {
        mockConnection.query.resolves([])
        const result = await db.checkAddressOption({ txHash: 'hash1' })
        assert.strictEqual(result, null)
    })
})

describe('checkDestroy()', function () {
    it('all-fields: 6 placeholders with tick, amount, memo, status', async function () {
        await db.checkDestroy({
            txHash: 'hash1', source: 'addr1', tick: 'TICK',
            amount: '50', memo: 'memo1', status: 'valid'
        })
        const sql    = mockConnection.query.firstCall.args[0]
        const params = mockConnection.query.firstCall.args[1]
        assert.strictEqual(countPlaceholders(sql), 6)
        assert.strictEqual(params.length, 6)
        assert.ok(sql.includes('d.amount = ?'))
        assert.ok(sql.includes('itick.tick = ?'))
        assert.ok(sql.includes('im.memo = ?'))
    })

    it('single-field: only tick condition', async function () {
        await db.checkDestroy({ tick: 'TICK' })
        const sql = mockConnection.query.firstCall.args[0]
        assert.strictEqual(countPlaceholders(sql), 1)
        assert.ok(sql.includes('itick.tick = ?'))
    })

    it('returns null when query returns empty array', async function () {
        mockConnection.query.resolves([])
        const result = await db.checkDestroy({ source: 'addr1' })
        assert.strictEqual(result, null)
    })
})

describe('checkBatch()', function () {
    it('all-fields: 3 placeholders', async function () {
        await db.checkBatch({ txHash: 'hash1', source: 'addr1', status: 'valid' })
        const sql    = mockConnection.query.firstCall.args[0]
        const params = mockConnection.query.firstCall.args[1]
        assert.strictEqual(countPlaceholders(sql), 3)
        assert.strictEqual(params.length, 3)
        assert.ok(sql.includes('ia.address = ?'))
        assert.ok(sql.includes('ist.status = ?'))
    })

    it('single-field: only txHash condition', async function () {
        await db.checkBatch({ txHash: 'hash1' })
        const sql = mockConnection.query.firstCall.args[0]
        assert.strictEqual(countPlaceholders(sql), 1)
        assert.ok(sql.includes('itx.hash = ?'))
    })

    it('returns null when query returns empty array', async function () {
        mockConnection.query.resolves([])
        const result = await db.checkBatch({ status: 'valid' })
        assert.strictEqual(result, null)
    })
})

describe('checkLink()', function () {
    it('all-fields: 7 placeholders with coin1/coin2 aliases', async function () {
        await db.checkLink({
            txHash: 'hash1', source: 'addr1', coin1: 'BTC',
            coin1ActionIndex: 1, coin2: 'LTC', coin2ActionIndex: 2, status: 'valid'
        })
        const sql    = mockConnection.query.firstCall.args[0]
        const params = mockConnection.query.firstCall.args[1]
        assert.strictEqual(countPlaceholders(sql), 7)
        assert.strictEqual(params.length, 7)
        assert.ok(sql.includes('ic1.coin = ?'))
        assert.ok(sql.includes('ic2.coin = ?'))
        assert.ok(sql.includes('l.coin1_action_index = ?'))
        assert.ok(sql.includes('l.coin2_action_index = ?'))
    })

    it('single-field: only coin1 condition', async function () {
        await db.checkLink({ coin1: 'BTC' })
        const sql = mockConnection.query.firstCall.args[0]
        assert.strictEqual(countPlaceholders(sql), 1)
        assert.ok(sql.includes('ic1.coin = ?'))
    })

    it('returns null when query returns empty array', async function () {
        mockConnection.query.resolves([])
        const result = await db.checkLink({ txHash: 'hash1' })
        assert.strictEqual(result, null)
    })
})

describe('checkContract()', function () {
    it('returns null immediately when no params provided (w.length === 0)', async function () {
        const result = await db.checkContract({})
        assert.strictEqual(result, null)
        assert.ok(!mockConnection.query.called)
    })

    it('all-fields: 3 placeholders with source, txHash, status', async function () {
        await db.checkContract({ source: 'addr1', txHash: 'hash1', status: 'valid' })
        const sql    = mockConnection.query.firstCall.args[0]
        const params = mockConnection.query.firstCall.args[1]
        assert.ok(sql.includes('ia.address = ?'))
        assert.ok(sql.includes('itx.hash = ?'))
        assert.ok(sql.includes('ist.status = ?'))
        assert.strictEqual(countPlaceholders(sql), 3)
        assert.strictEqual(params.length, 3)
    })

    it('returns null when query returns empty array', async function () {
        mockConnection.query.resolves([])
        const result = await db.checkContract({ source: 'addr1' })
        assert.strictEqual(result, null)
    })
})

describe('checkList()', function () {
    it('returns the list row when items match for type=2 (address)', async function () {
        const listRow  = { id: 1, action_index: 42, type: 2 }
        const itemRows = [{ item_name: 'addr_a' }, { item_name: 'addr_b' }]

        const conn1 = { query: sinon.stub().resolves([listRow]), release: sinon.stub().resolves() }
        const conn2 = { query: sinon.stub().resolves(itemRows), release: sinon.stub().resolves() }
        mockPool.getConnection.onFirstCall().resolves(conn1)
        mockPool.getConnection.onSecondCall().resolves(conn2)

        const result = await db.checkList({
            txHash: 'hash1', source: 'addr1', type: 2,
            status: 'valid', items: ['addr_a', 'addr_b']
        })

        assert.deepStrictEqual(result, listRow)
    })

    it('returns null when list items count does not match items array', async function () {
        const listRow  = { id: 1, action_index: 42, type: 2 }
        const itemRows = [{ item_name: 'addr_a' }]   // only 1, but items has 2

        const conn1 = { query: sinon.stub().resolves([listRow]), release: sinon.stub().resolves() }
        const conn2 = { query: sinon.stub().resolves(itemRows), release: sinon.stub().resolves() }
        mockPool.getConnection.onFirstCall().resolves(conn1)
        mockPool.getConnection.onSecondCall().resolves(conn2)

        const result = await db.checkList({
            txHash: 'hash1', type: 2, items: ['addr_a', 'addr_b']
        })

        assert.strictEqual(result, null)
    })

    it('returns null when item values mismatch', async function () {
        const listRow  = { id: 1, action_index: 42, type: 2 }
        const itemRows = [{ item_name: 'addr_a' }, { item_name: 'addr_c' }]

        const conn1 = { query: sinon.stub().resolves([listRow]), release: sinon.stub().resolves() }
        const conn2 = { query: sinon.stub().resolves(itemRows), release: sinon.stub().resolves() }
        mockPool.getConnection.onFirstCall().resolves(conn1)
        mockPool.getConnection.onSecondCall().resolves(conn2)

        const result = await db.checkList({
            txHash: 'hash1', type: 2, items: ['addr_a', 'addr_b']
        })

        assert.strictEqual(result, null)
    })

    it('returns null when first query finds no list row', async function () {
        const conn1 = { query: sinon.stub().resolves([]), release: sinon.stub().resolves() }
        mockPool.getConnection.resolves(conn1)

        const result = await db.checkList({ txHash: 'hash1', type: 2, items: ['addr_a'] })
        assert.strictEqual(result, null)
    })

    it('type=1 (tick list) uses index_tickers join in items query', async function () {
        const listRow  = { id: 1, action_index: 42, type: 1 }
        const itemRows = [{ item_name: 'TICK' }]

        const conn1 = { query: sinon.stub().resolves([listRow]), release: sinon.stub().resolves() }
        const conn2 = { query: sinon.stub().resolves(itemRows), release: sinon.stub().resolves() }
        mockPool.getConnection.onFirstCall().resolves(conn1)
        mockPool.getConnection.onSecondCall().resolves(conn2)

        const result = await db.checkList({
            type: 1, items: ['TICK']
        })

        assert.deepStrictEqual(result, listRow)
        const itemSql = conn2.query.firstCall.args[0]
        assert.ok(itemSql.includes('index_tickers'))
    })
})

describe('_waitFor()', function () {
    it('returns immediately when checkFn returns a row on first call', async function () {
        const row     = { id: 1 }
        const checkFn = sinon.stub().resolves(row)
        const result  = await db._waitFor(checkFn, {}, 30000)
        assert.deepStrictEqual(result, row)
        assert.ok(checkFn.calledOnce)
        assert.ok(db.sleep.notCalled)
    })

    it('returns row after checkFn returns null twice then a row (sleep stubbed)', async function () {
        const row     = { id: 42 }
        const checkFn = sinon.stub()
        checkFn.onCall(0).resolves(null)
        checkFn.onCall(1).resolves(null)
        checkFn.onCall(2).resolves(row)

        const result = await db._waitFor(checkFn, {}, 30000)
        assert.deepStrictEqual(result, row)
        assert.strictEqual(checkFn.callCount, 3)
        assert.ok(db.sleep.callCount >= 2)
    })

    it('returns null after timeout (Date.now stubbed to expire)', async function () {
        const checkFn = sinon.stub().resolves(null)

        let callCount = 0
        const nowStub = sinon.stub(Date, 'now').callsFake(() => {
            callCount++
            // First call: sets endTime; subsequent calls simulate expiry
            if (callCount === 1) return 1000
            return 1000 + 30001   // past endTime
        })

        try {
            const result = await db._waitFor(checkFn, {}, 30000)
            assert.strictEqual(result, null)
        } finally {
            nowStub.restore()
        }
    })

    it('continues polling when checkFn throws (catches error and retries)', async function () {
        const row     = { id: 7 }
        const checkFn = sinon.stub()
        checkFn.onCall(0).rejects(new Error('Transient DB error'))
        checkFn.onCall(1).resolves(row)

        const result = await db._waitFor(checkFn, {}, 30000)
        assert.deepStrictEqual(result, row)
        assert.strictEqual(checkFn.callCount, 2)
        // sleep should have been called after the error
        assert.ok(db.sleep.calledOnce)
    })
})

describe('waitForDestroy() delegation to _waitFor', function () {
    it('delegates to _waitFor with checkDestroy function reference', async function () {
        const row        = { id: 10 }
        const stub       = sinon.stub(db, '_waitFor').resolves(row)
        const params     = { txHash: 'hash1', tick: 'TICK' }

        const result = await db.waitForDestroy(params, 5000)
        assert.deepStrictEqual(result, row)
        assert.ok(stub.calledOnce)
        assert.strictEqual(stub.firstCall.args[0], db.checkDestroy)
        assert.deepStrictEqual(stub.firstCall.args[1], params)
        assert.strictEqual(stub.firstCall.args[2], 5000)
    })
})

describe('waitForBatch() delegation to _waitFor', function () {
    it('delegates to _waitFor with checkBatch function reference', async function () {
        const row    = { id: 20 }
        const stub   = sinon.stub(db, '_waitFor').resolves(row)
        const params = { txHash: 'hash1', status: 'valid' }

        const result = await db.waitForBatch(params, 10000)
        assert.deepStrictEqual(result, row)
        assert.ok(stub.calledOnce)
        assert.strictEqual(stub.firstCall.args[0], db.checkBatch)
        assert.deepStrictEqual(stub.firstCall.args[1], params)
        assert.strictEqual(stub.firstCall.args[2], 10000)
    })
})

describe('waitForLink() delegation to _waitFor', function () {
    it('delegates to _waitFor with checkLink function reference', async function () {
        const row    = { id: 30 }
        const stub   = sinon.stub(db, '_waitFor').resolves(row)
        const params = { txHash: 'hash1', coin1: 'BTC' }

        const result = await db.waitForLink(params, 15000)
        assert.deepStrictEqual(result, row)
        assert.ok(stub.calledOnce)
        assert.strictEqual(stub.firstCall.args[0], db.checkLink)
        assert.deepStrictEqual(stub.firstCall.args[1], params)
    })
})

describe('waitForDispenserStatus() delegation to _waitFor', function () {
    it('delegates to _waitFor with checkDispenserStatus function reference', async function () {
        const row    = { id: 99, status: 'open' }
        const stub   = sinon.stub(db, '_waitFor').resolves(row)
        const params = { dispenserActionIndex: 7, status: 'open' }

        const result = await db.waitForDispenserStatus(params, 20000)
        assert.deepStrictEqual(result, row)
        assert.ok(stub.calledOnce)
        assert.strictEqual(stub.firstCall.args[0], db.checkDispenserStatus)
        assert.deepStrictEqual(stub.firstCall.args[1], params)
    })
})

describe('waitForAddressOption() delegation to _waitFor', function () {
    it('delegates to _waitFor with checkAddressOption function reference', async function () {
        const row    = { id: 50 }
        const stub   = sinon.stub(db, '_waitFor').resolves(row)
        const params = { txHash: 'hash1', source: 'addr1' }

        const result = await db.waitForAddressOption(params, 5000)
        assert.deepStrictEqual(result, row)
        assert.ok(stub.calledOnce)
        assert.strictEqual(stub.firstCall.args[0], db.checkAddressOption)
        assert.deepStrictEqual(stub.firstCall.args[1], params)
    })
})

describe('waitForIssue() inline polling', function () {
    it('returns row when checkIssue resolves immediately', async function () {
        const row = { id: 5, tick: 'TICK' }
        sinon.stub(db, 'checkIssue').resolves(row)

        const result = await db.waitForIssue({ tick: 'TICK' }, 30000)
        assert.deepStrictEqual(result, row)
    })

    it('returns null when checkIssue always returns null and timeout is expired', async function () {
        sinon.stub(db, 'checkIssue').resolves(null)

        const nowStub = sinon.stub(Date, 'now')
        nowStub.onCall(0).returns(1000)         // endTime = 1000 + 30000
        nowStub.returns(1000 + 30001)           // already past end on condition check

        try {
            const result = await db.waitForIssue({ tick: 'TICK' }, 30000)
            assert.strictEqual(result, null)
        } finally {
            nowStub.restore()
        }
    })

    it('retries on error and returns row on second attempt', async function () {
        const row = { id: 8 }
        const stub = sinon.stub(db, 'checkIssue')
        stub.onCall(0).rejects(new Error('transient'))
        stub.onCall(1).resolves(row)

        const result = await db.waitForIssue({ tick: 'TICK' }, 30000)
        assert.deepStrictEqual(result, row)
        assert.strictEqual(stub.callCount, 2)
    })
})

describe('waitForSend() inline polling', function () {
    it('returns row when checkSend resolves on first attempt', async function () {
        const row = { id: 9 }
        sinon.stub(db, 'checkSend').resolves(row)

        const result = await db.waitForSend({ tick: 'TICK' }, 30000)
        assert.deepStrictEqual(result, row)
    })

    it('returns null when timeout exceeded', async function () {
        sinon.stub(db, 'checkSend').resolves(null)

        const nowStub = sinon.stub(Date, 'now')
        nowStub.onCall(0).returns(1000)
        nowStub.returns(1000 + 30001)

        try {
            const result = await db.waitForSend({ tick: 'TICK' }, 30000)
            assert.strictEqual(result, null)
        } finally {
            nowStub.restore()
        }
    })
})
