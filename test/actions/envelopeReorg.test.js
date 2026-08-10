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
 * TAPROOT ENVELOPE REORG ( §3.7)
 * spec: claude/specs/resolved/taproot-envelope-and-payload-compression.md
 *
 * envelope.test.js publishes the pair the fee-optimal way, both halves in one
 * block. This file drives the case the spec calls out separately and that the
 * happy path can never reach: the two halves SPLIT ACROSS BLOCKS, and then the
 * reveal's block orphaned out from under a confirmed commit.
 *
 * Three §3.7 claims, in one flow:
 *
 *   1. "Commit confirmed, reveal unconfirmed: no action exists." A commit is a
 *      P2TR output and nothing else. The decoder indexes reveals.
 *   2. "Reveal reorged out: identical to any reorged action." The action must
 *      disappear when its block does, even though the commit it points at is
 *      still confirmed on the surviving chain.
 *   3. "The reveal can re-enter from the mempool like any transaction", and when
 *      it does the action comes back EXACTLY ONCE, at its new height, with the
 *      payload intact.
 *
 * Mechanism mirrors gatedReorg/coinpayReorg: gate on tip agreement, pause the
 * auto-miner, invalidateblock the reveal's block, mine an EMPTY competing chain
 * past it so the orphan is not re-included, assert the rollback, then let the
 * miner sweep the reveal back in.
 *
 * DOGE-skipped twice over: no segwit (so no envelope at all), and Dogecoin Core
 * 1.14.x lacks generateblock.
 ********************************************************************/

const assert = require('assert')
const cryptoHelper = require('../cryptoHelper')
const envelopeHelper = require('../helpers/envelopeHelper')

const BODY = Buffer.from(
    ('An envelope reveal, orphaned and re-mined. The payload must survive both. ').repeat(40)
)

async function q(sql, params) {
    const conn = await indexerDatabase.getConnection()
    try { return await conn.query(sql, params) }
    finally { await conn.release() }
}
async function fileRowsByName(name) {
    return await q(`SELECT f.action_index, t.block_index AS block_index
        FROM files f
        JOIN actions a ON a.action_index = f.action_index
        JOIN transactions t ON t.tx_index = a.tx_index
        WHERE f.name = ?`, [name])
}
async function indexerTip() { const r = await q(`SELECT MAX(block_index) h FROM blocks`, []); return Number(r[0].h) }
async function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

// The indexer trails the node; every assertion about what IS or IS NOT indexed has
// to be made from a position where the two agree, or it is just a race.
async function waitForIndexerToCatchUp(timeoutMs = 180000) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
        const [nodeTip, idxTip] = [await nodeConnector.getBlockCount(), await indexerTip()]
        if (idxTip >= nodeTip) return true
        await sleep(2000)
    }
    return false
}

