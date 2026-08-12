// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const assert = require('assert')
const cryptoHelper = require('../cryptoHelper')
const transactionHelper = require('../transactionHelper')
const nativeFeeHelper = require('../helpers/nativeFeeHelper')
const { BOOTSTRAP_XCHAIN_USD, NO_PRICE_SEED } = require('../helpers/xchainPriceConstants')

// Live-stack proof of native-coin USD-pegged fee payment.
//
// This single-host regtest stack has no HUB_DB_* wiring, so the indexer reads price_snapshots from
// its OWN database (the one global.indexerDatabase connects to). We therefore seed prices directly
// through indexerDatabase (the exact DB getLatestPrice reads) rather than the hub-DB helper.
//
// The fee destination must match what the decoder/indexer were configured with.
// Resolved via nativeFeeHelper.discoverFeeMode(): env override first
// (XCHAIN_FEE_DESTINATION_<CODE>_<NET> / FEE_DESTINATION), then the live
// indexer's `feeschedule` RPC. The old env-only reader (which also built the
// key from the lowercase COIN name) returned null on every normal LTC/DOGE
// stack and permanently skipped this suite; discovery throws loudly
// on a fee chain it can't resolve, so a skip now only happens on genuinely
// gas-mode stacks (BTC without native fees).
let FEE_DEST = null

async function q(sql, args){
    let conn = await indexerDatabase.getConnection()
    try { return await conn.query(sql, args) } finally { await conn.release() }
}

async function seedPrice(coinPair, price, referenceBlock, roundNumber){
    let conn = await indexerDatabase.getConnection()
    try {
        await conn.query("DELETE FROM price_snapshots WHERE coin_pair = ?", [coinPair])
        // Anchor block_timestamp to max(chain tip, wall clock), mirroring
        // nativeFeeHelper.seedGlobalPrices: under sustained mining the tip can
        // drift AHEAD of wall time (tip wins), but on an IDLE chain the tip
        // lags wall clock and the action mines into a block timestamped ~now,
        // so a tip-only anchor is instantly stale beyond the 1800s cap (this
        // was the first-run "no current oracle price" failure).
        let rows = await conn.query("SELECT block_time FROM blocks ORDER BY block_index DESC LIMIT 1")
        let nowSec = Math.floor(Date.now() / 1000)
        let chainNow = rows.length ? Math.max(Number(rows[0].block_time), nowSec) : nowSec
        await conn.query(
            `INSERT INTO price_snapshots
               (round_number, coin_pair, price, reference_block, reference_chain,
                block_timestamp, validator_count, consensus_round, consensus_proof, status)
             VALUES (?, ?, ?, ?, 'BTC', ?, 1, 1, '[]', 'finalized')`,
            [roundNumber, coinPair, price, referenceBlock, chainNow - 60]
        )
    } finally { await conn.release() }
}

async function feeRow(txHash){
    let conn = await indexerDatabase.getConnection()
    try {
        let rows = await conn.query(
            `SELECT f.payment_mode, f.native_coin, f.native_coin_amount, f.oracle_round
               FROM fees f
               JOIN actions a            ON a.action_index = f.action_index
               JOIN transactions t       ON t.tx_index = a.tx_index
               JOIN index_transactions it ON it.id = t.tx_hash_id
              WHERE it.hash = ? LIMIT 1`, [txHash])
        return rows && rows[0] ? rows[0] : null
    } finally { await conn.release() }
}

async function actionCount(txHash){
    let conn = await indexerDatabase.getConnection()
    try {
        let rows = await conn.query(
            `SELECT COUNT(*) AS n FROM actions a
               JOIN transactions t        ON t.tx_index = a.tx_index
               JOIN index_transactions it ON it.id = t.tx_hash_id
              WHERE it.hash = ?`, [txHash])
        return Number(rows[0].n)
    } finally { await conn.release() }
}

function issueMessage(tick){
    return "ISSUE|0|" + tick + "|1000|1000|0|native fee live test|1000" + "||||||||||||||||||"
}

