'use strict'

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const assert = require('assert')
const proxyquire = require('proxyquire').noCallThru().noPreserveCache()
const sinon = require('sinon')

describe('batch issuance gas-child funding', function () {
    let savedContext
    let savedIt
    let savedCoin
    let savedNetwork

    beforeEach(function () {
        savedContext = global.context
        savedIt = global.it
        savedCoin = global.COIN
        savedNetwork = global.NETWORK
        global.COIN = 'bitcoin'
        global.NETWORK = 'regtest'
    })

    afterEach(function () {
        if (savedContext === undefined) delete global.context
        else global.context = savedContext
        if (savedIt === undefined) delete global.it
        else global.it = savedIt
        if (savedCoin === undefined) delete global.COIN
        else global.COIN = savedCoin
        if (savedNetwork === undefined) delete global.NETWORK
        else global.NETWORK = savedNetwork
        sinon.restore()
    })

    it('uses the supply-aware gas funder for the exact A6 budget', async function () {
        const addressInfo = { address: 'bcrt1qbatchgaschildren000000000000000000' }
        const getNewFundedAddress = sinon.stub().resolves(addressInfo)
        const ensureGasBalance = sinon.stub().resolves({ txHash: 'funding-tx' })
        const sendMintV0 = sinon.stub().throws(new Error('A6 bypassed the supply-aware funder'))
        const sendBatch = sinon.stub().resolves({ batch: { status: 'valid' }, txHash: 'batch-tx' })
        const sendGasPaidIssue = sinon.stub().resolves({ txHash: 'parent-tx' })
        const balances = ['4', '3', '0']
        const balanceOf = sinon.stub().callsFake(async () => balances.shift())
        const issues = [
            ...Array.from({ length: 6 }, (_, n) => ({ action_index: n + 1, status: 'valid' })),
            ...Array.from({ length: 2 }, (_, n) => ({ action_index: n + 7, status: 'invalid: insufficient funds (FEE)' }))
        ]
        const waitForIssueCount = sinon.stub().resolves(issues)
        const debitsForTx = sinon.stub().resolves(
            Array.from({ length: 6 }, (_, n) => ({ action_index: n + 1, amount: '0.5' }))
        )
        let runCase

        global.context = (name, register) => register()
        global.it = (name, test) => { runCase = test }

        const register = proxyquire('../actions/batch_issuance_limits/gas_children', {
            '../../helpers/core/cryptoHelper': { getNewFundedAddress },
            '../../helpers/gasHelper': { ensureGasBalance },
            '../../helpers/mintHelper': { sendMintV0 },
            '../../helpers/batchHelper': { sendBatch },
            './shared': {
                GAS_TICK: 'XCHAIN',
                XCHAIN_PER_ISSUE: 1,
                XCHAIN_PER_CHILD_ISSUE: 0.5,
                state: { GAS_MODE: true },
                debitsForTx,
                balanceOf,
                waitForIssueCount,
                issueCmd: (tick) => 'ISSUE:' + tick,
                sendGasPaidIssue
            }
        })

        register()
        assert.strictEqual(typeof runCase, 'function', 'A6 must register its test case')
        await runCase.call({ skip: () => { throw new Error('A6 unexpectedly skipped') } })

        assert.strictEqual(getNewFundedAddress.firstCall.args[7], false,
            'the fresh A6 address must not receive the default gas seed')
        assert(ensureGasBalance.calledOnceWithExactly(addressInfo, 4),
            'the supply-aware funder must receive the parent plus six-child budget')
        assert(sendMintV0.notCalled, 'A6 must not bypass gasHelper with a direct MINT')
        assert(sendGasPaidIssue.calledOnce)
        assert(sendBatch.calledOnce)
        assert.strictEqual(balanceOf.callCount, 3)
    })
})
