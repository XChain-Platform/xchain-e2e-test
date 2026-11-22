// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

'use strict'

const {
    assert, sinon, countPlaceholders, registerHooks, state
} = require('./setup.test')

registerHooks()

describe('checkDispense()', function () {
    it('all-fields: 11 placeholders using isNullOrNullString', async function () {
        await state.db.checkDispense({
            blockIndex: 100, txHash: 'hash1', source: 'addr1',
            giveCoin: 'BTC', giveTick: 'TICK', giveAmount: '100',
            getCoin: 'LTC', getTick: 'LTICK', getAmount: '200',
            destination: 'dest1', status: 'valid'
        })
        const sql    = state.mockConnection.query.firstCall.args[0]
        const params = state.mockConnection.query.firstCall.args[1]
        assert.strictEqual(countPlaceholders(sql), 11)
        assert.strictEqual(params.length, 11)
        assert.ok(sql.includes('iad.address = ?'))
        assert.ok(sql.includes('ias.address = ?'))
    })

    it('empty-string source is excluded (treated as null by isNullOrNullString)', async function () {
        await state.db.checkDispense({ txHash: 'hash1', source: '' })
        const sql    = state.mockConnection.query.firstCall.args[0]
        const params = state.mockConnection.query.firstCall.args[1]
        // Only txHash should produce a placeholder; source='' is excluded
        assert.strictEqual(countPlaceholders(sql), 1)
        assert.strictEqual(params.length, 1)
        // ias.address still appears in SELECT; check only the WHERE portion
        const wherePart = sql.split('WHERE')[1] || ''
        assert.ok(!wherePart.includes('ias.address'))
    })

    it('returns null when query returns empty array', async function () {
        state.mockConnection.query.resolves([])
        const result = await state.db.checkDispense({ txHash: 'hash1' })
        assert.strictEqual(result, null)
    })
})

describe('checkDispenserStatus()', function () {
    it('returns null immediately when no params provided (w.length === 0)', async function () {
        const result = await state.db.checkDispenserStatus({})
        assert.strictEqual(result, null)
        assert.ok(!state.mockConnection.query.called)
    })

    it('builds correct SQL when dispenserActionIndex provided', async function () {
        await state.db.checkDispenserStatus({ dispenserActionIndex: 5 })
        const sql    = state.mockConnection.query.firstCall.args[0]
        const params = state.mockConnection.query.firstCall.args[1]
        assert.ok(sql.includes('ds.dispenser_action_index = ?'))
        assert.strictEqual(countPlaceholders(sql), 1)
        assert.deepStrictEqual(params, [5])
    })

    it('returns null when query returns empty array', async function () {
        state.mockConnection.query.resolves([])
        const result = await state.db.checkDispenserStatus({ status: 'open' })
        assert.strictEqual(result, null)
    })
})

describe('checkAddressOption()', function () {
    it('all-fields: 5 placeholders with fee_preference and require_memo', async function () {
        await state.db.checkAddressOption({
            txHash: 'hash1', source: 'addr1',
            feePreference: 1, requireMemo: 0, status: 'valid'
        })
        const sql    = state.mockConnection.query.firstCall.args[0]
        const params = state.mockConnection.query.firstCall.args[1]
        assert.strictEqual(countPlaceholders(sql), 5)
        assert.strictEqual(params.length, 5)
        assert.ok(sql.includes('ao.fee_preference = ?'))
        assert.ok(sql.includes('ao.require_memo = ?'))
    })

    it('single-field: only status condition', async function () {
        await state.db.checkAddressOption({ status: 'valid' })
        const sql = state.mockConnection.query.firstCall.args[0]
        assert.strictEqual(countPlaceholders(sql), 1)
        assert.ok(sql.includes('ist.status = ?'))
    })

    it('returns null when query returns empty array', async function () {
        state.mockConnection.query.resolves([])
        const result = await state.db.checkAddressOption({ txHash: 'hash1' })
        assert.strictEqual(result, null)
    })
})

describe('checkDestroy()', function () {
    it('all-fields: 6 placeholders with tick, amount, memo, status', async function () {
        await state.db.checkDestroy({
            txHash: 'hash1', source: 'addr1', tick: 'TICK',
            amount: '50', memo: 'memo1', status: 'valid'
        })
        const sql    = state.mockConnection.query.firstCall.args[0]
        const params = state.mockConnection.query.firstCall.args[1]
        assert.strictEqual(countPlaceholders(sql), 6)
        assert.strictEqual(params.length, 6)
        assert.ok(sql.includes('d.amount = ?'))
        assert.ok(sql.includes('itick.tick = ?'))
        assert.ok(sql.includes('im.memo = ?'))
    })

    it('single-field: only tick condition', async function () {
        await state.db.checkDestroy({ tick: 'TICK' })
        const sql = state.mockConnection.query.firstCall.args[0]
        assert.strictEqual(countPlaceholders(sql), 1)
        assert.ok(sql.includes('itick.tick = ?'))
    })

    it('returns null when query returns empty array', async function () {
        state.mockConnection.query.resolves([])
        const result = await state.db.checkDestroy({ source: 'addr1' })
        assert.strictEqual(result, null)
    })

    it('memo="" produces IS NULL clause with no extra placeholder', async function () {
        await state.db.checkDestroy({ memo: '' })
        const sql    = state.mockConnection.query.firstCall.args[0]
        const params = state.mockConnection.query.firstCall.args[1]
        assert.ok(sql.includes('im.memo IS NULL'))
        assert.strictEqual(countPlaceholders(sql), 0)
        assert.strictEqual(params.length, 0)
    })
})

