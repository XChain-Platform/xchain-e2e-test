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
// XCHAIN price derivation, live proof (spec §10 step 7).
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
const sendHelper = require('../helpers/sendHelper')
const issueHelper = require('../helpers/issueHelper')
const stakeHelper = require('../helpers/stakeHelper')
const { NO_PRICE_SEED } = require('../helpers/xchainPriceConstants')

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

// The hub-published half of the proof needs a live price-capability VALIDATOR
// hub and a miner API on the same venue (both reachable over the operator's SSH
// tunnels). Both legs skip cleanly when the venue is not built that way, exactly
// like the sibling-checkout guard above.
const HUB_API_URL   = process.env.HUB_API_URL   || 'http://127.0.0.1:10000'
const MINER_API_URL = process.env.MINER_API_URL || 'http://127.0.0.1:3025'
// The indexer's HTTP health view (chain lag), beside its JSON-RPC port.
const INDEXER_STATUS_URL = process.env.INDEXER_STATUS_URL ||
    ('http://' + (process.env.INDEXER_URL || '127.0.0.1') + ':' +
     (process.env.INDEXER_API_PORT || '3024') + '/status')

// Production window constants (constants.js on both sides of the vendoring).
// The venue must run the hub with these UNSET so the drill proves the shipped
// values; if an override is ever set on the venue the equality assertion below
// fails loudly rather than silently proving a different window.
const WINDOW_BLOCKS = 1000
const CONFIRMATION_BUFFER = 6

// Lowest synthetic round number any seeding helper in this repo writes
// (nativeFeeHelper 888100001, nativeFeeLive 999200001, nativeFeeDispenser
// 999300001, the DOGE setups 990001). A price_snapshots row at or above it is a
// fixture; a hub's round counter is a small monotonic integer that needs decades
// at a ten-minute cadence to reach six digits.
const SEED_ROUND_FLOOR = 990000

// Page to exhaustion: this venue finalizes 37 pairs a minute, so a single
// since_id=0 fetch stops covering the NEWEST rounds within hours of venue
// uptime, and every consumer below reasons about the newest rounds.
async function hubPriceSnapshots() {
    const all = []
    let since = 0
    for (;;) {
        const res = await fetch(HUB_API_URL + '/hub-db/snapshot/price_snapshots?since_id=' + since + '&limit=5000')
        if (!res.ok) throw new Error('hub snapshot endpoint HTTP ' + res.status)
        const body = await res.json()
        const rows = body.rows || []
        if (!rows.length) break
        all.push(...rows)
        since = rows[rows.length - 1].id
        if (rows.length < 5000) break
    }
    return all.filter(r => r.status === 'finalized')
}

// Finalized rows for a pair, ascending by round. The reference reads mirror the
// hub's _lastFinalized: the newest finalized row STRICTLY BELOW a round.
function pairRows(rows, pair) {
    return rows.filter(r => r.coin_pair === pair)
        .sort((a, b) => Number(a.round_number) - Number(b.round_number))
}
function lastBelow(rows, pair, round) {
    const below = pairRows(rows, pair).filter(r => Number(r.round_number) < Number(round))
    return below.length ? below[below.length - 1] : null
}

async function minerRpc(method, params) {
    const res = await fetch(MINER_API_URL + '/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: method, params: params || {} })
    })
    const body = await res.json()
    if (body.error) throw new Error('miner ' + method + ' failed: ' + JSON.stringify(body.error))
    return body.result
}

// Advance the chain by `count` blocks and wait for the indexer to catch up.
// This venue's miner mines on tx arrival only (no idle blocks), which is what
// makes the derivation window deterministic enough to reproduce exactly: the
// tip moves precisely when this test says so.
// The indexer's own view of how far behind the CHAIN it is. `blocks` only says
// what the indexer has parsed, so a target of "the height I saw plus what I
// mined" is satisfied while the chain is still hundreds of blocks ahead - and
// every wait after that (waitForOrder, waitForDispense) then times out against
// actions sitting in blocks the indexer has not reached. Ask the service.
async function indexerLag() {
    const res = await fetch(INDEXER_STATUS_URL)
    if (!res.ok) throw new Error('indexer /status HTTP ' + res.status)
    const body = await res.json()
    return { lag: Number(body.lag), indexerBlock: Number(body.indexerBlock),
             decoderBlock: Number(body.decoderBlock) }
}

