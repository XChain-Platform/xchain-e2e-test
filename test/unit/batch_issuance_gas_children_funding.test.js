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

const GLOBAL_KEYS = ['context', 'it', 'COIN', 'NETWORK']

function saveGlobals() {
    const saved = {}
    for (const key of GLOBAL_KEYS) saved[key] = global[key]
    global.COIN = 'bitcoin'
    global.NETWORK = 'regtest'
    return saved
}

function restoreGlobals(saved) {
    for (const key of GLOBAL_KEYS) {
        if (saved[key] === undefined) delete global[key]
        else global[key] = saved[key]
    }
    sinon.restore()
}

function makeIssues() {
    return [
        ...Array.from({ length: 6 }, (_, n) => ({ action_index: n + 1, status: 'valid' })),
        ...Array.from({ length: 2 }, (_, n) => ({ action_index: n + 7, status: 'invalid: insufficient funds (FEE)' }))
    ]
}

function makeStubs() {
    const addressInfo = { address: 'bcrt1qbatchgaschildren000000000000000000' }
    const balances = ['4', '3', '0']
    return {
        addressInfo,
        getNewFundedAddress: sinon.stub().resolves(addressInfo),
        ensureGasBalance: sinon.stub().resolves({ txHash: 'funding-tx' }),
        sendMintV0: sinon.stub().throws(new Error('A6 bypassed the supply-aware funder')),
        sendBatch: sinon.stub().resolves({ batch: { status: 'valid' }, txHash: 'batch-tx' }),
        sendGasPaidIssue: sinon.stub().resolves({ txHash: 'parent-tx' }),
        balanceOf: sinon.stub().callsFake(async () => balances.shift()),
        waitForIssueCount: sinon.stub().resolves(makeIssues()),
        debitsForTx: sinon.stub().resolves(
            Array.from({ length: 6 }, (_, n) => ({ action_index: n + 1, amount: '0.5' }))
        )
    }
}

function loadRegister(stubs) {
    return proxyquire('../actions/batch_issuance_limits/gas_children.test', {
        '../../helpers/core/cryptoHelper': { getNewFundedAddress: stubs.getNewFundedAddress },
        '../../helpers/gasHelper': { ensureGasBalance: stubs.ensureGasBalance },
        '../../helpers/mintHelper': { sendMintV0: stubs.sendMintV0 },
        '../../helpers/batchHelper': { sendBatch: stubs.sendBatch },
        './lib/shared': {
            GAS_TICK: 'XCHAIN',
            XCHAIN_PER_ISSUE: 1,
            XCHAIN_PER_CHILD_ISSUE: 0.5,
            state: { GAS_MODE: true },
            debitsForTx: stubs.debitsForTx,
            balanceOf: stubs.balanceOf,
            waitForIssueCount: stubs.waitForIssueCount,
            issueCmd: (tick) => 'ISSUE:' + tick,
            sendGasPaidIssue: stubs.sendGasPaidIssue
        }
    })
}

async function runRegisteredCase(stubs) {
    let runCase
    global.context = (name, register) => register()
    global.it = (name, test) => { runCase = test }
    loadRegister(stubs)()
    assert.strictEqual(typeof runCase, 'function', 'A6 must register its test case')
    await runCase.call({ skip: () => { throw new Error('A6 unexpectedly skipped') } })
}

function assertExactBudgetFunding(stubs) {
    assert.strictEqual(stubs.getNewFundedAddress.firstCall.args[7], false,
        'the fresh A6 address must not receive the default gas seed')
    assert(stubs.ensureGasBalance.calledOnceWithExactly(stubs.addressInfo, 4),
        'the supply-aware funder must receive the parent plus six-child budget')
    assert(stubs.sendMintV0.notCalled, 'A6 must not bypass gasHelper with a direct MINT')
    assert(stubs.sendGasPaidIssue.calledOnce)
    assert(stubs.sendBatch.calledOnce)
    assert.strictEqual(stubs.balanceOf.callCount, 3)
}

describe('batch issuance gas-child funding', function () {
    let saved

    beforeEach(function () { saved = saveGlobals() })

    afterEach(function () { restoreGlobals(saved) })

    it('uses the supply-aware gas funder for the exact A6 budget', async function () {
        const stubs = makeStubs()
        await runRegisteredCase(stubs)
        assertExactBudgetFunding(stubs)
    })
})
