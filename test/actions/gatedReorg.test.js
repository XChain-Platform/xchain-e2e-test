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
 * Token-Gated Content Reorg (on-chain): proves the indexer rolls back a gated
 * FILE across a real chain reorg, and that the gated-SEND enforcement rule (a
 * SEND of a token with active gated content must be paired with a MESSAGE v2)
 * is itself a function of the rolled-back `gated_files` row. gatedFile.test.js
 * exercises publish/transfer/enforce under normal conditions; the gated_files
 * rollback (a block-scoped dataTable DELETE in rollback.js) was never driven
 * end-to-end on-chain.
 *
 * Mechanism (mirrors controllerReorg/contractStakeReorg): the gate token ISSUE
 * lands in an EARLIER surviving block; the gated FILE (BATCH FILE+MESSAGE-to-self)
 * lands ALONE in block H, giving the token "active gated content" (a bare SEND is
 * then rejected: proven pre-reorg). We gate on indexer-tip==node-tip, pause the
 * auto-miner, invalidateblock(H), and mine an EMPTY competing chain longer than H
 * so the orphaned FILE is NOT re-included. After the reorg we assert the
 * gated_files row is gone AND a bare SEND of the (now un-gated) token lands valid:
 * the enforcement rule rolled back with the row.
 *
 * DOGE-skipped: Dogecoin Core 1.14.x lacks generateblock.
 ********************************************************************/

const assert            = require('assert')
const crypto            = require('crypto')
const cryptoHelper      = require('../cryptoHelper')
const issueHelper       = require('../helpers/issueHelper')
const transactionHelper = require('../transactionHelper')

function makeGatedCiphertext(plaintext) {
    const key = crypto.randomBytes(32)
    const iv = crypto.randomBytes(12)
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()])
    const ciphertext = Buffer.concat([iv, cipher.getAuthTag(), encrypted])
    const keyHash = crypto.createHash('sha256').update(key).digest('hex')
    return { ciphertext, keyHash }
}
// Structurally-valid stub ECIES envelope (the indexer checks structure at publish
// time; the wallet validates the real key at unlock). Mirrors gatedFile.test.js.
function stubEncryptedMessage(keyHashHex) {
    const seed = Buffer.from(keyHashHex.padEnd(64, '0'), 'hex')
    const blob = Buffer.alloc(94)
    for (let i = 0; i < blob.length; i++) blob[i] = seed[i % seed.length] ^ (i + 1)
    return blob.toString('hex')
}

async function q(sql, params) {
    const conn = await indexerDatabase.getConnection()
    try { return await conn.query(sql, params) }
    finally { await conn.release() }
}
async function gatedFileRow(actionIndex) {
    const rows = await q(`SELECT action_index, gate_ticker, key_hash FROM gated_files WHERE action_index=? LIMIT 1`, [actionIndex])
    return rows.length ? rows[0] : null
}
async function activeGatedCount(tick) {
    const rows = await q(`SELECT COUNT(*) c FROM gated_files WHERE gate_ticker=?`, [tick])
    return Number(rows[0].c)
}
async function balanceOf(address, tick) {
    const rows = await q(`SELECT b.amount FROM balances b
        JOIN index_addresses ia ON ia.id=b.address_id
        JOIN index_tickers it ON it.id=b.tick_id
        WHERE ia.address=? AND it.tick=?`, [address, tick])
    return rows.length ? String(rows[0].amount) : '0'
}
async function fileActionIndexByName(name) {
    const rows = await q(`SELECT a.action_index FROM files f
        JOIN actions a ON a.action_index=f.action_index
        WHERE f.name=? ORDER BY a.action_index DESC LIMIT 1`, [name])
    return rows.length ? rows[0].action_index : null
}
async function blockOfAction(actionIndex) {
    const rows = await q(`SELECT t.block_index AS b FROM actions a
        JOIN transactions t ON t.tx_index=a.tx_index WHERE a.action_index=?`, [actionIndex])
    return rows.length ? Number(rows[0].b) : null
}
async function tip() { const r = await q(`SELECT MAX(block_index) h FROM blocks`, []); return Number(r[0].h) }
async function mine(n) { await regtestMinerConnector.generateBlocks(n) }
async function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }
function randTick(p) { let s = p; for (let i = 0; i < 6; i++) s += String.fromCharCode(65 + Math.floor(Math.random() * 26)); return s }

