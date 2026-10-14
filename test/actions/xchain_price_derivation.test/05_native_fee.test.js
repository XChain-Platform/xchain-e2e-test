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
// XCHAIN price derivation, native-fee validation from the mirrored derived pair
// (non-BTC venue). This is the consumer end of the derivation: only LTC/DOGE
// pay fees in native coin, so only they can prove the pair actually prices a fee.

const assert = require('assert')
const cryptoHelper = require('../../helpers/core/cryptoHelper')
const transactionHelper = require('../../helpers/core/transactionHelper')
const { NO_PRICE_SEED } = require('../../helpers/xchainPriceConstants')
const venue = require('./helpers/venue.test')

const { COIN_CODE, SEED_ROUND_FLOOR } = venue

const tailOf = (addr) => addr['address'].substring(addr['address'].length - 6).toUpperCase()

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
function gateOnNoSeedVenue(suite) {
    if (COIN_CODE === 'BTC') suite.skip()
    if (NO_PRICE_SEED) return
    console.log('xchainPriceDerivation: this venue seeds XCHAIN/USD, which shadows the ' +
        'derived pair these legs verify; they need a no-seed validator venue ' +
        '(XCHAIN_E2E_NO_PRICE_SEED=1). Skipping.')
    suite.skip()
}

// Provenance first: the XCHAIN/USD this venue prices from must be a
// MIRRORED finalized hub round (HubDbSync), not a seed. This leg
// never calls the seeding helpers, and the transaction below opts out
// of the harness's automatic fee injection because that path seeds.
//
// ...and it must be a HUB round, not a leftover seed. This is the
// assertion that decides whether this leg proves anything: every
// seeding helper in this repo writes a synthetic round number in the
// 990000+ / 888100000+ space, getLatestPrice picks the HIGHEST
// round_number, and a hub's counter is a small monotonic integer. So
// one stale seed row from any earlier suite on the same venue outranks
// every round the hub will ever publish, and the fee below would then
// be priced off a fixture while the test reported success.
//
// Suppress the harness's own seeding for this venue with
// XCHAIN_E2E_NO_PRICE_SEED=1 (nativeFeeHelper): it re-seeds from
// getNativeFeeOutput() on a throttle, so even a leg that opts out of
// fee injection can be overtaken mid-run by another action's seed.
async function mirroredHubRound(db) {
    const mirrored = await db.doQuery(
        `SELECT round_number, price FROM price_snapshots
          WHERE coin_pair = 'XCHAIN/USD' AND status = 'finalized'
          ORDER BY round_number DESC LIMIT 1`)
    assert(mirrored.length, 'the indexer must hold a mirrored finalized XCHAIN/USD snapshot')
    assert(Number(mirrored[0].round_number) < SEED_ROUND_FLOOR,
        'XCHAIN/USD newest round ' + mirrored[0].round_number + ' is a seeded fixture, not a hub ' +
        'round: the derived pair is shadowed, so this leg would prove nothing. Clear the seeded ' +
        'rows and re-run with XCHAIN_E2E_NO_PRICE_SEED=1')
    console.log('mirrored XCHAIN/USD round ' + mirrored[0].round_number + ' = ' + mirrored[0].price)
    return mirrored[0]
}

// Quote through the production dry-run: the REAL handler priced at
// the CURRENT mirrored oracle rows.
async function quoteIssueFee(source, issueTail) {
    const quote = await global.indexerConnector.call('feequote', {
        action: 'ISSUE',
        params: issueTail.split('|'),
        source: source['address']
    })
    assert(!quote.error, 'feequote must not error: ' + JSON.stringify(quote.error || null))
    assert(quote.feeDestination, 'feequote must name the fee destination')
    assert(Number(quote.requiredFeeSats) > 0,
        'an ISSUE on a native-fee chain must price a positive fee, got ' + JSON.stringify(quote))
    return quote
}

// Send the real action carrying exactly the quoted fee output, with
// the harness's (seeding) auto-injection disabled.
async function provePricedByFeequote() {
    const db = venue.queryAdapter(indexerDatabase)
    const mirrored = await mirroredHubRound(db)

    const source = await cryptoHelper.getNewFundedAddress(
        'XCPRICE.NATFEE', COIN, NETWORK, null, 'legacy', 0, 2)
    const tick = 'XCPNF' + tailOf(source)
    const issueTail = '0|' + tick + '|1000|1000|0|native fee proof|100'
    const quote = await quoteIssueFee(source, issueTail)

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
        + ' ' + COIN_CODE + ' priced from mirrored XCHAIN/USD ' + mirrored.price)
}

