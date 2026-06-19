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

const GAS_TICK = 'XCHAIN'

/**
 * Phase 5 ACCEPTANCE GATE for the deterministic index-id fix
 * (plan: address `^id` compaction + deterministic index-id consensus fix).
 *
 * This is the INVERSE of tickIdReorgDivergence.test.js (the Phase 1 gate, which
 * proved the OLD AUTO_INCREMENT behaviour forked). With the fix in place
 * (index_tickers/index_addresses ids assigned by an explicit dense counter,
 * stamped with block_index, and ROLLED BACK on reorg) the same scenario must NO
 * LONGER diverge: the orphaned id is reclaimed, so a later issue reuses it and a
 * wire `^id` resolves identically on this (reorged) node and on a fresh
 * canonical-only node.
 *
 *   1. ISSUE TOKENA -> it takes id = idA.
 *   2. Orphan the block that introduced TOKENA (invalidateblock + a longer EMPTY
 *      competing chain).
 *   3. After rollback: the `tokens`/`issues` rows for TOKENA are gone AND the
 *      `index_tickers` row idA->TOKENA is now DELETED (the fix rolls it back).
 *   4. On the canonical chain, ISSUE TOKENB. It must take id = idA (reclaimed),
 *      exactly what a fresh canonical-only node would assign. No divergence.
 *
 * generateBlock(addr, []) is a Bitcoin Core 0.19 RPC; Dogecoin Core 1.14.x lacks
 * it, so this runs on BTC/LTC regtest only (chain-agnostic divergence; the
 * empty-competing-chain mechanism is the node-capability gate).
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

    it('an orphaned ISSUE id is reclaimed by rollback, so a later issue reuses it (no ^id divergence)', async function () {
        // Precondition: the deterministic fix requires the block_index column. If the
        // indexer under test predates the migration, fail loud rather than false-green.
        const cols = await q("SHOW COLUMNS FROM index_tickers LIKE 'block_index'")
        assert.strictEqual(cols.length, 1, 'index_tickers.block_index must exist (deterministic-id migration applied)')

        const issuer = await cryptoHelper.getNewFundedAddress('tickiddet-issuer', COIN, NETWORK, null, 'legacy', 0, 1)
        const suffix = issuer['address'].substring(issuer['address'].length - 6).toUpperCase().replace(/[^A-Z0-9]/g, 'X')
        const TOKENA = 'TDA' + suffix
        const TOKENB = 'TDB' + suffix

        await mintHelper.sendMintV0(issuer, GAS_TICK, 10)

        // 1. ISSUE TOKENA -> idA, stamped with its block_index.
        const issueA = await issueHelper.sendIssueV0(issuer, TOKENA, 1000, 1000, 0, 'tick-id deterministic A', 1000)
        assert(issueA && issueA.issue, 'TOKENA must be indexed pre-reorg')
        const idA = await tickerIdByName(TOKENA)
        assert(idA, 'TOKENA resolved an index_tickers id pre-reorg')
        assert.strictEqual(await tickById(idA), TOKENA, 'idA maps to TOKENA pre-reorg')

        const issueABlock = await blockOfAction(issueA.issue.action_index)
        assert(issueABlock, 'TOKENA ISSUE block height resolved')

        // 2. Pause auto-mining so the orphaned ISSUE cannot be re-mined from the mempool.
        await regtestMinerConnector.setMiningTime(3600000, 3600000)
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

            // THE FIX (part 1): index_tickers idA was ROLLED BACK, so it no longer maps to
            // the orphaned TOKENA (under the old behaviour this row survived and poisoned ^id).
            assert.strictEqual(await tickById(idA), null,
                'index_tickers id ' + idA + ' must be reclaimed (deleted) after the orphaning reorg')

            // 4. ISSUE TOKENB on the canonical chain. With the id reclaimed it must take
            //    idA (the same id a fresh canonical-only node assigns), NOT idA+1.
            await regtestMinerConnector.setDefaultMiningTime()
            await mintHelper.sendMintV0(issuer, GAS_TICK, 10)
            const issueB = await issueHelper.sendIssueV0(issuer, TOKENB, 1000, 1000, 0, 'tick-id deterministic B', 1000)
            assert(issueB && issueB.issue, 'TOKENB must be indexed on the canonical chain')
            const idB = await tickerIdByName(TOKENB)
            assert(idB, 'TOKENB resolved an index_tickers id')

            // THE FIX (part 2): no divergence. TOKENB reclaimed idA, so a wire `^idA`
            // resolves to TOKENB here exactly as it would on a fresh canonical-only node.
            assert.strictEqual(idB, idA,
                'post-reorg TOKENB must reclaim id ' + idA + ' (got ' + idB + '); a fresh canonical-only node assigns the same, so ^' + idA + ' no longer forks')
            assert.strictEqual(await tickById(idA), TOKENB,
                'wire ^' + idA + ' now resolves to TOKENB on this reorged node, matching a fresh node (no consensus fork)')

            console.log('    [tickid-det] CONFIRMED FIX: orphaned id ' + idA + ' was reclaimed by rollback; ' +
                'canonical TOKENB took ' + idB + ' (== idA). Wire ^' + idA + ' resolves identically everywhere.')
        } finally {
            await regtestMinerConnector.setDefaultMiningTime()
        }
    })
})
