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
const issueHelper = require('../helpers/issueHelper')
const gasHelper = require('../helpers/gasHelper')
const nativeFeeHelper = require('../helpers/nativeFeeHelper')
const { BOOTSTRAP_XCHAIN_USD, NO_PRICE_SEED } = require('../helpers/xchainPriceConstants')

// Live-stack proof of native-coin USD-pegged fee payment, using the DISPENSER expiration fee
// (which, unlike the ISSUE issuance fee, is NOT gated behind the mainnet activation height
// 862633, so it actually charges on a low-height regtest chain).
//
// A DISPENSER with an expiration beyond the free-days window charges days * EXPIRATION_FEE_PER_DAY
// XCHAIN. We pay that fee with a native-coin output to FEE_DESTINATION instead of an XCHAIN balance,
// and assert the indexer records payment_mode=1 (native) with the oracle-derived amount.
//
// Single-host stack: the indexer reads price_snapshots from its OWN db, so we seed via
// global.indexerDatabase (the db getLatestPrice reads). FEE_DESTINATION is resolved via
// nativeFeeHelper.discoverFeeMode() (env override, then the indexer's feeschedule RPC);
// the old env-only reader permanently skipped this suite on normal LTC/DOGE stacks .
let FEE_DEST = null

async function q(sql, args){
    let conn = await indexerDatabase.getConnection()
    try { return await conn.query(sql, args) } finally { await conn.release() }
}

async function seedPrice(coinPair, price, referenceBlock, roundNumber){
    await q("DELETE FROM price_snapshots WHERE coin_pair = ?", [coinPair])
    // max(chain tip, wall clock) anchor; see nativeFeeLive.seedPrice (idle-chain
    // tip lag made a tip-only anchor stale beyond the 1800s cap, ).
    let rows = await q("SELECT block_time FROM blocks ORDER BY block_index DESC LIMIT 1")
    let nowSec = Math.floor(Date.now() / 1000)
    let chainNow = rows.length ? Math.max(Number(rows[0].block_time), nowSec) : nowSec
    await q(`INSERT INTO price_snapshots
               (round_number, coin_pair, price, reference_block, reference_chain,
                block_timestamp, validator_count, consensus_round, consensus_proof, status)
             VALUES (?, ?, ?, ?, 'BTC', ?, 1, 1, '[]', 'finalized')`,
            [roundNumber, coinPair, price, referenceBlock, chainNow - 60])
}

async function feeAndActions(txHash){
    let tx = await q("SELECT t.tx_index FROM transactions t JOIN index_transactions it ON it.id=t.tx_hash_id WHERE it.hash=?", [txHash])
    if (!tx.length) return { actions: [], fee: null }
    let actions = await q("SELECT action_index FROM actions WHERE tx_index=?", [tx[0].tx_index])
    let fee = null
    for (const a of actions) {
        let f = await q("SELECT payment_mode,native_coin,native_coin_amount,oracle_round FROM fees WHERE action_index=?", [a.action_index])
        if (f.length) fee = f[0]
    }
    return { actions, fee }
}

describe('Native-coin fee payment via DISPENSER expiration fee (live stack)', function () {
    before(async function () {
        //  step 8: fixture-priced suite; unrunnable where the hub publishes
        // the pair (the seed would shadow every derived round).
        if (NO_PRICE_SEED) this.skip()
        // Throws on LTC/DOGE when unresolvable; skips only on gas-mode stacks.
        const mode = await nativeFeeHelper.discoverFeeMode()
        if (!mode.enabled) this.skip()
        assert(mode.destination, 'native fees enabled but no FEE_DESTINATION resolvable')
        FEE_DEST = mode.destination
    })

    it('charges the expiration fee in native coin (payment_mode=1), no XCHAIN balance', async function () {
        let tip = Number((await q("SELECT MAX(block_index) AS h FROM blocks"))[0].h || 0)
        // XCHAIN $1.00; coin priced high so the native fee is a small sat amount.
        await seedPrice('XCHAIN/USD', BOOTSTRAP_XCHAIN_USD, tip, 999300001)
        await seedPrice(COIN_CODE + '/USD', '100000.00000000', tip, 999300002)

        // Fresh address: zero XCHAIN. Issuance is free at this height, so it gets the token but no GAS.
        let addr = await cryptoHelper.getNewFundedAddress("NATIVEFEE.DISP", COIN, NETWORK, null, "legacy", 0, 1)
        let address = addr["address"]
        let tick = "NFD" + address.substring(address.length - 8)
        // Fund XCHAIN for the ISSUE *setup* fee (issuance now charges a fee on regtest after F#1).
        // The DISPENSER's own expiration fee is still paid natively below; that's what we're verifying.
        await gasHelper.ensureGasBalance(addr, '100')
        await issueHelper.sendIssueV0(addr, tick, 1000, 1000, 0, "native fee dispenser test", 1000)

        // DISPENSER with a ~300-day expiration -> well past the free window -> charges an expiration fee.
        let expiration = Math.floor(Date.now() / 1000) + 300 * 86400
        let dispenserMessage = "DISPENSER|0"
            + "|" + COIN_CODE + "|" + tick + "|1||10"   // GIVE_COIN|GIVE_TICK|GIVE_AMOUNT|GIVE_OWNERSHIP|GIVE_ESCROW
            + "|" + COIN_CODE + "||5|" + address          // GET_COIN|GET_TICK|GET_AMOUNT|GET_ADDRESS
            + "|||"                                        // FIAT_CODE|FIAT_AMOUNT|ORACLE_ADDRESS
            + "|" + expiration + "|||native fee dispenser" // EXPIRATION|ALLOW_LIST|BLOCK_LIST|MEMO

        // Pay the fee natively: an output to FEE_DESTINATION (generous; only underpayment is rejected).
        let feeSats = 50000
        let txHash = await transactionHelper.createAndSendTransaction(
            addr, dispenserMessage, null, [{ address: FEE_DEST, value: feeSats }]
        )
        console.log("native-fee DISPENSER txHash:", txHash)

        let dispenserRow = await indexerDatabase.waitForDispenser({
            source: address, txHash: txHash, giveCoin: COIN_CODE, giveTick: tick,
            giveAmount: "1", giveEscrow: "10", getCoin: COIN_CODE, getTick: "",
            getAmount: "5", getAddress: address, fiatCode: "", fiatAmount: "",
            expiration: String(expiration), allowList: "", blockList: "",
            memo: "native fee dispenser", status: "valid"
        }, 90000)
        assert(dispenserRow, "DISPENSER paid with a native-coin fee should be VALID")

        let { actions, fee } = await feeAndActions(txHash)
        assert(fee, "a fee row should exist")
        assert.strictEqual(Number(fee.payment_mode), 1, "fee recorded as native-coin (payment_mode=1)")
        assert.strictEqual(fee.native_coin, COIN_CODE, "native_coin = chain coin")
        assert(fee.native_coin_amount && Number(fee.native_coin_amount) > 0, "native_coin_amount recorded")
        assert(fee.oracle_round != null, "oracle_round recorded")
        assert.strictEqual(actions.length, 1, "fee output must NOT spawn a second action")
        console.log("native-fee row:", JSON.stringify(fee, (k, v) => typeof v === 'bigint' ? Number(v) : v))
    })
})
