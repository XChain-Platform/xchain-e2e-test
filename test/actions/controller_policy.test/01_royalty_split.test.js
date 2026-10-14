/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 ********************************************************************/

// Royalty split: payout_legs stored and exact conservation across partial fills. Part of controller_policy.test.js.

const assert = require('assert')
const cryptoHelper = require('../../helpers/core/cryptoHelper')
const gasHelper = require('../../helpers/gasHelper')
const issueHelper = require('../../helpers/issueHelper')
const vmHelper = require('../../helpers/vmHelper')
const {
    balanceOf, randTick, mine, sleep, submitRaw, issueBindWire, waitValidOrder, waitTokenController, royaltyGate, newOwner,
} = require('./support/shared')

// Controlled token T, proceeds token PAY, royalty parties and the bound royalty guard.
async function setUpRoyaltyMarket(owner) {
    const T   = randTick('CVT')   // controlled token (seller gives)
    const PAY = randTick('CVP')   // proceeds tick (buyers give)
    const creator = await cryptoHelper.getNewFundedAddress('cv-creator', COIN, NETWORK, null, 'legacy', 0, 1)
    const market  = await cryptoHelper.getNewFundedAddress('cv-market',  COIN, NETWORK, null, 'legacy', 0, 1)
    const buyer   = await cryptoHelper.getNewFundedAddress('cv-buyer',   COIN, NETWORK, null, 'legacy', 0, 1)
    await gasHelper.ensureGasBalance(buyer, '5000')

    await issueHelper.sendIssueV0(owner, T,   '100000', '100000', '0', 'royalty token', '100000')
    await issueHelper.sendIssueV0(buyer, PAY, '100000', '100000', '0', 'proceeds token', '100000')

    const dep = await vmHelper.sendDeployV0(owner, royaltyGate(creator.address, market.address), 250000)
    await submitRaw(owner, issueBindWire(T, dep.contract.action_index, 'trade', 0, 0))
    await mine(1)
    await waitTokenController(T, e => Number(e.is_unbind) === 0)
    return { owner, T, PAY, creator, market, buyer }
}

// Owner lists 1000 T for 1000 PAY (price 1:1). Guard returns payoutLegs.
async function assertListingPersistsLegs({ owner, T, PAY }) {
    await submitRaw(owner, `ORDER|0|${COIN_CODE}|${T}|1000||${COIN_CODE}|${PAY}|1000||${owner.address}||||royalty-listing`)
    await mine(1)
    const ord = await waitValidOrder(owner.address, T, 22500)
    assert(ord && ord.status === 'valid', 'controlled-token ORDER accepted with payout legs')
    console.log('   order.payout_legs =', ord.payout_legs)
    assert(ord.payout_legs !== null && ord.payout_legs !== undefined,
        'BUG: payout_legs NOT persisted on controlled ORDER (Phase D royalty no-op)')
    const legs = JSON.parse(ord.payout_legs)
    assert(legs.length === 2 && legs[0].bps === 250 && legs[1].bps === 100, 'payout_legs persisted [{250},{100}]')
}

async function payBalances({ owner, creator, market }, PAY) {
    return [await balanceOf(owner.address, PAY), await balanceOf(creator.address, PAY), await balanceOf(market.address, PAY)]
}

// Poll until EVERY leg the assertions read has moved: creator, market and seller.
// Breaking on the creator alone would leave the other two legs read with no settle
// behind them, so a half-applied split could be measured as a conservation failure.
async function waitForAllLegs(m, before) {
    let after = before
    for (let tries = 24; tries-- > 0;) {
        after = await payBalances(m, m.PAY)
        if (after.every((v, i) => v !== before[i])) break
        await sleep(1000)
    }
    return after
}

// Partial fill: buyer gives `proceeds` PAY for `proceeds` T.
async function fillAndCheck(m, proceeds) {
    const { T, PAY, buyer } = m
    const before = await payBalances(m, PAY)
    await submitRaw(buyer, `ORDER|0|${COIN_CODE}|${PAY}|${proceeds}||${COIN_CODE}|${T}|${proceeds}||${buyer.address}||||fill-${proceeds}`)
    await mine(1)
    const after = await waitForAllLegs(m, before)
    const [dOwner, dCreator, dMarket] = after.map((v, i) => Number(v) - Number(before[i]))
    console.log(`   fill ${proceeds}: seller+${dOwner} creator+${dCreator} market+${dMarket} (sum=${dOwner+dCreator+dMarket})`)
    // 2.5% + 1.0% of `proceeds`; seller gets remainder. The split rounds the leg
    // to tick precision (deterministic, mathjs bcdiv half-up), so each leg is within
    // [floor,ceil] of its exact bps amount. What matters for consensus is determinism
    // + EXACT conservation (seller absorbs any rounding).
    const exC = proceeds * 250 / 10000, exM = proceeds * 100 / 10000
    assert(dCreator === Math.floor(exC) || dCreator === Math.ceil(exC), 'creator leg ≈ 2.5%')
    assert(dMarket  === Math.floor(exM) || dMarket  === Math.ceil(exM), 'market leg ≈ 1.0%')
    assert(dCreator > 0 && dMarket > 0, 'both royalty legs took a cut')
    assert(dOwner + dCreator + dMarket === proceeds, 'EXACT conservation: legs + seller == proceeds')
}

async function royaltySplitConserves(owner) {
    const m = await setUpRoyaltyMarket(owner)
    await assertListingPersistsLegs(m)
    await fillAndCheck(m, 400)
    await fillAndCheck(m, 300)
    console.log('   royalty split conserved across two partial fills; OK')
}

describe('Controller Policy Layer: bindings, enforcement, royalty split + permissions manifest (Phases A-E)', function () {
    this.timeout(0)
    let owner

    before(async function () {
        owner = await newOwner()
    })

    it('3. royalty split: payout_legs stored + exact conservation across partial fills', async function () { await royaltySplitConserves(owner) })
})