describe('checkBatch()', function () {
    it('all-fields: 3 placeholders', async function () {
        await state.db.checkBatch({ txHash: 'hash1', source: 'addr1', status: 'valid' })
        const sql    = state.mockConnection.query.firstCall.args[0]
        const params = state.mockConnection.query.firstCall.args[1]
        assert.strictEqual(countPlaceholders(sql), 3)
        assert.strictEqual(params.length, 3)
        assert.ok(sql.includes('ia.address = ?'))
        assert.ok(sql.includes('ist.status = ?'))
    })

    it('single-field: only txHash condition', async function () {
        await state.db.checkBatch({ txHash: 'hash1' })
        const sql = state.mockConnection.query.firstCall.args[0]
        assert.strictEqual(countPlaceholders(sql), 1)
        assert.ok(sql.includes('itx.hash = ?'))
    })

    it('returns null when query returns empty array', async function () {
        state.mockConnection.query.resolves([])
        const result = await state.db.checkBatch({ status: 'valid' })
        assert.strictEqual(result, null)
    })
})

describe('checkLink()', function () {
    it('all-fields: 7 placeholders with coin1/coin2 aliases', async function () {
        await state.db.checkLink({
            txHash: 'hash1', source: 'addr1', coin1: 'BTC',
            coin1ActionIndex: 1, coin2: 'LTC', coin2ActionIndex: 2, status: 'valid'
        })
        const sql    = state.mockConnection.query.firstCall.args[0]
        const params = state.mockConnection.query.firstCall.args[1]
        assert.strictEqual(countPlaceholders(sql), 7)
        assert.strictEqual(params.length, 7)
        assert.ok(sql.includes('ic1.coin = ?'))
        assert.ok(sql.includes('ic2.coin = ?'))
        assert.ok(sql.includes('l.coin1_action_index = ?'))
        assert.ok(sql.includes('l.coin2_action_index = ?'))
    })

    it('single-field: only coin1 condition', async function () {
        await state.db.checkLink({ coin1: 'BTC' })
        const sql = state.mockConnection.query.firstCall.args[0]
        assert.strictEqual(countPlaceholders(sql), 1)
        assert.ok(sql.includes('ic1.coin = ?'))
    })

    it('returns null when query returns empty array', async function () {
        state.mockConnection.query.resolves([])
        const result = await state.db.checkLink({ txHash: 'hash1' })
        assert.strictEqual(result, null)
    })
})

describe('checkContract()', function () {
    it('returns null immediately when no params provided (w.length === 0)', async function () {
        const result = await state.db.checkContract({})
        assert.strictEqual(result, null)
        assert.ok(!state.mockConnection.query.called)
    })

    it('all-fields: 3 placeholders with source, txHash, status', async function () {
        await state.db.checkContract({ source: 'addr1', txHash: 'hash1', status: 'valid' })
        const sql    = state.mockConnection.query.firstCall.args[0]
        const params = state.mockConnection.query.firstCall.args[1]
        assert.ok(sql.includes('ia.address = ?'))
        assert.ok(sql.includes('itx.hash = ?'))
        assert.ok(sql.includes('ist.status = ?'))
        assert.strictEqual(countPlaceholders(sql), 3)
        assert.strictEqual(params.length, 3)
    })

    it('returns null when query returns empty array', async function () {
        state.mockConnection.query.resolves([])
        const result = await state.db.checkContract({ source: 'addr1' })
        assert.strictEqual(result, null)
    })
})

