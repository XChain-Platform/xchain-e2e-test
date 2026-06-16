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

const sinon = require('sinon')

// Shared mariadb mock — MUST be required before db.js
const mockMariadb = require('../integration/fixtures/mockMariadb')
const Database = require('../../src/db')

// Global keys that chaos tests typically save/restore
const GLOBAL_KEYS = [
    'COIN', 'NETWORK', 'NETWORK_OBJECT', 'COIN_CODE',
    'encoderConnector', 'nodeConnector', 'utxoTrackerConnector',
    'indexerDatabase', 'indexerConnector', 'regtestMinerConnector',
    'hubConnector', 'wallets'
]

function makeMockConnection(queryResult) {
    return {
        query: sinon.stub().resolves(queryResult !== undefined ? queryResult : []),
        release: sinon.stub().resolves(),
    }
}

function makeMockPool(conn) {
    return {
        getConnection: sinon.stub().resolves(conn),
        end: sinon.stub().resolves(),
    }
}

function createDb() {
    const mockConn = makeMockConnection()
    const mockPool = makeMockPool(mockConn)
    mockMariadb.createPool.returns(mockPool)
    const db = new Database('localhost', 3306, 'test_db', 'user', 'pass')
    db.sleep = sinon.stub().resolves()
    return { db, mockPool, mockConn }
}

function saveGlobals(keys) {
    const saved = {}
    for (const k of keys) {
        saved[k] = global[k]
    }
    return saved
}

function restoreGlobals(saved) {
    Object.assign(global, saved)
}

module.exports = {
    GLOBAL_KEYS,
    makeMockConnection,
    makeMockPool,
    createDb,
    saveGlobals,
    restoreGlobals,
    mockMariadb,
}
