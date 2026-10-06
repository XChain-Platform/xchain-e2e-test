// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.
//



const assert = require('assert')
const cryptoHelper = require('../../helpers/core/cryptoHelper')
const issueHelper = require('../../helpers/issueHelper')
const batchHelper = require('../../helpers/batchHelper')
const { NO_PRICE_SEED } = require('../../helpers/xchainPriceConstants')
const { prepareFeeFixture, restoreFeeFixture, feeOutput, POOL_EXHAUSTED } = require('./fee_fixture')
const {
    XCHAIN_PER_CHILD_ISSUE, ORDER_GAS_PER_DAY, ORDER_FREE_DAYS, state, ordersForTx,
    chainTipTime, waitForIssueCount, issueCmd
} = require('./shared')

module.exports = function registerNativeFeeCases(){

    // ─── A4 ────────────────────────────────────────────────────────────────────
    context('A4: batch-cumulative native-coin fee', function () {
        // Fixture-priced (the exact output size is computed FROM the seeded pair), so
        // this cannot run on a venue whose hub publishes XCHAIN/USD itself.
        const N = 3

        let addr = null, address = null, parent = null

        before(async function () {
            if (!state.FEE_DEST || NO_PRICE_SEED) return
            // Setup runs at whatever the shared fixture says, so the harness's own
            // injected fee output covers it; only the batches below are hand-sized.
            addr    = await cryptoHelper.getNewFundedAddress("BIL.A4", COIN, NETWORK, null, "legacy", 0, 1)
            address = addr["address"]
            parent  = "BILA4" + address.substring(address.length - 8)
            await issueHelper.sendIssueV0(addr, parent, 100000, 100000, 0, "A4 parent", 10)
        })

        after(async function () {
            if (!state.FEE_DEST || NO_PRICE_SEED) return
            // Put the shared fixture back for whatever runs next.
            await restoreFeeFixture()
        })

        it('yields at most ONE valid command when the fee covers exactly one', async function () {
            if (!state.FEE_DEST) this.skip()   // no native fee to pay
            if (NO_PRICE_SEED) this.skip()

            const perCommandSats = await prepareFeeFixture(XCHAIN_PER_CHILD_ISSUE)
            const commands = []
            for (let n = 1; n <= N; n++)
                commands.push(issueCmd(parent + ".a" + n, 100, 100, 1, "c"))

            const result = await batchHelper.sendBatch(addr, commands, {
                status: 'valid', customOutputs: feeOutput(perCommandSats) })
            assert(result.batch, "the BATCH is valid; the shortfall is per-command")

            const issues = await waitForIssueCount(result.txHash, N)
            console.log("A4 one-fee txHash=" + result.txHash + " feeOutput=" + perCommandSats +
                " sats statuses=" + JSON.stringify(issues.map(r => r.status)))
            assert.strictEqual(issues.length, N)
            assert.strictEqual(issues.filter(r => r.status === 'valid').length, 1,
                "one command's worth of native fee must cover exactly ONE command, not " + N)
            for (const row of issues.filter(r => r.status !== 'valid'))
                assert(POOL_EXHAUSTED.test(row.status),
                    "a command past the exhausted fee pool should say so, got " + row.status)
        })

        it('yields N valid commands when the fee covers N', async function () {
            if (!state.FEE_DEST) this.skip()
            if (NO_PRICE_SEED) this.skip()

            const perCommandSats = await prepareFeeFixture(XCHAIN_PER_CHILD_ISSUE)
            const commands = []
            for (let n = 1; n <= N; n++)
                commands.push(issueCmd(parent + ".b" + n, 100, 100, 1, "c"))

            const result = await batchHelper.sendBatch(addr, commands, {
                status: 'valid', customOutputs: feeOutput(perCommandSats * N) })
            assert(result.batch)

            const issues = await waitForIssueCount(result.txHash, N)
            console.log("A4 N-fee txHash=" + result.txHash + " feeOutput=" + (perCommandSats * N) +
                " sats statuses=" + JSON.stringify(issues.map(r => r.status)))
            assert.strictEqual(issues.length, N)
            assert.strictEqual(issues.filter(r => r.status === 'valid').length, N,
                "N commands' worth of native fee must cover all N")
        })
    })

    // ─── A5 (fee half) ─────────────────────────────────────────────────────────
    context('A5: the same one-fee-for-N shape over a batch of ORDERs', function () {
        const N = 3
        const EXPIRE_DAYS     = 190
        const CHARGEABLE_DAYS = EXPIRE_DAYS - ORDER_FREE_DAYS
        const ORDER_XCHAIN    = CHARGEABLE_DAYS * ORDER_GAS_PER_DAY * 0.00001

        let addr = null, address = null, tick = null

        before(async function () {
            if (!state.FEE_DEST || NO_PRICE_SEED) return
            addr    = await cryptoHelper.getNewFundedAddress("BIL.A5", COIN, NETWORK, null, "legacy", 0, 1)
            address = addr["address"]
            tick    = "BILA5" + address.substring(address.length - 8)
            await issueHelper.sendIssueV0(addr, tick, 10000, 10000, 0, "A5 order token", 1000)
        })

        after(async function () {
            if (!state.FEE_DEST || NO_PRICE_SEED) return
            await restoreFeeFixture()
        })

        async function orderCommands(count, giveAmount){
            // EXPIRATION is anchored on the CHAIN clock, never the wall clock: the
            // indexer prices the duration against BLOCK_TIME, and a regtest chain can
            // sit many hours behind wall time, which would silently change the
            // chargeable-day count this case's fee arithmetic depends on.
            const exp = (await chainTipTime()) + EXPIRE_DAYS * 86400
            const cmds = []
            for (let n = 0; n < count; n++)
                cmds.push("ORDER|0|" + COIN_CODE + "|" + tick + "|" + giveAmount + "||" +
                          COIN_CODE + "||0.00100000||" + address + "|" + exp + "|||A5")
            return cmds
        }

        async function waitForOrders(txHash, expected){
            const deadline = Date.now() + 180000
            for (;;){
                const rows = await ordersForTx(txHash)
                if (rows.length >= expected || Date.now() > deadline) return rows
                await new Promise(r => setTimeout(r, 2000))
            }
        }

        it('yields at most ONE valid ORDER when the fee covers exactly one', async function () {
            if (!state.FEE_DEST) this.skip()
            if (NO_PRICE_SEED) this.skip()

            const perOrderSats = await prepareFeeFixture(ORDER_XCHAIN)
            const result = await batchHelper.sendBatch(addr, await orderCommands(N, 10), {
                status: 'valid', customOutputs: feeOutput(perOrderSats) })
            assert(result.batch)

            const orders = await waitForOrders(result.txHash, N)
            console.log("A5 one-fee txHash=" + result.txHash + " feeOutput=" + perOrderSats +
                " sats (" + ORDER_XCHAIN + " XCHAIN/order) statuses=" +
                JSON.stringify(orders.map(r => r.status)))
            assert.strictEqual(orders.length, N, "every ORDER gets its own record")
            assert.strictEqual(orders.filter(r => r.status === 'valid').length, 1,
                "one ORDER's worth of native fee must cover exactly ONE ORDER, not " + N)
            for (const row of orders.filter(r => r.status !== 'valid'))
                assert(POOL_EXHAUSTED.test(row.status),
                    "an ORDER past the exhausted fee pool should say so, got " + row.status)
        })

        it('yields N valid ORDERs when the fee covers N', async function () {
            if (!state.FEE_DEST) this.skip()
            if (NO_PRICE_SEED) this.skip()

            const perOrderSats = await prepareFeeFixture(ORDER_XCHAIN)
            const result = await batchHelper.sendBatch(addr, await orderCommands(N, 11), {
                status: 'valid', customOutputs: feeOutput(perOrderSats * N) })
            assert(result.batch)

            const orders = await waitForOrders(result.txHash, N)
            console.log("A5 N-fee txHash=" + result.txHash + " feeOutput=" + (perOrderSats * N) +
                " sats statuses=" + JSON.stringify(orders.map(r => r.status)))
            assert.strictEqual(orders.length, N)
            assert.strictEqual(orders.filter(r => r.status === 'valid').length, N,
                "N ORDERs' worth of native fee must cover all N")
        })
    })
}
