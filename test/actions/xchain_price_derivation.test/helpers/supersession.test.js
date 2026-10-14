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
// XCHAIN price derivation, hub-published pair: the steps of the supersession
// drill (bury old fills, find the carry-forward, price and make the drill
// trades, then match a published round against its own reproduction).

const assert = require('assert')
const cryptoHelper = require('../../../helpers/core/cryptoHelper')
const transactionHelper = require('../../../helpers/core/transactionHelper')
const dispenserHelper = require('../../../helpers/dispenserHelper')
const orderHelper = require('../../../helpers/orderHelper')
const coinpayHelper = require('../../../helpers/coinpayHelper')
const gasHelper = require('../../../helpers/gasHelper')
const venue = require('./venue.test')

const { COIN_CODE, GAS_TICK, WINDOW_BLOCKS, CONFIRMATION_BUFFER,
        hubPriceSnapshots, pairRows, lastBelow } = venue

// 1a. The indexer may still be digesting blocks a previous run mined; a
// tip read mid-digest under-counts and would over-mine. Blocks on
// this venue appear only when something transacts, so a tip that
// holds still across samples IS the chain tip.
// Bound the settle by the burial budget: a backlog is at most one
// interrupted burial, so a tip still moving past it means something else mines.
async function settledTip(db, burialBudgetMs) {
    const quiesceDeadline = Date.now() + burialBudgetMs
    let tipNow = Number((await db.doQuery('SELECT MAX(block_index) AS h FROM blocks'))[0].h)
    for (;;) {
        await new Promise(r => setTimeout(r, 8000))
        const again = Number((await db.doQuery('SELECT MAX(block_index) AS h FROM blocks'))[0].h)
        if (again === tipNow) return tipNow
        if (Date.now() > quiesceDeadline) {
            throw new Error('indexer tip still moving after ' + (burialBudgetMs / 1000) +
                ' s (' + tipNow + ' -> ' + again + '); something else is mining this venue, ' +
                'so the burial cannot be sized')
        }
        tipNow = again
    }
}

// 1. Age every pre-existing fill out of the derivation window, so the
//    value under assertion is composed ONLY of the trades this test
//    creates. This also proves the quiet-market branch on the way: an
//    empty window must publish the carry-forward, unchanged, round
//    after round. Mine only what burial actually needs, so a rerun on
//    an already-buried venue costs seconds, not a thousand blocks.
async function buryOldFills(ctx, db) {
    const burialBudgetMs = 3000000
    const tipNow = await settledTip(db, burialBudgetMs)
    const lookback = await venue.windowFills(ctx, db, {
        referenceHeight: tipNow, windowLength: tipNow
    })
    assert.strictEqual(lookback.ok, true, 'burial look-back must succeed: ' + lookback.error)
    const newestFill = lookback.fills.reduce((m, f) => Math.max(m, f.blockIndex), 0)
    const burialDeficit = (newestFill + WINDOW_BLOCKS + CONFIRMATION_BUFFER + 1) - tipNow
    // 3000s covers ~1000 blocks at this venue's parse rate with slack; the
    // wait is on the indexer reaching the chain, so a shorter budget just
    // returns early and moves the failure to an unrelated later assertion.
    if (burialDeficit > 0) await venue.mineAndIndex(db, burialDeficit + 1, burialBudgetMs)
}

// 2. Wait for two consecutive finalized rounds with the same value:
//    that is the stabilized carry-forward CF.
async function awaitCarryForward() {
    for (let tries = 0; tries < 12; tries++) {
        const rows = pairRows(await hubPriceSnapshots(), 'XCHAIN/USD')
        if (rows.length >= 2) {
            const a = rows[rows.length - 2], b = rows[rows.length - 1]
            if (a.price === b.price) return { cf: b.price, cfRound: Number(b.round_number) }
        }
        await new Promise(r => setTimeout(r, 15000))
    }
    assert.fail('the empty window must stabilize on a carry-forward value')
}

