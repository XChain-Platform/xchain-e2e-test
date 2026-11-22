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
const transactionHelper = require('../../helpers/core/transactionHelper')
const sendHelper = require('../../helpers/sendHelper')
const dispenserHelper = require('../../helpers/dispenserHelper')
const {
    GIVE_PER_FILL, PAY_PER_FILL, INSUFFICIENT, fillSats, fillCoin, tokenBalance,
    waitForDispenses, waitForBalance, statuses
} = require('./lib/dispenser_fixture')

// Coin-payment and token-SEND triggers share one three-dispenser fixture shape.
function logFill(label, txHash, rows, before, after, withGive){
    console.log(label + " txHash=" + txHash +
        " statuses=" + JSON.stringify(statuses(rows)) +
        (withGive ? " giveAmounts=" + JSON.stringify(rows.map(r => r.give_amount)) : "") +
        " getAmounts=" + JSON.stringify(rows.map(r => r.get_amount)) +
        " buyerBalance=" + before + "->" + after)
}

async function openThree(ctx, giveTick, payTick, price, tag){
    for (let n = 0; n < 3; n++){
        const created = await dispenserHelper.sendDispenserV0(
            ctx.host, COIN_CODE, giveTick, GIVE_PER_FILL, GIVE_PER_FILL,
            COIN_CODE, payTick, price, ctx.hostAddress,
            null, null, null, null, null, null, tag + n)
        assert(created.dispenser, "dispenser " + n + " should be open")
        ctx.dispenserIndexes.push(Number(created.dispenser["action_index"]))
    }
}

async function newHostAndBuyer(ctx, label){
    ctx.host  = await cryptoHelper.getNewFundedAddress("BIL." + label + ".H", COIN, NETWORK, null, "legacy", 0, 2)
    ctx.buyer = await cryptoHelper.getNewFundedAddress("BIL." + label + ".B", COIN, NETWORK, null, "legacy", 0, 2)
    ctx.hostAddress  = ctx.host["address"]
    ctx.buyerAddress = ctx.buyer["address"]
    ctx.suffix = ctx.hostAddress.substring(ctx.hostAddress.length - 8)
}

// ─── Row 23, native-coin trigger ───────────────────────────────────────

async function setUpNativeFixture(ctx){
    await newHostAndBuyer(ctx, "D23N")
    ctx.tick = "BILDN" + ctx.suffix
    await issueHelper.sendIssueV0(ctx.host, ctx.tick, 1000, 1000, 0, "row 23 native trigger", 1000)
    // Three dispensers, all at the SAME GET_ADDRESS, each holding exactly
    // one fill of escrow. No EXPIRATION: inside the free window, so the
    // creates are charged nothing and no fee output is hand-sized here.
    await openThree(ctx, ctx.tick, null, fillCoin(), 'row 23 dispenser ')
    console.log("row 23 native: host=" + ctx.hostAddress + " tick=" + ctx.tick +
        " dispensers=" + JSON.stringify(ctx.dispenserIndexes) +
        " fill=" + fillSats() + " sats")
}

function assertNativeOneFill(ctx, rows, before, after){
    // Every matched dispenser gets its own record, so "one settled" is
    // proven by the SPLIT rather than by the absence of rows.
    assert.strictEqual(rows.length, 3,
        "all three dispensers behind the paid address are evaluated")

    // EXACTLY one, not "at most one": a path that settles NOTHING satisfies
    // the weaker bound, and that is the failure mode this case exists to
    // rule out. The companion case below is the other half of the argument.
    const valid = rows.filter(r => r.status === 'valid')
    assert.strictEqual(valid.length, 1,
        "one payment must buy exactly ONE fill, not three (statuses " +
        JSON.stringify(statuses(rows)) + ")")

    // Which one settles is deterministic across nodes: the match query
    // orders by the dispenser's action index.
    assert.strictEqual(Number(valid[0].dispenser_action_index), ctx.dispenserIndexes[0],
        "the lowest dispenser action index draws the payment")

    for (const row of rows.filter(r => r.status !== 'valid'))
        assert.strictEqual(row.status, INSUFFICIENT,
            "a dispenser past the drained payment reports an empty pool")

    // The money, not just the bookkeeping.
    assert.strictEqual(after, before + GIVE_PER_FILL,
        "exactly one fill of " + ctx.tick + " moved to the buyer")
    assert.strictEqual(Number(valid[0].give_amount), GIVE_PER_FILL)

    // Row 18: the row records what this dispense was CHARGED. At a payment
    // of exactly one fill the two figures coincide, so the discriminating
    // check is in the companion case, whose payment is larger than a fill.
    assert.strictEqual(Number(valid[0].get_amount), Number(fillCoin()),
        "the settled row records the fill price it was charged")
}

