'use strict'

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available —
// contact legal@dankest.llc.

// Chaos Experiment 8: GAS Token Bootstrap Failure (@P0)
//
// Verifies that when the GAS token (XCHAIN) creation fails during bootstrap,
// the suite aborts with a diagnostic error rather than running tests that
// will all fail.

const assert = require('assert')
const sinon = require('sinon')
const bitcoin = require('bitcoinjs-lib')
const { saveGlobals, restoreGlobals, GLOBAL_KEYS } = require('./chaos-helpers')

const GAS_TICK = 'XCHAIN'

// Replicate the GAS token bootstrap logic from initialCheck.test.js
async function runGasBootstrap(db, cryptoHelper, issueHelper) {
    const gasTokenExists = await db.checkIssue({ tick: GAS_TICK, status: 'valid' })
    if (!gasTokenExists) {
        const gasAddrInfo = await cryptoHelper.getNewFundedAddress(
            'GAS.TOKEN', global.COIN, global.NETWORK, null, 'legacy', 0, 1
        )
        await issueHelper.sendIssueV0(
            gasAddrInfo, GAS_TICK, 1000000000, 1000000, 0, 'XChain GAS Token', 1000000
        )
    }
    return true
}

describe('Chaos Experiment 8 — GAS Token Bootstrap Failure @P0', function () {

    let saved

    beforeEach(function () {
        saved = saveGlobals(GLOBAL_KEYS)
        global.COIN = 'bitcoin'
        global.NETWORK = 'regtest'
        global.NETWORK_OBJECT = bitcoin.networks.regtest
        global.wallets = {}
    })

    afterEach(function () {
        restoreGlobals(saved)
        sinon.restore()
    })

    it('rejects when encoder is unreachable during GAS token creation', async function () {
        const mockDb = {
            checkIssue: sinon.stub().resolves(null) // GAS token does not exist
        }
        const mockCryptoHelper = {
            getNewFundedAddress: sinon.stub().resolves({
                address: 'addr_gas',
                privateKey: Buffer.alloc(32, 1),
                publicKey: Buffer.alloc(33, 2)
            })
        }
        const mockIssueHelper = {
            sendIssueV0: sinon.stub().rejects(new Error('Error trying to create a tx with the encoder module'))
        }

        await assert.rejects(
            () => runGasBootstrap(mockDb, mockCryptoHelper, mockIssueHelper),
            /encoder module/
        )
        assert(mockDb.checkIssue.calledOnce, 'should check if GAS token exists')
        assert(mockCryptoHelper.getNewFundedAddress.calledOnce, 'should attempt to fund address')
        assert(mockIssueHelper.sendIssueV0.calledOnce, 'should attempt to issue GAS token')
    })

    it('rejects when regtest miner is unreachable during funding', async function () {
        const mockDb = {
            checkIssue: sinon.stub().resolves(null)
        }
        const mockCryptoHelper = {
            getNewFundedAddress: sinon.stub().rejects(new Error("The sent tx didn't appear in the blockchain"))
        }
        const mockIssueHelper = {
            sendIssueV0: sinon.stub()
        }

        await assert.rejects(
            () => runGasBootstrap(mockDb, mockCryptoHelper, mockIssueHelper),
            /didn't appear in the blockchain/
        )
        assert(mockIssueHelper.sendIssueV0.notCalled, 'should not attempt issue when funding fails')
    })

    it('skips creation when GAS token already exists', async function () {
        const existingRow = { tick: GAS_TICK, status: 'valid', max_supply: '1000000000' }
        const mockDb = {
            checkIssue: sinon.stub().resolves(existingRow)
        }
        const mockCryptoHelper = {
            getNewFundedAddress: sinon.stub()
        }
        const mockIssueHelper = {
            sendIssueV0: sinon.stub()
        }

        const result = await runGasBootstrap(mockDb, mockCryptoHelper, mockIssueHelper)

        assert.strictEqual(result, true)
        assert(mockCryptoHelper.getNewFundedAddress.notCalled, 'should not fund when GAS exists')
        assert(mockIssueHelper.sendIssueV0.notCalled, 'should not issue when GAS exists')
    })

    it('rejects with descriptive error when db.checkIssue itself fails', async function () {
        const mockDb = {
            checkIssue: sinon.stub().rejects(new Error('ER_ACCESS_DENIED_ERROR'))
        }
        const mockCryptoHelper = { getNewFundedAddress: sinon.stub() }
        const mockIssueHelper = { sendIssueV0: sinon.stub() }

        await assert.rejects(
            () => runGasBootstrap(mockDb, mockCryptoHelper, mockIssueHelper),
            /ER_ACCESS_DENIED_ERROR/
        )
    })
})
