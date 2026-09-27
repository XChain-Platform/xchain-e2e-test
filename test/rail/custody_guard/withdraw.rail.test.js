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
const cryptoHelper = require('../../cryptoHelper')
const gasHelper = require('../../helpers/gasHelper')
const issueHelper = require('../../helpers/issueHelper')
const vmHelper = require('../../helpers/vmHelper')
const transactionHelper = require('../../transactionHelper')
const { waitForTxIndexed } = require('../../helpers/indexerWait')
const { custodyWires, WITHDRAW_CASES } = require('./plan')

const ALL_DENY_GATE = `module.exports = { meta: { name: 'All Deny Gate', description: 'Controller guard that denies every action class it is bound to.', version: '1.0.0' }, guard: function(){
    xchain.revert('all-class denied');
}};`

const ALLOW_GATE = `module.exports = { meta: { name: 'Allow Gate', description: 'Controller guard that allows every action class it is bound to.', version: '1.0.0' }, guard: function(){ return {}; }};`

const PLAIN_CUSTODY = `module.exports = { meta: { name: 'Plain Custody', description: 'Plain custody target for deposit and withdrawal checks.', version: '1.0.0', ownerWithdraw: true }, ping: function(){ return 'ok'; } };`
const CHAIN = ({ bitcoin: 'BTC', litecoin: 'LTC', dogecoin: 'DOGE' })[global.COIN] || 'BTC'
const DEPOSIT_AMOUNT = '25'
const WITHDRAW_AMOUNT = '10'

function randTick(prefix) {
    let tick = prefix
    for (let i = 0; i < 6; i++) {
        tick += String.fromCharCode(65 + Math.floor(Math.random() * 26))
    }
    return tick
}

async function freshTick(prefix) {
    while (true) {
        const tick = randTick(prefix)
        const rows = await q('SELECT id FROM index_tickers WHERE tick=? LIMIT 1', [tick])
        if (rows.length === 0) return tick
    }
}

async function q(sql, params) {
    const connection = await indexerDatabase.getConnection()
    try { return await connection.query(sql, params) }
    finally { await connection.release() }
}

async function balanceOf(address, tick) {
    const rows = await q(`SELECT b.amount FROM balances b
        JOIN index_addresses ia ON ia.id=b.address_id
        JOIN index_tickers it ON it.id=b.tick_id
        WHERE ia.address=? AND it.tick=?`, [address, tick])
    return rows.length ? String(rows[0].amount) : '0'
}

async function submitBinding(owner, tick, guardIndex) {
    const wire = custodyWires({ tick, controllerIndex: guardIndex }).issue
    const txHash = await transactionHelper.createAndSendTransaction(owner, wire)
    await waitForTxIndexed(txHash, { timeoutMs: 120000, intervalMs: 250 })
}

async function submitWithdrawal(testCase, owner, custodyIndex, tick) {
    if (testCase.expect === 'valid') {
        return (await vmHelper.sendWithdrawV0(
            owner, custodyIndex, tick, WITHDRAW_AMOUNT
        )).withdrawal
    }

    const wire = ['WITHDRAW', '0', custodyIndex, tick, WITHDRAW_AMOUNT].join('|')
    const txHash = await transactionHelper.createAndSendTransaction(owner, wire)
    await waitForTxIndexed(txHash, { timeoutMs: 120000, intervalMs: 250 })
    return await indexerDatabase.checkWithdrawal({ txHash })
}

function assertVerdict(testCase, withdrawal) {
    assert(withdrawal, 'the indexed withdrawal row should exist')
    assert.strictEqual(
        String(withdrawal.status).startsWith('invalid'),
        testCase.expect === 'invalid',
        `withdrawal status ${withdrawal.status} did not match ${testCase.expect}`
    )
}

describe('controller custody guard rail: WITHDRAW', function () {
    let owner
    let guardIndexes
    let custodyIndex
    let custodyAddress

    before(async function () {
        owner = await cryptoHelper.getNewFundedAddress(
            'custody-guard-owner', COIN, NETWORK, null, 'legacy', 0, 1
        )
        await gasHelper.ensureGasBalance(owner, '5000')
        guardIndexes = {
            deny: (await vmHelper.sendDeployV0(owner, ALL_DENY_GATE, 250000)).contract.action_index,
            allow: (await vmHelper.sendDeployV0(owner, ALLOW_GATE, 250000)).contract.action_index
        }
        custodyIndex = (await vmHelper.sendDeployV0(owner, PLAIN_CUSTODY, 250000)).contract.action_index
        custodyAddress = `C:${CHAIN}:${custodyIndex}`
    })

    for (const testCase of WITHDRAW_CASES) {
        it(`WITHDRAW ${testCase.name} is ${testCase.expect}`, async function () {
            const tick = await freshTick('CGW')
            await issueHelper.sendIssueV0(
                owner, tick, '1000', '1000', '0', 'custody guard withdraw', '1000'
            )
            if (!testCase.bindBeforeWithdraw) {
                await submitBinding(owner, tick, guardIndexes[testCase.guard])
            }
            await vmHelper.sendDepositV0(owner, custodyIndex, tick, DEPOSIT_AMOUNT)
            if (testCase.bindBeforeWithdraw) {
                await submitBinding(owner, tick, guardIndexes[testCase.guard])
            }

            const custodyBefore = await balanceOf(custodyAddress, tick)
            const gasBefore = await balanceOf(owner.address, 'XCHAIN')
            const withdrawal = await submitWithdrawal(testCase, owner, custodyIndex, tick)
            assertVerdict(testCase, withdrawal)

            const custodyAfter = await balanceOf(custodyAddress, tick)
            if (testCase.expect === 'invalid') {
                assert.strictEqual(custodyAfter, custodyBefore, 'invalid withdrawal changed custody balance')
            } else {
                const gasAfter = await balanceOf(owner.address, 'XCHAIN')
                assert(Number(gasAfter) < Number(gasBefore), 'guarded withdrawal did not burn GAS')
            }
        })
    }
})
