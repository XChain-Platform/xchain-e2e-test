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
 * PRICE v1 Reorg (on-chain): proves the indexer rolls back a published
 * permissionless oracle quote across a real chain reorg. price.test.js drives
 * the v1 validation contract under normal conditions, but the `prices` rollback
 * was never driven end-to-end on-chain. The indexer's rollback.js lists `prices`
 * among the block-scoped tables it deletes; this drill exercises that path.
 *
 * Mechanism (mirrors dexReorg/controllerReorg/nftReorg): the funding lands in
 * EARLIER surviving blocks; a valid PRICE v1 lands ALONE in block H. We gate on
 * indexer-tip==node-tip, pause the auto-miner, invalidateblock(H), and mine an
 * EMPTY competing chain longer than H. The node reorgs; rollback.js deletes the
 * block-scoped `prices` row. We assert the quote is gone after the reorg.
 *
 * DOGE-skipped: Dogecoin Core 1.14.x lacks generateblock.
 ********************************************************************/

const assert       = require('assert')
const cryptoHelper = require('../cryptoHelper')
const priceHelper  = require('../helpers/priceHelper')

async function q(sql, params) {
    const conn = await indexerDatabase.getConnection()
    try { return await conn.query(sql, params) }
    finally { await conn.release() }
}
async function priceRow(actionIndex) {
    const rows = await q(`SELECT p.action_index, p.validation_status, ist.status
        FROM prices p LEFT JOIN index_statuses ist ON ist.id=p.status_id
        WHERE p.action_index=? LIMIT 1`, [actionIndex])
    return rows.length ? rows[0] : null
}
async function priceCount(tick) {
    const rows = await q(`SELECT COUNT(*) c FROM prices p
        JOIN index_tickers it ON it.id=p.tick_id WHERE it.tick=?`, [tick])
    return Number(rows[0].c)
}
async function blockOfAction(actionIndex) {
    const rows = await q(`SELECT t.block_index AS b FROM actions a
        JOIN transactions t ON t.tx_index=a.tx_index WHERE a.action_index=?`, [actionIndex])
    return rows.length ? Number(rows[0].b) : null
}
async function tip() { const r = await q(`SELECT MAX(block_index) h FROM blocks`, []); return Number(r[0].h) }
async function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }
function randTick(p) { let s = p; for (let i = 0; i < 6; i++) s += String.fromCharCode(65 + Math.floor(Math.random() * 26)); return s }

describe('PRICE v1 Reorg: a published oracle quote rolls back across an on-chain reorg', function () {
    this.timeout(0)

    before(async function () {
        if (global.COIN_CODE === 'DOGE') this.skip()   // generateblock unavailable on Core 1.14
    })

    it('orphaning the PRICE block rolls back the prices row', async function () {
        const addr = await cryptoHelper.getNewFundedAddress('pricer-pub', COIN, NETWORK, null, 'legacy', 0, 2)
        const tick = randTick('PRICER')

        // Publish a valid PRICE v1 quote; it lands in its own block H.
        const res = await priceHelper.sendPriceV1(addr, {
            coin: COIN_CODE, tick: tick, fiat: 'USD', value: '2.50000000', fee: '0.01', memo: 'reorg quote'
        })
        const priceActionIndex = res.price.action_index
        assert(priceActionIndex !== undefined && priceActionIndex !== null, 'price has an action_index')

        // Pre-reorg: the quote is recorded valid.
        let row = await priceRow(priceActionIndex)
        assert(row, 'price row exists pre-reorg')
        assert.strictEqual(row.validation_status, 'valid', 'quote is valid pre-reorg')
        const priceBlock = await blockOfAction(priceActionIndex)
        assert(priceBlock, 'resolved the PRICE block')
        console.log('   PRICE', priceActionIndex, tick + '/USD=2.5 valid at block', priceBlock)

        // Gate on the indexer catching up to the node tip before reorging.
        let settle = 0
        while ((await tip()) < (await nodeConnector.getBlockCount()) && settle++ < 60) { await sleep(1000) }
        console.log('   indexer tip', await tip(), 'node tip', await nodeConnector.getBlockCount())

        // -- Reorg out the PRICE block --
        await regtestMinerConnector.pauseMining()
        try {
            const tipBefore = await nodeConnector.getBlockCount()
            const priceHash = await nodeConnector.getBlockHash(priceBlock)
            const miner = (await cryptoHelper.getNewAddress('pricer-miner', COIN, NETWORK, null, 'legacy', 0)).address

            await nodeConnector.invalidateBlock(priceHash)
            assert.strictEqual(await nodeConnector.getBlockCount(), priceBlock - 1, 'rolled back to before the PRICE')

            const need = tipBefore - (priceBlock - 1) + 2
            for (let i = 0; i < need; i++) await nodeConnector.generateBlock(miner, [])
            assert(await nodeConnector.getBlockCount() > tipBefore, 'competing chain overtakes the original')

            // Wait for rollback.js to delete the block-scoped prices row.
            let gone = false
            const deadline = Date.now() + 180000
            while (Date.now() < deadline) {
                gone = (await priceRow(priceActionIndex)) === null
                if (gone) break
                await sleep(2000)
            }
            console.log('   indexer tip after reorg', await tip(), 'node tip', await nodeConnector.getBlockCount())
            assert.strictEqual(gone, true, 'prices row rolled back (quote gone)')
            assert.strictEqual(await priceCount(tick), 0, 'no price row remains for the tick')
            console.log('   PRICE v1 rolled back on reorg: isolation OK')
        } finally {
            await regtestMinerConnector.resumeMining()
        }
    })
})
