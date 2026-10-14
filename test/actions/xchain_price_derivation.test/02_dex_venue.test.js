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
// XCHAIN price derivation, DEX venue (coinpay): a settled coinpay fill is
// selected and dated by its PAYMENT block.
//
// This leg exists for the two §3 corrections that came out of building the
// predicate. Both were live-verified at the SQL level; neither had ever
// been exercised by a trade the test itself created, which is the gap.

const assert = require('assert')
const cryptoHelper = require('../../helpers/core/cryptoHelper')
const orderHelper = require('../../helpers/orderHelper')
const coinpayHelper = require('../../helpers/coinpayHelper')
const gasHelper = require('../../helpers/gasHelper')
const venue = require('./helpers/venue.test')

const { COIN_CODE, GAS_TICK } = venue

// Expiration comes from the CHAIN's clock, not the wall clock: the indexer
// validates EXPIRATION against block time, so a wall-clock "+24h" can land in
// the past on a chain that has been through a setmocktime drill.
async function chainExpirationChecked(db) {
    const clock = await db.doQuery('SELECT MAX(block_time) AS t FROM blocks')
    assert(Number.isFinite(Number(clock[0].t)) && Number(clock[0].t) > 0,
        'chain block time must be readable')
    return venue.chainExpiration(db)
}

// 100 XCHAIN for 0.001 coin = 0.00001 coin per XCHAIN.
async function placeMatchedOrders(db) {
    const sellerInfo = await cryptoHelper.getNewFundedAddress(
        'XCPRICE.DEX.SELLER', COIN, NETWORK, null, 'legacy', 0, 2)
    const buyerInfo = await cryptoHelper.getNewFundedAddress(
        'XCPRICE.DEX.BUYER', COIN, NETWORK, null, 'legacy', 0, 2)
    await gasHelper.ensureGasBalance(sellerInfo, '200')
    const expiration = await chainExpirationChecked(db)

    const sellerOrder = await orderHelper.sendOrderV0(
        sellerInfo, COIN_CODE, GAS_TICK, '100',
        COIN_CODE, '', '0.001',
        sellerInfo['address'], expiration, '', '', 'sell XCHAIN for coin')
    assert(sellerOrder.order, 'seller ORDER should exist in DB')

    const buyerOrder = await orderHelper.sendOrderV0(
        buyerInfo, COIN_CODE, '', '0.001',
        COIN_CODE, GAS_TICK, '100',
        buyerInfo['address'], expiration, '', '', 'buy XCHAIN with coin')
    assert(buyerOrder.order, 'buyer ORDER should exist in DB')

    const orderMatch = await indexerDatabase.waitForOrderMatch({
        giveActionIndex: Number(sellerOrder.order['action_index']),
        getActionIndex: Number(buyerOrder.order['action_index']),
        status: 'pending_coinpay'
    }, 60000)
    assert(orderMatch, 'ORDER_MATCH should exist')
    return { sellerInfo, buyerInfo, orderMatch }
}

async function fillsNow(ctx, db) {
    const selection = await venue.windowFills(ctx, db, {
        referenceHeight: await venue.actionTip(db), windowLength: 100000
    })
    assert.strictEqual(selection.ok, true, 'selection must succeed: ' + selection.error)
    return selection.fills
}

// Before payment the trade has NOT happened. It must not be selectable:
// counting an unpaid obligation as a realized trade would be a free price
// print, which is what selecting on 'pending_coinpay' would have done.
async function assertUnpaidNotSelected(ctx, db, orderMatch) {
    const fills = await fillsNow(ctx, db)
    assert.strictEqual(
        fills.filter(f => f.actionIndex === Number(orderMatch.action_index)).length, 0,
        'an UNPAID coinpay obligation must not be selected as a realized trade')
}