async function mineAndIndex(db, count, timeoutMs) {
    let remaining = count
    while (remaining > 0) {
        const n = Math.min(200, remaining)
        await minerRpc('generate_blocks', { count: n })
        remaining -= n
    }
    // Wait for the indexer to reach the CHAIN, not a height arithmetic says it
    // should have reached: a thousand-block burial takes minutes to parse, and
    // returning early is what turns this leg's later waits into timeouts that
    // read like protocol failures.
    const deadline = Date.now() + (timeoutMs || 300000)
    let last = null
    for (;;) {
        last = await indexerLag()
        if (Number.isFinite(last.lag) && last.lag <= 0) return last.indexerBlock
        if (Date.now() > deadline)
            throw new Error('indexer still ' + last.lag + ' blocks behind the chain (' +
                last.indexerBlock + '/' + last.decoderBlock + ') after mining ' + count)
        await new Promise(r => setTimeout(r, 5000))
    }
}

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

describe('XCHAIN price derivation from real fills (spec step 7)', function () {

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
        before(function () {
            // XCHAIN is BTC-only as a balance-bearing token; these legs make
            // XCHAIN trades and can only run on a BTC venue.
            if (COIN_CODE !== 'BTC') this.skip()
        })

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
                null, null, 'derived-price proof'
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

            // THIS dispense, by action index - not "every dispense fill in the
            // window". A 100000-block window on a venue that has run this suite
            // before also holds the earlier runs' dispenses at their own rates, so
            // the venue-wide filter made the assertion below pass only on a chain
            // this test had never touched, and fail on every rerun with a
            // clamped-VWAP number that looks like a derivation bug and is not.
            const mine = selection.fills.filter(f =>
                f.venue === 'dispense' && f.actionIndex === Number(dispenseRow['action_index']))
            assert.strictEqual(mine.length, 1,
                'exactly this dispense must be selected as a fill, got ' + mine.length)

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
        before(function () {
            // XCHAIN is BTC-only as a balance-bearing token; these legs make
            // XCHAIN trades and can only run on a BTC venue.
            if (COIN_CODE !== 'BTC') this.skip()
        })

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

            // CORRECTION 1: the fill is selected on the strength of the `coinpays`
            // row, never on the match's own status. A fully paid match is cleared to
            // 'valid' by the indexer's match-scoped status writer, and that clearing
            // is forward-only: a match settled before it holds 'pending_coinpay'
            // permanently. A selection keyed on the match status therefore drops
            // exactly the historical fills a price window depends on.
            assert(fill, 'a SETTLED coinpay fill must be selected on its coinpays row, whatever the match status')
            const matchStatus = await db.doQuery(
                `SELECT s.status, a.block_index FROM order_matches m
                   JOIN index_statuses s ON s.id = m.status_id
                   JOIN actions a ON a.action_index = m.action_index
                  WHERE m.action_index = ?`, [Number(orderMatch.action_index)])
            assert.strictEqual(String(matchStatus[0].status), 'valid',
                'a fully paid coinpay match is cleared to valid by the settling COINPAY')

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

    describe('hub-published pair (live validator venue)', function () {

        let venueReady = false

        before(async function () {
            if (COIN_CODE !== 'BTC') { this.skip(); return }
            // Venue probe, not a failure: a stack whose hub is not a
            // price-capability validator has no XCHAIN/USD snapshots and cannot
            // run this half of the proof.
            try {
                const rows = await hubPriceSnapshots()
                venueReady = pairRows(rows, 'XCHAIN/USD').length > 0
            } catch (e) {
                venueReady = false
            }
            if (!venueReady) {
                console.log('xchainPriceDerivation: hub is not publishing XCHAIN/USD on this venue; skipping hub-published legs')
                this.skip()
            }
        })

        it('restores the validator stake when the chain has lost it (env-gated venue op)', async function () {
            this.timeout(300000)
            // A destructive regtest reset wipes the chain but not the hub's
            // signing identity, so the stake that qualifies the price capability
            // must be re-created on the new chain. Pubkey comes from the operator
            // env because it is venue state, not repo state.
            const pubkey = process.env.XCHAIN_VALIDATOR_PUBKEY
            if (!pubkey) this.skip()

            // give-up-ok: an existence probe - empty means the stake is gone and
            // this venue op has work to do, which is the branch below.
            const existing = await indexerDatabase.waitForStake({
                signingPubkey: pubkey, status: 'valid'
            }, 5000).catch(() => null)
            if (existing) {
                console.log('validator stake already on-chain; nothing to restore')
                return
            }

            const staker = await cryptoHelper.getNewFundedAddress(
                'XCPRICE.VALSTAKE', COIN, NETWORK, null, 'legacy', 0, 1)
            // MAX_MINT caps a single MINT at 100000; mint once at the cap and
            // stake well above the price capability MIN_STAKE.
            await gasHelper.mintGas(staker, '100000')
            const res = await stakeHelper.sendStakeV1(staker, '50000', pubkey)
            assert(res.stake, 'validator stake should be re-created on the fresh chain')
        })

        it('supersedes the carry-forward with the exact volume-weighted value', async function () {
            // Budgeted for the burial, not for the assertions. Ageing a fill out of
            // a 1000-block window means mining ~1000 blocks AND waiting for the
            // indexer to parse them, and this venue parses at a couple of seconds a
            // block, so the burial alone can run past half an hour on a chain that
            // has not been buried before. A rerun on an already-buried venue skips
            // it entirely and the whole leg costs a few minutes.
            this.timeout(3600000)
            const db = queryAdapter(indexerDatabase)

            // 1. Age every pre-existing fill out of the derivation window, so the
            //    value under assertion is composed ONLY of the trades this test
            //    creates. This also proves the quiet-market branch on the way: an
            //    empty window must publish the carry-forward, unchanged, round
            //    after round. Mine only what burial actually needs, so a rerun on
            //    an already-buried venue costs seconds, not a thousand blocks.
            // The indexer may still be digesting blocks a previous run mined; a
            // tip read mid-digest under-counts and would over-mine. Blocks on
            // this venue appear only when something transacts, so a tip that
            // holds still across samples IS the chain tip.
            let tipNow = Number((await db.doQuery('SELECT MAX(block_index) AS h FROM blocks'))[0].h)
            for (;;) {
                await new Promise(r => setTimeout(r, 8000))
                const again = Number((await db.doQuery('SELECT MAX(block_index) AS h FROM blocks'))[0].h)
                if (again === tipNow) break
                tipNow = again
            }
            const lookback = await derivation.query.getWindowFills(db, {
                referenceHeight: tipNow, confirmationBuffer: 0, windowLength: tipNow,
                gasTick: GAS_TICK, coin: COIN_CODE
            })
            assert.strictEqual(lookback.ok, true, 'burial look-back must succeed: ' + lookback.error)
            const newestFill = lookback.fills.reduce((m, f) => Math.max(m, f.blockIndex), 0)
            const burialDeficit = (newestFill + WINDOW_BLOCKS + CONFIRMATION_BUFFER + 1) - tipNow
            // 3000s covers ~1000 blocks at this venue's parse rate with slack; the
            // wait is on the indexer reaching the chain, so a shorter budget just
            // returns early and moves the failure to an unrelated later assertion.
            if (burialDeficit > 0) await mineAndIndex(db, burialDeficit + 1, 3000000)

            // 2. Wait for two consecutive finalized rounds with the same value:
            //    that is the stabilized carry-forward CF.
            let cf = null
            let cfRound = null
            for (let tries = 0; tries < 12; tries++) {
                const rows = pairRows(await hubPriceSnapshots(), 'XCHAIN/USD')
                if (rows.length >= 2) {
                    const a = rows[rows.length - 2], b = rows[rows.length - 1]
                    if (a.price === b.price) { cf = b.price; cfRound = Number(b.round_number); break }
                }
                await new Promise(r => setTimeout(r, 15000))
            }
            assert(cf, 'the empty window must stabilize on a carry-forward value')
            console.log('carry-forward stabilized at ' + cf + ' (round ' + cfRound + ')')

            // 3. Price the drill trades IN BAND: within the winsorization band
            //    (2x either side of the reference) AND inside the 10%/round
            //    per-pair clamp, so the published value must equal the exact
            //    VWAP - a clamped or winsorized echo would fail the equality.
            const allRows = await hubPriceSnapshots()
            const btcUsdNow = pairRows(allRows, 'BTC/USD').slice(-1)[0]
            assert(btcUsdNow, 'venue must publish BTC/USD')
            // bcmath helpers return Decimal OBJECTS (spec §4). Everything below
            // hands these to string concatenation (the wire message) and to the
            // mariadb driver (the waitFor predicates), and the driver cannot
            // parameterize a Decimal - the coin-side ORDER wait times out against
            // a row that indexed valid. Render to fixed 8dp strings HERE, once.
            const rate1Btc = bcmath.bcformat(bcmath.bcdiv(bcmath.bcmul(cf, '1.04', 16), btcUsdNow.price, 8), 8)
            const rate2Btc = bcmath.bcformat(bcmath.bcdiv(bcmath.bcmul(cf, '0.97', 16), btcUsdNow.price, 8), 8)
            assert(bcmath.bcgt(rate1Btc, '0') && bcmath.bcgt(rate2Btc, '0'),
                'drill rates must be representable at 8dp; CF too small vs BTC/USD would be a venue defect')

            // 4a. Dispense leg: 30 XCHAIN realized at rate1Btc coin per XCHAIN.
            const seller = await cryptoHelper.getNewFundedAddress(
                'XCPRICE.SUP.DISP.SELLER', COIN, NETWORK, null, 'legacy', 0, 1)
            await gasHelper.mintGas(seller, '200')
            const disp = await dispenserHelper.sendDispenserV0(
                seller, COIN_CODE, GAS_TICK, 1, 30,
                COIN_CODE, null, Number(rate1Btc), seller['address'],
                null, null, null, null,
                null, null, 'supersession drill dispense')
            assert(disp.dispenser, 'drill dispenser should exist')

            const dispBuyer = await cryptoHelper.getNewFundedAddress(
                'XCPRICE.SUP.DISP.BUYER', COIN, NETWORK, null, 'legacy', 0, 1)
            const paySats = Number(bcmath.bcmul(rate1Btc, '30', 8)) * 1e8
            const dispTx = await transactionHelper.createSimpleTransaction(
                dispBuyer, seller['address'], Math.round(paySats))
            const dispRow = await indexerDatabase.waitForDispense({
                txHash: dispTx, giveCoin: COIN_CODE, giveTick: GAS_TICK,
                getCoin: COIN_CODE, status: 'valid'
            }, 120000)
            assert(dispRow, 'drill dispense should index valid')

            // 4b. DEX leg in the OPPOSITE orientation from the first DEX proof
            //     above: the coin-giving order is placed FIRST and its owner pays
            //     the COINPAY, so the match row holds the tick on the other side.
            //     50 XCHAIN realized at rate2Btc coin per XCHAIN.
            const dexBuyer = await cryptoHelper.getNewFundedAddress(
                'XCPRICE.SUP.DEX.BUYER', COIN, NETWORK, null, 'legacy', 0, 2)
            const dexSeller = await cryptoHelper.getNewFundedAddress(
                'XCPRICE.SUP.DEX.SELLER', COIN, NETWORK, null, 'legacy', 0, 2)
            await gasHelper.mintGas(dexSeller, '200')

            const clock = await db.doQuery('SELECT MAX(block_time) AS t FROM blocks')
            const expiration = Number(clock[0].t) + 86400
            const coinTotal = bcmath.bcformat(bcmath.bcmul(rate2Btc, '50', 8), 8)

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

            await coinpayHelper.sendCoinpayV0(
                dexBuyer, Number(match.action_index), dexSeller['address'],
                Math.round(Number(coinTotal) * 1e8))
            const paid = await indexerDatabase.waitForCoinpayObligation({
                actionIndex: Number(match.action_index), coinpayStatus: 'fulfilled'
            }, 60000)
            assert(paid, 'opposite-orientation COINPAY should fulfill')

            // 5. Clear the confirmation buffer, then freeze the tip. From here to
            //    the assertion no transactions are made, so no blocks are mined
            //    and every subsequent round derives over the identical window.
            const tip = await mineAndIndex(db, CONFIRMATION_BUFFER + 1, 120000)

            // 6. The frozen window must contain exactly the two drill fills, and
            //    the reproduction over them must not be winsorized (they were
            //    priced in band by construction).
            const selection = await derivation.query.getWindowFills(db, {
                referenceHeight: tip,
                confirmationBuffer: CONFIRMATION_BUFFER,
                windowLength: WINDOW_BLOCKS,
                gasTick: GAS_TICK,
                coin: COIN_CODE
            })
            assert.strictEqual(selection.ok, true, 'reproduction selection must succeed: ' + selection.error)
            assert.strictEqual(selection.fills.length, 2,
                'the frozen window must contain exactly the two drill fills, got ' + selection.fills.length)

            // 7. Assert per round, not on a stabilized value: BTC/USD is live and
            //    moves a little every round, so the published USD value never
            //    freezes - but every round must equal the reproduction of ITS OWN
            //    round from the hub's snapshot rows plus the production formula
            //    over the live DB. The first fresh round after the tip settles can
            //    legitimately disagree (the hub may have composed it against a
            //    tip the indexer had not finished serving), so keep evaluating
            //    rounds until one matches exactly.
            let matched = null
            let attempts = []
            const deadline = Date.now() + 420000
            while (!matched && Date.now() < deadline) {
                const rows = await hubPriceSnapshots()
                const fresh = pairRows(rows, 'XCHAIN/USD')
                    .filter(r => Number(r.round_number) > cfRound && r.price !== cf)
                for (const cand of fresh) {
                    const R = Number(cand.round_number)
                    if (attempts.some(a => a.round === R)) continue
                    const btcUsdR = pairRows(rows, 'BTC/USD').find(r => Number(r.round_number) === R)
                    const refXchain = lastBelow(rows, 'XCHAIN/USD', R)
                    const refBtc    = lastBelow(rows, 'BTC/USD', R)
                    if (!btcUsdR || !refXchain || !refBtc) continue
                    const refRate = derivation.price.referenceRateFromUsd(bcmath, refXchain.price, refBtc.price)
                    const derived = derivation.price.deriveXchainRate(bcmath, selection.fills, refRate)
                    if (!derived) continue
                    const expected = derivation.price.toUsd(bcmath, derived.rate, btcUsdR.price)
                    attempts.push({ round: R, published: cand.price, expected: expected,
                                    clamped: derived.clampedCount })
                    if (cand.price === expected && derived.clampedCount === 0) matched = attempts[attempts.length - 1]
                }
                if (!matched) await new Promise(r => setTimeout(r, 15000))
            }
            assert(matched,
                'no fresh round matched its own reproduction exactly; rounds seen: ' + JSON.stringify(attempts))
            console.log('supersession proven at round ' + matched.round + ': ' + cf + ' -> '
                + matched.published + ' == reproduction ' + matched.expected + ' (clamped=0)')
            assert.notStrictEqual(matched.published, cf,
                'supersession must move the pair off the carry-forward')
        })

    })

    // The two selection shapes the unit suite could only pin by asserting on the
    // text of the SQL, because regtest held zero rows of either (spec §10 step 1
    // residual, step 7 closes it). An exclusion nothing has ever exercised is the
    // kind that turns out to be inverted, and inverted here means pricing every
    // LTC/DOGE fee off trades that carry no XCHAIN/coin information at all.
    //
    // Neither of these needs the validator hub: they are properties of the
    // SELECTION, so they run on any venue with the sibling checkouts.
    describe('selection exclusions', function () {

        before(function () {
            // Same gate as the trade legs above: both exclusions need XCHAIN
            // trades to exclude, and XCHAIN is BTC-only as a balance-bearing token.
            if (COIN_CODE !== 'BTC') this.skip()
        })

        it('excludes a token-for-token dispense from the derivation', async function () {
            // Five minutes is not enough when this file's own supersession leg has
            // just mined a thousand burial blocks: these legs then wait on actions
            // sitting in blocks the indexer has not parsed yet, and the harness's
            // own "indexer is N blocks behind" extensions run out first. The
            // failure that produces is a bare mocha timeout that says nothing about
            // the exclusion under test.
            this.timeout(900000)
            const db = queryAdapter(indexerDatabase)

            // An XCHAIN dispenser PRICED IN A TOKEN is a real trade with no coin
            // leg, so it carries no price information for XCHAIN/BTC and must
            // never be selected. Until now this exclusion was held by
            // predicate-text assertions alone (spec step 1 residual).
            const seller = await cryptoHelper.getNewFundedAddress(
                'XCPRICE.T4T.SELLER', COIN, NETWORK, null, 'legacy', 0, 1)
            const buyer = await cryptoHelper.getNewFundedAddress(
                'XCPRICE.T4T.BUYER', COIN, NETWORK, null, 'legacy', 0, 1)
            await gasHelper.mintGas(seller, '200')
            await gasHelper.ensureGasBalance(buyer, '100')

            const payTick = 'XCPT4T' + seller['address'].substring(seller['address'].length - 6).toUpperCase()
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

            const tip = Number((await db.doQuery('SELECT MAX(block_index) AS h FROM actions'))[0].h)
            const selection = await derivation.query.getWindowFills(db, {
                referenceHeight: tip, confirmationBuffer: 0, windowLength: WINDOW_BLOCKS,
                gasTick: GAS_TICK, coin: COIN_CODE
            })
            assert.strictEqual(selection.ok, true, 'selection must succeed: ' + selection.error)
            assert.strictEqual(
                selection.fills.filter(f => f.actionIndex === Number(dispense.action_index)).length, 0,
                'a token-for-token dispense must never be selected as a price fill')
        })

        it('excludes cross-chain trades, at both layers that can carry one', async function () {
            this.timeout(900000)
            const db = queryAdapter(indexerDatabase)

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
            const otherCoin = (COIN_CODE === 'BTC') ? 'LTC' : 'BTC'

            const seller = await cryptoHelper.getNewFundedAddress(
                'XCPRICE.XCHAIN.SELLER', COIN, NETWORK, null, 'legacy', 0, 2)
            await gasHelper.mintGas(seller, '200')

            // (a) The dispenser layer: refused, so the exclusion has nothing to
            //     exclude there. Asserted as a REJECTED create rather than skipped,
            //     because "no rows of that shape exist" is only reassuring while the
            //     reason holds - if cross-chain dispensers are ever wired, this fails
            //     and the derivation's dispense predicate has to be re-examined
            //     before that ships.
            const rejected = await dispenserHelper.sendDispenserV0(
                seller, COIN_CODE, GAS_TICK, 1, 5,
                otherCoin, null, 0.05, seller['address'],
                null, null, null, null,
                null, null, 'cross-chain dispenser (must be refused)',
                null, null, 'invalid: GET_COIN (network)')
            assert(rejected.dispenser,
                'a cross-chain dispenser create must index, as INVALID')

            // (b) The order layer: a genuine cross-chain ORDER. It gives XCHAIN on
            //     this chain and asks for the OTHER chain's native coin, so its
            //     get_coin_id is a foreign coin id in this indexer's index_coins.
            const clock = await db.doQuery('SELECT MAX(block_time) AS t FROM blocks')
            const expiration = Number(clock[0].t) + 86400
            const crossOrder = await orderHelper.sendOrderV0(
                seller, COIN_CODE, GAS_TICK, '25',
                otherCoin, '', '0.001',
                seller['address'], expiration, '', '', 'cross-chain order')
            assert(crossOrder.order, 'the cross-chain ORDER must index valid')

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

            // The selection resolves ONE coin id and binds both sides of both
            // predicates to it, so a row whose two coin ids differ cannot satisfy
            // either. Assert the resolved id is this chain's and that nothing from
            // the cross-chain order reached the fills.
            const tip = Number((await db.doQuery('SELECT MAX(block_index) AS h FROM actions'))[0].h)
            const selection = await derivation.query.getWindowFills(db, {
                referenceHeight: tip, confirmationBuffer: 0, windowLength: WINDOW_BLOCKS,
                gasTick: GAS_TICK, coin: COIN_CODE
            })
            assert.strictEqual(selection.ok, true, 'selection must succeed: ' + selection.error)
            assert.strictEqual(Number(selection.coinId), Number(coinIds[0].give_coin_id),
                'the derivation must resolve THIS chain\'s coin id')
            assert.strictEqual(
                selection.fills.filter(f => f.actionIndex === Number(crossOrder.order['action_index'])).length, 0,
                'nothing from a cross-chain order may be selected as a price fill')

            // And the general shape, over the live rows rather than this one order:
            // no selected fill may come from a row whose two coin ids differ.
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
        })
    })

    describe('native-fee validation from the mirrored derived pair (non-BTC venue)', function () {

        before(function () {
            // This is the consumer end of the derivation: only LTC/DOGE pay fees in
            // native coin, so only they can prove the pair actually prices a fee.
            if (COIN_CODE === 'BTC') this.skip()

            // ...and only a venue that does NOT seed prices can prove it. Every leg
            // below reads the newest finalized XCHAIN/USD and requires it to be a hub
            // round rather than a fixture; on the ordinary venue the harness seeds
            // that pair for every fee-bearing action, at a synthetic round number
            // that outranks any round a hub will ever publish. So the pair is
            // shadowed before these tests start, through no fault of the code they
            // grade, and asserting it here reddens the gate for a venue setting.
            //
            // Declared with XCHAIN_E2E_NO_PRICE_SEED=1, which also requires a hub
            // publishing the pair itself, i.e. the validator venue. Skipping keeps
            // that coverage honest rather than optional: it is real coverage that
            // this venue cannot supply, and it is named here so it stays visible.
            if (!NO_PRICE_SEED) {
                console.log('xchainPriceDerivation: this venue seeds XCHAIN/USD, which shadows the ' +
                    'derived pair these legs verify; they need a no-seed validator venue ' +
                    '(XCHAIN_E2E_NO_PRICE_SEED=1). Skipping.')
                this.skip()
            }
        })

        it('prices and validates a fee-bearing action with NO seeded pair', async function () {
            this.timeout(300000)
            const db = queryAdapter(indexerDatabase)

            // Provenance first: the XCHAIN/USD this venue prices from must be a
            // MIRRORED finalized hub round (HubDbSync), not a seed. This leg
            // never calls the seeding helpers, and the transaction below opts out
            // of the harness's automatic fee injection because that path seeds.
            const mirrored = await db.doQuery(
                `SELECT round_number, price FROM price_snapshots
                  WHERE coin_pair = 'XCHAIN/USD' AND status = 'finalized'
                  ORDER BY round_number DESC LIMIT 1`)
            assert(mirrored.length, 'the indexer must hold a mirrored finalized XCHAIN/USD snapshot')

            // ...and it must be a HUB round, not a leftover seed. This is the
            // assertion that decides whether this leg proves anything: every
            // seeding helper in this repo writes a synthetic round number in the
            // 990000+ / 888100000+ space, getLatestPrice picks the HIGHEST
            // round_number, and a hub's counter is a small monotonic integer. So
            // one stale seed row from any earlier suite on the same venue outranks
            // every round the hub will ever publish, and the fee below would then
            // be priced off a fixture while the test reported success. Real rounds
            // sit far below the floor; anything at or above it is a fixture.
            //
            // Suppress the harness's own seeding for this venue with
            // XCHAIN_E2E_NO_PRICE_SEED=1 (nativeFeeHelper): it re-seeds from
            // getNativeFeeOutput() on a throttle, so even a leg that opts out of
            // fee injection can be overtaken mid-run by another action's seed.
            assert(Number(mirrored[0].round_number) < SEED_ROUND_FLOOR,
                'XCHAIN/USD newest round ' + mirrored[0].round_number + ' is a seeded fixture, not a hub ' +
                'round: the derived pair is shadowed, so this leg would prove nothing. Clear the seeded ' +
                'rows and re-run with XCHAIN_E2E_NO_PRICE_SEED=1')
            console.log('mirrored XCHAIN/USD round ' + mirrored[0].round_number + ' = ' + mirrored[0].price)

            const source = await cryptoHelper.getNewFundedAddress(
                'XCPRICE.NATFEE', COIN, NETWORK, null, 'legacy', 0, 2)
            const tick = 'XCPNF' + source['address'].substring(source['address'].length - 6).toUpperCase()
            const issueTail = '0|' + tick + '|1000|1000|0|native fee proof|100'

            // Quote through the production dry-run: the REAL handler priced at
            // the CURRENT mirrored oracle rows.
            const quote = await global.indexerConnector.call('feequote', {
                action: 'ISSUE',
                params: issueTail.split('|'),
                source: source['address']
            })
            assert(!quote.error, 'feequote must not error: ' + JSON.stringify(quote.error || null))
            assert(quote.feeDestination, 'feequote must name the fee destination')
            assert(Number(quote.requiredFeeSats) > 0,
                'an ISSUE on a native-fee chain must price a positive fee, got ' + JSON.stringify(quote))

            // Send the real action carrying exactly the quoted fee output, with
            // the harness's (seeding) auto-injection disabled.
            const txHash = await transactionHelper.createAndSendTransaction(
                source, 'ISSUE|' + issueTail, null,
                [{ address: quote.feeDestination, value: Number(quote.requiredFeeSats) }],
                null, null, true)

            const issueRow = await indexerDatabase.waitForIssue({
                txHash: txHash, tick: tick, status: 'valid'
            }, 120000)
            assert(issueRow,
                'the fee-bearing ISSUE must validate on-chain against the mirrored derived pair')
            console.log('native-fee ISSUE valid: tick ' + tick + ', fee ' + quote.requiredFeeNative
                + ' ' + COIN_CODE + ' priced from mirrored XCHAIN/USD ' + mirrored[0].price)
        })

        // The case above goes through `feequote`, which is the ADVISORY path and
        // anchors staleness on WALL CLOCK (`_priceFeeQuote` passes refTime =
        // nowEpoch, deliberately: a pre-flight is not tied to a future block).
        // That makes it unrunnable on any venue whose chain clock runs ahead of
        // real time - every hub round is then stamped in the future and the
        // time-keyed selection `block_timestamp <= nowEpoch` matches nothing,
        // which cost a session to diagnose.
        //
        // This case proves the same thing through the path that actually GATES
        // THE CHAIN: on-chain fee validation, anchored on the evaluated BLOCK's
        // time. It sizes the fee itself from the mirrored rows, so it holds on a
        // mock-time venue, and its real assertion is which round CONSENSUS used.
        it('validates a native fee priced off the derived pair via the CONSENSUS path (no feequote)', async function () {
            this.timeout(600000)
            const db = queryAdapter(indexerDatabase)

            // Newest finalized round per pair, and both must be real hub rounds.
            const rows = await db.doQuery(
                `SELECT coin_pair, round_number, price FROM price_snapshots
                  WHERE status = 'finalized' AND coin_pair IN (?, ?)
                    AND (coin_pair, round_number) IN (
                        SELECT coin_pair, MAX(round_number) FROM price_snapshots
                         WHERE status = 'finalized' GROUP BY coin_pair)`,
                ['XCHAIN/USD', COIN_CODE + '/USD'])
            assert.strictEqual(rows.length, 2, 'both pairs must be mirrored, got ' + JSON.stringify(rows))

            let xchainUsd = null, coinUsd = null, derivedRound = null
            for (const r of rows) {
                assert(Number(r.round_number) < SEED_ROUND_FLOOR,
                    r.coin_pair + ' newest round ' + r.round_number + ' is a SEEDED fixture, so this ' +
                    'proof would price off a fixture and mean nothing')
                if (r.coin_pair === 'XCHAIN/USD') { xchainUsd = String(r.price); derivedRound = Number(r.round_number) }
                else                              { coinUsd   = String(r.price) }
            }

            // ISSUE is 100,000 gas x GAS_PRICE 0.00001 = exactly 1.0 XCHAIN (§9 D2),
            // so expected native = XCHAIN/USD / COIN/USD. Pay 1.02x: the chain
            // rejects underpayment, and 2% clears 8dp rounding while staying well
            // inside the 1.10 tolerance ceiling.
            const expectedNative = Number(bcmath.bcformat(
                bcmath.bcdiv(xchainUsd, coinUsd, 8), 8))
            const feeSats = Math.round(expectedNative * 1.02 * 1e8)
            assert(feeSats > 0, 'the derived pair must price a positive fee, got ' + feeSats)

            const source = await cryptoHelper.getNewFundedAddress(
                'XCPRICE.CONSENSUSFEE', COIN, NETWORK, null, 'legacy', 0, 2)
            const tick = 'XCCF' + source['address'].substring(source['address'].length - 6).toUpperCase()
            // Same wire shape the other native-fee suites use, which is proven to
            // index on a fee chain.
            const message = 'ISSUE|0|' + tick + '|1000|1000|0|consensus fee proof|1000' +
                            '||||||||||||||||||'

            // discoverFeeMode reads the stack's real fee mode (env or the indexer
            // feeschedule) and does NOT seed; the seeding lives in
            // seedGlobalPrices/getNativeFeeOutput, which this file never calls.
            const mode = await require('../helpers/nativeFeeHelper').discoverFeeMode()
            assert(mode.enabled, 'this venue must be a native-fee chain to run this case')
            const feeDest = mode.destination
            assert(feeDest, 'a FEE_DESTINATION must be resolvable on a native-fee venue')

            const txHash = await transactionHelper.createAndSendTransaction(
                source, message, null, [{ address: feeDest, value: feeSats }],
                null, null, true)

            const issueRow = await indexerDatabase.waitForIssue({
                source: source['address'], tick: tick, txHash: txHash, status: 'valid'
            }, 180000)
            assert(issueRow, 'an ISSUE paid in native coin, priced off the mirrored derived pair, must be VALID')

            // The assertion that makes this airtight: consensus must have priced the
            // fee off a real hub round. A seed row would satisfy every assertion
            // above while proving nothing.
            const fee = await db.doQuery(
                `SELECT f.payment_mode, f.native_coin_amount, f.oracle_round
                   FROM fees f
                   JOIN actions a             ON a.action_index = f.action_index
                   JOIN transactions t        ON t.tx_index = a.tx_index
                   JOIN index_transactions it ON it.id = t.tx_hash_id
                  WHERE it.hash = ? LIMIT 1`, [txHash])
            assert(fee.length, 'the indexer must have written a fees row')
            assert.strictEqual(Number(fee[0].payment_mode), 1,
                'the fee must be recorded as native-coin (payment_mode=1)')
            assert(Number(fee[0].oracle_round) < SEED_ROUND_FLOOR,
                'consensus priced the fee off round ' + fee[0].oracle_round + ', a SEEDED fixture: the ' +
                'derived pair is shadowed and this proves nothing')
            console.log('CONSENSUS PROOF: payment_mode=' + fee[0].payment_mode +
                        ' native_coin_amount=' + fee[0].native_coin_amount +
                        ' oracle_round=' + fee[0].oracle_round +
                        ' (derived round ' + derivedRound + ' = ' + xchainUsd + ' USD)')
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
