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
 * VM Execute Negative: DEPOSIT / WITHDRAW failure paths on a valid contract.
 * Invalid deposits/withdrawals still write a row (with the rejection status) and
 * must move no balances. (EXECUTE on a nonexistent contract index is covered in the
 * library suite to avoid risking the live indexer's per-block transaction.)
 */
describe('VM Execute Negative: deposit/withdraw failure paths', function () {

    const CHAIN = ({ bitcoin: 'BTC', litecoin: 'LTC', dogecoin: 'DOGE' })[COIN] || 'BTC'
    const NOOP = `module.exports = { ping: function(){ return 'ok'; } };`

    let deployer = null

    async function q(sql, params) {
        const conn = await indexerDatabase.getConnection()
        try { return await conn.query(sql, params) }
        finally { await conn.release() }
    }
    async function balanceOf(address, tick) {
        const rows = await q(`SELECT b.amount FROM balances b
            JOIN index_addresses ia ON ia.id=b.address_id
            JOIN index_tickers it ON it.id=b.tick_id
            WHERE ia.address=? AND it.tick=?`, [address, tick])
        return rows.length ? String(rows[0].amount) : null
    }
    async function rawDeposit(addr, ci, tick, qty) {
        return await transactionHelper.createAndSendTransaction(addr, `DEPOSIT|0|${ci}|${tick}|${qty}`)
    }
    async function rawWithdraw(addr, ci, tick, qty) {
        return await transactionHelper.createAndSendTransaction(addr, `WITHDRAW|0|${ci}|${tick}|${qty}`)
    }
    async function waitDeposit(source, ci, tick, timeMax = 50000) {
        const end = Date.now() + timeMax
        while (Date.now() < end) {
            const r = await indexerDatabase.checkDeposit({ source, contractIndex: ci, tick })
            if (r) return r
            await new Promise(res => setTimeout(res, 1000))
        }
        return null
    }
    async function waitWithdrawal(source, ci, tick, timeMax = 50000) {
        const end = Date.now() + timeMax
        while (Date.now() < end) {
            const r = await indexerDatabase.checkWithdrawal({ source, contractIndex: ci, tick })
            if (r) return r
            await new Promise(res => setTimeout(res, 1000))
        }
        return null
    }
    function randTick(p) { let s = p; for (let i = 0; i < 5; i++) s += String.fromCharCode(65 + Math.floor(Math.random() * 26)); return s }

    let contractIndex = null
    let contractAddr = null
    let heldTick = null

    before(async function () {
        deployer = await cryptoHelper.getNewFundedAddress('vmneg-deployer', COIN, NETWORK, null, 'legacy', 0, 1)
        await gasHelper.ensureGasBalance(deployer, '500')
        heldTick = randTick('VNG')
        await issueHelper.sendIssueV0(deployer, heldTick, '1000', '1000', '0', 'vm neg', '1000')
        const dep = await vmHelper.sendDeployV0(deployer, NOOP, 200000)
        contractIndex = dep.contract.action_index
        contractAddr = `C:${CHAIN}:${contractIndex}`
    })

    it('rejects a DEPOSIT exceeding the depositor balance', async function () {
        // deployer holds 1000 of heldTick; depositing 5000 must fail.
        await rawDeposit(deployer, contractIndex, heldTick, '5000')
        const row = await waitDeposit(deployer.address, contractIndex, heldTick)
        assert(row, 'a rejected deposit row should be recorded')
        assert.notStrictEqual(row.status, 'valid', 'over-balance deposit must fail')
        assert(/insufficient/i.test(row.status), `status should cite insufficient funds (got: ${row.status})`)
        assert.strictEqual(await balanceOf(contractAddr, heldTick), null, 'contract must hold nothing')
    })

    it('rejects a DEPOSIT of an unknown tick', async function () {
        const ghost = randTick('VNX')
        await rawDeposit(deployer, contractIndex, ghost, '1')
        const row = await waitDeposit(deployer.address, contractIndex, ghost)
        assert(row, 'a rejected deposit row should be recorded')
        assert.notStrictEqual(row.status, 'valid', 'unknown-tick deposit must fail')
        assert(/TICK|unknown/i.test(row.status), `status should cite unknown tick (got: ${row.status})`)
    })

    it('rejects a WITHDRAW exceeding the contract balance', async function () {
        // Deposit 100 (valid), then try to withdraw 200.
        const d = await vmHelper.sendDepositV0(deployer, contractIndex, heldTick, '100')
        assert.strictEqual(d.deposit.status, 'valid')
        assert.strictEqual(await balanceOf(contractAddr, heldTick), '100')

        await rawWithdraw(deployer, contractIndex, heldTick, '200')
        // Poll for the (rejected) withdrawal row; fetch the latest by action_index, since the
        // earlier valid deposit/withdraw history may share (source, contract, tick).
        const latestWithdrawal = async () => {
            const rows = await q(`SELECT wd.action_index, ist.status AS status
                FROM withdrawals wd
                JOIN index_addresses ia ON ia.id=wd.source_id
                JOIN index_tickers it ON it.id=wd.tick_id
                LEFT JOIN index_statuses ist ON ist.id=wd.status_id
                WHERE ia.address=? AND wd.contract_index=? AND it.tick=?
                ORDER BY wd.action_index DESC LIMIT 1`, [deployer.address, contractIndex, heldTick])
            return rows.length ? rows[0] : null
        }
        let row = null
        const end = Date.now() + 50000
        while (Date.now() < end) { row = await latestWithdrawal(); if (row) break; await new Promise(r => setTimeout(r, 1000)) }
        assert(row, 'a withdrawal row should be recorded')
        assert.notStrictEqual(row.status, 'valid', 'over-balance withdrawal must fail')
        assert(/insufficient/i.test(row.status), `status should cite insufficient contract balance (got: ${row.status})`)
        assert.strictEqual(await balanceOf(contractAddr, heldTick), '100', 'contract balance must be unchanged')
    })
})