async function payCoinpay(trade) {
    const { buyerInfo, sellerInfo, orderMatch } = trade
    await coinpayHelper.sendCoinpayV0(
        buyerInfo, Number(orderMatch.action_index), sellerInfo['address'], 100000)
    const fulfilled = await indexerDatabase.waitForCoinpayObligation({
        actionIndex: Number(orderMatch.action_index), coinpayStatus: 'fulfilled'
    }, 60000)
    assert(fulfilled, 'COINPay obligation should be fulfilled')
}

// CORRECTION 1: the fill is selected on the strength of the `coinpays`
// row, never on the match's own status. A fully paid match is cleared to
// 'valid' by the indexer's match-scoped status writer, and that clearing
// is forward-only: a match settled before it holds 'pending_coinpay'
// permanently. A selection keyed on the match status therefore drops
// exactly the historical fills a price window depends on.
async function assertSelectedOnCoinpayRow(db, fill, orderMatch) {
    assert(fill, 'a SETTLED coinpay fill must be selected on its coinpays row, whatever the match status')
    const matchStatus = await db.doQuery(
        `SELECT s.status, a.block_index FROM order_matches m
           JOIN index_statuses s ON s.id = m.status_id
           JOIN actions a ON a.action_index = m.action_index
          WHERE m.action_index = ?`, [Number(orderMatch.action_index)])
    assert.strictEqual(String(matchStatus[0].status), 'valid',
        'a fully paid coinpay match is cleared to valid by the settling COINPAY')
    return Number(matchStatus[0].block_index)
}

// CORRECTION 2: the fill is dated by the COINPAY's block, not the match's.
// Windowing on the match block makes a historical window mutable, which
// forks the pair between validators computing before and after payment.
async function assertDatedByPayment(db, fill, orderMatch, matchBlock) {
    const coinpayRow = await db.doQuery(
        'SELECT block_index FROM coinpays WHERE obligation_action_index = ?',
        [Number(orderMatch.action_index)])
    assert.strictEqual(fill.blockIndex, Number(coinpayRow[0].block_index),
        'the fill must be dated by its payment block')
    assert(fill.blockIndex >= matchBlock, 'the payment block cannot precede the match block')
}

// Both orientations reduce to the same rate; the mapper reads the amounts
// by which side holds the tick id, never from fixed columns.
// Compared as a NUMBER, not a string. XCHAIN rejects a padded
// GIVE_AMOUNT ('100.00000000' is `invalid: GIVE_AMOUNT (format)`) while
// the coin side stores padded, so both conventions coexist across a
// single trade - which is exactly why the derivation hands every amount
// to bcmath and never string-compares.
function assertDexRate(ctx, fill) {
    const { bcmath } = ctx
    assert(bcmath.bcgt(fill.xchainAmount, '99.99999999') &&
           bcmath.bclt(fill.xchainAmount, '100.00000001'),
        'the XCHAIN leg must be 100, got ' + fill.xchainAmount)
    const derived = ctx.derivation.price.deriveXchainRate(bcmath, [fill], '0.00001')
    assert(derived, 'derivation must produce a rate')
    assert.strictEqual(derived.rate, '0.00001000',
        'derived XCHAIN/' + COIN_CODE + ' must equal the realized DEX rate')
}

async function runDexLeg(ctx) {
    const db = venue.queryAdapter(indexerDatabase)
    const trade = await placeMatchedOrders(db)
    await assertUnpaidNotSelected(ctx, db, trade.orderMatch)
    await payCoinpay(trade)
    const fills = await fillsNow(ctx, db)
    const fill = fills.find(f => f.actionIndex === Number(trade.orderMatch.action_index))
    const matchBlock = await assertSelectedOnCoinpayRow(db, fill, trade.orderMatch)
    await assertDatedByPayment(db, fill, trade.orderMatch, matchBlock)
    assertDexRate(ctx, fill)
}

function registerDexVenue(ctx) {
    describe('DEX venue (coinpay)', function () {
        before(function () { venue.skipUnlessBtc(this) })

        it('selects a settled coinpay fill and dates it by its PAYMENT block', async function () {
            this.timeout(300000)
            await runDexLeg(ctx)
        })
    })
}

module.exports = { registerDexVenue }
