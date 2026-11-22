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

const { assert, countPlaceholders, registerHooks, state } = require('./setup.test')

registerHooks()

describe('checkOrderMatch()', function () {
    it('applies tick, amount, and status filters', async function () {
        await state.db.checkOrderMatch({
            giveTick: 'XCHAIN', getTick: 'NFT', giveAmount: '30',
            getAmount: '3', status: 'valid'
        })
        const sql = state.mockConnection.query.firstCall.args[0]
        const params = state.mockConnection.query.firstCall.args[1]
        const where = sql.split('WHERE')[1]
        for (const clause of [
            'give_it.tick = ?', 'get_it.tick = ?', 'om.give_amount = ?',
            'om.get_amount = ?', 'ist.status = ?'
        ]) assert.ok(where.includes(clause), clause)
        assert.strictEqual(countPlaceholders(sql), 5)
        assert.deepStrictEqual(params, ['XCHAIN', 'NFT', '30', '3', 'valid'])
    })

    it('still filters by action index', async function () {
        await state.db.checkOrderMatch({ giveActionIndex: 7, getActionIndex: 9 })
        const sql = state.mockConnection.query.firstCall.args[0]
        assert.ok(sql.includes('om.give_action_index = ?'))
        assert.ok(sql.includes('om.get_action_index = ?'))
        assert.deepStrictEqual(state.mockConnection.query.firstCall.args[1], [7, 9])
    })

    it('returns null without querying when no filter is given', async function () {
        const result = await state.db.checkOrderMatch({})
        assert.strictEqual(result, null)
        assert.strictEqual(state.mockConnection.query.called, false)
    })
})
