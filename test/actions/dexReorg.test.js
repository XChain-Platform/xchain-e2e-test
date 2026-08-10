/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available:
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * DEX Reorg (on-chain): proves the indexer rolls back an open ORDER (and the
 * GIVE-side escrow it created) across a real chain reorg. order.test.js drives
 * create/cancel/match/expire under normal conditions, but the `orders` rollback
 * AND the escrow-release (give amount debited back into the maker's balance) was
 * never driven end-to-end on-chain. An open order escrows its give amount (the
 * maker's balance is debited); orphaning the ORDER must both delete the `orders`
 * row and credit the escrowed amount back.
 *
 * Mechanism (mirrors controllerReorg/contractStakeReorg/nftReorg): the ISSUE +
 * gas MINT land in EARLIER surviving blocks; the ORDER (give 30 TOKEN for 15
 * XCHAIN, no counter-order so it stays open) lands ALONE in block H. We gate on
 * indexer-tip==node-tip, pause the auto-miner, invalidateblock(H), and mine an
 * EMPTY competing chain longer than H. The node reorgs; rollback.js deletes the
 * block-scoped `orders` row and releases the escrow. We assert the order is gone
 * and the maker's TOKEN balance is restored to the full minted amount.
 *
 * DOGE-skipped: Dogecoin Core 1.14.x lacks generateblock.
 ********************************************************************/

const assert       = require('assert')
const cryptoHelper = require('../cryptoHelper')
const issueHelper  = require('../helpers/issueHelper')
const gasHelper    = require('../helpers/gasHelper')
const orderHelper  = require('../helpers/orderHelper')

async function q(sql, params) {
    const conn = await indexerDatabase.getConnection()
    try { return await conn.query(sql, params) }
    finally { await conn.release() }
}
async function orderRow(actionIndex) {
    const rows = await q(`SELECT o.action_index, ist.status
        FROM orders o LEFT JOIN index_statuses ist ON ist.id=o.status_id
        WHERE o.action_index=? LIMIT 1`, [actionIndex])
    return rows.length ? rows[0] : null
}
async function blockOfAction(actionIndex) {
    const rows = await q(`SELECT t.block_index AS b FROM actions a
        JOIN transactions t ON t.tx_index=a.tx_index WHERE a.action_index=?`, [actionIndex])
    return rows.length ? Number(rows[0].b) : null
}
async function orderCount(tick) {
    const rows = await q(`SELECT COUNT(*) c FROM orders o
        JOIN index_tickers it ON it.id=o.give_tick_id
        WHERE it.tick=?`, [tick])
    return Number(rows[0].c)
}
async function balanceOf(address, tick) {
    const rows = await q(`SELECT b.amount FROM balances b
        JOIN index_addresses ia ON ia.id=b.address_id
        JOIN index_tickers it ON it.id=b.tick_id
        WHERE ia.address=? AND it.tick=?`, [address, tick])
    return rows.length ? String(rows[0].amount) : '0'
}
async function tip() { const r = await q(`SELECT MAX(block_index) h FROM blocks`, []); return Number(r[0].h) }
async function mine(n) { try { await regtestMinerConnector.generateBlocks(n) } catch (e) {} }
async function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }
function randTick(p) { let s = p; for (let i = 0; i < 6; i++) s += String.fromCharCode(65 + Math.floor(Math.random() * 26)); return s }

describe('DEX Reorg: an open ORDER (and its escrow) rolls back across an on-chain reorg', function () {
    this.timeout(0)

    before(async function () {
        if (global.COIN_CODE === 'DOGE') this.skip()   // generateblock unavailable on Core 1.14
    })

    it('orphaning the ORDER block rolls back the order and releases the escrow', async function () {
        const maker = await cryptoHelper.getNewFundedAddress('dexr-maker', COIN, NETWORK, null, 'legacy', 0, 2)
        await gasHelper.ensureGasBalance(maker, '2000')
        const tick = randTick('DEXR')

        // ISSUE (mint 100 to maker) in an EARLIER block, then bury it.
        await issueHelper.sendIssueV0(maker, tick, '100', '0', '0', 'dex-reorg give token', '100')
        assert.strictEqual(await balanceOf(maker.address, tick), '100', 'maker holds the full mint pre-order')
        await mine(2)

        // ORDER: give 30 TOKEN for 15 XCHAIN (no counter-order → stays open). Escrows 30.
        const expiration = Math.floor(Date.now() / 1000) + 90 * 86400
        const res = await orderHelper.sendOrderV0(maker, COIN_CODE, tick, 30, COIN_CODE, 'XCHAIN', 15,
            maker.address, expiration, null, null, 'dex-reorg order')
        const orderActionIndex = res.order.action_index
        assert(orderActionIndex !== undefined && orderActionIndex !== null, 'order has an action_index')

        // Pre-reorg: the order is live and the give amount is escrowed (balance debited
        // 100 -> 70). The escrow debit is the authoritative "open & holding" signal; the
        // status string is logged for context (not asserted: its exact value varies).
        let ord = await orderRow(orderActionIndex)
        assert(ord, 'order row exists pre-reorg')
        console.log('   order status =', ord.status)
        assert.strictEqual(await balanceOf(maker.address, tick), '70', 'give amount escrowed (balance debited 30)')
        const orderBlock = await blockOfAction(orderActionIndex)
        assert(orderBlock, 'resolved the ORDER block')
        console.log('   order', orderActionIndex, 'open at block', orderBlock, ': 30', tick, 'escrowed')

        // Gate on the indexer catching up to the node tip before reorging.
        let settle = 0
        while ((await tip()) < (await nodeConnector.getBlockCount()) && settle++ < 60) { await sleep(1000) }
        console.log('   indexer tip', await tip(), 'node tip', await nodeConnector.getBlockCount())

        // ── Reorg out the ORDER block ──
        await regtestMinerConnector.pauseMining()
        try {
            const tipBefore = await nodeConnector.getBlockCount()
            const orderHash = await nodeConnector.getBlockHash(orderBlock)
            const miner = (await cryptoHelper.getNewAddress('dexr-miner', COIN, NETWORK, null, 'legacy', 0)).address

            await nodeConnector.invalidateBlock(orderHash)
            assert.strictEqual(await nodeConnector.getBlockCount(), orderBlock - 1, 'rolled back to before the ORDER')

            const need = tipBefore - (orderBlock - 1) + 2
            for (let i = 0; i < need; i++) await nodeConnector.generateBlock(miner, [])
            assert(await nodeConnector.getBlockCount() > tipBefore, 'competing chain overtakes the original')

            // Wait for rollback.js to delete the block-scoped order + release the escrow.
            let gone = false, bal = '70'
            const deadline = Date.now() + 180000
            while (Date.now() < deadline) {
                gone = (await orderRow(orderActionIndex)) === null
                bal  = await balanceOf(maker.address, tick)
                if (gone && bal === '100') break
                await sleep(2000)
            }
            console.log('   indexer tip after reorg', await tip(), 'node tip', await nodeConnector.getBlockCount())
            assert.strictEqual(gone, true, 'orders row rolled back (order gone)')
            assert.strictEqual(await orderCount(tick), 0, 'no order row remains for the tick')
            assert.strictEqual(bal, '100', 'escrow released: maker balance restored to the full mint')
            console.log('   ORDER rolled back + escrow released (balance 70 -> 100): isolation OK')
        } finally {
            await regtestMinerConnector.resumeMining()
        }
    })
})
