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
const mintHelper = require('../helpers/mintHelper')
const transactionHelper = require('../transactionHelper')

const GAS_TICK = 'XCHAIN'

/**
 * Phase 5 ACCEPTANCE GATE for the deterministic index-id fix - ADDRESS twin of
 * tickIdReorgDeterministic.test.js (plan: address `^id` compaction + deterministic
 * index-id consensus fix).
 *
 * ADDRESS `^id` is the headline feature: a wire address field (MINT/SEND.DESTINATION
 * etc.) may be compacted to `^<id>` and resolved back to a canonical address at
 * block-hash time, so the SAME `^<id>` must name the SAME address on every node.
 * index_addresses ids are now assigned by an explicit dense counter, stamped with
 * block_index, ROLLED BACK on reorg, and (the fix this gates) NOT resurrected by the
 * rollback refresh phase (updateBalances -> updateAddressBalance -> createAddress
 * was re-creating just-deleted rows; suppressIndexIdCreation closes that). With the
 * fix, an orphaned new-address id is reclaimed and a later DIFFERENT address reuses
 * it, matching a fresh canonical-only node.
 *
 *   1. MINT XCHAIN from issuerA to a FRESH addrA -> addrA takes id = idA (its
 *      block_index stamped). issuerA already has an id (surviving self-mint), so the
 *      MINT introduces ONLY addrA.
 *   2. Orphan the block that introduced addrA (invalidateblock + a longer EMPTY
 *      competing chain).
 *   3. After rollback: addrA's credit is gone AND the index_addresses row idA->addrA
 *      is DELETED (not resurrected by updateBalances during rollback).
 *   4. On the canonical chain, MINT XCHAIN from issuerB to a DIFFERENT fresh addrB.
 *      addrB must take id = idA (reclaimed) - what a fresh canonical-only node
 *      assigns - so a wire `^idA` resolves to addrB everywhere. No divergence.
 *
 * RE-MINE PREVENTION (same as the ticker twin): invalidateblock returns the orphaned
 * MINT(issuerA->addrA) tx to the mempool where it is still valid. If we resumed
 * auto-mining it would be re-mined alongside the addrB MINT, addrA would reclaim idA
 * itself, and addrB would get idA+1 - a drill artifact, not a fork. So we keep
 * auto-mining PAUSED, issue the addrB MINT from a SEPARATE issuer (issuerB, no
 * mempool input collision with issuerA's orphaned tx), and mine ONLY that tx via
 * generateBlock(miner,[txid]); the orphaned tx stays unmined so idA stays free.
 *
 * generateBlock(addr, [...]) is a Bitcoin Core 0.19 RPC; Dogecoin Core 1.14.x lacks
 * it, so this runs on BTC/LTC regtest only.
 */
