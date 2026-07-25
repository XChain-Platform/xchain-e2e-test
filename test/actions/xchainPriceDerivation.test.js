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
// XCHAIN price derivation, live proof (, spec §10 step 7).
//
// Every other suite that touches native-coin fees seeds XCHAIN/USD by hand
// (nativeFeeHelper.seedGlobalPrices), which is exactly why the missing-pair bug
// survived to launch-blocker status: every green run tested against data
// production does not produce. This file does the opposite. It MAKES real XCHAIN
// trades on the chain and then asserts the production selection + formula price
// them, so a regression in either is caught by data rather than by a fixture.
//
// It deliberately does NOT seed the pair.

const assert = require('assert')
const fs = require('fs')
const path = require('path')
const cryptoHelper = require('../cryptoHelper')
const transactionHelper = require('../transactionHelper')
const dispenserHelper = require('../helpers/dispenserHelper')
const orderHelper = require('../helpers/orderHelper')
const coinpayHelper = require('../helpers/coinpayHelper')
const gasHelper = require('../helpers/gasHelper')

// The derivation lives in xchain-indexer and is vendored byte-identically into
// xchain-hub. Require it from the sibling checkout rather than copying it here:
// a local copy in the e2e repo would be a THIRD implementation to drift, and the
// whole point is to exercise the one production actually runs. Absent sibling ->
// skip, matching the cross-repo guard convention used elsewhere.
const INDEXER_DIR = process.env.XCHAIN_INDEXER_DIR ||
    path.join(__dirname, '..', '..', '..', 'xchain-indexer')
const QUERY_PATH = path.join(INDEXER_DIR, 'src', 'xchainPriceQuery.js')
const PRICE_PATH = path.join(INDEXER_DIR, 'src', 'xchainPrice.js')
const HAVE_DERIVATION = fs.existsSync(QUERY_PATH) && fs.existsSync(PRICE_PATH)

const GAS_TICK = 'XCHAIN'

// Adapt the e2e Database to the one method the query module needs. The module was
// built to require nothing else precisely so it can run here, in the indexer and
// in the hub without a per-caller shim.
function queryAdapter(db) {
    return {
        async doQuery(sql, args) {
            const connection = await db.getConnection()
            try {
                return await connection.query(sql, args || [])
            } finally {
                if (connection && connection.release) connection.release()
            }
        }
    }
}

// bcmath in the shape the formula expects. The e2e has no Utility, so borrow the
// hub's vendored bcmath if present; it is verified byte-equivalent to the
// indexer's Utility across every operation the derivation performs.
function loadBcmath() {
    const hubBc = path.join(__dirname, '..', '..', '..', 'xchain-hub', 'src', 'bcmath.js')
    return fs.existsSync(hubBc) ? require(hubBc) : null
}

