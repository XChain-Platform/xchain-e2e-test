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
    assert, countPlaceholders, registerHooks, state
} = require('./setup.test')

registerHooks()

describe('checkIssue()', function () {
    it('all-fields: builds SQL with 9 ? placeholders and correct column aliases', async function () {
        const result = await state.db.checkIssue({
            source: 'addr1', tick: 'TICK', txHash: 'hash1',
            maxSupply: '1000', maxMint: '100', decimals: 8,
            description: 'desc', mintSupply: '500', status: 'valid'
        })
        const sql    = state.mockConnection.query.firstCall.args[0]
        const params = state.mockConnection.query.firstCall.args[1]
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
        await state.db.checkIssue({ source: 'addr1' })
        const sql = state.mockConnection.query.firstCall.args[0]
        assert.strictEqual(countPlaceholders(sql), 1)
        assert.ok(sql.includes('ia.address = ?'))
    })

    it('returns null when query returns empty array', async function () {
        state.mockConnection.query.resolves([])
        const result = await state.db.checkIssue({ tick: 'TICK' })
        assert.strictEqual(result, null)
    })
})

describe('checkSend()', function () {
    it('all-fields: 7 placeholders with correct aliases', async function () {
        await state.db.checkSend({
            source: 'addr1', destination: 'addr2', tick: 'TICK',
            amount: '100', txHash: 'hash1', memo: 'memo1', status: 'valid'
        })
        const sql    = state.mockConnection.query.firstCall.args[0]
        const params = state.mockConnection.query.firstCall.args[1]
        assert.strictEqual(countPlaceholders(sql), 7)
        assert.strictEqual(params.length, 7)
        assert.ok(sql.includes('ia.address = ?'))
        assert.ok(sql.includes('ia2.address = ?'))
        assert.ok(sql.includes('im.memo = ?'))
        assert.ok(sql.includes('amount = ?'))
    })

    it('single-field: only destination condition', async function () {
        await state.db.checkSend({ destination: 'addr2' })
        const sql = state.mockConnection.query.firstCall.args[0]
        assert.strictEqual(countPlaceholders(sql), 1)
        assert.ok(sql.includes('ia2.address = ?'))
    })

    it('returns null when query returns empty array', async function () {
        state.mockConnection.query.resolves([])
        const result = await state.db.checkSend({ tick: 'TICK' })
        assert.strictEqual(result, null)
    })
})

describe('checkCredit()', function () {
    it('all-fields: 5 placeholders including block_index and amount', async function () {
        await state.db.checkCredit({
            blockIndex: 100, txHash: 'hash1', tick: 'TICK',
            address: 'addr1', amount: '50'
        })
        const sql    = state.mockConnection.query.firstCall.args[0]
        const params = state.mockConnection.query.firstCall.args[1]
        assert.strictEqual(countPlaceholders(sql), 5)
        assert.strictEqual(params.length, 5)
        assert.ok(sql.includes('tr.block_index = ?'))
        assert.ok(sql.includes('ia.address = ?'))
        assert.ok(sql.includes('amount = ?'))
        assert.ok(sql.includes('itick.tick = ?'))
    })

    it('single-field: only txHash condition', async function () {
        await state.db.checkCredit({ txHash: 'hash1' })
        const sql = state.mockConnection.query.firstCall.args[0]
        assert.strictEqual(countPlaceholders(sql), 1)
        assert.ok(sql.includes('itx.hash = ?'))
    })

    it('returns null when query returns empty array', async function () {
        state.mockConnection.query.resolves([])
        const result = await state.db.checkCredit({ address: 'addr1' })
        assert.strictEqual(result, null)
    })
})