describe('Taproot Envelope Reorg: a split pair, and a reveal orphaned off a live commit ( §3.7)', function () {
    this.timeout(0)

    before(async function () {
        if (!envelopeHelper.envelopeSupported()) this.skip()   // no segwit, no envelope
        if (global.COIN_CODE === 'DOGE') this.skip()           // generateblock unavailable on Core 1.14
    })

    it('rolls the action back with its reveal, then re-indexes it exactly once', async function () {
        const fileName = 'xc990-reorg-' + Date.now().toString().slice(-6) + '.txt'
        const addr = await cryptoHelper.getNewFundedAddress('envreorg', COIN, NETWORK, null, 'segwit', 0, 1)

        const pair = await envelopeHelper.buildEnvelopePair(addr, {
            name: fileName,
            type: 'text/plain',
            title: ' envelope reorg',
            memo: 'split across blocks, then orphaned',
            rawData: BODY,
            compress: true
        })
        console.log('   commit', pair.commitTxid.slice(0, 16) + '...', 'reveal', pair.revealTxid.slice(0, 16) + '...')

        // Mining is paused for the whole drill: the two halves must land in blocks we
        // chose, and an auto-mined block in the middle of the competing chain would
        // re-include the orphan we are trying to keep out.
        await regtestMinerConnector.pauseMining()
        try {
            const miner = (await cryptoHelper.getNewAddress('envreorg-miner', COIN, NETWORK, null, 'legacy', 0)).address

            // ── 1. Commit alone, confirmed. No action may exist. ──
            await nodeConnector.broadcastTx(pair.commitHex)
            await nodeConnector.generateBlock(miner, [pair.commitTxid])
            const commitBlock = await nodeConnector.getBlockCount()
            assert(await waitForIndexerToCatchUp(), 'indexer caught up to the commit block')

            assert.strictEqual((await fileRowsByName(fileName)).length, 0,
                'a confirmed commit with no reveal must produce NO action: it is only a P2TR output')
            console.log('   commit confirmed alone at', commitBlock, '- no action, as §3.7 requires')

            // ── 2. Reveal in the NEXT block: the split pair. ──
            await nodeConnector.broadcastTx(pair.revealHex)
            await nodeConnector.generateBlock(miner, [pair.revealTxid])
            const revealBlock = await nodeConnector.getBlockCount()
            assert.strictEqual(revealBlock, commitBlock + 1, 'the pair is split across two blocks')

            let rows = []
            const appear = Date.now() + 180000
            while (Date.now() < appear) {
                rows = await fileRowsByName(fileName)
                if (rows.length) break
                await sleep(2000)
            }
            assert.strictEqual(rows.length, 1, 'the split pair indexes exactly one action')
            assert.strictEqual(Number(rows[0].block_index), revealBlock,
                'the action belongs to the REVEAL block, not the commit block (§3.1)')
            const actionIndex = rows[0].action_index
            console.log('   split pair indexed at action_index', actionIndex, 'block', revealBlock)

            const servedBefore = await envelopeHelper.waitForServedFile(actionIndex)
            assert.strictEqual(envelopeHelper.sha256(servedBefore.body), envelopeHelper.sha256(BODY),
                'the payload serves byte-exactly before the reorg')

            // ── 3. Orphan the reveal's block, leaving the commit confirmed. ──
            const tipBefore = await nodeConnector.getBlockCount()
            const revealHash = await nodeConnector.getBlockHash(revealBlock)
            await nodeConnector.invalidateBlock(revealHash)
            assert.strictEqual(await nodeConnector.getBlockCount(), revealBlock - 1,
                'rolled back to the block before the reveal')

            // EMPTY competing blocks: the orphaned reveal must NOT be swept back in
            // while we are asserting that its action is gone.
            const need = tipBefore - (revealBlock - 1) + 2
            for (let i = 0; i < need; i++) await nodeConnector.generateBlock(miner, [])
            assert(await nodeConnector.getBlockCount() > tipBefore, 'the competing chain overtakes the original')

            let after = [{}]
            const gone = Date.now() + 180000
            while (Date.now() < gone) {
                after = await fileRowsByName(fileName)
                if (after.length === 0) break
                await sleep(2000)
            }
            assert.strictEqual(after.length, 0,
                'the action rolled back with its reveal, even though the commit is still confirmed')

            // The commit really did survive: this is what makes the case distinct from
            // orphaning a same-block pair, where both halves vanish together.
            const commitStill = await nodeConnector.getTransaction(pair.commitTxid)
            assert(commitStill && commitStill.blockhash, 'the commit is still confirmed on the surviving chain')
            console.log('   reveal orphaned, action gone, commit still confirmed at', commitBlock)

            // ── 4. Let the reveal re-enter from the mempool. ──
            await regtestMinerConnector.resumeMining()
            const reBroadcast = async () => {
                // invalidateblock returns the orphan to the mempool, but a node that
                // already evicted it needs it again; re-broadcasting a transaction the
                // mempool still holds is a no-op, so this is safe either way.
                try { await nodeConnector.broadcastTx(pair.revealHex) } catch (e) { /* already there */ }
            }
            await reBroadcast()
            await regtestMinerConnector.generateBlocks(1)

            let back = []
            const returned = Date.now() + 180000
            while (Date.now() < returned) {
                back = await fileRowsByName(fileName)
                if (back.length) break
                await sleep(2000)
                await reBroadcast()
            }
            assert.strictEqual(back.length, 1,
                'the action comes back EXACTLY once: a second row would mean the rollback left a duplicate')
            assert(Number(back[0].block_index) > revealBlock,
                'it comes back at its NEW height, not the orphaned one')
            console.log('   reveal re-mined; action re-indexed once at block', Number(back[0].block_index))

            const servedAfter = await envelopeHelper.waitForServedFile(back[0].action_index)
            assert.strictEqual(envelopeHelper.sha256(servedAfter.body), envelopeHelper.sha256(BODY),
                'the payload survives the round trip through the reorg, byte for byte')
        } finally {
            await regtestMinerConnector.resumeMining()
        }
    })
})
