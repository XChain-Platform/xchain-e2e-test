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
    assert, sinon, registerHooks, state
} = require('./setup.test')

registerHooks()

// contract_state is utf8_general_ci, so matching the plain state_key column folds
// "Key" into "key" and an assertion can read a different key's row. The indexer
// keys current state on the utf8_bin shadow state_key_bin (armed from genesis on
// regtest), so the harness must match the same column or its assertions describe
// a key nobody wrote.
describe('getContractState() key semantics', function () {
    it('matches the binary shadow column, never the folding state_key', async function () {
        await state.db.getContractState(7, 'callback_status')
        const sql    = state.mockConnection.query.firstCall.args[0]
        const params = state.mockConnection.query.firstCall.args[1]
        assert.match(sql, /state_key_bin\s*=\s*\?/)
        assert.doesNotMatch(sql, /[^_]state_key\s*=\s*\?/)
        assert.deepStrictEqual(params, [7, 'callback_status'])
    })

    it('selects the latest row by id DESC, the writer tiebreak', async function () {
        await state.db.getContractState(7, 'callback_status')
        const sql = state.mockConnection.query.firstCall.args[0]
        assert.match(sql, /ORDER BY\s+id\s+DESC\s+LIMIT\s+1/)
        assert.doesNotMatch(sql, /ORDER BY\s+block_index/)
    })

    it('returns null when no row matches', async function () {
        state.mockConnection.query.resolves([])
        assert.strictEqual(await state.db.getContractState(7, 'missing'), null)
    })

    it('names a missing shadow column instead of swallowing it', async function () {
        const err = new Error("Unknown column 'state_key_bin' in 'where clause'")
        err.code = 'ER_BAD_FIELD_ERROR'
        state.mockConnection.query.rejects(err)
        const spy = sinon.stub(console, 'error')
        try {
            assert.strictEqual(await state.db.getContractState(7, 'callback_status'), null)
            assert.strictEqual(spy.callCount, 1)
            assert.match(spy.firstCall.args[0], /state_key_bin/)
        } finally { spy.restore() }
    })
})

describe('queryListAddresses()', function () {
    it('returns the address ids and releases its connection', async function () {
        state.mockConnection.query.resolves([{ address: 'a1' }, { address: 'a2' }])
        const result = await state.db.queryListAddresses('SELECT 1', 5)
        assert.deepStrictEqual(result, { succeeded: true, addresses: ['a1', 'a2'] })
        assert.ok(state.mockConnection.release.calledOnce)
    })

    it('releases its connection when the query fails, without throwing', async function () {
        state.mockConnection.query.rejects(new Error('query failed'))
        const result = await state.db.queryListAddresses('SELECT 1', 5)
        assert.deepStrictEqual(result, { succeeded: false })
        assert.ok(state.mockConnection.release.calledOnce)
    })

    it('reports failure when no connection can be taken', async function () {
        state.db.getConnection = sinon.stub().rejects(new Error('pool down'))
        const result = await state.db.queryListAddresses('SELECT 1', 5)
        assert.deepStrictEqual(result, { succeeded: false })
        assert.ok(state.mockConnection.release.notCalled)
    })
})