describe('checkDebit()', function () {
    it('all-fields: 5 placeholders with block_index', async function () {
        await state.db.checkDebit({
            blockIndex: 100, txHash: 'hash1', tick: 'TICK',
            address: 'addr1', amount: '50'
        })
        const sql    = state.mockConnection.query.firstCall.args[0]
        const params = state.mockConnection.query.firstCall.args[1]
        assert.strictEqual(countPlaceholders(sql), 5)
        assert.strictEqual(params.length, 5)
        assert.ok(sql.includes('tr.block_index = ?'))
        assert.ok(sql.includes('amount = ?'))
    })

    it('single-field: only address condition', async function () {
        await state.db.checkDebit({ address: 'addr1' })
        const sql = state.mockConnection.query.firstCall.args[0]
        assert.strictEqual(countPlaceholders(sql), 1)
        assert.ok(sql.includes('ia.address = ?'))
    })

    it('returns null when query returns empty array', async function () {
        state.mockConnection.query.resolves([])
        const result = await state.db.checkDebit({ tick: 'TICK' })
        assert.strictEqual(result, null)
    })
})

describe('checkMint()', function () {
    it('all-fields with non-empty memo: 7 placeholders', async function () {
        await state.db.checkMint({
            blockIndex: 100, txHash: 'hash1', tick: 'TICK',
            destination: 'addr1', amount: '50', memo: 'mymemo', status: 'valid'
        })
        const sql    = state.mockConnection.query.firstCall.args[0]
        const params = state.mockConnection.query.firstCall.args[1]
        assert.strictEqual(countPlaceholders(sql), 7)
        assert.strictEqual(params.length, 7)
        assert.ok(sql.includes('im.memo = ?'))
        assert.ok(sql.includes('ia.address = ?'))
    })

    it('memo="" produces IS NULL clause with no extra placeholder', async function () {
        await state.db.checkMint({ memo: '' })
        const sql    = state.mockConnection.query.firstCall.args[0]
        const params = state.mockConnection.query.firstCall.args[1]
        assert.ok(sql.includes('im.memo IS NULL'))
        assert.strictEqual(countPlaceholders(sql), 0)
        assert.strictEqual(params.length, 0)
    })

    it('returns null when query returns empty array', async function () {
        state.mockConnection.query.resolves([])
        const result = await state.db.checkMint({ tick: 'TICK' })
        assert.strictEqual(result, null)
    })
})

describe('checkBroadcast()', function () {
    it('all-fields: 9 placeholders with correct aliases', async function () {
        await state.db.checkBroadcast({
            blockIndex: 100, txHash: 'hash1', source: 'addr1',
            message: 'msg', value: '1.0', fee: '0.001',
            memo: 'memo1', broadcastActionIndex: 5, status: 'valid'
        })
        const sql    = state.mockConnection.query.firstCall.args[0]
        const params = state.mockConnection.query.firstCall.args[1]
        assert.strictEqual(countPlaceholders(sql), 9)
        assert.strictEqual(params.length, 9)
        assert.ok(sql.includes('b.message = ?'))
        assert.ok(sql.includes('b.broadcast_action_index = ?'))
        assert.ok(sql.includes('b.value = ?'))
        assert.ok(sql.includes('b.fee = ?'))
    })

    it('single-field: only source condition', async function () {
        await state.db.checkBroadcast({ source: 'addr1' })
        const sql = state.mockConnection.query.firstCall.args[0]
        assert.strictEqual(countPlaceholders(sql), 1)
        assert.ok(sql.includes('ia.address = ?'))
    })

    it('returns null when query returns empty array', async function () {
        state.mockConnection.query.resolves([])
        const result = await state.db.checkBroadcast({ txHash: 'hash1' })
        assert.strictEqual(result, null)
    })

    it('memo="" produces IS NULL clause with no extra placeholder', async function () {
        await state.db.checkBroadcast({ memo: '' })
        const sql    = state.mockConnection.query.firstCall.args[0]
        const params = state.mockConnection.query.firstCall.args[1]
        assert.ok(sql.includes('im.memo IS NULL'))
        assert.strictEqual(countPlaceholders(sql), 0)
        assert.strictEqual(params.length, 0)
    })
})

