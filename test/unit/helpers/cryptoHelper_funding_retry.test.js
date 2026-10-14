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
const assert = require('assert')
const cryptoHelper = require('../../helpers/core/cryptoHelper')

const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const TRANSIENT = () => new Error('There was a problem sending funds')

describe('cryptoHelper getNewFundedAddress funding retry', () => {
    let sendFunds
    let savedDelay

    beforeEach(() => {
        savedDelay = cryptoHelper.fundingRetryBaseDelayMs
        cryptoHelper.fundingRetryBaseDelayMs = 1
        sendFunds = sinon.stub()
        global.regtestMinerConnector = { sendFunds }
        global.nodeConnector = { waitForTx: sinon.stub().resolves(true) }
        global.utxoTrackerConnector = { waitForUtxos: sinon.stub().resolves(true) }
        global.wallets = {}
        sinon.stub(console, 'log')
    })

    afterEach(() => {
        cryptoHelper.fundingRetryBaseDelayMs = savedDelay
        sinon.restore()
        delete global.regtestMinerConnector
        delete global.nodeConnector
        delete global.utxoTrackerConnector
        global.wallets = {}
    })

    const fund = () => cryptoHelper.getNewFundedAddress('retry', 'bitcoin', 'regtest', MNEMONIC, 'legacy', 0, 1, false)

    it('succeeds first time with a single call', async () => {
        sendFunds.resolves('tx1')
        const info = await fund()
        assert.ok(info.address)
        assert.strictEqual(sendFunds.callCount, 1)
    })

    it('retries a transient miner error and then succeeds', async () => {
        sendFunds.onCall(0).rejects(TRANSIENT())
        sendFunds.onCall(1).rejects(TRANSIENT())
        sendFunds.onCall(2).resolves('tx3')
        const info = await fund()
        assert.ok(info.address)
        assert.strictEqual(sendFunds.callCount, 3)
    })

    it('gives up after three attempts and rethrows', async () => {
        sendFunds.rejects(TRANSIENT())
        await assert.rejects(fund, /problem sending funds/)
        assert.strictEqual(sendFunds.callCount, 3)
    })

    it('does not retry other errors', async () => {
        sendFunds.rejects(new Error('Miner unreachable'))
        await assert.rejects(fund, /Miner unreachable/)
        assert.strictEqual(sendFunds.callCount, 1)
    })

    it('backs off with doubling delays', async () => {
        cryptoHelper.fundingRetryBaseDelayMs = 20
        const clock = sinon.spy(global, 'setTimeout')
        sendFunds.onCall(0).rejects(TRANSIENT())
        sendFunds.onCall(1).rejects(TRANSIENT())
        sendFunds.onCall(2).resolves('tx3')
        await fund()
        const delays = clock.getCalls().map(c => c.args[1]).filter(d => d === 20 || d === 40)
        assert.deepStrictEqual(delays, [20, 40])
    })
})
