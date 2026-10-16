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

const assert = require('assert')
const sinon  = require('sinon')
const Module = require('module')

const mariadbPath = require.resolve('mariadb')

const mockMariadb = {
    createPool: sinon.stub()
}

const mariadbModule = new Module(mariadbPath, module)
mariadbModule.exports = mockMariadb
mariadbModule.loaded  = true
require.cache[mariadbPath] = mariadbModule

delete require.cache[require.resolve('../../../../src/db')]

const Database = require('../../../../src/db')
const state = {}
let hooksRegistered = false

function makeMockConnection(queryResult) {
    return {
        query:   sinon.stub().resolves(queryResult !== undefined ? queryResult : [{ id: 1 }]),
        release: sinon.stub().resolves()
    }
}

function countPlaceholders(sql) {
    return (sql.match(/\?/g) || []).length
}

function registerHooks() {
    if (hooksRegistered) return
    hooksRegistered = true

    beforeEach(function () {
        state.mockConnection = makeMockConnection([{ id: 1 }])
        state.mockPool = { getConnection: sinon.stub().resolves(state.mockConnection) }

        mockMariadb.createPool.reset()
        mockMariadb.createPool.returns(state.mockPool)

        state.db = new Database('localhost', 3306, 'testdb', 'user', 'pass')
        state.db.sleep = sinon.stub().resolves()
    })

    afterEach(function () {
        sinon.restore()
    })
}

module.exports = {
    assert,
    sinon,
    Database,
    state,
    makeMockConnection,
    countPlaceholders,
    registerHooks
}
