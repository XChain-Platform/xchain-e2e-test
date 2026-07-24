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
 * NFT Reorg (on-chain): proves the indexer rolls back a collection CHILD
 * issuance across a real chain reorg while the parent (in an earlier surviving
 * block) remains. NFTs are a composition of ISSUE (NFT_Standard.md); the
 * `tokens`/`issues`/`balances` rollback for a child sub-TICK was never driven
 * end-to-end on-chain for the collection-provenance path.
 *
 * Mechanism (mirrors vmContractReorg/controllerReorg/contractStakeReorg): the
 * parent ISSUE lands in an EARLIER surviving block; the CHILD ISSUE (PARENT.ITEM)
 * lands ALONE in block H. We gate on indexer-tip==node-tip, then pause the
 * auto-miner, invalidateblock(H), and mine an EMPTY competing chain longer than H
 * (mempool ignored, so the orphaned CHILD tx is NOT re-included). The node reorgs;
 * decoder + indexer follow and rollback.js deletes the block-scoped child token.
 * We assert the child token is gone (and the issuer's child balance reverts) while
 * the parent token survives.
 *
 * DOGE-skipped: Dogecoin Core 1.14.x lacks generateblock (the rollback path is
 * chain-agnostic, operating on DB rows by block_index; proven on BTC/LTC).
 ********************************************************************/

const assert            = require('assert')
const cryptoHelper      = require('../cryptoHelper')
const issueHelper       = require('../helpers/issueHelper')
const transactionHelper = require('../transactionHelper')

async function q(sql, params) {
    const conn = await indexerDatabase.getConnection()
    try { return await conn.query(sql, params) }
    finally { await conn.release() }
}
async function tokenExists(tick) {
    const rows = await q(`SELECT 1 FROM tokens t JOIN index_tickers it ON it.id=t.tick_id WHERE it.tick=?`, [tick])
    return rows.length > 0
}
async function balanceOf(address, tick) {
    const rows = await q(`SELECT b.amount FROM balances b
        JOIN index_addresses ia ON ia.id=b.address_id
        JOIN index_tickers it ON it.id=b.tick_id
        WHERE ia.address=? AND it.tick=?`, [address, tick])
    return rows.length ? String(rows[0].amount) : '0'
}
async function blockOfAction(actionIndex) {
    const rows = await q(`SELECT t.block_index AS b FROM actions a
        JOIN transactions t ON t.tx_index=a.tx_index WHERE a.action_index=?`, [actionIndex])
    return rows.length ? Number(rows[0].b) : null
}
async function tip() { const r = await q(`SELECT MAX(block_index) h FROM blocks`, []); return Number(r[0].h) }
async function mine(n) { try { await regtestMinerConnector.generateBlocks(n) } catch (e) {} }
async function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }
function randTick(p) { let s = p; for (let i = 0; i < 6; i++) s += String.fromCharCode(65 + Math.floor(Math.random() * 26)); return s }
const j = (x) => JSON.stringify(x, (k, v) => typeof v === 'bigint' ? Number(v) : v)

describe('NFT Reorg: a collection child issuance rolls back across an on-chain reorg', function () {
    this.timeout(0)

    before(async function () {
        if (global.COIN_CODE === 'DOGE') this.skip()   // generateblock unavailable on Core 1.14
    })

    it('orphaning the CHILD block rolls back the child token while the parent survives', async function () {
        const owner = await cryptoHelper.getNewFundedAddress('nftr-owner', COIN, NETWORK, null, 'legacy', 0, 2)
        const parent = randTick('NFTRP')
        const child  = parent + '.ITEM'

        // Parent ISSUE in an EARLIER block, then bury it so the CHILD is isolatable.
        await issueHelper.sendIssueV0(owner, parent, '100', '0', '0', 'nft-reorg parent', '100')
        assert.strictEqual(await tokenExists(parent), true, 'parent token created')
        await mine(2)
        const parentRows = await q(`SELECT a.action_index FROM issues i
            JOIN actions a ON a.action_index=i.action_index
            JOIN index_tickers it ON it.id=i.tick_id WHERE it.tick=? LIMIT 1`, [parent])
        const parentBlock = parentRows.length ? await blockOfAction(parentRows[0].action_index) : null

        // CHILD ISSUE (valid NFT) alone in block H.
        await issueHelper.sendIssueV0(owner, child, '1', '0', '0', 'nft-reorg child', '1', '', '', '1')
        assert.strictEqual(await tokenExists(child), true, 'child token created pre-reorg')
        assert.strictEqual(await balanceOf(owner.address, child), '1', 'owner holds the child pre-reorg')
        const childRows = await q(`SELECT i.action_index FROM issues i
            JOIN index_tickers it ON it.id=i.tick_id WHERE it.tick=? ORDER BY i.action_index DESC LIMIT 1`, [child])
        const childActionIndex = childRows.length ? childRows[0].action_index : null
        const childBlock = await blockOfAction(childActionIndex)
        assert(childBlock && parentBlock && childBlock > parentBlock,
            `CHILD must be in a later block than PARENT (parent=${parentBlock} child=${childBlock})`)
        console.log('   child', child, 'issued at block', childBlock, '(parent', parentBlock + ')')

        // Gate on the indexer catching up to the node tip before reorging.
        let settle = 0
        while ((await tip()) < (await nodeConnector.getBlockCount()) && settle++ < 60) { await sleep(1000) }
        console.log('   indexer tip', await tip(), 'node tip', await nodeConnector.getBlockCount())

        // ── Reorg out the CHILD block ──
        await regtestMinerConnector.pauseMining()
        try {
            const tipBefore = await nodeConnector.getBlockCount()
            const childHash = await nodeConnector.getBlockHash(childBlock)
            const miner = (await cryptoHelper.getNewAddress('nftr-miner', COIN, NETWORK, null, 'legacy', 0)).address

            await nodeConnector.invalidateBlock(childHash)
            assert.strictEqual(await nodeConnector.getBlockCount(), childBlock - 1, 'rolled back to before the CHILD')

            const need = tipBefore - (childBlock - 1) + 2
            for (let i = 0; i < need; i++) await nodeConnector.generateBlock(miner, [])
            assert(await nodeConnector.getBlockCount() > tipBefore, 'competing chain overtakes the original')

            // Wait for node -> decoder -> indexer + rollback.js to delete the block-scoped child token.
            let rolled = true
            const deadline = Date.now() + 180000
            while (Date.now() < deadline) {
                rolled = await tokenExists(child)
                if (!rolled) break
                await sleep(2000)
            }
            console.log('   indexer tip after reorg', await tip(), 'node tip', await nodeConnector.getBlockCount())
            assert.strictEqual(rolled, false, 'child token rolled back (collection child reverts)')
            assert.strictEqual(await balanceOf(owner.address, child), '0', 'owner child balance reverted to 0')

            // Parent (earlier surviving block) must remain, supply intact.
            assert.strictEqual(await tokenExists(parent), true, 'parent token (earlier block) survives')
            assert.strictEqual(await balanceOf(owner.address, parent), '100', 'parent supply intact')
            console.log('   parent survived; only the CHILD rolled back: isolation OK')
        } finally {
            await regtestMinerConnector.resumeMining()
        }
    })
})
