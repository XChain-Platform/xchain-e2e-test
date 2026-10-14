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
// XCHAIN price derivation, selection exclusions: the two selection shapes the
// unit suite could only pin by asserting on the text of the SQL, because
// regtest held zero rows of either (spec §10 step 1 residual, step 7 closes
// it). An exclusion nothing has ever exercised is the kind that turns out to
// be inverted, and inverted here means pricing every LTC/DOGE fee off trades
// that carry no XCHAIN/coin information at all.
//
// Neither of these needs the validator hub: they are properties of the
// SELECTION, so they run on any venue with the sibling checkouts.

const assert = require('assert')
const cryptoHelper = require('../../helpers/core/cryptoHelper')
const dispenserHelper = require('../../helpers/dispenserHelper')
const orderHelper = require('../../helpers/orderHelper')
const gasHelper = require('../../helpers/gasHelper')
const sendHelper = require('../../helpers/sendHelper')
const issueHelper = require('../../helpers/issueHelper')
const venue = require('./helpers/venue.test')

const { COIN_CODE, GAS_TICK, WINDOW_BLOCKS } = venue

const tailOf = (addr) => addr['address'].substring(addr['address'].length - 6).toUpperCase()

// An XCHAIN dispenser PRICED IN A TOKEN is a real trade with no coin
// leg, so it carries no price information for XCHAIN/BTC and must
// never be selected. Until now this exclusion was held by
// predicate-text assertions alone (spec step 1 residual).
async function makeTokenForTokenDispense() {
    const seller = await cryptoHelper.getNewFundedAddress(
        'XCPRICE.T4T.SELLER', COIN, NETWORK, null, 'legacy', 0, 1)
    const buyer = await cryptoHelper.getNewFundedAddress(
        'XCPRICE.T4T.BUYER', COIN, NETWORK, null, 'legacy', 0, 1)
    await gasHelper.ensureGasBalance(seller, '200')
    await gasHelper.ensureGasBalance(buyer, '100')

    const payTick = 'XCPT4T' + tailOf(seller)
    await issueHelper.sendIssueV0(buyer, payTick, 1000, 1000, 0, 'token-for-token pay tick', 100)

    const disp = await dispenserHelper.sendDispenserV0(
        seller, COIN_CODE, GAS_TICK, 1, 5,
        COIN_CODE, payTick, 10, seller['address'],
        null, null, null, null,
        null, null, 'token-for-token dispense')
    assert(disp.dispenser, 'token-priced dispenser should exist')

    const sendRes = await sendHelper.sendSendV0(buyer, payTick, 10, seller['address'], '')
    const dispense = await indexerDatabase.waitForDispense({
        giveCoin: COIN_CODE, giveTick: GAS_TICK,
        getCoin: COIN_CODE, getTick: payTick, status: 'valid'
    }, 120000)
    assert(dispense, 'token-for-token dispense should index valid: ' + JSON.stringify(sendRes || null))
    return dispense
}

async function currentSelection(ctx, db) {
    const selection = await venue.windowFills(ctx, db, {
        referenceHeight: await venue.actionTip(db), windowLength: WINDOW_BLOCKS
    })
    assert.strictEqual(selection.ok, true, 'selection must succeed: ' + selection.error)
    return selection
}

// (a) The dispenser layer: refused, so the exclusion has nothing to
//     exclude there. Asserted as a REJECTED create rather than skipped,
//     because "no rows of that shape exist" is only reassuring while the
//     reason holds - if cross-chain dispensers are ever wired, this fails
//     and the derivation's dispense predicate has to be re-examined
//     before that ships.
async function assertCrossChainDispenserRefused(seller, otherCoin) {
    const rejected = await dispenserHelper.sendDispenserV0(
        seller, COIN_CODE, GAS_TICK, 1, 5,
        otherCoin, null, 0.05, seller['address'],
        null, null, null, null,
        null, null, 'cross-chain dispenser (must be refused)',
        null, null, 'invalid: GET_COIN (network)')
    assert(rejected.dispenser, 'a cross-chain dispenser create must index, as INVALID')
}

// (b) The order layer: a genuine cross-chain ORDER. It gives XCHAIN on
//     this chain and asks for the OTHER chain's native coin, so its
//     get_coin_id is a foreign coin id in this indexer's index_coins.
async function placeCrossChainOrder(db, seller, otherCoin) {
    const expiration = await venue.chainExpiration(db)
    const crossOrder = await orderHelper.sendOrderV0(
        seller, COIN_CODE, GAS_TICK, '25',
        otherCoin, '', '0.001',
        seller['address'], expiration, '', '', 'cross-chain order')
    assert(crossOrder.order, 'the cross-chain ORDER must index valid')
    return crossOrder
}

