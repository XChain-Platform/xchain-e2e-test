// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const assert = require('assert')
const cryptoHelper = require('../cryptoHelper')
const issueHelper = require('../helpers/issueHelper')
const mintHelper = require('../helpers/mintHelper')
const transactionHelper = require('../transactionHelper')

const GAS_TICK = 'XCHAIN'

/**
 * Phase 5 ACCEPTANCE GATE for the deterministic index-id fix
 * (plan: address `^id` compaction + deterministic index-id consensus fix).
 *
 * This is the INVERSE of the retired tickIdReorgDivergence.test.js (the Phase 1
 * gate, which proved the OLD AUTO_INCREMENT behaviour forked; retired 2026-07-03
 * once the fix shipped, because its assertions encode the broken behaviour and
 * its failure was the fix working). With the fix in place
 * (index_tickers/index_addresses ids assigned by an explicit dense counter,
 * stamped with block_index, ROLLED BACK on reorg, and NOT resurrected by the
 * rollback refresh phase) the same scenario must NO LONGER diverge: the orphaned
 * id is reclaimed, so a DIFFERENT later issue reuses it and a wire `^id` resolves
 * identically on this (reorged) node and on a fresh canonical-only node.
 *
 *   1. ISSUE TOKENA (issuerA) -> it takes id = idA, stamped with its block_index.
 *   2. Orphan the block that introduced TOKENA (invalidateblock + a longer EMPTY
 *      competing chain).
 *   3. After rollback: the `tokens`/`issues` rows for TOKENA are gone AND the
 *      `index_tickers` row idA->TOKENA is now DELETED (the fix rolls it back and
 *      does not re-create it during the balance/token refresh phase).
 *   4. On the canonical chain, ISSUE TOKENB. It must take id = idA (reclaimed),
 *      exactly what a fresh canonical-only node would assign. No divergence.
 *
 * RE-MINE PREVENTION (why TOKENB is issued the way it is): `invalidateblock`
 * returns the orphaned TOKENA ISSUE tx to the mempool, where it is still valid
 * (its funding UTXO is in a surviving block). If we simply resumed auto-mining and
 * issued TOKENB, the auto-miner would re-mine the orphaned TOKENA ISSUE alongside
 * TOKENB; TOKENA would reclaim idA itself and TOKENB would get idA+1 - a drill
 * artifact, not a fork (determinism would still hold). To actually exercise "a
 * DIFFERENT token reuses the freed id" (what a competing miner that never saw
 * TOKENA produces), we keep auto-mining PAUSED, issue TOKENB from a SEPARATE
 * issuer (issuerB, so its inputs do not collide in the mempool with issuerA's
 * orphaned txs), and mine ONLY TOKENB's tx via generateBlock(miner, [txid]) - the
 * orphaned TOKENA ISSUE stays in the mempool, unmined, so idA stays free for
 * TOKENB. issuerB is funded + gas-minted BEFORE the reorg so its setup is in
 * surviving blocks.
 *
 * generateBlock(addr, [...]) is a Bitcoin Core 0.19 RPC; Dogecoin Core 1.14.x
 * lacks it, so this runs on BTC/LTC regtest only (chain-agnostic divergence; the
 * competing-chain mechanism is the node-capability gate).
 */
