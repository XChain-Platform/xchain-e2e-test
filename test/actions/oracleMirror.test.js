/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available:
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * The hub -> indexer MIRROR leg for PRICE v1 oracle quotes.
 *
 * Everything else in the FIAT dispenser suite proves SETTLEMENT: given a quote
 * the indexer can see, does reverseOraclePriceMatch credit the right amount.
 * Those cases seed the quote straight into the table settlement reads, so they
 * say nothing about how a real quote GETS there. In production it gets there by
 * replication: an on-chain PRICE v1 action is recorded by the indexer, pushed to
 * the hub, aggregated into the hub's oracle_prices, broadcast over the hub-db
 * WebSocket channel, and mirrored into each indexer's own copy by hub_db_sync.
 * This file drives that chain.
 *
 * WHY THIS IS ORACLE-ONLY, and not the validator snapshots Mode A reads: a
 * fixture can only exercise replication if the hub has a write path that
 * BROADCASTS, because an out-of-band row never propagates (HubDbBroadcaster fires
 * only from the hub's own writers, and the consumer's gap-detection catch-up
 * reads max_ids from the WebSocket `ready` handshake, so a row inserted behind
 * the hub's back lands at the next reconnect and not before). oracle_prices has
 * such a path, reachable over `pushoracleprice`. price_snapshots is broadcast
 * solely from OracleConsensus, i.e. a validator federation finalizing rounds,
 * which no regtest stack has. So Mode A's mirror leg needs a regtest federation
 * and is deliberately left unproven rather than faked.
 *
 * REQUIRES the mirror to actually be configured (HUB_DB_NAME +
 * HUB_DB_SYNC_ENABLED on the indexer, HUB_SOURCE_DB_NAME for the suite). On the
 * single-host stack there is no mirror leg to test and every case here skips,
 * which is why this file can land before the venue is flipped.
 ********************************************************************/

const assert            = require('assert')
const cryptoHelper      = require('../cryptoHelper')
const priceHelper       = require('../helpers/priceHelper')
const issueHelper       = require('../helpers/issueHelper')
const dispenserHelper   = require('../helpers/dispenserHelper')
const transactionHelper = require('../transactionHelper')
const priceSnapshotHelper = require('../helpers/priceSnapshotHelper')
const oraclePriceHelper   = require('../helpers/oraclePriceHelper')

describe('PRICE v1 hub -> indexer mirror', function () {
    this.timeout(0)

    // Its own fiat: every FIAT case prices in a currency no other
    // case or helper touches, so none of them can clear or reseed a pair another
    // is mid-way through using. MXN is unused elsewhere in the tree.
    const FIAT_MIRROR = 'MXN'

    // The mirror is the thing under test here, so unlike the settlement cases
    // this skips on its ABSENCE rather than on the price tables being unreachable.
    async function requireMirror(ctx){
        if (!oraclePriceHelper.seedsThroughMirror()){
            console.log('hub_db_sync mirror not configured (no HUB_SOURCE_DB_NAME + HUB_DB_NAME); '
                + 'skipping the mirror leg. This is the expected state on a single-host stack.')
            ctx.skip()
            return false
        }
        if (!(await oraclePriceHelper.isAvailable())){
            console.log('oracle_prices unreachable on one side of the mirror; skipping')
            ctx.skip()
            return false
        }
        return true
    }

    describe('replication of a real on-chain publish', function () {
        it('carries an on-chain PRICE v1 quote through the hub into the indexer mirror', async function () {
            if (!(await requireMirror(this))) return

            const addr = await cryptoHelper.getNewFundedAddress('PRICE.V1.MIRROR', COIN, NETWORK, null, 'legacy', 0, 1)
            const oracleAddress = addr['address']
            // Tick is derived from the address so a re-run never collides with a
            // previous run's quote for the same (address, coin, tick, fiat) key.
            const tick = 'MIRROR' + oracleAddress.substring(oracleAddress.length - 6)

            // Leg 1, on chain. price.test.js already pins the validation contract;
            // what matters here is only that a VALID row exists to be pushed.
            const res = await priceHelper.sendPriceV1(addr, {
                coin: COIN_CODE, tick: tick, fiat: FIAT_MIRROR,
                value: '2.50000000', fee: '0', memo: 'oracle mirror leg'
            })
            assert(res.price, 'PRICE v1 row should exist in the indexer')
            assert.strictEqual(res.price.validation_status, 'valid',
                'the published quote must be valid, or the indexer never pushes it')

            // Leg 2, indexer -> hub. Proven live under §11.7 once xchain-node
            // 336a7d5 supplied HUB_API_URL; asserted separately from leg 3 so a
            // failure says which half broke.
            const hubRow = await oraclePriceHelper.waitForHubRow({
                sourceAddress: oracleAddress, coin: COIN_CODE, tick: tick, fiat: FIAT_MIRROR
            })
            assert(hubRow, 'the quote should reach the hub oracle_prices')
            assert.strictEqual(String(hubRow.value), '2.50000000', 'the hub stored the published value')

            // The 24h activation delay (§5.4), observed rather than read. The hub
            // applies it unconditionally, first publish included, and it is what
            // makes the mirror a sound consensus barrier: every row lands in every
            // mirror long before any block is allowed to price against it.
            assert.strictEqual(Number(hubRow.effective_at) - Number(hubRow.block_time), 86400,
                'every publish is effective exactly 24h after its block_time')

            // Leg 3, hub -> mirror. The leg this suite exists for, and the one nothing
            // in this repo drove before.
            const mirrored = await oraclePriceHelper.waitForMirror({
                sourceAddress: oracleAddress, coin: COIN_CODE, tick: tick, fiat: FIAT_MIRROR
            })
            assert.strictEqual(mirrored.skipped, false,
                'the wait must have actually polled; a skip here means the topology reported no mirror')
            assert.strictEqual(mirrored.mirrored, true, 'the quote should reach the indexer mirror')
            console.log('oracle mirror: quote mirrored in ' + mirrored.waitedMs + 'ms')
        })
    })

    describe('settlement against a replicated quote', function () {
        it('settles a Mode 2 dispense from a quote that arrived by replication', async function () {
            if (!(await requireMirror(this))) return
            if (!(await priceSnapshotHelper.isAvailable())){
                console.log('price_snapshots unreachable; skipping')
                this.skip()
                return
            }

            const dispenserAddr = await cryptoHelper.getNewFundedAddress('DISP.MIRROR', COIN, NETWORK, null, 'legacy', 0, 1)
            const buyerAddr     = await cryptoHelper.getNewFundedAddress('DISP.MIRROR.BUYER', COIN, NETWORK, null, 'legacy', 0, 1)
            const oracleAddr    = await cryptoHelper.getNewFundedAddress('DISP.MIRROR.SRC', COIN, NETWORK, null, 'legacy', 0, 1)
            const dispenserAddress = dispenserAddr['address']
            const buyerAddress     = buyerAddr['address']
            const oracleAddress    = oracleAddr['address']
            const tick = 'DISPMIR' + dispenserAddress.substring(dispenserAddress.length - 7)

            await issueHelper.sendIssueV0(dispenserAddr, tick, 100, 100, 0, 'oracle mirror dispenser', 100)

            const expiration = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 90
            const pair       = COIN_CODE + '/' + FIAT_MIRROR
            const coinPrice  = 50000   // 1 coin = 50,000 fiat (validator)
            const tokenPrice = 100     // 1 token = 100 fiat   (user oracle)
            const chainNow   = await priceSnapshotHelper.latestBlockTime()

            // The validator leg is a local fixture by necessity (no federation on
            // regtest, see the file header). The ORACLE leg is the one under test
            // and travels the real path: seedQuote routes through the hub's
            // `pushoracleprice` whenever a mirror is in play, then waits for
            // hub_db_sync to carry the row down. The caller's contract is
            // unchanged, which is why the existing Mode 2 cases need no edit.
            await priceSnapshotHelper.clearPair(pair)
            await priceSnapshotHelper.seedSnapshot({
                coinPair: pair,
                price: coinPrice.toFixed(8),
                blockTimestamp: chainNow - 120,
                roundNumber: 999000708
            })
            await oraclePriceHelper.clearQuotes({
                sourceAddress: oracleAddress, coin: COIN_CODE, tick: tick, fiat: FIAT_MIRROR
            })
            await oraclePriceHelper.seedQuote({
                sourceAddress: oracleAddress, sourceChain: COIN_CODE,
                coin: COIN_CODE, tick: tick, fiat: FIAT_MIRROR,
                value: tokenPrice.toFixed(8), fee: '0',
                effectiveAt: chainNow - 60, actionIndex: 999000708
            })

            // Prove the quote is in the MIRROR specifically, not merely somewhere.
            // Without this the case could pass on a stale row and still be called
            // a replication test.
            const mirrored = await oraclePriceHelper.waitForMirror({
                sourceAddress: oracleAddress, coin: COIN_CODE, tick: tick,
                fiat: FIAT_MIRROR, actionIndex: 999000708
            })
            assert.strictEqual(mirrored.skipped, false, 'the quote must have travelled the mirror')

            const dispenserResult = await dispenserHelper.sendDispenserV0(
                dispenserAddr,
                COIN_CODE, tick, 1, 50,
                COIN_CODE, null, 0, dispenserAddress,
                FIAT_MIRROR, null, oracleAddress, expiration,
                null, null, 'mirrored oracle dispenser'
            )
            assert(dispenserResult.dispenser, 'the Mode 2 dispenser should be created')

            // tokens = (0.011 * 50000) / 100 = 5.5 => floor => 5
            const paySats = 1100000
            const txHash  = await transactionHelper.createSimpleTransaction(buyerAddr, dispenserAddress, paySats)

            const expectedUnits = Math.floor(((paySats / 1e8) * coinPrice) / tokenPrice)

            const dispenseRow = await indexerDatabase.waitForDispense({
                txHash: txHash, source: buyerAddress, giveTick: tick, status: 'valid'
            }, 60000)
            assert(dispenseRow, 'the dispense should settle valid against the mirrored quote')

            const credit = await indexerDatabase.waitForCredit({
                address: buyerAddress, tick: tick, amount: String(expectedUnits)
            }, 30000)
            assert(credit, 'buyer should be credited ' + expectedUnits + ' tokens via the mirrored quote')
        })
    })
})