async function assertOrderCarriesForeignCoin(db, crossOrder, otherCoin) {
    const coinIds = await db.doQuery(
        `SELECT o.give_coin_id, o.get_coin_id, gc.coin AS give_coin, tc.coin AS get_coin
           FROM orders o
           JOIN index_coins gc ON gc.id = o.give_coin_id
           JOIN index_coins tc ON tc.id = o.get_coin_id
          WHERE o.action_index = ?`, [Number(crossOrder.order['action_index'])])
    assert.strictEqual(coinIds.length, 1, 'the cross-chain order row must resolve both coins')
    assert.strictEqual(String(coinIds[0].give_coin), COIN_CODE, 'give side is this chain')
    assert.strictEqual(String(coinIds[0].get_coin), otherCoin, 'get side is the foreign chain')
    assert.notStrictEqual(Number(coinIds[0].give_coin_id), Number(coinIds[0].get_coin_id),
        'a cross-chain row must carry two DIFFERENT coin ids, or the predicate has nothing to exclude')
    return Number(coinIds[0].give_coin_id)
}

// The selection resolves ONE coin id and binds both sides of both
// predicates to it, so a row whose two coin ids differ cannot satisfy
// either. Assert the resolved id is this chain's and that nothing from
// the cross-chain order reached the fills.
function assertOrderNotSelected(selection, crossOrder, giveCoinId) {
    assert.strictEqual(Number(selection.coinId), giveCoinId,
        'the derivation must resolve THIS chain\'s coin id')
    assert.strictEqual(
        selection.fills.filter(f => f.actionIndex === Number(crossOrder.order['action_index'])).length, 0,
        'nothing from a cross-chain order may be selected as a price fill')
}

// And the general shape, over the live rows rather than this one order:
// no selected fill may come from a row whose two coin ids differ.
async function assertNoCrossRowSelected(db, selection) {
    const crossMatches = await db.doQuery(
        `SELECT action_index FROM order_matches WHERE give_coin_id <> get_coin_id`)
    const crossDispenses = await db.doQuery(
        `SELECT action_index FROM dispenses WHERE give_coin_id <> get_coin_id`)
    const crossIndexes = new Set(
        crossMatches.concat(crossDispenses).map(r => Number(r.action_index)))
    assert.strictEqual(selection.fills.filter(f => crossIndexes.has(f.actionIndex)).length, 0,
        'no cross-chain row may appear among the selected fills')
    console.log('cross-chain exclusion: ' + crossMatches.length + ' cross matches / ' +
        crossDispenses.length + ' cross dispenses on this chain, 0 selected')
}

// The §11 cross-chain exclusion is `give_coin_id = get_coin_id = <this
// chain>` on BOTH predicates. Unlike token-for-token there is no way to
// make a cross-chain FILL row on a single-chain venue, and that is not a
// gap in the venue - it is a property of the chain, which this leg
// asserts rather than assumes:
//
//   dispensers: refused outright. A cross-chain dispenser is not wired
//     (dispenser.js, `GET_COIN (network)`), so no cross-chain dispense
//     row can exist on any chain today.
//   orders: accepted. A cross-chain ORDER escrows locally and is matched
//     and settled by the validator federation, so the local chain holds a
//     real order row naming a FOREIGN coin - which is the row this test
//     creates, and the closest a single-chain venue gets to the shape the
//     exclusion is written against.
async function proveCrossChainExcluded(ctx) {
    const db = venue.queryAdapter(indexerDatabase)
    const otherCoin = (COIN_CODE === 'BTC') ? 'LTC' : 'BTC'
    const seller = await cryptoHelper.getNewFundedAddress(
        'XCPRICE.XCHAIN.SELLER', COIN, NETWORK, null, 'legacy', 0, 2)
    await gasHelper.ensureGasBalance(seller, '200')

    await assertCrossChainDispenserRefused(seller, otherCoin)
    const crossOrder = await placeCrossChainOrder(db, seller, otherCoin)
    const giveCoinId = await assertOrderCarriesForeignCoin(db, crossOrder, otherCoin)
    const selection = await currentSelection(ctx, db)
    assertOrderNotSelected(selection, crossOrder, giveCoinId)
    await assertNoCrossRowSelected(db, selection)
}

// Five minutes is not enough when the supersession leg has just mined a
// thousand burial blocks: these legs then wait on actions sitting in blocks
// the indexer has not parsed yet, and the harness's own "indexer is N blocks
// behind" extensions run out first. The failure that produces is a bare mocha
// timeout that says nothing about the exclusion under test.
const EXCLUSION_TIMEOUT_MS = 900000

function registerSelectionExclusions(ctx) {
    describe('selection exclusions', function () {
        // Same gate as the trade legs: both exclusions need XCHAIN trades to
        // exclude, and XCHAIN is BTC-only as a balance-bearing token.
        before(function () { venue.skipUnlessBtc(this) })

        it('excludes a token-for-token dispense from the derivation', async function () {
            this.timeout(EXCLUSION_TIMEOUT_MS)
            const db = venue.queryAdapter(indexerDatabase)
            const dispense = await makeTokenForTokenDispense()
            const selection = await currentSelection(ctx, db)
            assert.strictEqual(
                selection.fills.filter(f => f.actionIndex === Number(dispense.action_index)).length, 0,
                'a token-for-token dispense must never be selected as a price fill')
        })

        it('excludes cross-chain trades, at both layers that can carry one', async function () {
            this.timeout(EXCLUSION_TIMEOUT_MS)
            await proveCrossChainExcluded(ctx)
        })
    })
}

module.exports = { registerSelectionExclusions }