describe('Tick ^id reorg DETERMINISTIC (Phase 5 gate): orphaned index_tickers id is reclaimed, ^id no longer forks', function () {

    this.timeout(0)

    before(function () { if (global.COIN_CODE === 'DOGE') this.skip() })

    async function q(sql, params) {
        const conn = await indexerDatabase.getConnection()
        try { return await conn.query(sql, params) }
        finally { await conn.release() }
    }
    async function tickerIdByName(tick) {
        const rows = await q('SELECT id FROM index_tickers WHERE LOWER(tick)=? LIMIT 1', [String(tick).toLowerCase()])
        return rows.length ? Number(rows[0].id) : null
    }
    async function tickById(id) {
        const rows = await q('SELECT tick FROM index_tickers WHERE id=? LIMIT 1', [Number(id)])
        return rows.length ? rows[0].tick : null
    }
    async function tokenRowExists(tick) {
        const rows = await q(`SELECT 1 FROM tokens t JOIN index_tickers it ON it.id=t.tick_id
            WHERE it.tick=? LIMIT 1`, [tick])
        return rows.length > 0
    }
    async function blockOfAction(actionIndex) {
        const rows = await q(`SELECT t.block_index AS b FROM actions a
            JOIN transactions t ON t.tx_index=a.tx_index WHERE a.action_index=?`, [actionIndex])
        return rows.length ? Number(rows[0].b) : null
    }

    it('an orphaned ISSUE id is reclaimed by rollback, so a later DIFFERENT issue reuses it (no ^id divergence)', async function () {
        // Precondition: the deterministic fix requires the block_index column. If the
        // indexer under test predates the migration, fail loud rather than false-green.
        const cols = await q("SHOW COLUMNS FROM index_tickers LIKE 'block_index'")
        assert.strictEqual(cols.length, 1, 'index_tickers.block_index must exist (deterministic-id migration applied)')

        // Two independent funded issuers. issuerB issues TOKENB after the reorg; using a
        // SEPARATE issuer keeps TOKENB's inputs out of conflict with issuerA's orphaned
        // ISSUE/MINT txs that sit in the mempool after invalidateblock. Both are funded
        // (and gas-minted) BEFORE the reorg so their setup lands in surviving blocks.
        const issuerA = await cryptoHelper.getNewFundedAddress('tickiddet-issuerA', COIN, NETWORK, null, 'legacy', 0, 1)
        const issuerB = await cryptoHelper.getNewFundedAddress('tickiddet-issuerB', COIN, NETWORK, null, 'legacy', 0, 1)
        const suffix = issuerA['address'].substring(issuerA['address'].length - 6).toUpperCase().replace(/[^A-Z0-9]/g, 'X')
        const TOKENA = 'TDA' + suffix
        const TOKENB = 'TDB' + suffix

        await mintHelper.sendMintV0(issuerA, GAS_TICK, 10)
        await mintHelper.sendMintV0(issuerB, GAS_TICK, 10)

        // 1. ISSUE TOKENA -> idA, stamped with its block_index.
        const issueA = await issueHelper.sendIssueV0(issuerA, TOKENA, 1000, 1000, 0, 'tick-id deterministic A', 1000)
        assert(issueA && issueA.issue, 'TOKENA must be indexed pre-reorg')
        const idA = await tickerIdByName(TOKENA)
        assert(idA, 'TOKENA resolved an index_tickers id pre-reorg')
        assert.strictEqual(await tickById(idA), TOKENA, 'idA maps to TOKENA pre-reorg')

        const issueABlock = await blockOfAction(issueA.issue.action_index)
        assert(issueABlock, 'TOKENA ISSUE block height resolved')

        // 2. Pause auto-mining so the orphaned ISSUE cannot be re-mined from the mempool.
        await regtestMinerConnector.pauseMining()
        try {
            const tipBefore = await nodeConnector.getBlockCount()
            const issueHash = await nodeConnector.getBlockHash(issueABlock)
            const miner     = (await cryptoHelper.getNewAddress('tickiddet-miner', COIN, NETWORK, null, 'legacy', 0)).address

            await nodeConnector.invalidateBlock(issueHash)
            assert.strictEqual(await nodeConnector.getBlockCount(), issueABlock - 1, 'node rolled back below the TOKENA ISSUE')

            const need = tipBefore - (issueABlock - 1) + 2
            for (let i = 0; i < need; i++) await nodeConnector.generateBlock(miner, [])
            assert(await nodeConnector.getBlockCount() > tipBefore, 'competing chain overtakes the original tip')
            assert.notStrictEqual(await nodeConnector.getBlockHash(issueABlock), issueHash, 'the chain actually reorged')

            // 3. Wait for node -> decoder -> indexer rollback to drop the orphaned token.
            let tokenAGone = false
            const deadline = Date.now() + 120000
            while (Date.now() < deadline) {
                if (!(await tokenRowExists(TOKENA))) { tokenAGone = true; break }
                await new Promise(r => setTimeout(r, 2000))
            }
            assert.strictEqual(tokenAGone, true, 'the orphaned TOKENA tokens row must be rolled back')

            // THE FIX (part 1): index_tickers idA was ROLLED BACK and NOT resurrected by the
            // rollback refresh phase, so it no longer maps to the orphaned TOKENA. Under the
            // old behaviour this row survived (Phase 1); a pre-fix run also re-created it with
            // a NULL/stale block_index via updateTokens/updateBalances, both of which poison ^id.
            assert.strictEqual(await tickById(idA), null,
                'index_tickers id ' + idA + ' must be reclaimed (deleted) after the orphaning reorg')

            // 4. ISSUE TOKENB on the canonical chain WITHOUT re-mining the orphaned TOKENA.
            //    Auto-mining stays paused: broadcast TOKENB from issuerB (no mempool conflict
            //    with issuerA's orphaned txs) and mine ONLY that tx, so the orphaned TOKENA
            //    ISSUE stays in the mempool unmined and the freed idA is available for TOKENB.
            //    Message mirrors issueHelper.sendIssueV0's ISSUE v0 template (maxSupply 1000,
            //    maxMint 1000, decimals 0, description, mintSupply 1000, then 17 empty fields).
            const issueBMessage = 'ISSUE|0|' + TOKENB + '|1000|1000|0|tick-id deterministic B|1000' + '|'.repeat(17)
            const issueBTxid = await transactionHelper.createAndSendTransaction(issuerB, issueBMessage)
            await nodeConnector.generateBlock(miner, [issueBTxid])

            const issueBRow = await indexerDatabase.waitForIssue({
                source: issuerB['address'], tick: TOKENB, txHash: issueBTxid,
                description: 'tick-id deterministic B', maxSupply: 1000, maxMint: 1000,
                decimals: 0, mintSupply: 1000, status: 'valid'
            })
            assert(issueBRow, 'TOKENB must be indexed on the canonical chain')
            const idB = await tickerIdByName(TOKENB)
            assert(idB, 'TOKENB resolved an index_tickers id')

            // THE FIX (part 2): no divergence. TOKENB (a DIFFERENT token than the orphaned
            // TOKENA) reclaimed idA, so a wire `^idA` resolves to TOKENB here exactly as it
            // would on a fresh canonical-only node that never saw TOKENA.
            assert.strictEqual(idB, idA,
                'post-reorg TOKENB must reclaim id ' + idA + ' (got ' + idB + '); a fresh canonical-only node assigns the same, so ^' + idA + ' no longer forks')
            assert.strictEqual(await tickById(idA), TOKENB,
                'wire ^' + idA + ' now resolves to TOKENB on this reorged node, matching a fresh node (no consensus fork)')

            console.log('    [tickid-det] CONFIRMED FIX: orphaned id ' + idA + ' was reclaimed by rollback (not resurrected); ' +
                'a DIFFERENT canonical token TOKENB took ' + idB + ' (== idA). Wire ^' + idA + ' resolves identically everywhere.')
        } finally {
            await regtestMinerConnector.resumeMining()
        }
    })
})