// 3. Price the drill trades IN BAND: within the winsorization band
//    (2x either side of the reference) AND inside the 10%/round
//    per-pair clamp, so the published value must equal the exact
//    VWAP - a clamped or winsorized echo would fail the equality.
// bcmath helpers return Decimal OBJECTS (spec §4). Everything downstream
// hands these to string concatenation (the wire message) and to the
// mariadb driver (the waitFor predicates), and the driver cannot
// parameterize a Decimal - the coin-side ORDER wait times out against
// a row that indexed valid. Render to fixed 8dp strings HERE, once.
async function priceDrillRates(ctx, cf) {
    const { bcmath } = ctx
    const btcUsdNow = pairRows(await hubPriceSnapshots(), 'BTC/USD').slice(-1)[0]
    assert(btcUsdNow, 'venue must publish BTC/USD')
    const rateAt = (factor) =>
        bcmath.bcformat(bcmath.bcdiv(bcmath.bcmul(cf, factor, 16), btcUsdNow.price, 8), 8)
    const rate1Btc = rateAt('1.04')
    const rate2Btc = rateAt('0.97')
    assert(bcmath.bcgt(rate1Btc, '0') && bcmath.bcgt(rate2Btc, '0'),
        'drill rates must be representable at 8dp; CF too small vs BTC/USD would be a venue defect')
    return { rate1Btc, rate2Btc }
}

// 4a. Dispense leg: 30 XCHAIN realized at rate1Btc coin per XCHAIN.
async function drillDispenseLeg(ctx, rate1Btc) {
    const seller = await cryptoHelper.getNewFundedAddress(
        'XCPRICE.SUP.DISP.SELLER', COIN, NETWORK, null, 'legacy', 0, 1)
    await gasHelper.ensureGasBalance(seller, '200')
    const disp = await dispenserHelper.sendDispenserV0(
        seller, COIN_CODE, GAS_TICK, 1, 30,
        COIN_CODE, null, Number(rate1Btc), seller['address'],
        null, null, null, null,
        null, null, 'supersession drill dispense')
    assert(disp.dispenser, 'drill dispenser should exist')

    const dispBuyer = await cryptoHelper.getNewFundedAddress(
        'XCPRICE.SUP.DISP.BUYER', COIN, NETWORK, null, 'legacy', 0, 1)
    const paySats = Number(ctx.bcmath.bcmul(rate1Btc, '30', 8)) * 1e8
    const dispTx = await transactionHelper.createSimpleTransaction(
        dispBuyer, seller['address'], Math.round(paySats))
    const dispRow = await indexerDatabase.waitForDispense({
        txHash: dispTx, giveCoin: COIN_CODE, giveTick: GAS_TICK,
        getCoin: COIN_CODE, status: 'valid'
    }, 120000)
    assert(dispRow, 'drill dispense should index valid')
}

async function placeOppositeOrders(dexBuyer, dexSeller, coinTotal, expiration) {
    const buyOrder = await orderHelper.sendOrderV0(
        dexBuyer, COIN_CODE, '', coinTotal,
        COIN_CODE, GAS_TICK, '50',
        dexBuyer['address'], expiration, '', '', 'buy XCHAIN, coin side first')
    assert(buyOrder.order, 'coin-side ORDER should exist')

    const sellOrder = await orderHelper.sendOrderV0(
        dexSeller, COIN_CODE, GAS_TICK, '50',
        COIN_CODE, '', coinTotal,
        dexSeller['address'], expiration, '', '', 'sell XCHAIN, matching second')
    assert(sellOrder.order, 'XCHAIN-side ORDER should exist')

    const match = await indexerDatabase.waitForOrderMatch({
        giveActionIndex: Number(buyOrder.order['action_index']),
        getActionIndex: Number(sellOrder.order['action_index']),
        status: 'pending_coinpay'
    }, 60000)
    assert(match, 'opposite-orientation ORDER_MATCH should exist')
    return match
}

