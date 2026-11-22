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
// XCHAIN price derivation, dispenser venue: a real XCHAIN dispense priced at
// its realized rate.

const assert = require('assert')
const cryptoHelper = require('../../helpers/core/cryptoHelper')
const transactionHelper = require('../../helpers/core/transactionHelper')
const dispenserHelper = require('../../helpers/dispenserHelper')
const gasHelper = require('../../helpers/gasHelper')
const venue = require('./helpers/venue.test')

const { COIN_CODE, GAS_TICK } = venue

// XCHAIN is acquirable on regtest (minted from the open BTC faucet, or
// bridged in from BTC off it since D62 closed the local ISSUE/MINT path),
// which is what makes this proof possible at all: mainnet supply is 0 with
// the mint disabled.
// 1 XCHAIN for 0.05 coin, escrowing 10. The rate under test is therefore
// 0.05 coin per XCHAIN, and it must come back out of the derivation
// unchanged: a units misread (satoshi vs whole-coin) shows up here as a
// factor of 1e8, which is the specific failure this proof exists to catch.
async function createXchainDispenser() {
    const sellerInfo = await cryptoHelper.getNewFundedAddress(
        'XCPRICE.DISP.SELLER', COIN, NETWORK, null, 'legacy', 0, 1)
    await gasHelper.ensureGasBalance(sellerInfo, '100')
    const dispenserResult = await dispenserHelper.sendDispenserV0(
        sellerInfo,
        COIN_CODE, GAS_TICK, 1, 10,
        COIN_CODE, null, 0.05, sellerInfo['address'],
        null, null, null, null,
        null, null, 'derived-price proof'
    )
    assert(dispenserResult.dispenser, 'XCHAIN dispenser should exist in DB')
    return sellerInfo
}

async function buyOneDispense(sellerInfo) {
    const buyerInfo = await cryptoHelper.getNewFundedAddress(
        'XCPRICE.DISP.BUYER', COIN, NETWORK, null, 'legacy', 0, 1)
    const txHash = await transactionHelper.createSimpleTransaction(
        buyerInfo, sellerInfo['address'], 5000000)   // 0.05 coin
    return indexerDatabase.waitForDispense({
        txHash: txHash,
        giveCoin: COIN_CODE,
        giveTick: GAS_TICK,
        getCoin: COIN_CODE,
        status: 'valid'
    }, 120000)
}

// Now the production path, over a window that certainly contains the
// fill. K=0 so the just-mined block is not held back by the confirmation
// buffer; the buffer itself is covered by the indexer's unit suite.
async function selectThisDispense(ctx, dispenseRow) {
    const db = venue.queryAdapter(indexerDatabase)
    const selection = await venue.windowFills(ctx, db, {
        referenceHeight: await venue.actionTip(db), windowLength: 100000
    })
    assert.strictEqual(selection.ok, true, 'selection must succeed: ' + selection.error)
    assert(selection.fills.length >= 1, 'the dispense must be selected as a fill')

    // THIS dispense, by action index - not "every dispense fill in the
    // window". A 100000-block window on a venue that has run this suite
    // before also holds the earlier runs' dispenses at their own rates, so
    // the venue-wide filter made the assertion pass only on a chain this test
    // had never touched, and fail on every rerun with a clamped-VWAP number
    // that looks like a derivation bug and is not.
    const mine = selection.fills.filter(f =>
        f.venue === 'dispense' && f.actionIndex === Number(dispenseRow['action_index']))
    assert.strictEqual(mine.length, 1,
        'exactly this dispense must be selected as a fill, got ' + mine.length)
    return mine
}

// Anchor the band on the rate itself so nothing is winsorized; the clamp
// is unit-tested separately and would only obscure the units question here.
// The load-bearing assertion. 0.05 coin per XCHAIN, NOT 5000000 and not
// 0.00000005: whole-coin decimals, exactly as the schema stores them.
function assertRealizedRate(ctx, mine) {
    const derived = ctx.derivation.price.deriveXchainRate(ctx.bcmath, mine, '0.05')
    assert(derived, 'derivation must produce a rate')
    assert.strictEqual(derived.clampedCount, 0, 'no fill should be clamped at its own rate')
    assert.strictEqual(derived.rate, '0.05000000',
        'derived XCHAIN/' + COIN_CODE + ' must equal the realized dispense rate')
}

function registerDispenserVenue(ctx) {
    describe('dispenser venue', function () {
        before(function () { venue.skipUnlessBtc(this) })

        it('prices a real XCHAIN dispense at its realized rate', async function () {
            this.timeout(300000)
            const sellerInfo = await createXchainDispenser()
            const dispenseRow = await buyOneDispense(sellerInfo)
            assert(dispenseRow, 'XCHAIN dispense should exist in DB')
            const mine = await selectThisDispense(ctx, dispenseRow)
            assertRealizedRate(ctx, mine)
        })
    })
}

module.exports = { registerDispenserVenue }