describe('XCHAIN price derivation from real fills ( step 7)', function () {

    let derivation = null
    let bcmath = null

    before(function () {
        if (!HAVE_DERIVATION) {
            console.log('xchainPriceDerivation: sibling xchain-indexer not checked out; skipping')
            this.skip()
            return
        }
        bcmath = loadBcmath()
        if (!bcmath) {
            console.log('xchainPriceDerivation: sibling xchain-hub bcmath not found; skipping')
            this.skip()
            return
        }
        derivation = {
            query: require(QUERY_PATH),
            price: require(PRICE_PATH)
        }
    })

    describe('dispenser venue', function () {
        it('prices a real XCHAIN dispense at its realized rate', async function () {
            this.timeout(300000)

            // XCHAIN is freely mintable on regtest, which is what makes this proof
            // possible at all: mainnet supply is 0 with the mint disabled.
            const sellerInfo = await cryptoHelper.getNewFundedAddress(
                'XCPRICE.DISP.SELLER', COIN, NETWORK, null, 'legacy', 0, 1)
            await gasHelper.mintGas(sellerInfo, '100')

            // 1 XCHAIN for 0.05 coin, escrowing 10. The rate under test is therefore
            // 0.05 coin per XCHAIN, and it must come back out of the derivation
            // unchanged: a units misread (satoshi vs whole-coin) shows up here as a
            // factor of 1e8, which is the specific failure this proof exists to catch.
            const dispenserResult = await dispenserHelper.sendDispenserV0(
                sellerInfo,
                COIN_CODE, GAS_TICK, 1, 10,
                COIN_CODE, null, 0.05, sellerInfo['address'],
                null, null, null, null,
                null, null, ' derived-price proof'
            )
            assert(dispenserResult.dispenser, 'XCHAIN dispenser should exist in DB')

            const buyerInfo = await cryptoHelper.getNewFundedAddress(
                'XCPRICE.DISP.BUYER', COIN, NETWORK, null, 'legacy', 0, 1)
            const txHash = await transactionHelper.createSimpleTransaction(
                buyerInfo, sellerInfo['address'], 5000000)   // 0.05 coin

            const dispenseRow = await indexerDatabase.waitForDispense({
                txHash: txHash,
                giveCoin: COIN_CODE,
                giveTick: GAS_TICK,
                getCoin: COIN_CODE,
                status: 'valid'
            }, 120000)
            assert(dispenseRow, 'XCHAIN dispense should exist in DB')

            // Now the production path, over a window that certainly contains the
            // fill. K=0 so the just-mined block is not held back by the confirmation
            // buffer; the buffer itself is covered by the indexer's unit suite.
            const tipRow = await queryAdapter(indexerDatabase)
                .doQuery('SELECT MAX(block_index) AS h FROM actions')
            const tip = Number(tipRow[0].h)

            const selection = await derivation.query.getWindowFills(queryAdapter(indexerDatabase), {
                referenceHeight: tip,
                confirmationBuffer: 0,
                windowLength: 100000,
                gasTick: GAS_TICK,
                coin: COIN_CODE
            })
            assert.strictEqual(selection.ok, true, 'selection must succeed: ' + selection.error)
            assert(selection.fills.length >= 1, 'the dispense must be selected as a fill')

            const mine = selection.fills.filter(f => f.venue === 'dispense')
            assert(mine.length >= 1, 'at least one dispense fill must be present')

            // Anchor the band on the rate itself so nothing is winsorized; the clamp
            // is unit-tested separately and would only obscure the units question here.
            const derived = derivation.price.deriveXchainRate(bcmath, mine, '0.05')
            assert(derived, 'derivation must produce a rate')
            assert.strictEqual(derived.clampedCount, 0, 'no fill should be clamped at its own rate')

            // The load-bearing assertion. 0.05 coin per XCHAIN, NOT 5000000 and not
            // 0.00000005: whole-coin decimals, exactly as the schema stores them.
            assert.strictEqual(derived.rate, '0.05000000',
                'derived XCHAIN/' + COIN_CODE + ' must equal the realized dispense rate')
        })
    })

    describe('DEX venue (coinpay)', function () {
        it('selects a settled coinpay fill and dates it by its PAYMENT block', async function () {
            this.timeout(300000)

            // This leg exists for the two §3 corrections that came out of building the
            // predicate. Both were live-verified at the SQL level; neither had ever
            // been exercised by a trade the test itself created, which is the gap.
            const sellerInfo = await cryptoHelper.getNewFundedAddress(
                'XCPRICE.DEX.SELLER', COIN, NETWORK, null, 'legacy', 0, 2)
            const buyerInfo = await cryptoHelper.getNewFundedAddress(
                'XCPRICE.DEX.BUYER', COIN, NETWORK, null, 'legacy', 0, 2)
            await gasHelper.mintGas(sellerInfo, '200')

            const db = queryAdapter(indexerDatabase)

            // Expiration comes from the CHAIN's clock, not the wall clock. A regtest
            // chain that has been through a setmocktime drill can sit many hours
            // ahead of real time (measured at +24.35h while writing this), and the
            // indexer validates EXPIRATION against block time - so a wall-clock
            // "+24h" lands in the past and the order dies with
            // `invalid: EXPIRATION (past)` for reasons that have nothing to do with
            // what is under test.
            const clock = await db.doQuery('SELECT MAX(block_time) AS t FROM blocks')
            const chainNow = Number(clock[0].t)
            assert(Number.isFinite(chainNow) && chainNow > 0, 'chain block time must be readable')
            const expiration = chainNow + 86400

            // 100 XCHAIN for 0.001 coin = 0.00001 coin per XCHAIN.
            const sellerOrder = await orderHelper.sendOrderV0(
                sellerInfo, COIN_CODE, GAS_TICK, '100',
                COIN_CODE, '', '0.001',
                sellerInfo['address'], expiration, '', '', ' sell XCHAIN for coin')
            assert(sellerOrder.order, 'seller ORDER should exist in DB')

            const buyerOrder = await orderHelper.sendOrderV0(
                buyerInfo, COIN_CODE, '', '0.001',
                COIN_CODE, GAS_TICK, '100',
                buyerInfo['address'], expiration, '', '', ' buy XCHAIN with coin')
            assert(buyerOrder.order, 'buyer ORDER should exist in DB')

            const orderMatch = await indexerDatabase.waitForOrderMatch({
                giveActionIndex: Number(sellerOrder.order['action_index']),
                getActionIndex: Number(buyerOrder.order['action_index']),
                status: 'pending_coinpay'
            }, 60000)
            assert(orderMatch, 'ORDER_MATCH should exist')

            // Before payment the trade has NOT happened. It must not be selectable:
            // counting an unpaid obligation as a realized trade would be a free price
            // print, which is what selecting on 'pending_coinpay' would have done.
            const tipBefore = Number((await db.doQuery('SELECT MAX(block_index) AS h FROM actions'))[0].h)
            const beforePay = await derivation.query.getWindowFills(db, {
                referenceHeight: tipBefore, confirmationBuffer: 0, windowLength: 100000,
                gasTick: GAS_TICK, coin: COIN_CODE
            })
            assert.strictEqual(beforePay.ok, true, 'selection must succeed: ' + beforePay.error)
            assert.strictEqual(
                beforePay.fills.filter(f => f.actionIndex === Number(orderMatch.action_index)).length, 0,
                'an UNPAID coinpay obligation must not be selected as a realized trade')

            await coinpayHelper.sendCoinpayV0(
                buyerInfo, Number(orderMatch.action_index), sellerInfo['address'], 100000)
            const fulfilled = await indexerDatabase.waitForCoinpayObligation({
                actionIndex: Number(orderMatch.action_index), coinpayStatus: 'fulfilled'
            }, 60000)
            assert(fulfilled, 'COINPay obligation should be fulfilled')

            const tipAfter = Number((await db.doQuery('SELECT MAX(block_index) AS h FROM actions'))[0].h)
            const afterPay = await derivation.query.getWindowFills(db, {
                referenceHeight: tipAfter, confirmationBuffer: 0, windowLength: 100000,
                gasTick: GAS_TICK, coin: COIN_CODE
            })
            assert.strictEqual(afterPay.ok, true, 'selection must succeed: ' + afterPay.error)

            const fill = afterPay.fills.find(f => f.actionIndex === Number(orderMatch.action_index))

            // CORRECTION 1: the match's OWN status is still 'pending_coinpay' right
            // now and will stay that way forever - nothing updates it. The fill is
            // selected anyway, because settlement is proven by the coinpays row. A
            // predicate keyed on the match status selects zero rows on every chain.
            assert(fill, 'a SETTLED coinpay fill must be selected despite its match status')
            const matchStatus = await db.doQuery(
                `SELECT s.status, a.block_index FROM order_matches m
                   JOIN index_statuses s ON s.id = m.status_id
                   JOIN actions a ON a.action_index = m.action_index
                  WHERE m.action_index = ?`, [Number(orderMatch.action_index)])
            assert.strictEqual(String(matchStatus[0].status), 'pending_coinpay',
                'the match row is expected to still read pending after full payment')

            // CORRECTION 2: the fill is dated by the COINPAY's block, not the match's.
            // Windowing on the match block makes a historical window mutable, which
            // forks the pair between validators computing before and after payment.
            const coinpayRow = await db.doQuery(
                'SELECT block_index FROM coinpays WHERE obligation_action_index = ?',
                [Number(orderMatch.action_index)])
            assert.strictEqual(fill.blockIndex, Number(coinpayRow[0].block_index),
                'the fill must be dated by its payment block')
            assert(fill.blockIndex >= Number(matchStatus[0].block_index),
                'the payment block cannot precede the match block')

            // Both orientations reduce to the same rate; the mapper reads the amounts
            // by which side holds the tick id, never from fixed columns.
            // Compared as a NUMBER, not a string. XCHAIN rejects a padded
            // GIVE_AMOUNT ('100.00000000' is `invalid: GIVE_AMOUNT (format)`) while
            // the coin side stores padded, so both conventions coexist across a
            // single trade - which is exactly why the derivation hands every amount
            // to bcmath and never string-compares.
            assert(bcmath.bcgt(fill.xchainAmount, '99.99999999') &&
                   bcmath.bclt(fill.xchainAmount, '100.00000001'),
                'the XCHAIN leg must be 100, got ' + fill.xchainAmount)
            const derived = derivation.price.deriveXchainRate(bcmath, [fill], '0.00001')
            assert(derived, 'derivation must produce a rate')
            assert.strictEqual(derived.rate, '0.00001000',
                'derived XCHAIN/' + COIN_CODE + ' must equal the realized DEX rate')
        })
    })

    describe('the anti-reseed guard (spec step 8)', function () {
        it('does not seed XCHAIN/USD anywhere in this file', function () {
            // The path of least resistance for a future author who sees this suite go
            // red is to seed the pair and move on, which silently resurrects the
            // original bug: a green run that proves nothing about production. Keep the
            // guard next to the temptation.
            // Match CALL syntax (`helper.seedSnapshot(`), not the bare names: a
            // scan for the names alone matches this very line and fails the guard
            // on itself, which is the same self-match trap a source-scanning
            // assertion always sets for its author.
            const self = fs.readFileSync(__filename, 'utf8')
            const seeds = self.split('\n').filter(line =>
                /\.(seedSnapshot|seedGlobalPrices)\s*\(/.test(line) && !/^\s*\/\//.test(line))
            assert.deepStrictEqual(seeds, [],
                'this proof must derive XCHAIN/USD from real fills, never seed it')
        })
    })
})