// 4b. DEX leg in the OPPOSITE orientation from the first DEX proof: the
//     coin-giving order is placed FIRST and its owner pays the COINPAY, so
//     the match row holds the tick on the other side. 50 XCHAIN realized at
//     rate2Btc coin per XCHAIN.
async function drillDexLeg(ctx, db, rate2Btc) {
    const dexBuyer = await cryptoHelper.getNewFundedAddress(
        'XCPRICE.SUP.DEX.BUYER', COIN, NETWORK, null, 'legacy', 0, 2)
    const dexSeller = await cryptoHelper.getNewFundedAddress(
        'XCPRICE.SUP.DEX.SELLER', COIN, NETWORK, null, 'legacy', 0, 2)
    await gasHelper.ensureGasBalance(dexSeller, '200')

    const expiration = await venue.chainExpiration(db)
    const coinTotal = ctx.bcmath.bcformat(ctx.bcmath.bcmul(rate2Btc, '50', 8), 8)
    const match = await placeOppositeOrders(dexBuyer, dexSeller, coinTotal, expiration)

    await coinpayHelper.sendCoinpayV0(
        dexBuyer, Number(match.action_index), dexSeller['address'],
        Math.round(Number(coinTotal) * 1e8))
    const paid = await indexerDatabase.waitForCoinpayObligation({
        actionIndex: Number(match.action_index), coinpayStatus: 'fulfilled'
    }, 60000)
    assert(paid, 'opposite-orientation COINPAY should fulfill')
}

// 5. Clear the confirmation buffer, then freeze the tip. From here to
//    the assertion no transactions are made, so no blocks are mined
//    and every subsequent round derives over the identical window.
// 6. The frozen window must contain exactly the two drill fills, and
//    the reproduction over them must not be winsorized (they were
//    priced in band by construction).
async function frozenWindowFills(ctx, db) {
    const tip = await venue.mineAndIndex(db, CONFIRMATION_BUFFER + 1, 120000)
    const selection = await venue.windowFills(ctx, db, {
        referenceHeight: tip,
        confirmationBuffer: CONFIRMATION_BUFFER,
        windowLength: WINDOW_BLOCKS
    })
    assert.strictEqual(selection.ok, true, 'reproduction selection must succeed: ' + selection.error)
    assert.strictEqual(selection.fills.length, 2,
        'the frozen window must contain exactly the two drill fills, got ' + selection.fills.length)
    return selection.fills
}

// One published round against the reproduction of ITS OWN round, or null
// when the rows needed to reproduce it are not all there yet.
function reproduceRound(ctx, rows, cand, fills) {
    const R = Number(cand.round_number)
    const btcUsdR = pairRows(rows, 'BTC/USD').find(r => Number(r.round_number) === R)
    const refXchain = lastBelow(rows, 'XCHAIN/USD', R)
    const refBtc    = lastBelow(rows, 'BTC/USD', R)
    if (!btcUsdR || !refXchain || !refBtc) return null
    const { price } = ctx.derivation
    const refRate = price.referenceRateFromUsd(ctx.bcmath, refXchain.price, refBtc.price)
    const derived = price.deriveXchainRate(ctx.bcmath, fills, refRate)
    if (!derived) return null
    return { round: R, published: cand.price,
             expected: price.toUsd(ctx.bcmath, derived.rate, btcUsdR.price),
             clamped: derived.clampedCount }
}

// 7. Assert per round, not on a stabilized value: BTC/USD is live and
//    moves a little every round, so the published USD value never
//    freezes - but every round must equal the reproduction of ITS OWN
//    round from the hub's snapshot rows plus the production formula
//    over the live DB. The first fresh round after the tip settles can
//    legitimately disagree (the hub may have composed it against a
//    tip the indexer had not finished serving), so keep evaluating
//    rounds until one matches exactly.
async function matchFreshRound(ctx, fills, cf, cfRound) {
    let matched = null
    const attempts = []
    const deadline = Date.now() + 420000
    while (!matched && Date.now() < deadline) {
        const rows = await hubPriceSnapshots()
        const fresh = pairRows(rows, 'XCHAIN/USD')
            .filter(r => Number(r.round_number) > cfRound && r.price !== cf)
        for (const cand of fresh) {
            if (attempts.some(a => a.round === Number(cand.round_number))) continue
            const attempt = reproduceRound(ctx, rows, cand, fills)
            if (!attempt) continue
            attempts.push(attempt)
            if (cand.price === attempt.expected && attempt.clamped === 0) matched = attempt
        }
        if (!matched) await new Promise(r => setTimeout(r, 15000))
    }
    assert(matched,
        'no fresh round matched its own reproduction exactly; rounds seen: ' + JSON.stringify(attempts))
    return matched
}

module.exports = {
    buryOldFills, awaitCarryForward, priceDrillRates, drillDispenseLeg,
    drillDexLeg, frozenWindowFills, matchFreshRound
}