describe('Native-coin fee payment (live stack)', function () {
    before(async function () {
        // This suite seeds the pair and computes its expected fees
        // FROM the fixture prices, so on a venue whose hub publishes the pair the
        // seed would shadow every derived round. Not runnable there; the
        // derivation suite owns native-fee proof on publishing venues.
        if (NO_PRICE_SEED) this.skip()
        // Throws on LTC/DOGE when unresolvable (loud failure beats a silent
        // permanent skip on the very chains this suite targets).
        const mode = await nativeFeeHelper.discoverFeeMode()
        if (!mode.enabled) this.skip()
        assert(mode.destination, 'native fees enabled but no FEE_DESTINATION resolvable')
        FEE_DEST = mode.destination
    })

    it('accepts an ISSUE whose fee is paid in native coin, with NO XCHAIN balance', async function () {
        // Seed XCHAIN $1.00 and a high coin price so the native fee is a tiny sat amount.
        // reference_block is the current indexer tip; the ISSUE lands in a later block.
        let tip = Number((await (async () => {
            let c = await indexerDatabase.getConnection()
            try { let r = await c.query("SELECT MAX(block_index) AS h FROM blocks"); return (r[0].h || 0) } finally { await c.release() }
        })()))
        await seedPrice('XCHAIN/USD', BOOTSTRAP_XCHAIN_USD, tip, 999200001)
        await seedPrice(COIN_CODE + '/USD', '100000.00000000', tip, 999200002)

        // Fresh address: ZERO XCHAIN, so the ISSUE can ONLY be valid via native-coin fee detection.
        let addr = await cryptoHelper.getNewFundedAddress("NATIVEFEE.LIVE", COIN, NETWORK, null, "legacy", 0, 1)
        let address = addr["address"]
        let tick = "NFL" + address.substring(address.length - 8)

        // Generous fee output (overpayment is always accepted; only underpayment is rejected).
        let feeSats = 50000
        let txHash = await transactionHelper.createAndSendTransaction(
            addr, issueMessage(tick), null, [{ address: FEE_DEST, value: feeSats }]
        )
        console.log("native-fee ISSUE txHash:", txHash)

        let issueRow = await indexerDatabase.waitForIssue({
            source: address, tick: tick, txHash: txHash, status: "valid"
        }, 90000)
        assert(issueRow, "ISSUE paid with a native-coin fee should be VALID")

        let fee = await feeRow(txHash)
        assert(fee, "a fee row should exist")
        assert.strictEqual(Number(fee.payment_mode), 1, "fee recorded as native-coin (payment_mode=1)")
        assert.strictEqual(fee.native_coin, COIN_CODE, "native_coin = chain coin")
        assert(fee.native_coin_amount, "native_coin_amount recorded")
        assert(fee.oracle_round != null, "oracle_round recorded")

        assert.strictEqual(await actionCount(txHash), 1, "fee output must NOT spawn a second action")
        console.log("native-fee row:", JSON.stringify(fee, (k, v) => typeof v === 'bigint' ? Number(v) : v))
    })

    it('rejects an ISSUE with NO fee output and NO XCHAIN balance (fee unpaid)', async function () {
        let tip = Number((await q("SELECT MAX(block_index) AS h FROM blocks"))[0].h || 0)
        await seedPrice('XCHAIN/USD', BOOTSTRAP_XCHAIN_USD, tip, 999200011)
        await seedPrice(COIN_CODE + '/USD', '100000.00000000', tip, 999200012)

        // seedGas=false: this case asserts the no-fee-output, no-XCHAIN-balance path.
        let addr = await cryptoHelper.getNewFundedAddress("NATIVEFEE.NEG", COIN, NETWORK, null, "legacy", 0, 1, false)
        let address = addr["address"]
        let tick = "NFN" + address.substring(address.length - 8)

        // No fee output, no XCHAIN balance -> the issuance fee cannot be paid -> invalid.
        // Opt out of the harness's native-fee injection (last arg) so this path
        // truly sends a tx with NO fee output. The rejection differs by chain:
        // BTC falls back to XCHAIN-balance deduction ("insufficient funds (FEE)"),
        // LTC/DOGE require a native fee output ("native coin output required").
        let txHash = await transactionHelper.createAndSendTransaction(addr, issueMessage(tick), null, [], null, null, true)
        let expectedStatus = (COIN_CODE === 'LTC' || COIN_CODE === 'DOGE')
            ? "invalid: insufficient fee (native coin output required)"
            : "invalid: insufficient funds (FEE)"
        let invalid = await indexerDatabase.waitForIssue({
            source: address, tick: tick, txHash: txHash, status: expectedStatus
        }, 90000)
        assert(invalid, "ISSUE with no fee output and no XCHAIN should be INVALID")
        console.log("negative case: ISSUE correctly rejected (fee unpaid)")
    })
})