// Newest finalized round per pair, and both must be real hub rounds.
async function newestPairRounds(db) {
    const rows = await db.doQuery(
        `SELECT coin_pair, round_number, price FROM price_snapshots
          WHERE status = 'finalized' AND coin_pair IN (?, ?)
            AND (coin_pair, round_number) IN (
                SELECT coin_pair, MAX(round_number) FROM price_snapshots
                 WHERE status = 'finalized' GROUP BY coin_pair)`,
        ['XCHAIN/USD', COIN_CODE + '/USD'])
    assert.strictEqual(rows.length, 2, 'both pairs must be mirrored, got ' + JSON.stringify(rows))

    const out = { xchainUsd: null, coinUsd: null, derivedRound: null }
    for (const r of rows) {
        assert(Number(r.round_number) < SEED_ROUND_FLOOR,
            r.coin_pair + ' newest round ' + r.round_number + ' is a SEEDED fixture, so this ' +
            'proof would price off a fixture and mean nothing')
        if (r.coin_pair === 'XCHAIN/USD') { out.xchainUsd = String(r.price); out.derivedRound = Number(r.round_number) }
        else                              { out.coinUsd = String(r.price) }
    }
    return out
}

// ISSUE is 100,000 gas x GAS_PRICE 0.00001 = exactly 1.0 XCHAIN (§9 D2),
// so expected native = XCHAIN/USD / COIN/USD. Pay 1.02x: the chain
// rejects underpayment, and 2% clears 8dp rounding while staying well
// inside the 1.10 tolerance ceiling.
function sizeFeeSats(ctx, pair) {
    const expectedNative = Number(ctx.bcmath.bcformat(
        ctx.bcmath.bcdiv(pair.xchainUsd, pair.coinUsd, 8), 8))
    const feeSats = Math.round(expectedNative * 1.02 * 1e8)
    assert(feeSats > 0, 'the derived pair must price a positive fee, got ' + feeSats)
    return feeSats
}

// discoverFeeMode reads the stack's real fee mode (env or the indexer
// feeschedule) and does NOT seed; the seeding lives in
// seedGlobalPrices/getNativeFeeOutput, which this file never calls.
async function sendConsensusFeeIssue(feeSats) {
    const source = await cryptoHelper.getNewFundedAddress(
        'XCPRICE.CONSENSUSFEE', COIN, NETWORK, null, 'legacy', 0, 2)
    const tick = 'XCCF' + tailOf(source)
    // Same wire shape the other native-fee suites use, which is proven to
    // index on a fee chain.
    const message = 'ISSUE|0|' + tick + '|1000|1000|0|consensus fee proof|1000' +
                    '||||||||||||||||||'
    const mode = await require('../../helpers/nativeFeeHelper').discoverFeeMode()
    assert(mode.enabled, 'this venue must be a native-fee chain to run this case')
    assert(mode.destination, 'a FEE_DESTINATION must be resolvable on a native-fee venue')

    const txHash = await transactionHelper.createAndSendTransaction(
        source, message, null, [{ address: mode.destination, value: feeSats }],
        null, null, true)
    const issueRow = await indexerDatabase.waitForIssue({
        source: source['address'], tick: tick, txHash: txHash, status: 'valid'
    }, 180000)
    assert(issueRow, 'an ISSUE paid in native coin, priced off the mirrored derived pair, must be VALID')
    return txHash
}

// The assertion that makes this airtight: consensus must have priced the
// fee off a real hub round. A seed row would satisfy every assertion
// above while proving nothing.
async function assertFeePricedOffHubRound(db, txHash, pair) {
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
                ' (derived round ' + pair.derivedRound + ' = ' + pair.xchainUsd + ' USD)')
}

async function proveConsensusPriced(ctx) {
    const db = venue.queryAdapter(indexerDatabase)
    const pair = await newestPairRounds(db)
    const txHash = await sendConsensusFeeIssue(sizeFeeSats(ctx, pair))
    await assertFeePricedOffHubRound(db, txHash, pair)
}

function registerNativeFee(ctx) {
    describe('native-fee validation from the mirrored derived pair (non-BTC venue)', function () {
        before(function () { gateOnNoSeedVenue(this) })

        it('prices and validates a fee-bearing action with NO seeded pair', async function () {
            this.timeout(300000)
            await provePricedByFeequote()
        })

        // The case above goes through `feequote`, which is the ADVISORY path and
        // anchors staleness on WALL CLOCK (`priceFeeQuote` passes refTime =
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
            await proveConsensusPriced(ctx)
        })
    })
}

module.exports = { registerNativeFee }