describe('checkAirdrop()', function () {
    it('all-fields: 8 placeholders with list_action_index', async function () {
        await state.db.checkAirdrop({
            blockIndex: 100, txHash: 'hash1', source: 'addr1',
            tick: 'TICK', amount: '50', listActionIndex: 10,
            memo: 'memo1', status: 'valid'
        })
        const sql    = state.mockConnection.query.firstCall.args[0]
        const params = state.mockConnection.query.firstCall.args[1]
        assert.strictEqual(countPlaceholders(sql), 8)
        assert.strictEqual(params.length, 8)
        assert.ok(sql.includes('a.list_action_index = ?'))
        assert.ok(sql.includes('ia.address = ?'))
        assert.ok(sql.includes('a.amount = ?'))
    })

    it('single-field: only tick condition', async function () {
        await state.db.checkAirdrop({ tick: 'TICK' })
        const sql = state.mockConnection.query.firstCall.args[0]
        assert.strictEqual(countPlaceholders(sql), 1)
        assert.ok(sql.includes('itick.tick = ?'))
    })

    it('returns null when query returns empty array', async function () {
        state.mockConnection.query.resolves([])
        const result = await state.db.checkAirdrop({ source: 'addr1' })
        assert.strictEqual(result, null)
    })

    it('memo="" produces IS NULL clause with no extra placeholder', async function () {
        await state.db.checkAirdrop({ memo: '' })
        const sql    = state.mockConnection.query.firstCall.args[0]
        const params = state.mockConnection.query.firstCall.args[1]
        assert.ok(sql.includes('im.memo IS NULL'))
        assert.strictEqual(countPlaceholders(sql), 0)
        assert.strictEqual(params.length, 0)
    })
})

describe('checkDispenser()', function () {
    it('getAddress non-null: adds get_ia.address = ? placeholder (uses isNullOrNullString)', async function () {
        await state.db.checkDispenser({
            blockIndex: 100, txHash: 'hash1', source: 'addr1',
            giveCoin: 'BTC', giveTick: 'TICK', giveAmount: '100',
            giveEscrow: '50', getCoin: 'LTC', getTick: 'LTICK',
            getAmount: '200', getAddress: 'getaddr', fiatCode: null,
            fiatAmount: null, expiration: null, allowList: null,
            blockList: null, memo: null, status: 'valid'
        })
        const sql = state.mockConnection.query.firstCall.args[0]
        assert.ok(sql.includes('get_ia.address = ?'))
        assert.ok(!sql.includes('get_ia.address = ias.address'))
    })

    it('when getAddress is null, adds get_ia.address = ias.address clause (no placeholder)', async function () {
        await state.db.checkDispenser({ txHash: 'hash1', getAddress: null })
        const sql = state.mockConnection.query.firstCall.args[0]
        assert.ok(sql.includes('get_ia.address = ias.address'))
    })

    it('empty-string getAddress treated as null, uses ias.address clause', async function () {
        await state.db.checkDispenser({ txHash: 'hash1', getAddress: '' })
        const sql = state.mockConnection.query.firstCall.args[0]
        assert.ok(sql.includes('get_ia.address = ias.address'))
    })

    it('returns null when query returns empty array', async function () {
        state.mockConnection.query.resolves([])
        const result = await state.db.checkDispenser({ txHash: 'hash1' })
        assert.strictEqual(result, null)
    })
})