describe('Address ^id reorg DETERMINISTIC (Phase 5 gate): orphaned index_addresses id is reclaimed, ^id no longer forks', function () {

    this.timeout(0)

    before(function () { if (global.COIN_CODE === 'DOGE') this.skip() })

    async function q(sql, params) {
        const conn = await indexerDatabase.getConnection()
        try { return await conn.query(sql, params) }
        finally { await conn.release() }
    }
    async function addrIdByName(addr) {
        const rows = await q('SELECT id FROM index_addresses WHERE address=? LIMIT 1', [String(addr)])
        return rows.length ? Number(rows[0].id) : null
    }
    async function addrById(id) {
        const rows = await q('SELECT address FROM index_addresses WHERE id=? LIMIT 1', [Number(id)])
        return rows.length ? rows[0].address : null
    }
    async function addrBlockIndex(addr) {
        const rows = await q('SELECT block_index AS b FROM index_addresses WHERE address=? LIMIT 1', [String(addr)])
        return rows.length && rows[0].b != null ? Number(rows[0].b) : null
    }
    // True while addrA still has a credit (the MINT credit). Goes false once rollback
    // (atomic) deletes the orphaned credit + index_addresses row.
    async function addrHasCredit(addr) {
        const rows = await q(`SELECT 1 FROM credits c JOIN index_addresses a ON a.id=c.address_id
            WHERE a.address=? LIMIT 1`, [String(addr)])
        return rows.length > 0
    }

    it('an orphaned new-address id is reclaimed by rollback, so a later DIFFERENT address reuses it (no ^id divergence)', async function () {
        // Precondition: the deterministic fix requires the block_index column. If the
        // indexer under test predates the migration, fail loud rather than false-green.
        const cols = await q("SHOW COLUMNS FROM index_addresses LIKE 'block_index'")
        assert.strictEqual(cols.length, 1, 'index_addresses.block_index must exist (deterministic-id migration applied)')

        // Two funded source issuers + two fresh destination-only addresses.
        const issuerA = await cryptoHelper.getNewFundedAddress('addriddet-issuerA', COIN, NETWORK, null, 'legacy', 0, 1)
        const issuerB = await cryptoHelper.getNewFundedAddress('addriddet-issuerB', COIN, NETWORK, null, 'legacy', 0, 1)
        const addrA = (await cryptoHelper.getNewAddress('addriddet-destA', COIN, NETWORK, null, 'legacy', 0)).address
        const addrB = (await cryptoHelper.getNewAddress('addriddet-destB', COIN, NETWORK, null, 'legacy', 0)).address

        // Pre-reorg, surviving: each issuer (source) gets its index_addresses id via a
        // self-mint, so the destination MINTs below introduce ONLY the fresh address.
        await mintHelper.sendMintV0(issuerA, GAS_TICK, 10)
        await mintHelper.sendMintV0(issuerB, GAS_TICK, 10)
        assert(await addrIdByName(issuerA['address']), 'issuerA has an index_addresses id pre-reorg')
        assert(await addrIdByName(issuerB['address']), 'issuerB has an index_addresses id pre-reorg')

        // 1. MINT XCHAIN from issuerA -> the FRESH addrA. addrA takes the next dense
        //    index_addresses id (idA), stamped with the block_index of this MINT.
        await mintHelper.sendMintV0(issuerA, GAS_TICK, 5, addrA)
        const idA = await addrIdByName(addrA)
        assert(idA, 'addrA resolved an index_addresses id pre-reorg')
        assert.strictEqual(await addrById(idA), addrA, 'idA maps to addrA pre-reorg')

        // The block where addrA's id was first assigned == the block to orphan.
        const addrABlock = await addrBlockIndex(addrA)
        assert(addrABlock, 'addrA introduction block (index_addresses.block_index) resolved')

        // 2. Pause auto-mining so the orphaned MINT cannot be re-mined from the mempool.
        await regtestMinerConnector.setMiningTime(3600000, 3600000)
        try {
            const tipBefore = await nodeConnector.getBlockCount()
            const orphanHash = await nodeConnector.getBlockHash(addrABlock)
            const miner      = (await cryptoHelper.getNewAddress('addriddet-miner', COIN, NETWORK, null, 'legacy', 0)).address

            await nodeConnector.invalidateBlock(orphanHash)
            assert.strictEqual(await nodeConnector.getBlockCount(), addrABlock - 1, 'node rolled back below the addrA MINT')

            const need = tipBefore - (addrABlock - 1) + 2
            for (let i = 0; i < need; i++) await nodeConnector.generateBlock(miner, [])
            assert(await nodeConnector.getBlockCount() > tipBefore, 'competing chain overtakes the original tip')
            assert.notStrictEqual(await nodeConnector.getBlockHash(addrABlock), orphanHash, 'the chain actually reorged')

            // 3. Wait for node -> decoder -> indexer rollback to drop the orphaned credit.
            let addrAGone = false
            const deadline = Date.now() + 120000
            while (Date.now() < deadline) {
                if (!(await addrHasCredit(addrA))) { addrAGone = true; break }
                await new Promise(r => setTimeout(r, 2000))
            }
            assert.strictEqual(addrAGone, true, 'the orphaned addrA credit must be rolled back')

            // THE FIX (part 1): index_addresses idA was ROLLED BACK and NOT resurrected by
            // the rollback refresh phase (updateBalances -> updateAddressBalance -> createAddress
            // used to re-create it with a NULL/stale block_index, poisoning ^id).
            assert.strictEqual(await addrById(idA), null,
                'index_addresses id ' + idA + ' must be reclaimed (deleted) after the orphaning reorg')

            // 4. MINT XCHAIN from issuerB -> the DIFFERENT fresh addrB, WITHOUT re-mining the
            //    orphaned MINT. Auto-mining stays paused: broadcast from issuerB (no mempool
            //    conflict with issuerA's orphaned tx) and mine ONLY that tx, so the orphaned
            //    MINT stays unmined and idA is available for addrB. Message mirrors
            //    mintHelper.sendMintV0 (MINT v0, amount 5, empty memo).
            const mintBMessage = 'MINT|0|' + GAS_TICK + '|5|' + addrB + '|'
            const mintBTxid = await transactionHelper.createAndSendTransaction(issuerB, mintBMessage)
            await nodeConnector.generateBlock(miner, [mintBTxid])

            // Wait for the canonical MINT to index (addrB gets its id when credited).
            let idB = null
            const deadlineB = Date.now() + 120000
            while (Date.now() < deadlineB) {
                idB = await addrIdByName(addrB)
                if (idB) break
                await new Promise(r => setTimeout(r, 2000))
            }
            assert(idB, 'addrB resolved an index_addresses id on the canonical chain')

            // THE FIX (part 2): no divergence. addrB (a DIFFERENT address than the orphaned
            // addrA) reclaimed idA, so a wire `^idA` resolves to addrB here exactly as it
            // would on a fresh canonical-only node that never saw addrA.
            assert.strictEqual(idB, idA,
                'post-reorg addrB must reclaim id ' + idA + ' (got ' + idB + '); a fresh canonical-only node assigns the same, so ^' + idA + ' no longer forks')
            assert.strictEqual(await addrById(idA), addrB,
                'wire ^' + idA + ' now resolves to addrB on this reorged node, matching a fresh node (no consensus fork)')

            console.log('    [addrid-det] CONFIRMED FIX: orphaned index_addresses id ' + idA + ' was reclaimed by rollback (not resurrected); ' +
                'a DIFFERENT canonical address took ' + idB + ' (== idA). Wire ^' + idA + ' resolves identically everywhere.')
        } finally {
            await regtestMinerConnector.setDefaultMiningTime()
        }
    })
})
