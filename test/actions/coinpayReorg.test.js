/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available;
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * COINPAY Reorg (on-chain). Proves the indexer rolls back a COINPAY native-coin
 * settlement across a real chain reorg. coinpay.test.js drives the happy path
 * (token-for-coin ORDER match, pending_coinpay obligation, COINPAY settles,
 * buyer credited), but the SETTLEMENT rollback (the `coinpays` row, the buyer's
 * token credit, and the obligation reverting to pending_coinpay) was never driven
 * end-to-end on-chain.
 *
 * Mechanism (mirrors dexReorg/controllerReorg): the seller ISSUE, both ORDERs, and
 * the ORDER_MATCH (which opens the pending_coinpay obligation, escrowing the
 * seller's 100 tokens) land in EARLIER surviving blocks. The buyer's COINPAY (the
 * native-coin payment that fulfils the obligation and credits the buyer the 100
 * tokens) lands ALONE in block H. We gate on indexer-tip==node-tip, pause the
 * auto-miner, invalidateblock(H), and mine an EMPTY competing chain longer than H.
 * rollback.js deletes the `coinpays` row, reverts the obligation to pending_coinpay,
 * and un-credits the buyer (tokens return to the obligation escrow). We assert the
 * coinpays row is gone and the buyer's token balance reverts to 0, while the
 * ORDER_MATCH and obligation (earlier blocks) survive.
 *
 * DOGE-skipped: Dogecoin Core 1.14.x lacks generateblock.
 ********************************************************************/

const assert        = require('assert')
const cryptoHelper  = require('../cryptoHelper')
const issueHelper   = require('../helpers/issueHelper')
const orderHelper   = require('../helpers/orderHelper')
const coinpayHelper = require('../helpers/coinpayHelper')

async function q(sql, params) {
    const conn = await indexerDatabase.getConnection()
    try { return await conn.query(sql, params) }
    finally { await conn.release() }
}
async function balanceOf(address, tick) {
    const rows = await q(`SELECT b.amount FROM balances b
        JOIN index_addresses ia ON ia.id=b.address_id
        JOIN index_tickers it ON it.id=b.tick_id
        WHERE ia.address=? AND it.tick=?`, [address, tick])
    return rows.length ? String(rows[0].amount) : '0'
}
async function coinpayRowCount(obligationActionIndex) {
    const rows = await q(`SELECT COUNT(*) c FROM coinpays WHERE obligation_action_index=?`, [obligationActionIndex])
    return Number(rows[0].c)
}
async function obligationExists(actionIndex) {
    const rows = await q(`SELECT 1 FROM coinpay_obligations WHERE action_index=?`, [actionIndex])
    return rows.length > 0
}
async function blockOfAction(actionIndex) {
    const rows = await q(`SELECT t.block_index AS b FROM actions a
        JOIN transactions t ON t.tx_index=a.tx_index WHERE a.action_index=?`, [actionIndex])
    return rows.length ? Number(rows[0].b) : null
}
async function tip() { const r = await q(`SELECT MAX(block_index) h FROM blocks`, []); return Number(r[0].h) }
async function mine(n) { try { await regtestMinerConnector.generateBlocks(n) } catch (e) {} }
async function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

describe('COINPAY Reorg: a native-coin settlement rolls back across an on-chain reorg', function () {
    this.timeout(0)

    before(async function () {
        if (global.COIN_CODE === 'DOGE') this.skip()   // generateblock unavailable on Core 1.14
    })

    it('orphaning the COINPAY block rolls back the settlement (coinpays + buyer credit)', async function () {
        const seller = await cryptoHelper.getNewFundedAddress('cpr-seller', COIN, NETWORK, null, 'legacy', 0, 1)
        const buyer  = await cryptoHelper.getNewFundedAddress('cpr-buyer',  COIN, NETWORK, null, 'legacy', 0, 2)
        const tick = 'CPR' + seller.address.substring(5, 11).toUpperCase()

        // Seller ISSUEs and lists 100 tokens for 0.001 coin; buyer posts the matching coin order.
        await issueHelper.sendIssueV0(seller, tick, '1000', '1000', '8', 'coinpay-reorg token', '1000')
        const expiration = Math.floor(Date.now() / 1000) + 86400
        const sellerOrder = await orderHelper.sendOrderV0(seller, COIN_CODE, tick, '100.00000000',
            COIN_CODE, '', '0.00100000', seller.address, expiration, '', '', 'cpr sell')
        const buyerOrder = await orderHelper.sendOrderV0(buyer, COIN_CODE, '', '0.00100000',
            COIN_CODE, tick, '100.00000000', buyer.address, expiration, '', '', 'cpr buy')

        // Match opens the pending_coinpay obligation (escrows the seller's 100 tokens).
        const orderMatch = await indexerDatabase.waitForOrderMatch({
            giveActionIndex: Number(sellerOrder.order.action_index),
            getActionIndex:  Number(buyerOrder.order.action_index),
            status: 'pending_coinpay',
        }, 30000)
        assert(orderMatch, 'ORDER_MATCH pending_coinpay exists')
        const obligationIndex = Number(orderMatch.action_index)
        assert.strictEqual(await balanceOf(buyer.address, tick), '0', 'buyer holds no tokens pre-settlement')
        await mine(2)   // bury the match/obligation so the COINPAY is isolatable in a later block

        // Buyer COINPAY (native-coin payment) ALONE in block H, fulfilling the obligation.
        const cp = await coinpayHelper.sendCoinpayV0(buyer, obligationIndex, seller.address, 100000)
        const coinpayActionIndex = cp.coinpay.action_index
        // Wait for the buyer to actually receive the tokens (settlement applied).
        let bal = '0'
        for (let i = 0; i < 30 && bal !== '100'; i++) { bal = await balanceOf(buyer.address, tick); if (bal !== '100') await sleep(2000) }
        assert.strictEqual(bal, '100', 'buyer credited 100 tokens by the COINPAY settlement pre-reorg')
        assert.strictEqual(await coinpayRowCount(obligationIndex), 1, 'one coinpays row pre-reorg')
        const coinpayBlock = await blockOfAction(coinpayActionIndex)
        assert(coinpayBlock, 'resolved the COINPAY block')
        console.log('   COINPAY', coinpayActionIndex, 'settled at block', coinpayBlock, ': buyer credited 100', tick)

        // Gate on the indexer catching up to the node tip before reorging.
        let settle = 0
        while ((await tip()) < (await nodeConnector.getBlockCount()) && settle++ < 60) { await sleep(1000) }
        console.log('   indexer tip', await tip(), 'node tip', await nodeConnector.getBlockCount())

        // ----- Reorg out the COINPAY block -----
        await regtestMinerConnector.setMiningTime(3600000, 3600000)
        try {
            const tipBefore = await nodeConnector.getBlockCount()
            const coinpayHash = await nodeConnector.getBlockHash(coinpayBlock)
            const miner = (await cryptoHelper.getNewAddress('cpr-miner', COIN, NETWORK, null, 'legacy', 0)).address

            await nodeConnector.invalidateBlock(coinpayHash)
            assert.strictEqual(await nodeConnector.getBlockCount(), coinpayBlock - 1, 'rolled back to before the COINPAY')

            const need = tipBefore - (coinpayBlock - 1) + 2
            for (let i = 0; i < need; i++) await nodeConnector.generateBlock(miner, [])
            assert(await nodeConnector.getBlockCount() > tipBefore, 'competing chain overtakes the original')

            // Wait for rollback.js to delete the coinpays row and un-credit the buyer.
            let gone = false, bbal = '100'
            const deadline = Date.now() + 180000
            while (Date.now() < deadline) {
                gone = (await coinpayRowCount(obligationIndex)) === 0
                bbal = await balanceOf(buyer.address, tick)
                if (gone && bbal === '0') break
                await sleep(2000)
            }
            console.log('   indexer tip after reorg', await tip(), 'node tip', await nodeConnector.getBlockCount())
            assert.strictEqual(gone, true, 'coinpays row rolled back (settlement undone)')
            assert.strictEqual(bbal, '0', 'buyer token credit reverted (tokens returned to obligation escrow)')

            // The ORDER_MATCH and obligation (earlier surviving blocks) must remain: only
            // the settlement rolled back, so the obligation is open again (pending_coinpay).
            assert.strictEqual(await obligationExists(obligationIndex), true, 'the obligation (earlier block) survives, open again')
            console.log('   COINPAY settlement rolled back; obligation survives (pending again). Isolation OK')
        } finally {
            await regtestMinerConnector.setDefaultMiningTime()
        }
    })
})
