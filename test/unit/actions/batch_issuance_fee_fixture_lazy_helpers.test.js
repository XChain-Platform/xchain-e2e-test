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

// The A4/A5 fee fixture must act on the helper instances that are live NOW, not
// the ones it saw at load time. chainRail drops nativeFeeHelper and
// priceSnapshotHelper from the require cache on every rail swap; a fixture that
// kept its load-time copies reset a dead instance's seed throttle, the live one
// re-seeded mid-batch, and A5 on LTC saw one ORDER's fee cover all three.

const assert = require('assert')
const Module = require('module')

const NATIVE = require.resolve('../../helpers/nativeFeeHelper')
const PRICES = require.resolve('../../helpers/priceSnapshotHelper')
const FIXTURE = require.resolve('../../actions/batch_issuance_limits/fee_fixture')

function fakeModule(id, exports){
    const m = new Module(id, module)
    m.id = id
    m.filename = id
    m.loaded = true
    m.exports = exports
    return m
}

function recorder(name, calls){
    return {
        seedGlobalPrices: async (force) => { calls.push(name + '.seedGlobalPrices(' + force + ')') },
        clearPair: async (pair) => { calls.push(name + '.clearPair(' + pair + ')') },
        seedSnapshot: async () => { calls.push(name + '.seedSnapshot') }
    }
}

describe('batch issuance fee fixture follows a rail swap', function () {
    const saved = {}
    let savedCoin

    beforeEach(function () {
        for (const id of [NATIVE, PRICES, FIXTURE]) saved[id] = require.cache[id]
        savedCoin = global.COIN_CODE
        global.COIN_CODE = 'LTC'
    })

    afterEach(function () {
        for (const id of [NATIVE, PRICES, FIXTURE]) {
            if (saved[id]) require.cache[id] = saved[id]
            else delete require.cache[id]
        }
        if (savedCoin === undefined) delete global.COIN_CODE
        else global.COIN_CODE = savedCoin
    })

    it('restores the pair and resets the throttle on the instance live after the swap', async function () {
        const calls = []
        // The instances the fixture would capture at load time.
        require.cache[NATIVE] = fakeModule(NATIVE, recorder('old', calls))
        require.cache[PRICES] = fakeModule(PRICES, recorder('oldPrices', calls))
        delete require.cache[FIXTURE]
        const fixture = require(FIXTURE)
        const { state } = require('../../actions/batch_issuance_limits/shared')

        // What chainRail's cache drop plus transactionHelper's lazy re-require leave behind.
        require.cache[NATIVE] = fakeModule(NATIVE, recorder('live', calls))
        require.cache[PRICES] = fakeModule(PRICES, recorder('livePrices', calls))

        const repriced = state.FEE_CASE_REPRICED
        state.FEE_CASE_REPRICED = true
        try {
            await fixture.restoreFeeFixture()
        } finally {
            state.FEE_CASE_REPRICED = repriced
        }

        assert.deepStrictEqual(calls, [
            'livePrices.clearPair(XCHAIN/USD)',
            'livePrices.clearPair(LTC/USD)',
            'live.seedGlobalPrices(true)'
        ])
    })
})
