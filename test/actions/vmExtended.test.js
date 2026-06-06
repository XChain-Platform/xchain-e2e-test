// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available —
// contact legal@dankest.llc.

const assert = require('assert')
const cryptoHelper = require('../cryptoHelper')
const vmHelper = require('../helpers/vmHelper')
const issueHelper = require('../helpers/issueHelper')
const gasHelper = require('../helpers/gasHelper')

/**
 * VM Extended — exercises the smart-contract engine end-to-end against the live
 * regtest stack, going beyond the baseline DEPLOY/EXECUTE happy path:
 *
 *   A. State persistence across separate on-chain executions
 *   B. Revert atomicity (no state / no emissions / failed status)
 *   C. Gas exhaustion (out-of-gas execution, no side effects)
 *   D. Emission round trip — emit.issue mints a token to the contract address
 *   E. DEPOSIT / WITHDRAW token custody round trip
 *   F. Emission round trip — emit.send pays deposited tokens to a recipient
 *
 * Every assertion is made against the authoritative indexer DB, not VM return
 * values (which are not persisted on-chain).
 */
describe('VM Extended — on-chain capabilities', function () {

    // Coin symbol used in the contract derived address: C:<CHAIN>:<action_index>
    const CHAIN = ({ bitcoin: 'BTC', litecoin: 'LTC', dogecoin: 'DOGE' })[COIN] || 'BTC'

    const COUNTER = `
        module.exports = {
            increment: function() {
                var c = parseInt(xchain.state.get('count') || '0');
                xchain.state.set('count', String(c + 1));
                return String(c + 1);
            }
        };
    `

    // Writes state AND emits an action, then reverts — both must be discarded.
    const REVERT_ATOMIC = `
        module.exports = function() {
            xchain.state.set('ghost', 'should-not-persist');
            xchain.emit.destroy({ tick: 'XCHAIN', quantity: '1' });
            xchain.revert('intentional revert');
        };
    `

    // Loop that burns well past the 1,000,000 gas ceiling (fast in wall-clock).
    const GAS_BOMB = `
        module.exports = {
            burn: function() {
                var x = 0;
                for (var i = 0; i < 5000000; i++) { x = x + i; }
                return String(x);
            }
        };
    `

    // Mints a brand-new token to the contract's own derived address.
    const MINTER = `
        module.exports = {
            mintToken: function() {
                var tick = xchain.getInputParam(0);
                xchain.emit.issue({
                    tick: tick, maxSupply: '1000', maxMint: '1000',
                    decimals: '0', mintSupply: '1000', description: 'vm-minted'
                });
                return tick;
            }
        };
    `

    // Pays out deposited tokens: payout(destination, amount, tick)
    const SENDER = `
        module.exports = {
            payout: function() {
                var dest = xchain.getInputParam(0);
                var amt  = xchain.getInputParam(1);
                var tick = xchain.getInputParam(2);
                xchain.emit.send({ tick: tick, quantity: amt, destination: dest });
            }
        };
    `

    let deployer = null

    // --- raw indexer-DB helpers (no waitFor* exists for these tables) ---
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
        return await q(
            `SELECT emitted_action, position FROM contract_emissions
             WHERE execution_index=? ORDER BY position`, [executionIndex])
    }
    async function balanceOf(address, tick) {
        const rows = await q(
            `SELECT b.amount FROM balances b
             JOIN index_addresses ia ON ia.id=b.address_id
             JOIN index_tickers it ON it.id=b.tick_id
             WHERE ia.address=? AND it.tick=?`, [address, tick])
        return rows.length ? String(rows[0].amount) : null
    }
    async function gasDebitFor(actionIndex) {
        return await q(
            `SELECT d.amount FROM debits d
             JOIN index_tickers it ON it.id=d.tick_id
             WHERE d.action_index=? AND it.tick='XCHAIN'`, [actionIndex])
    }
    async function tickExists(tick) {
        const rows = await q(`SELECT id FROM index_tickers WHERE tick=? LIMIT 1`, [tick])
        return rows.length > 0
    }
    // Poll for an execution row regardless of status (failed runs never reach status='valid').
    async function waitForAnyExecution(contractIndex, caller, method, timeMax = 60000) {
        const end = Date.now() + timeMax
        while (Date.now() < end) {
            const row = await indexerDatabase.checkExecution({ contractIndex, caller, methodName: method })
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
        deployer = await cryptoHelper.getNewFundedAddress('vmx-deployer', COIN, NETWORK, null, 'legacy', 0, 1)
        await gasHelper.ensureGasBalance(deployer, '500')
    })

    describe('A. State persistence across executions', function () {
        it('increments persist across separate on-chain EXECUTEs', async function () {
            const dep = await vmHelper.sendDeployV0(deployer, COUNTER, 200000)
            const ci = dep.contract.action_index

            const e1 = await vmHelper.sendExecuteV0(deployer, ci, 'increment', [])
            assert(e1.execution, 'first increment should produce an execution row')
            assert.strictEqual(e1.execution.status, 'valid')
            assert(e1.execution.gas_used > 0, 'gas should be consumed')

            const e2 = await vmHelper.sendExecuteV0(deployer, ci, 'increment', [])
            assert(e2.execution, 'second increment should produce an execution row')
            assert.strictEqual(e2.execution.status, 'valid')

            const val = await latestState(ci, 'count')
            assert.strictEqual(val, '"2"', `count should persist as 2 across executions (got ${val})`)
        })
    })

    describe('B. Revert atomicity', function () {
        it('reverted execution persists no state and no emissions', async function () {
            const dep = await vmHelper.sendDeployV0(deployer, REVERT_ATOMIC, 200000)
            const ci = dep.contract.action_index

            // Helper waits for status='valid' then falls back to a no-txHash search;
            // a revert never reaches 'valid', so use the status-agnostic poller.
            await vmHelper.sendExecuteV0(deployer, ci, 'default', []).catch(() => {})
            const row = await waitForAnyExecution(ci, deployer.address, 'default')
            assert(row, 'a (failed) execution row should still be recorded')
            assert.strictEqual(row.status, 'reverted', `revert should yield status 'reverted' (got: ${row.status})`)
            assert.strictEqual(Number(row.emitted_count), 0, 'no emissions should be recorded on revert')

            const ghost = await latestState(ci, 'ghost')
            assert.strictEqual(ghost, null, 'state written before revert must NOT persist')

            const emissions = await emissionsFor(row.action_index)
            assert.strictEqual(emissions.length, 0, 'no contract_emissions rows on revert')

            // Caller must be charged gas for the failed attempt (no debit pre-fix).
            const debit = await gasDebitFor(row.action_index)
            assert(debit.length > 0, 'caller should be charged GAS for the reverted execution')
        })
    })

    describe('C. Gas exhaustion', function () {
        it('over-budget loop fails out-of-gas with no side effects', async function () {
            const dep = await vmHelper.sendDeployV0(deployer, GAS_BOMB, 200000)
            const ci = dep.contract.action_index

            await vmHelper.sendExecuteV0(deployer, ci, 'burn', []).catch(() => {})
            const row = await waitForAnyExecution(ci, deployer.address, 'burn')
            assert(row, 'an execution row should be recorded for the out-of-gas attempt')
            assert.strictEqual(row.status, 'out_of_gas', `gas exhaustion should yield status 'out_of_gas' (got: ${row.status})`)
            assert.strictEqual(Number(row.emitted_count), 0, 'no emissions on gas exhaustion')

            // Caller must be charged gas (the full burned amount) for the failed attempt.
            const debit = await gasDebitFor(row.action_index)
            assert(debit.length > 0, 'caller should be charged GAS for the out-of-gas execution')
        })
    })

    describe('D. Emission — emit.issue mints to the contract address', function () {
        it('contract issues a token to its own derived address', async function () {
            const dep = await vmHelper.sendDeployV0(deployer, MINTER, 300000)
            const ci = dep.contract.action_index
            const tick = randTick('VMI')

            const ex = await vmHelper.sendExecuteV0(deployer, ci, 'mintToken', [tick])
            assert(ex.execution, 'mintToken should produce an execution row')
            assert.strictEqual(ex.execution.status, 'valid')
            assert.strictEqual(Number(ex.execution.emitted_count), 1, 'exactly one emission expected')

            const emissions = await emissionsFor(ex.execution.action_index)
            assert.strictEqual(emissions.length, 1)
            assert.strictEqual(emissions[0].emitted_action, 'ISSUE')

            assert(await tickExists(tick), `emitted token ${tick} should exist`)

            const contractAddr = `C:${CHAIN}:${ci}`
            const bal = await balanceOf(contractAddr, tick)
            assert.strictEqual(bal, '1000',
                `contract address ${contractAddr} should hold the minted supply (got ${bal})`)
        })
    })

    describe('E. DEPOSIT / WITHDRAW custody round trip', function () {
        it('deposits then withdraws a token through the contract address', async function () {
            const tick = randTick('VMD')
            await issueHelper.sendIssueV0(deployer, tick, '1000', '1000', '0', 'vm deposit test', '1000')

            const dep = await vmHelper.sendDeployV0(deployer, COUNTER, 200000)
            const ci = dep.contract.action_index
            const contractAddr = `C:${CHAIN}:${ci}`

            const d = await vmHelper.sendDepositV0(deployer, ci, tick, '100')
            assert(d.deposit, 'deposit row should exist')
            assert.strictEqual(d.deposit.status, 'valid')
            assert.strictEqual(await balanceOf(contractAddr, tick), '100', 'contract should hold deposited amount')
            assert.strictEqual(await balanceOf(deployer.address, tick), '900', 'depositor balance should drop by 100')

            const w = await vmHelper.sendWithdrawV0(deployer, ci, tick, '40')
            assert(w.withdrawal, 'withdrawal row should exist')
            assert.strictEqual(w.withdrawal.status, 'valid')
            assert.strictEqual(await balanceOf(contractAddr, tick), '60', 'contract balance should drop by 40')
            assert.strictEqual(await balanceOf(deployer.address, tick), '940', 'depositor should recover 40')
        })
    })

    describe('F. Emission — emit.send pays out deposited tokens', function () {
        it('contract sends deposited tokens to a recipient', async function () {
            const tick = randTick('VMS')
            await issueHelper.sendIssueV0(deployer, tick, '1000', '1000', '0', 'vm send test', '1000')

            const recipient = await cryptoHelper.getNewFundedAddress('vmx-recipient', COIN, NETWORK, null, 'legacy', 0, 1)

            const dep = await vmHelper.sendDeployV0(deployer, SENDER, 200000)
            const ci = dep.contract.action_index
            const contractAddr = `C:${CHAIN}:${ci}`

            await vmHelper.sendDepositV0(deployer, ci, tick, '100')
            assert.strictEqual(await balanceOf(contractAddr, tick), '100')

            const ex = await vmHelper.sendExecuteV0(deployer, ci, 'payout', [recipient.address, '30', tick])
            assert(ex.execution, 'payout should produce an execution row')
            assert.strictEqual(ex.execution.status, 'valid')
            assert.strictEqual(Number(ex.execution.emitted_count), 1, 'one SEND emission expected')

            const emissions = await emissionsFor(ex.execution.action_index)
            assert.strictEqual(emissions[0].emitted_action, 'SEND')

            assert.strictEqual(await balanceOf(recipient.address, tick), '30', 'recipient should receive emitted SEND')
            assert.strictEqual(await balanceOf(contractAddr, tick), '70', 'contract balance should drop by sent amount')
        })
    })
})