describe('checkDispenser() fiatAmount filter', function () {
    // Pin the FIAT_AMOUNT the caller names, so a dispenser indexed with the
    // right fiat code but the wrong amount no longer satisfies the wait.
    it('fiatAmount set: adds d.fiat_amount = ? with the value bound in step', async function () {
        await state.db.checkDispenser({ txHash: 'hash1', fiatCode: 'USD', fiatAmount: '1.50' })
        const sql    = state.mockConnection.query.firstCall.args[0]
        const params = state.mockConnection.query.firstCall.args[1]
        const wherePart = sql.split('WHERE')[1] || ''
        assert.ok(wherePart.includes('d.fiat_amount = ?'))
        assert.ok(params.includes('1.50'))
        assert.strictEqual(countPlaceholders(sql), params.length)
    })

    // A dispenser with no fiat price passes "" or null, which must add no clause.
    for (const fiatAmount of [null, '']) {
        it('fiatAmount ' + JSON.stringify(fiatAmount) + ': adds no d.fiat_amount clause', async function () {
            await state.db.checkDispenser({ txHash: 'hash1', fiatAmount })
            const sql    = state.mockConnection.query.firstCall.args[0]
            const params = state.mockConnection.query.firstCall.args[1]
            const wherePart = sql.split('WHERE')[1] || ''
            assert.ok(!wherePart.includes('d.fiat_amount'))
            assert.strictEqual(countPlaceholders(sql), params.length)
        })
    }
})

describe('checkDispenser() ownership and oracle columns', function () {
    // A dispenser indexed with the wrong ownership flag or oracle address must be visible and filterable.
    it('selects d.give_ownership and the joined oracle address', async function () {
        await state.db.checkDispenser({ txHash: 'hash1' })
        const sql = state.mockConnection.query.firstCall.args[0]
        assert.ok(sql.includes('d.give_ownership,'))
        assert.ok(sql.includes('oracle_ia.address AS oracle_address'))
        assert.ok(sql.includes('LEFT JOIN index_addresses oracle_ia ON oracle_ia.id = d.oracle_address_id'))
    })

    for (const giveOwnership of [1, 0, '1', '0']) {
        it('giveOwnership ' + JSON.stringify(giveOwnership) + ': adds d.give_ownership = ? with the number bound', async function () {
            await state.db.checkDispenser({ txHash: 'hash1', giveOwnership })
            const sql    = state.mockConnection.query.firstCall.args[0]
            const params = state.mockConnection.query.firstCall.args[1]
            const wherePart = sql.split('WHERE')[1] || ''
            assert.ok(wherePart.includes('d.give_ownership = ?'))
            assert.ok(params.includes(Number(giveOwnership)))
            assert.strictEqual(countPlaceholders(sql), params.length)
        })
    }

    for (const giveOwnership of [null, undefined, '']) {
        it('giveOwnership ' + String(JSON.stringify(giveOwnership)) + ': adds no d.give_ownership clause', async function () {
            await state.db.checkDispenser({ txHash: 'hash1', giveOwnership })
            const sql    = state.mockConnection.query.firstCall.args[0]
            const params = state.mockConnection.query.firstCall.args[1]
            assert.ok(!(sql.split('WHERE')[1] || '').includes('d.give_ownership'))
            assert.strictEqual(countPlaceholders(sql), params.length)
        })
    }

    it('oracleAddress set: adds oracle_ia.address = ? with the address bound', async function () {
        await state.db.checkDispenser({ txHash: 'hash1', oracleAddress: 'addrOracle' })
        const sql    = state.mockConnection.query.firstCall.args[0]
        const params = state.mockConnection.query.firstCall.args[1]
        assert.ok((sql.split('WHERE')[1] || '').includes('oracle_ia.address = ?'))
        assert.ok(params.includes('addrOracle'))
        assert.strictEqual(countPlaceholders(sql), params.length)
    })

    for (const oracleAddress of [null, '']) {
        it('oracleAddress ' + JSON.stringify(oracleAddress) + ': adds no oracle_ia.address clause', async function () {
            await state.db.checkDispenser({ txHash: 'hash1', oracleAddress })
            const sql    = state.mockConnection.query.firstCall.args[0]
            const params = state.mockConnection.query.firstCall.args[1]
            assert.ok(!(sql.split('WHERE')[1] || '').includes('oracle_ia.address'))
            assert.strictEqual(countPlaceholders(sql), params.length)
        })
    }
})
