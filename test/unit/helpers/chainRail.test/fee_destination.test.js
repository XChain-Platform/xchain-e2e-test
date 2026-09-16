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
//
// A rail swap must not let the second chain's helpers inherit the leg coin's
// FEE_DESTINATION. nativeFeeHelper.resolveFeeDestination reads that generic env
// name before it asks the indexer, and an xchain-node e2e container sets it to
// the LEG coin's address, so a BTC gas lock built from a litecoin leg paid LTC's
// regtest destination and the BTC indexer refused it (`insufficient funds
// (FEE)`, first two-stack matrix leg, 2026-09-16). These cases drive enterRail
// and createRail against a stubbed hub and assert the env the helpers see.

const sinon      = require('sinon')
const assert     = require('assert')
const proxyquire = require('proxyquire')

const XChainHubConnector = require('../../../../src/XChainHubConnector.js')

// The Database constructor opens a mariadb pool; a rail here never touches a
// database, so it gets a constructor that records its arguments and nothing else.
class FakeDatabase { constructor(host, port, name, user, pass) { Object.assign(this, { host, port, name, user, pass }) } }
const chainRail = proxyquire('../../../helpers/chainRail', { '../../src/db.js': FakeDatabase })

const HUB_CONFIG = {
    bitcoin: { regtest: {
        node:             { user: 'rpcuser', pass: 'rpcpass' },
        'xchain-indexer': { name: 'XChain_BTC_Regtest_Indexer', user: 'xchain_indexer_bitcoin_regtest', pass: 'dbpass' },
    } },
}

describe('chainRail: the rail owns FEE_DESTINATION', function () {
    const savedEnv = {}
    const keys = ['FEE_DESTINATION', 'BTC_FEE_DESTINATION', 'XCHAIN_FEE_DESTINATION_LTC_REGTEST',
                  'DATABASE_URL', 'DATABASE_PORT', 'HUB_URL', 'HUB_PORT']

    beforeEach(function () {
        for (const k of keys) savedEnv[k] = process.env[k]
        // The leg coin's env, as an xchain-node litecoin e2e container carries it.
        process.env.FEE_DESTINATION = 'mfeesJdVLx23zhtsCveA8EEfmHX7qSV2Ls'
        process.env.XCHAIN_FEE_DESTINATION_LTC_REGTEST = 'mfeesJdVLx23zhtsCveA8EEfmHX7qSV2Ls'
        delete process.env.BTC_FEE_DESTINATION
        sinon.stub(XChainHubConnector.prototype, 'ping').resolves(true)
        sinon.stub(XChainHubConnector.prototype, 'getAllConfig').resolves(HUB_CONFIG)
    })

    afterEach(function () {
        sinon.restore()
        for (const k of keys) {
            if (savedEnv[k] === undefined) delete process.env[k]
            else process.env[k] = savedEnv[k]
        }
    })

    it('createRail leaves FEE_DESTINATION unset for a chain with no override, so the helpers ask that chain', async function () {
        const rail = await chainRail.createRail('bitcoin', 'regtest')
        assert.ok(Object.prototype.hasOwnProperty.call(rail.env, 'FEE_DESTINATION'), 'the rail must own the key')
        assert.strictEqual(rail.env.FEE_DESTINATION, undefined)
    })

    it('createRail takes <CODE>_FEE_DESTINATION from the environment for that chain', async function () {
        process.env.BTC_FEE_DESTINATION = 'mfeesX6rLE6V3WPg9tsbL2fHNS7E4rDAim'
        const rail = await chainRail.createRail('bitcoin', 'regtest')
        assert.strictEqual(rail.env.FEE_DESTINATION, 'mfeesX6rLE6V3WPg9tsbL2fHNS7E4rDAim')
    })

    it('enterRail deletes the leg coin\'s FEE_DESTINATION while the rail is installed and exitRail puts it back', async function () {
        const rail = await chainRail.createRail('bitcoin', 'regtest')
        let seenInside
        await chainRail.withRail(rail, async () => { seenInside = process.env.FEE_DESTINATION })
        assert.strictEqual(seenInside, undefined, 'inside the BTC rail the LTC destination must be gone')
        assert.strictEqual(process.env.FEE_DESTINATION, 'mfeesJdVLx23zhtsCveA8EEfmHX7qSV2Ls', 'restored after the swap')
    })

    it('enterRail installs a rail\'s own FEE_DESTINATION and exitRail restores the previous one', async function () {
        process.env.BTC_FEE_DESTINATION = 'mfeesX6rLE6V3WPg9tsbL2fHNS7E4rDAim'
        const rail = await chainRail.createRail('bitcoin', 'regtest')
        let seenInside
        await chainRail.withRail(rail, async () => { seenInside = process.env.FEE_DESTINATION })
        assert.strictEqual(seenInside, 'mfeesX6rLE6V3WPg9tsbL2fHNS7E4rDAim')
        assert.strictEqual(process.env.FEE_DESTINATION, 'mfeesJdVLx23zhtsCveA8EEfmHX7qSV2Ls')
    })

    it('captureCurrentRail carries FEE_DESTINATION, so re-entering the leg chain restores its address', function () {
        const current = chainRail.captureCurrentRail()
        assert.strictEqual(current.env.FEE_DESTINATION, 'mfeesJdVLx23zhtsCveA8EEfmHX7qSV2Ls')
    })
})
