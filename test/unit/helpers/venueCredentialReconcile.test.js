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
const path = require('path')
const proxyquire = require('proxyquire')
const sinon = require('sinon')

const PASSWORD_ENV = [
    'BTC_INDEXER_DB_PASS', 'XCHAIN_NODE_CONFIG_DIR', 'DATABASE_URL', 'DATABASE_PORT',
]

function loadChainRail(hubPass, acceptedPass) {
    class FakeHub {
        static parseEndpoints() { return [] }
        async getAllConfig() {}
    }
    sinon.stub(FakeHub.prototype, 'getAllConfig').resolves({
        bitcoin: { regtest: { 'xchain-indexer': {
            name: 'XChain_BTC_Regtest_Indexer', user: 'indexer', pass: hubPass,
        } } },
    })
    class FakeDatabase {
        constructor(host, port, name, user, pass) {
            this.pass = pass
            FakeDatabase.probes.push({ host, port, name, user, pass })
        }
        async ping() {}
    }
    FakeDatabase.probes = []
    sinon.stub(FakeDatabase.prototype, 'ping').callsFake(async function () {
        return this.pass === acceptedPass
    })

    const fsStub = {
        existsSync(file) {
            return path.basename(file) === '.env.btc' || path.basename(file) === 'bitcoin-regtest.local'
        },
        readFileSync(file) {
            if (path.basename(file) === '.env.btc') return 'INDEXER_DB_PASS=live\n'
            if (path.basename(file) === 'bitcoin-regtest.local') return 'INDEXER_DB_PASS=live\n'
            throw new Error('unexpected read: ' + file)
        },
    }
    const chainRail = proxyquire('../../helpers/chainRail', {
        fs: fsStub,
        '../../src/XChainHubConnector.js': FakeHub,
        '../../src/db.js': FakeDatabase,
    })
    return { chainRail, FakeDatabase }
}

describe('chainRail venue database credential reconciliation', function () {
    const savedEnv = {}

    beforeEach(function () {
        for (const key of PASSWORD_ENV) savedEnv[key] = process.env[key]
        process.env.BTC_INDEXER_DB_PASS = 'live'
        process.env.XCHAIN_NODE_CONFIG_DIR = '/fake/config'
        process.env.DATABASE_URL = '127.0.0.1'
        process.env.DATABASE_PORT = '13306'
    })

    afterEach(function () {
        sinon.restore()
        for (const key of PASSWORD_ENV) {
            if (savedEnv[key] === undefined) delete process.env[key]
            else process.env[key] = savedEnv[key]
        }
    })

    it('reports clean agreement across all four present stores without probing', async function () {
        const { chainRail, FakeDatabase } = loadChainRail('live', 'live')
        const result = await chainRail.reconcileVenueDbCredential('bitcoin')

        assert.deepStrictEqual(result, { agree: true, checked: 4 })
        assert.strictEqual(FakeDatabase.probes.length, 0)
    })

    it('probes each candidate and names the stale store when stores disagree', async function () {
        const { chainRail, FakeDatabase } = loadChainRail('old', 'live')

        await assert.rejects(
            chainRail.reconcileVenueDbCredential('bitcoin'),
            (err) => /hub's install-time config/.test(err.message) && !err.message.includes('old')
        )
        assert.deepStrictEqual(FakeDatabase.probes.map((probe) => probe.pass).sort(), ['live', 'old'])
    })
})