describe('Gated Content Reorg: a gated FILE (and its SEND-gating) rolls back across a reorg', function () {
    this.timeout(0)

    before(async function () {
        if (global.COIN_CODE === 'DOGE') this.skip()   // generateblock unavailable on Core 1.14
    })

    it('orphaning the gated FILE block rolls back gated_files and un-gates the token', async function () {
        const issuer    = await cryptoHelper.getNewFundedAddress('greorg-issuer',    COIN, NETWORK, null, 'legacy', 0, 3)
        const recipient = await cryptoHelper.getNewFundedAddress('greorg-recipient', COIN, NETWORK, null, 'legacy', 0, 1)
        const tick = randTick('GR')
        const fileName = 'gr-secret-' + Date.now().toString().slice(-6) + '.txt'
        const { ciphertext, keyHash } = makeGatedCiphertext(Buffer.from('reorg holder-only content'))

        // Gate token ISSUE in an EARLIER block, then bury it.
        await issueHelper.sendIssueV0(issuer, tick, '1000', '0', '0', 'gated-reorg token', '1000')
        await mine(2)

        // Gated FILE (BATCH FILE + MESSAGE-to-self) ALONE in block H: gives the token active gated content.
        const fileCmd = ['FILE', '0', fileName, 'text/plain', 'Gated Reorg', '', tick, '1', keyHash].join('|')
        const selfMsg = ['MESSAGE', '2', COIN_CODE, issuer.address, stubEncryptedMessage(keyHash)].join('|')
        await transactionHelper.createAndSendTransaction(issuer, 'BATCH|0|' + fileCmd + ';' + selfMsg, ciphertext.toString('binary'))
        await mine(1)

        // Wait for the gated_files row to materialise.
        let fileActionIndex = null
        for (let i = 0; i < 30 && fileActionIndex === null; i++) { fileActionIndex = await fileActionIndexByName(fileName); if (!fileActionIndex) await sleep(2000) }
        assert(fileActionIndex, 'gated FILE indexed')
        let gf = null
        for (let i = 0; i < 30 && !gf; i++) { gf = await gatedFileRow(fileActionIndex); if (!gf) await sleep(2000) }
        assert(gf, 'gated_files row present pre-reorg')
        assert.strictEqual(String(gf.key_hash).toLowerCase(), keyHash, 'gated_files key_hash matches')
        const fileBlock = await blockOfAction(fileActionIndex)
        console.log('   gated FILE', fileActionIndex, 'at block', fileBlock, 'gate_ticker', tick)

        // Teeth pre-reorg: a BARE SEND of the gated token (no sibling MESSAGE) is REJECTED.
        const recvBefore = await balanceOf(recipient.address, tick)
        await transactionHelper.createAndSendTransaction(issuer, `SEND|0|${tick}|5|${recipient.address}|bare-pre`)
        await mine(1)
        let s0 = 0
        while ((await tip()) < (await nodeConnector.getBlockCount()) && s0++ < 60) { await sleep(1000) }
        await sleep(1500)
        assert.strictEqual(await balanceOf(recipient.address, tick), recvBefore,
            'bare SEND of the gated token denied pre-reorg (gated-SEND rule has teeth)')
        console.log('   bare SEND denied pre-reorg: gated-SEND rule active')

        // ── Reorg out the gated FILE block ──
        await regtestMinerConnector.setMiningTime(3600000, 3600000)
        try {
            const tipBefore = await nodeConnector.getBlockCount()
            const fileHash = await nodeConnector.getBlockHash(fileBlock)
            const miner = (await cryptoHelper.getNewAddress('greorg-miner', COIN, NETWORK, null, 'legacy', 0)).address

            await nodeConnector.invalidateBlock(fileHash)
            assert.strictEqual(await nodeConnector.getBlockCount(), fileBlock - 1, 'rolled back to before the gated FILE')

            const need = tipBefore - (fileBlock - 1) + 2
            for (let i = 0; i < need; i++) await nodeConnector.generateBlock(miner, [])
            assert(await nodeConnector.getBlockCount() > tipBefore, 'competing chain overtakes the original')

            // Wait for rollback.js to delete the block-scoped gated_files row.
            let cnt = 1
            const deadline = Date.now() + 180000
            while (Date.now() < deadline) {
                cnt = await activeGatedCount(tick)
                if (cnt === 0) break
                await sleep(2000)
            }
            assert.strictEqual(cnt, 0, 'gated_files row rolled back (no active gated content for the ticker)')
            assert.strictEqual(await gatedFileRow(fileActionIndex), null, 'the specific gated_files row is gone')
            console.log('   indexer tip after reorg', await tip(), 'node tip', await nodeConnector.getBlockCount())

            // The enforcement rule rolled back with the row: a BARE SEND now lands VALID.
            // (Capture the baseline BEFORE restoring the miner: the orphaned pre-reorg
            // denied SEND is back in the mempool and, now that the token is un-gated, is
            // ALSO valid: so once mining resumes the recipient may receive that 5 PLUS
            // this 7 [=12]. Either way a bare SEND now credits, which is the proof; assert
            // >= 7 rather than an exact amount to tolerate the re-included orphan.)
            const recvBefore2 = Number(await balanceOf(recipient.address, tick))
            await regtestMinerConnector.setDefaultMiningTime()
            await transactionHelper.createAndSendTransaction(issuer, `SEND|0|${tick}|7|${recipient.address}|bare-post`)
            await mine(1)
            let credited = recvBefore2
            const d2 = Date.now() + 120000
            while (Date.now() < d2) {
                credited = Number(await balanceOf(recipient.address, tick))
                if (credited - recvBefore2 >= 7) break
                await sleep(2000)
            }
            assert(credited - recvBefore2 >= 7,
                `bare SEND of the now-ungated token lands valid (gating rule rolled back): recipient +${credited - recvBefore2}`)
            console.log('   bare SEND valid post-reorg (recipient now ' + credited + '): gated-SEND rule rolled back with gated_files')
        } finally {
            await regtestMinerConnector.setDefaultMiningTime()
        }
    })
})