async function nativeOneFill(ctx){
    const before = await tokenBalance(ctx.buyerAddress, ctx.tick)
    const txHash = await transactionHelper.createSimpleTransaction(
        ctx.buyer, ctx.hostAddress, fillSats())
    const rows  = await waitForDispenses(txHash, 3)
    const after = await waitForBalance(ctx.buyerAddress, ctx.tick, before + GIVE_PER_FILL)
    logFill("row 23 native ONE-FILL", txHash, rows, before, after, true)
    assertNativeOneFill(ctx, rows, before, after)
}

function assertNativeTwoFills(ctx, rows, before, after){
    assert.strictEqual(rows.length, 2,
        "the exhausted dispenser has closed; the other two remain open")
    assert.deepStrictEqual(statuses(rows), ['valid', 'valid'],
        "two fills' worth must fund two fills")
    assert.deepStrictEqual(
        rows.map(r => Number(r.dispenser_action_index)),
        [ctx.dispenserIndexes[1], ctx.dispenserIndexes[2]],
        "the two dispensers the first payment could not reach")
    assert.strictEqual(after, before + GIVE_PER_FILL * 2,
        "two fills of " + ctx.tick + " moved to the buyer")

    // Each row carries ONE fill's price, never the two-fill payment: the
    // record and the amount drained from the pool are one number.
    for (const row of rows)
        assert.strictEqual(Number(row.get_amount), Number(fillCoin()),
            "each dispense records the fill it bought, not the whole payment")
}

// The same fixture, paid again. The first dispenser is exhausted and
// closed, so this payment meets dispensers 2 and 3 - and if the case
// above had passed merely because nothing ever settles, nothing would
// settle here either.
//
// TWO fills' worth against two dispensers that serve one fill each:
// both settle, and each draws ONE fill's price out of the pool rather
// than the whole payment. That is the row 18 record correction too.
async function nativeTwoFills(ctx){
    const before = await tokenBalance(ctx.buyerAddress, ctx.tick)
    const txHash = await transactionHelper.createSimpleTransaction(
        ctx.buyer, ctx.hostAddress, fillSats() * 2)
    const rows  = await waitForDispenses(txHash, 2)
    const after = await waitForBalance(ctx.buyerAddress, ctx.tick, before + GIVE_PER_FILL * 2)
    logFill("row 23 native TWO-FILL", txHash, rows, before, after, false)
    assertNativeTwoFills(ctx, rows, before, after)
}

function registerNativeTrigger(){
    context('row 23: one coin payment behind THREE dispensers at one address', function () {
        const ctx = { dispenserIndexes: [] }
        before(() => setUpNativeFixture(ctx))
        it('fills exactly ONE dispenser, and moves exactly one fill of balance', () => nativeOneFill(ctx))
        it('fills the REMAINING two when a later payment carries two fills', () => nativeTwoFills(ctx))
    })
}

// ─── Row 23 / row 20, token-SEND trigger ───────────────────────────────
//
// The same double-spend lived on the SEND path: util.processDispenserSends
// builds its own data object per SEND and hands it to the same handler, so
// several dispensers priced in the sent token all drew on one SEND's amount.

