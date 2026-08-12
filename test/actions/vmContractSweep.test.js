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

/**
 * VM Contract SWEEP: closes the last `actions.source_id` reader not yet e2e-covered.
 * `getAddressEscrows(SOURCE)`. A contract opens its own (self-addressed) token ORDER, then emits
 * SWEEP{orders:1}. The SWEEP handler enumerates the SOURCE's open escrows via getAddressEscrows,
 * cancels the order, and credits its escrow to DESTINATION. Because SOURCE is read from
 * actions.source_id, the enumeration must find the CONTRACT's order, not the EXECUTE caller's
 * (which is empty). Pre-fix, source mis-derivation would have swept the caller's escrow set.
 */
// SKIPPED: surfaced that contract-emitted SWEEP currently FAILS. The contract's SWEEP emission
// indexes as `failed` (the prior ORDER emission succeeds), so getAddressEscrows(SOURCE) has no
// contract-facing path. Likely the SWEEP handler's fee-payment validation has no valid mode in an
// emission context. Un-skip once that's resolved, or reframe as a rejection assertion if contract
// SWEEP is intentionally unsupported.
describe('VM Contract SWEEP: a contract sweeps its own order escrow', function () {

    const CHAIN = ({ bitcoin: 'BTC', litecoin: 'LTC', dogecoin: 'DOGE' })[COIN] || 'BTC'

    // Opens a self-addressed token ORDER (escrows 40 of the test tick out of the contract), then
    // exposes a sweep that routes the contract's own order escrow to a destination. BALANCES and
    // OWNERSHIPS are explicitly 0 so only the ORDER-escrow path (source_id reader) is exercised.
    const SWEEPER = `module.exports = {
        mkorder: function(){
            xchain.emit.order({ giveCoin: '${CHAIN}', giveTick: xchain.getInputParam(0), giveAmount: '40',
                getCoin: '${CHAIN}', getTick: 'XCHAIN', getAmount: '5' });
        },
        sweepOrders: function(){
            xchain.emit.sweep({ destination: xchain.getInputParam(0), balances: '0', ownerships: '0', orders: '1' });
        }
    };`

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
    async function emissionsFor(executionIndex) {
        return await q(`SELECT emitted_action, action_index FROM contract_emissions
            WHERE execution_index=? ORDER BY position`, [executionIndex])
    }
    async function orderStatus(orderActionIndex) {
        const rows = await q(`SELECT s.status AS st FROM order_statuses os
            JOIN index_statuses s ON s.id=os.status_id
            WHERE os.order_action_index=? ORDER BY os.action_index DESC LIMIT 1`, [orderActionIndex])
        return rows.length ? rows[0].st : null
    }
    function randTick(p) { let s = p; for (let i = 0; i < 5; i++) s += String.fromCharCode(65 + Math.floor(Math.random() * 26)); return s }
    async function fundedContract(code, tick, depositAmt) {
        await issueHelper.sendIssueV0(deployer, tick, '1000', '1000', '0', 'vm sweep', '1000')
        const dep = await vmHelper.sendDeployV0(deployer, code, 250000)
        const ci = dep.contract.action_index
        await vmHelper.sendDepositV0(deployer, ci, tick, depositAmt)
        return ci
    }

    before(async function () {
        deployer = await cryptoHelper.getNewFundedAddress('vmsweep-deployer', COIN, NETWORK, null, 'legacy', 0, 1)
        await gasHelper.ensureGasBalance(deployer, '500')
    })

    it("sweeps the contract's own open order escrow to a destination (source_id enumeration)", async function () {
        const tick = randTick('VSW')
        const ci = await fundedContract(SWEEPER, tick, '100')
        const contractAddr = `C:${CHAIN}:${ci}`

        // 1. Contract opens a self-addressed token order: escrows 40 (100 -> 60 spendable).
        const ord = await vmHelper.sendExecuteV0(deployer, ci, 'mkorder', [tick])
        assert.strictEqual(ord.execution.status, 'valid', 'order emission must succeed')
        const em = await emissionsFor(ord.execution.action_index)
        assert.strictEqual(em[0].emitted_action, 'ORDER')
        const orderIndex = Number(em[0].action_index)
        assert.strictEqual(await balanceOf(contractAddr, tick), '60', 'GIVE escrowed on order creation')

        // 2. Contract sweeps its own orders to a fresh real destination address.
        const dest = await cryptoHelper.getNewAddress('vmsweep-dest', COIN, NETWORK, null, 'legacy', 0)
        const sw = await vmHelper.sendExecuteV0(deployer, ci, 'sweepOrders', [dest.address])
        assert.strictEqual(sw.execution.status, 'valid', 'sweep emission must succeed')
        assert.strictEqual((await emissionsFor(sw.execution.action_index))[0].emitted_action, 'SWEEP')

        // 3. The contract's order was cancelled and its 40-token escrow credited to DESTINATION.
        //    This proves getAddressEscrows enumerated the CONTRACT's escrow (source_id), not the caller's.
        assert.strictEqual(await orderStatus(orderIndex), 'cancelled', "the contract's order should be cancelled")
        assert.strictEqual(await balanceOf(dest.address, tick), '40',
            'the swept order escrow (40) should be credited to the destination')
        // The contract keeps its un-escrowed remainder (BALANCES:0 -> spendable balance untouched).
        assert.strictEqual(await balanceOf(contractAddr, tick), '60',
            'contract spendable balance is untouched (only the order escrow was swept)')
        // The EXECUTE caller is the token issuer (minted 1000, deposited 100 -> holds 900). The
        // sweep must not credit the caller: its balance stays exactly 900, proving the swept
        // escrow went to DESTINATION and getAddressEscrows enumerated the CONTRACT, not the caller.
        assert.strictEqual(await balanceOf(deployer.address, tick), '900',
            'the EXECUTE caller balance is unchanged by the sweep (it enumerated the contract, not the caller)')
    })
})
