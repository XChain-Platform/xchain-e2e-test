// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// Tests mock mariadb by injecting a synthetic module into require.cache.
// While db.js bound the driver at module-load time, that injection only worked if
// the injecting file was the FIRST in the mocha process to require db.js: a new
// test file sorting alphabetically earlier left db.js bound to the real driver, so
// every `new Database()` opened a real pool against a dead host and produced 55
// failures across unrelated describes, all timeouts pointing nowhere near the
// cause, while the injecting file still passed alone.
//
// The order dependence is what this file pins shut. Both the unit mock in
// test/unit/src/db.test.js and the shared fixture in
// test/integration/fixtures/mockMariadb.js rely on the property proved here, and
// neither can prove it about itself: each is the file that gets there first.

'use strict'

const assert = require('assert')
const sinon  = require('sinon')
const Module = require('module')

const mariadbPath = require.resolve('mariadb')
// XC701_DB_SRC lets this be pointed at an older copy of db.js, so the claim can be
// shown to FAIL against the source it fixes rather than just passing against the fix.
const dbPath      = require.resolve(process.env.XC701_DB_SRC || '../../../src/db')

function fakeDriverModule(exports) {
    const mod = new Module(mariadbPath, module)
    mod.exports = exports
    mod.loaded  = true
    mod._isMock = true
    return mod
}

describe('mariadb driver binding', function () {
    let savedDriver, savedDb

    beforeEach(function () {
        savedDriver = require.cache[mariadbPath]
        savedDb     = require.cache[dbPath]
    })

    afterEach(function () {
        // Whatever this file swapped in must not leak into the rest of the run,
        // which is the very failure mode being tested.
        if (savedDriver) require.cache[mariadbPath] = savedDriver
        else delete require.cache[mariadbPath]
        if (savedDb) require.cache[dbPath] = savedDb
        else delete require.cache[dbPath]
    })

    it('resolves the driver when a pool is created, not when db.js is loaded', function () {
        const early = { createPool: sinon.stub().returns({ marker: 'early' }) }
        const late  = { createPool: sinon.stub().returns({ marker: 'late' }) }

        // db.js is loaded while `early` is what require('mariadb') resolves to,
        // standing in for the real driver being cached by a file that sorted first.
        require.cache[mariadbPath] = fakeDriverModule(early)
        delete require.cache[dbPath]
        const Database = require(dbPath)

        // The mock arrives only afterwards, which used to be too late.
        require.cache[mariadbPath] = fakeDriverModule(late)
        const db = new Database('localhost', 3306, 'testdb', 'user', 'pass')

        assert.strictEqual(early.createPool.callCount, 0,
            'a driver cached before db.js loaded must not be the one the pool comes from')
        assert.strictEqual(late.createPool.callCount, 1)
        assert.strictEqual(db.pool.marker, 'late',
            'injection order must not decide which driver a Database gets')
    })

    it('picks up a driver swapped between two constructions', function () {
        const first  = { createPool: sinon.stub().returns({ marker: 'first' }) }
        const second = { createPool: sinon.stub().returns({ marker: 'second' }) }

        require.cache[mariadbPath] = fakeDriverModule(first)
        delete require.cache[dbPath]
        const Database = require(dbPath)

        assert.strictEqual(new Database('h', 3306, 'd', 'u', 'p').pool.marker, 'first')
        require.cache[mariadbPath] = fakeDriverModule(second)
        assert.strictEqual(new Database('h', 3306, 'd', 'u', 'p').pool.marker, 'second',
            'each pool must come from whatever driver is cached at construction time')
    })
})