function registerCheckListMatchTests() {
    it('returns the list row when items match for type=2 (address)', async function () {
        const listRow  = { id: 1, action_index: 42, type: 2 }
        const itemRows = [{ item_name: 'addr_a' }, { item_name: 'addr_b' }]

        const conn1 = { query: sinon.stub().resolves([listRow]), release: sinon.stub().resolves() }
        const conn2 = { query: sinon.stub().resolves(itemRows), release: sinon.stub().resolves() }
        state.mockPool.getConnection.onFirstCall().resolves(conn1)
        state.mockPool.getConnection.onSecondCall().resolves(conn2)

        const result = await state.db.checkList({
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
        state.mockPool.getConnection.onFirstCall().resolves(conn1)
        state.mockPool.getConnection.onSecondCall().resolves(conn2)

        const result = await state.db.checkList({
            txHash: 'hash1', type: 2, items: ['addr_a', 'addr_b']
        })

        assert.strictEqual(result, null)
    })
}

function registerCheckListMissAndTickTests() {
    it('returns null when item values mismatch', async function () {
        const listRow  = { id: 1, action_index: 42, type: 2 }
        const itemRows = [{ item_name: 'addr_a' }, { item_name: 'addr_c' }]

        const conn1 = { query: sinon.stub().resolves([listRow]), release: sinon.stub().resolves() }
        const conn2 = { query: sinon.stub().resolves(itemRows), release: sinon.stub().resolves() }
        state.mockPool.getConnection.onFirstCall().resolves(conn1)
        state.mockPool.getConnection.onSecondCall().resolves(conn2)

        const result = await state.db.checkList({
            txHash: 'hash1', type: 2, items: ['addr_a', 'addr_b']
        })

        assert.strictEqual(result, null)
    })

    it('returns null when first query finds no list row', async function () {
        const conn1 = { query: sinon.stub().resolves([]), release: sinon.stub().resolves() }
        state.mockPool.getConnection.resolves(conn1)

        const result = await state.db.checkList({ txHash: 'hash1', type: 2, items: ['addr_a'] })
        assert.strictEqual(result, null)
    })

    it('type=1 (tick list) uses index_tickers join in items query', async function () {
        const listRow  = { id: 1, action_index: 42, type: 1 }
        const itemRows = [{ item_name: 'TICK' }]

        const conn1 = { query: sinon.stub().resolves([listRow]), release: sinon.stub().resolves() }
        const conn2 = { query: sinon.stub().resolves(itemRows), release: sinon.stub().resolves() }
        state.mockPool.getConnection.onFirstCall().resolves(conn1)
        state.mockPool.getConnection.onSecondCall().resolves(conn2)

        const result = await state.db.checkList({
            type: 1, items: ['TICK']
        })

        assert.deepStrictEqual(result, listRow)
        const itemSql = conn2.query.firstCall.args[0]
        assert.ok(itemSql.includes('index_tickers'))
    })
}

function wireOneListRow(listRow, itemRows){
    const conn1 = { query: sinon.stub().resolves([listRow]), release: sinon.stub().resolves() }
    const conn2 = { query: sinon.stub().resolves(itemRows), release: sinon.stub().resolves() }
    state.mockPool.getConnection.onFirstCall().resolves(conn1)
    state.mockPool.getConnection.onSecondCall().resolves(conn2)
    return conn1
}

function registerListMemoProjectionTests() {
    it('projects the memo through the index_memos join', async function () {
        const conn1 = wireOneListRow({ id: 1, action_index: 42, type: 1, memo: 'hello' }, [{ item_name: 'TICK' }])

        const result = await state.db.checkList({ type: 1, items: ['TICK'] })

        const sql = conn1.query.firstCall.args[0]
        assert.ok(sql.includes('LEFT JOIN index_memos im ON im.id = l.memo_id'), 'joins index_memos on l.memo_id')
        assert.ok(sql.includes('im.memo AS memo'), 'projects the memo column')
        assert.strictEqual(result.memo, 'hello')
    })

    it('binds a non-empty memo as an equality filter', async function () {
        const conn1 = wireOneListRow({ id: 1, action_index: 42, type: 1, memo: 'hello' }, [{ item_name: 'TICK' }])

        await state.db.checkList({ type: 1, memo: 'hello', items: ['TICK'] })

        const [sql, values] = conn1.query.firstCall.args
        assert.ok(sql.includes('im.memo = ?'), 'emits the equality clause')
        assert.ok(values.includes('hello'), 'binds the memo value')
    })
}

function registerListMemoFilterTests() {
    it('treats an empty memo as the NULL the indexer stores', async function () {
        const conn1 = wireOneListRow({ id: 1, action_index: 42, type: 1, memo: null }, [{ item_name: 'TICK' }])

        await state.db.checkList({ type: 1, memo: '', items: ['TICK'] })

        const [sql, values] = conn1.query.firstCall.args
        assert.ok(sql.includes('im.memo IS NULL'), 'an empty memo asserts NULL, not an empty string')
        assert.ok(!values.includes(''), 'nothing is bound for the NULL check')
    })

    it('filters listActionIndex against the l alias this query actually declares', async function () {
        const conn1 = wireOneListRow({ id: 1, action_index: 42, type: 1 }, [{ item_name: 'TICK' }])

        await state.db.checkList({ type: 1, listActionIndex: 7, items: ['TICK'] })

        const [sql, values] = conn1.query.firstCall.args
        assert.ok(sql.includes('l.list_action_index = ?'), 'uses the bound alias')
        assert.ok(!/\bb\.list_action_index\b/.test(sql), 'no unbound b alias')
        assert.ok(values.includes(7))
    })
}

describe('checkList()', function () {
    registerCheckListMatchTests()
    registerCheckListMissAndTickTests()

    // LIST gained MEMO on the wire and a memo_id column on the lists table, but this
    // checker joined neither, so waitForList({memo}) was a silent no-op: a wrong,
    // dropped or unlinked LIST memo was unobservable end to end.
    describe('memo support', function () {
        registerListMemoProjectionTests()
        registerListMemoFilterTests()
    })
})
