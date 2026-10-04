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
const cryptoHelper = require('../../helpers/core/cryptoHelper')
const gasHelper = require('../../helpers/gasHelper')
const issueHelper = require('../../helpers/issueHelper')
const vmHelper = require('../../helpers/vmHelper')
const transactionHelper = require('../../helpers/core/transactionHelper')
const { waitForTxIndexed } = require('../../helpers/indexerWait')
const { custodyWires, DEPOSIT_CASES } = require('./helpers/plan')

const ALL_DENY_GATE = `module.exports = { meta: { name: 'All Deny Gate', description: 'Controller guard that denies every action class it is bound to.', version: '1.0.0' }, guard: function(){
    xchain.revert('all-class denied');
}};`

const PLAIN_CUSTODY = `module.exports = { meta: { name: 'Plain Custody', description: 'Plain custody target for deposit and withdrawal checks.', version: '1.0.0', ownerWithdraw: true }, ping: function(){ return 'ok'; } };`
const CHAIN = ({ bitcoin: 'BTC', litecoin: 'LTC', dogecoin: 'DOGE' })[global.COIN] || 'BTC'
const DEPOSIT_AMOUNT = '25'

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

async function submitBinding(depositor, wire) {
    const txHash = await transactionHelper.createAndSendTransaction(depositor, wire)
    await waitForTxIndexed(txHash, { timeoutMs: 120000, intervalMs: 250 })
}

async function bindCase(testCase, depositor, tick, guardIndex) {
    const wires = custodyWires({ tick, controllerIndex: guardIndex })
    if (testCase.tokenBound) await submitBinding(depositor, wires.issue)
    if (testCase.depositorBound) await submitBinding(depositor, wires.address)
}

async function submitDeposit(testCase, depositor, custodyIndex, tick) {
    if (testCase.expect === 'valid') {
        return (await vmHelper.sendDepositV0(depositor, custodyIndex, tick, DEPOSIT_AMOUNT)).deposit
    }

    const wire = ['DEPOSIT', '0', custodyIndex, tick, DEPOSIT_AMOUNT].join('|')
    const txHash = await transactionHelper.createAndSendTransaction(depositor, wire)
    await waitForTxIndexed(txHash, { timeoutMs: 120000, intervalMs: 250 })
    return await indexerDatabase.checkDeposit({ txHash })
}

function assertVerdict(testCase, deposit) {
    assert(deposit, 'the indexed deposit row should exist')
    assert.strictEqual(
        String(deposit.status).startsWith('invalid'),
        testCase.expect === 'invalid',
        `deposit status ${deposit.status} did not match ${testCase.expect}`
    )
}

describe('controller custody guard rail: DEPOSIT', function () {
    let depositor
    let guardIndex
    let custodyIndex
    let custodyAddress

    before(async function () {
        depositor = await cryptoHelper.getNewFundedAddress(
            'custody-guard-depositor', COIN, NETWORK, null, 'legacy', 0, 1
        )
        await gasHelper.ensureGasBalance(depositor, '5000')
        guardIndex = (await vmHelper.sendDeployV0(depositor, ALL_DENY_GATE, 250000)).contract.action_index
        custodyIndex = (await vmHelper.sendDeployV0(depositor, PLAIN_CUSTODY, 250000)).contract.action_index
        custodyAddress = `C:${CHAIN}:${custodyIndex}`
    })

    for (const testCase of DEPOSIT_CASES) {
        it(`DEPOSIT ${testCase.name} is ${testCase.expect}`, async function () {
            const tick = await freshTick('CGD')
            await issueHelper.sendIssueV0(
                depositor, tick, '1000', '1000', '0', 'custody guard deposit', '1000'
            )
            await bindCase(testCase, depositor, tick, guardIndex)

            const custodyBefore = await balanceOf(custodyAddress, tick)
            const gasBefore = await balanceOf(depositor.address, 'XCHAIN')
            const deposit = await submitDeposit(testCase, depositor, custodyIndex, tick)
            assertVerdict(testCase, deposit)

            const custodyAfter = await balanceOf(custodyAddress, tick)
            if (testCase.expect === 'invalid') {
                assert.strictEqual(custodyAfter, custodyBefore, 'invalid deposit changed custody balance')
            } else {
                assert.strictEqual(custodyAfter, DEPOSIT_AMOUNT, 'valid deposit did not credit custody')
                assert.strictEqual(
                    await balanceOf(depositor.address, 'XCHAIN'),
                    gasBefore,
                    'unbound deposit burned GAS'
                )
            }
        })
    }
})
