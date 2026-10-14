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
const { prepareFeeFixture, restoreFeeFixture, feeOutput, POOL_EXHAUSTED } = require('./lib/fee_fixture')
const {
    XCHAIN_PER_CHILD_ISSUE, ORDER_GAS_PER_DAY, ORDER_FREE_DAYS, state, ordersForTx,
    chainTipTime, waitForIssueCount, issueCmd
} = require('./lib/shared')

// Both contexts skip when no native fee exists or the venue publishes its own price.
function skipUnlessFeeLane(test){
    if (!state.FEE_DEST) test.skip()   // no native fee to pay
    if (NO_PRICE_SEED) test.skip()
}

const feeLaneOff = () => !state.FEE_DEST || NO_PRICE_SEED

async function exhaustedCount(rows, label){
    assert.strictEqual(rows.filter(r => r.status === 'valid').length, 1,
        label + " worth of native fee must cover exactly ONE, not " + rows.length)
    for (const row of rows.filter(r => r.status !== 'valid'))
        assert(POOL_EXHAUSTED.test(row.status),
            "a command past the exhausted fee pool should say so, got " + row.status)
}

// ─── A4 ────────────────────────────────────────────────────────────────────

// Fixture-priced (the exact output size is computed FROM the seeded pair), so
// this cannot run on a venue whose hub publishes XCHAIN/USD itself.
const A4_N = 3

async function setUpA4(ctx){
    if (feeLaneOff()) return
    // Setup runs at whatever the shared fixture says, so the harness's own
    // injected fee output covers it; only the batches below are hand-sized.
    ctx.addr    = await cryptoHelper.getNewFundedAddress("BIL.A4", COIN, NETWORK, null, "legacy", 0, 1)
    ctx.address = ctx.addr["address"]
    ctx.parent  = "BILA4" + ctx.address.substring(ctx.address.length - 8)
    await issueHelper.sendIssueV0(ctx.addr, ctx.parent, 100000, 100000, 0, "A4 parent", 10)
}

// Put the shared fixture back for whatever runs next.
async function restoreIfFeeLane(){
    if (feeLaneOff()) return
    await restoreFeeFixture()
}

async function a4Batch(ctx, suffix, outputFor){
    const perCommandSats = await prepareFeeFixture(XCHAIN_PER_CHILD_ISSUE)
    const commands = []
    for (let n = 1; n <= A4_N; n++)
        commands.push(issueCmd(ctx.parent + "." + suffix + n, 100, 100, 1, "c"))
    const feeSats = outputFor(perCommandSats)
    const result = await batchHelper.sendBatch(ctx.addr, commands, {
        status: 'valid', customOutputs: feeOutput(feeSats) })
    assert(result.batch, "the BATCH is valid; the shortfall is per-command")
    const issues = await waitForIssueCount(result.txHash, A4_N)
    console.log("A4 " + suffix + " txHash=" + result.txHash + " feeOutput=" + feeSats +
        " sats statuses=" + JSON.stringify(issues.map(r => r.status)))
    assert.strictEqual(issues.length, A4_N)
    return issues
}

async function a4AtMostOne(ctx, test){
    skipUnlessFeeLane(test)
    const issues = await a4Batch(ctx, "a", sats => sats)
    await exhaustedCount(issues, "one command's")
}

async function a4AllN(ctx, test){
    skipUnlessFeeLane(test)
    const issues = await a4Batch(ctx, "b", sats => sats * A4_N)
    assert.strictEqual(issues.filter(r => r.status === 'valid').length, A4_N,
        "N commands' worth of native fee must cover all N")
}

function registerA4Cases(){
    const ctx = {}
    before(() => setUpA4(ctx))
    after(restoreIfFeeLane)
    it('yields at most ONE valid command when the fee covers exactly one', function () { return a4AtMostOne(ctx, this) })
    it('yields N valid commands when the fee covers N', function () { return a4AllN(ctx, this) })
}

// ─── A5 (fee half) ─────────────────────────────────────────────────────────

const A5_N = 3
const EXPIRE_DAYS     = 190
const CHARGEABLE_DAYS = EXPIRE_DAYS - ORDER_FREE_DAYS
const ORDER_XCHAIN    = CHARGEABLE_DAYS * ORDER_GAS_PER_DAY * 0.00001

async function setUpA5(ctx){
    if (feeLaneOff()) return
    ctx.addr    = await cryptoHelper.getNewFundedAddress("BIL.A5", COIN, NETWORK, null, "legacy", 0, 1)
    ctx.address = ctx.addr["address"]
    ctx.tick    = "BILA5" + ctx.address.substring(ctx.address.length - 8)
    await issueHelper.sendIssueV0(ctx.addr, ctx.tick, 10000, 10000, 0, "A5 order token", 1000)
}

async function orderCommands(ctx, count, giveAmount){
    // EXPIRATION is anchored on the CHAIN clock, never the wall clock: the
    // indexer prices the duration against BLOCK_TIME, and a regtest chain can
    // sit many hours behind wall time, which would silently change the
    // chargeable-day count this case's fee arithmetic depends on.
    const exp = (await chainTipTime()) + EXPIRE_DAYS * 86400
    const cmds = []
    for (let n = 0; n < count; n++)
        cmds.push("ORDER|0|" + COIN_CODE + "|" + ctx.tick + "|" + giveAmount + "||" +
                  COIN_CODE + "||0.00100000||" + ctx.address + "|" + exp + "|||A5")
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

async function a5Batch(ctx, label, giveAmount, outputFor){
    const perOrderSats = await prepareFeeFixture(ORDER_XCHAIN)
    const feeSats = outputFor(perOrderSats)
    const result = await batchHelper.sendBatch(ctx.addr, await orderCommands(ctx, A5_N, giveAmount), {
        status: 'valid', customOutputs: feeOutput(feeSats) })
    assert(result.batch)
    const orders = await waitForOrders(result.txHash, A5_N)
    console.log("A5 " + label + " txHash=" + result.txHash + " feeOutput=" + feeSats +
        " sats (" + ORDER_XCHAIN + " XCHAIN/order) statuses=" +
        JSON.stringify(orders.map(r => r.status)))
    assert.strictEqual(orders.length, A5_N, "every ORDER gets its own record")
    return orders
}

async function a5AtMostOne(ctx, test){
    skipUnlessFeeLane(test)
    const orders = await a5Batch(ctx, "one-fee", 10, sats => sats)
    await exhaustedCount(orders, "one ORDER's")
}

async function a5AllN(ctx, test){
    skipUnlessFeeLane(test)
    const orders = await a5Batch(ctx, "N-fee", 11, sats => sats * A5_N)
    assert.strictEqual(orders.filter(r => r.status === 'valid').length, A5_N,
        "N ORDERs' worth of native fee must cover all N")
}

function registerA5Cases(){
    const ctx = {}
    before(() => setUpA5(ctx))
    after(restoreIfFeeLane)
    it('yields at most ONE valid ORDER when the fee covers exactly one', function () { return a5AtMostOne(ctx, this) })
    it('yields N valid ORDERs when the fee covers N', function () { return a5AllN(ctx, this) })
}

module.exports = function registerNativeFeeCases(){
    context('A4: batch-cumulative native-coin fee', registerA4Cases)
    context('A5: the same one-fee-for-N shape over a batch of ORDERs', registerA5Cases)
}