async function setUpSendFixture(ctx){
    await newHostAndBuyer(ctx, "D23S")
    ctx.giveTick = "BILDG" + ctx.suffix
    ctx.payTick  = "BILDP" + ctx.suffix
    await issueHelper.sendIssueV0(ctx.host, ctx.giveTick, 1000, 1000, 0, "row 23 send give", 1000)
    await issueHelper.sendIssueV0(ctx.host, ctx.payTick,  1000, 1000, 0, "row 23 send pay",  1000)
    // The buyer needs the payment token before it can trigger anything.
    await sendHelper.sendSendV0(ctx.host, ctx.payTick, PAY_PER_FILL * 4, ctx.buyerAddress, "row 23 fund buyer")
    await openThree(ctx, ctx.giveTick, ctx.payTick, PAY_PER_FILL, 'row 23 send dispenser ')
    console.log("row 23 send: host=" + ctx.hostAddress + " give=" + ctx.giveTick +
        " pay=" + ctx.payTick + " dispensers=" + JSON.stringify(ctx.dispenserIndexes))
}

async function sendOneFill(ctx){
    const before = await tokenBalance(ctx.buyerAddress, ctx.giveTick)
    const sent = await sendHelper.sendSendV0(
        ctx.buyer, ctx.payTick, PAY_PER_FILL, ctx.hostAddress, "row 23 one fill")
    assert(sent.send, "the triggering SEND itself is valid")

    const rows  = await waitForDispenses(sent.txHash, 3)
    const after = await waitForBalance(ctx.buyerAddress, ctx.giveTick, before + GIVE_PER_FILL)
    logFill("row 23 send ONE-FILL", sent.txHash, rows, before, after, false)

    assert.strictEqual(rows.length, 3,
        "all three token-priced dispensers behind the address are evaluated")
    const valid = rows.filter(r => r.status === 'valid')
    assert.strictEqual(valid.length, 1,
        "one SEND must buy exactly ONE fill, not three (statuses " +
        JSON.stringify(statuses(rows)) + ")")
    assert.strictEqual(Number(valid[0].dispenser_action_index), ctx.dispenserIndexes[0])
    for (const row of rows.filter(r => r.status !== 'valid'))
        assert.strictEqual(row.status, INSUFFICIENT)
    assert.strictEqual(after, before + GIVE_PER_FILL,
        "exactly one fill of " + ctx.giveTick + " moved to the buyer")
}

async function sendTwoFills(ctx){
    const before = await tokenBalance(ctx.buyerAddress, ctx.giveTick)
    const sent = await sendHelper.sendSendV0(
        ctx.buyer, ctx.payTick, PAY_PER_FILL * 2, ctx.hostAddress, "row 23 two fills")
    assert(sent.send, "the triggering SEND itself is valid")

    const rows  = await waitForDispenses(sent.txHash, 2)
    const after = await waitForBalance(ctx.buyerAddress, ctx.giveTick, before + GIVE_PER_FILL * 2)
    logFill("row 23 send TWO-FILL", sent.txHash, rows, before, after, false)

    assert.strictEqual(rows.length, 2)
    assert.deepStrictEqual(statuses(rows), ['valid', 'valid'],
        "two fills' worth of the payment token must fund two fills")
    assert.deepStrictEqual(
        rows.map(r => Number(r.dispenser_action_index)),
        [ctx.dispenserIndexes[1], ctx.dispenserIndexes[2]])
    assert.strictEqual(after, before + GIVE_PER_FILL * 2)
    for (const row of rows)
        assert.strictEqual(Number(row.get_amount), PAY_PER_FILL,
            "each dispense records the fill it bought, not the whole SEND")
}

function registerSendTrigger(){
    context('row 23: one token SEND behind THREE dispensers at one address', function () {
        const ctx = { dispenserIndexes: [] }
        before(() => setUpSendFixture(ctx))
        it('fills exactly ONE dispenser from one SEND carrying one fill', () => sendOneFill(ctx))
        it('fills the REMAINING two when a later SEND carries two fills', () => sendTwoFills(ctx))
    })
}

module.exports = function registerDispenserSinglePaymentCases(){
    registerNativeTrigger()
    registerSendTrigger()
}
