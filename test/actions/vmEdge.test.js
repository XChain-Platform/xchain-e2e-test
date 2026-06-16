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
const cryptoHelper = require('../cryptoHelper')
const vmHelper = require('../helpers/vmHelper')
const issueHelper = require('../helpers/issueHelper')
const gasHelper = require('../helpers/gasHelper')
const transactionHelper = require('../transactionHelper')

/**
 * VM Edge — negative paths, security boundaries, and the deploy-time constructor,
 * complementing the happy-path coverage in vmExtended.test.js. All assertions are
 * against the authoritative indexer DB.
 *
 *   G. Deploy-time constructor (initialize) runs and persists initial state
 *   H. WITHDRAW by a non-owner is rejected; custody is unchanged (security)
 *   I. Emission failure mid-execution rolls back atomically (savepoint path)
 *   J. Executing an unknown method fails cleanly with no side effects
 *   K. State delete persists across executions
 */
describe('VM Edge — negative paths & boundaries', function () {

    const CHAIN = ({ bitcoin: 'BTC', litecoin: 'LTC', dogecoin: 'DOGE' })[COIN] || 'BTC'

    // Sets initial state from a constructor param at deploy time.
    const CONSTRUCTED = `
        module.exports = {
            initialize: function() {
                xchain.state.set('initialized', xchain.getInputParam(0) || 'yes');
            },
            read: function() { return xchain.state.get('initialized'); }
        };
    `

    // Pays out tokens it does not hold — the emitted SEND must fail and roll back.
    const SENDER = `
        module.exports = {
            payout: function() {
                xchain.emit.send({
                    tick: xchain.getInputParam(2),
                    quantity: xchain.getInputParam(1),
                    destination: xchain.getInputParam(0)
                });
            }
        };
    `

    const PUT_DELETE = `
        module.exports = {
            put: function()    { xchain.state.set('k', 'v'); },
            remove: function() { xchain.state.delete('k'); }
        };
    `

    let deployer = null

    async function q(sql, params) {
        const conn = await indexerDatabase.getConnection()
        try { return await conn.query(sql, params) }
        finally { await conn.release() }
    }
    async function latestState(contractIndex, key) {
        const rows = await q(
            `SELECT state_value FROM contract_state
             WHERE contract_index=? AND state_key=?
             ORDER BY action_index DESC LIMIT 1`, [contractIndex, key])
        return rows.length ? rows[0].state_value : null
    }
    async function emissionsFor(executionIndex) {
        return await q(`SELECT emitted_action FROM contract_emissions WHERE execution_index=?`, [executionIndex])
    }
    async function balanceOf(address, tick) {
        const rows = await q(
            `SELECT b.amount FROM balances b
             JOIN index_addresses ia ON ia.id=b.address_id
             JOIN index_tickers it ON it.id=b.tick_id
             WHERE ia.address=? AND it.tick=?`, [address, tick])
        return rows.length ? String(rows[0].amount) : null
    }
    // Broadcast an EXECUTE without waiting for a valid row (negative paths never reach 'valid').
    async function rawExecute(addr, ci, method, params) {
        let msg = `EXECUTE|0|${ci}|${method}`
        if (params && params.length) msg += '|' + params.join('|')
        return await transactionHelper.createAndSendTransaction(addr, msg)
    }
    async function rawWithdraw(addr, ci, tick, amount) {
        return await transactionHelper.createAndSendTransaction(addr, `WITHDRAW|0|${ci}|${tick}|${amount}`)
    }
    async function waitForAnyExecution(ci, caller, method, timeMax = 40000) {
        const end = Date.now() + timeMax
        while (Date.now() < end) {
            const row = await indexerDatabase.checkExecution({ contractIndex: ci, caller, methodName: method })
            if (row) return row
            await new Promise(r => setTimeout(r, 1000))
        }
        return null
    }
    async function waitForAnyWithdrawal(ci, source, tick, timeMax = 40000) {
        const end = Date.now() + timeMax
        while (Date.now() < end) {
            const row = await indexerDatabase.checkWithdrawal({ contractIndex: ci, source, tick })
            if (row) return row
            await new Promise(r => setTimeout(r, 1000))
        }
        return null
    }
    function randTick(prefix) {
        let s = prefix
        for (let i = 0; i < 5; i++) s += String.fromCharCode(65 + Math.floor(Math.random() * 26))
        return s
    }

    before(async function () {
        deployer = await cryptoHelper.getNewFundedAddress('vme-deployer', COIN, NETWORK, null, 'legacy', 0, 1)
        await gasHelper.ensureGasBalance(deployer, '500')
    })

    describe('G. Deploy-time constructor', function () {
        it('runs initialize with constructor params and persists state', async function () {
            const dep = await vmHelper.sendDeployV0(deployer, CONSTRUCTED, 300000, 'hello')
            const ci = dep.contract.action_index
            const val = await latestState(ci, 'initialized')
            assert.strictEqual(val, '"hello"', `constructor should persist initialized="hello" (got ${val})`)
        })
    })

    describe('H. WITHDRAW non-owner rejection (security)', function () {
        it('rejects a withdrawal from a non-owner and leaves custody intact', async function () {
            const tick = randTick('VME')
            await issueHelper.sendIssueV0(deployer, tick, '1000', '1000', '0', 'vm edge', '1000')

            const dep = await vmHelper.sendDeployV0(deployer, PUT_DELETE, 200000)
            const ci = dep.contract.action_index
            const contractAddr = `C:${CHAIN}:${ci}`

            await vmHelper.sendDepositV0(deployer, ci, tick, '100')
            assert.strictEqual(await balanceOf(contractAddr, tick), '100')

            // A different funded address (not the contract owner) attempts to withdraw.
            const attacker = await cryptoHelper.getNewFundedAddress('vme-attacker', COIN, NETWORK, null, 'legacy', 0, 1)
            await rawWithdraw(attacker, ci, tick, '100')

            const row = await waitForAnyWithdrawal(ci, attacker.address, tick)
            assert(row, 'a (rejected) withdrawal row should be recorded')
            assert.notStrictEqual(row.status, 'valid', 'non-owner withdrawal must not be valid')
            assert(/owner/i.test(row.status), `status should cite ownership (got: ${row.status})`)

            // Custody untouched: contract still holds 100, attacker got nothing.
            assert.strictEqual(await balanceOf(contractAddr, tick), '100', 'contract balance must be unchanged')
            assert.strictEqual(await balanceOf(attacker.address, tick), null, 'attacker must not receive tokens')
        })
    })

    describe('I. Emission failure rolls back atomically', function () {
        it('a failed emitted SEND aborts the whole execution', async function () {
            const tick = randTick('VMF')
            // Token exists (held by deployer) but the contract holds none of it.
            await issueHelper.sendIssueV0(deployer, tick, '1000', '1000', '0', 'vm edge fail', '1000')

            const dep = await vmHelper.sendDeployV0(deployer, SENDER, 200000)
            const ci = dep.contract.action_index
            const contractAddr = `C:${CHAIN}:${ci}`
            const recipient = await cryptoHelper.getNewFundedAddress('vme-recipient', COIN, NETWORK, null, 'legacy', 0, 1)

            await rawExecute(deployer, ci, 'payout', [recipient.address, '50', tick])

            const row = await waitForAnyExecution(ci, deployer.address, 'payout')
            assert(row, 'an execution row should be recorded')
            assert.notStrictEqual(row.status, 'valid', 'execution with a failed emission must not be valid')
            assert.strictEqual(Number(row.emitted_count), 0, 'no emissions should be committed')

            const emissions = await emissionsFor(row.action_index)
            assert.strictEqual(emissions.length, 0, 'no contract_emissions rows')
            assert.strictEqual(await balanceOf(recipient.address, tick), null, 'recipient must not receive anything')
            assert.strictEqual(await balanceOf(contractAddr, tick), null, 'contract balance unchanged (held none)')
        })
    })

    describe('J. Unknown method', function () {
        it('executing a non-existent method fails cleanly', async function () {
            const dep = await vmHelper.sendDeployV0(deployer, PUT_DELETE, 200000)
            const ci = dep.contract.action_index

            await rawExecute(deployer, ci, 'doesNotExist', [])
            const row = await waitForAnyExecution(ci, deployer.address, 'doesNotExist')
            assert(row, 'an execution row should be recorded')
            assert.notStrictEqual(row.status, 'valid', 'unknown method must not be valid')
            assert.strictEqual(Number(row.emitted_count), 0)
        })
    })

    describe('K. State delete', function () {
        it('delete persists across executions', async function () {
            const dep = await vmHelper.sendDeployV0(deployer, PUT_DELETE, 200000)
            const ci = dep.contract.action_index

            const put = await vmHelper.sendExecuteV0(deployer, ci, 'put', [])
            assert.strictEqual(put.execution.status, 'valid')
            assert.strictEqual(await latestState(ci, 'k'), '"v"', 'put should set k="v"')

            const rem = await vmHelper.sendExecuteV0(deployer, ci, 'remove', [])
            assert.strictEqual(rem.execution.status, 'valid')
            assert.strictEqual(await latestState(ci, 'k'), null, 'remove should delete k (latest state null)')
        })
    })
})
