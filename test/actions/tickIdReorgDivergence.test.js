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
const sendHelper = require('../helpers/sendHelper')
const mintHelper = require('../helpers/mintHelper')

const GAS_TICK = 'XCHAIN'

/**
 * Phase 1 VERIFICATION GATE for the deterministic index-id work
 * (plan: address `^id` compaction + deterministic index-id consensus fix).
 *
 * Hypothesis: the existing ticker `^id` wire reference is NOT reorg-safe, because
 * `index_tickers.id` is an AUTO_INCREMENT assigned on first reference and is
 * intentionally NEVER rolled back (xchain-indexer/src/rollback.js:155-162). The
 * block hasher resolves ids to canonical STRINGS to dodge id divergence in the
 * hash itself, but a wire `^id` defeats that: `getTickerId('^N')` strips the caret
 * and trusts the LOCAL id->string map. So two honest nodes that reach the same
 * canonical tip via different reorg histories resolve the same `^id` to different
 * tokens, credit different state, and fork.
 *
 * This drill proves the DIVERGENCE ROOT on a single live stack, deterministically:
 *
 *   1. ISSUE TOKENA  -> it takes id = idA (the next free index_tickers id)
 *   2. Orphan the block that introduced TOKENA (invalidateblock + a longer EMPTY
 *      competing chain, the proven mechanism from reorgBalances.test.js).
 *   3. After rollback: the `tokens`/`issues` rows for TOKENA are gone, BUT the
 *      `index_tickers` row idA->TOKENA SURVIVES (not rolled back) and the
 *      AUTO_INCREMENT high-water does not rewind.
 *   4. On the canonical chain, ISSUE TOKENB. It takes id = idA + 1, NOT idA,
 *      because idA is still occupied by the orphaned TOKENA.
 *   5. A node that only ever saw the canonical chain would have given TOKENB = idA.
 *      So a wire `^idA` means TOKENA (an orphan that does not exist on the canonical
 *      chain) on THIS node and TOKENB on a fresh node. We confirm `getTickerId('^'+idA)`
 *      still resolves to the orphaned TOKENA even though TOKENA has no token row,
 *      and that a literal `^idA` SEND is therefore interpreted against a phantom token.
 *
 * If this reproduces, the consensus exposure is confirmed and the deterministic
 * id-assignment + index-table rollback fix is justified. If it does NOT reproduce,
 * STOP and re-examine before changing any schema (per the approved plan's gate).
 *
 * generateBlock(addr, []) is a Bitcoin Core 0.19 RPC; Dogecoin Core 1.14.x lacks it
 * (HTTP 404), so this drill runs on BTC/LTC regtest only (the divergence is
 * chain-agnostic; the empty-competing-chain mechanism is the node-capability gate).
 */
describe('Tick ^id reorg divergence (Phase 1 gate): orphaned index_tickers id survives and poisons ^id resolution', function () {

    this.timeout(0)

    before(function () { if (global.COIN_CODE === 'DOGE') this.skip() })

    async function q(sql, params) {
        const conn = await indexerDatabase.getConnection()
        try { return await conn.query(sql, params) }
        finally { await conn.release() }
    }
    // Mirror of indexer db.getTickerId: case-insensitive name lookup, or `^N` -> N.
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

    it('an orphaned ISSUE leaves a surviving index_tickers id that a later issue cannot reuse, diverging ^id resolution', async function () {
        const issuer = await cryptoHelper.getNewFundedAddress('tickidreorg-issuer', COIN, NETWORK, null, 'legacy', 0, 1)
        // Distinct, protocol-valid ticks tied to this run.
        const suffix = issuer['address'].substring(issuer['address'].length - 6).toUpperCase().replace(/[^A-Z0-9]/g, 'X')
        const TOKENA = 'TKA' + suffix
        const TOKENB = 'TKB' + suffix

        // Gas to pay the ISSUANCE_FEE (XCHAIN is an open faucet on regtest).
        await mintHelper.sendMintV0(issuer, GAS_TICK, 10)

        // 1. ISSUE TOKENA -> it grabs the next free index_tickers id (idA).
        const issueA = await issueHelper.sendIssueV0(issuer, TOKENA, 1000, 1000, 0, 'tick-id reorg drill A', 1000)
        assert(issueA && issueA.issue, 'TOKENA must be indexed pre-reorg')
        const idA = await tickerIdByName(TOKENA)
        assert(idA, 'TOKENA resolved an index_tickers id pre-reorg')
        assert.strictEqual(await tickById(idA), TOKENA, 'idA maps to TOKENA pre-reorg')
        assert.strictEqual(await tokenRowExists(TOKENA), true, 'TOKENA has a tokens row pre-reorg')

        const issueABlock = await blockOfAction(issueA.issue.action_index)
        assert(issueABlock, 'TOKENA ISSUE block height resolved')

        // 2. Pause auto-mining so the orphaned ISSUE cannot be re-mined from the mempool.
        await regtestMinerConnector.setMiningTime(3600000, 3600000)
        try {
            const tipBefore = await nodeConnector.getBlockCount()
            const issueHash = await nodeConnector.getBlockHash(issueABlock)
            const miner     = (await cryptoHelper.getNewAddress('tickidreorg-miner', COIN, NETWORK, null, 'legacy', 0)).address

            // Orphan the block that introduced TOKENA (and everything above it).
            await nodeConnector.invalidateBlock(issueHash)
            assert.strictEqual(await nodeConnector.getBlockCount(), issueABlock - 1, 'node rolled back below the TOKENA ISSUE')

            // Empty competing chain that overtakes the original tip, so the TOKENA ISSUE
            // tx is excluded from the canonical chain entirely.
            const need = tipBefore - (issueABlock - 1) + 2
            for (let i = 0; i < need; i++) await nodeConnector.generateBlock(miner, [])
            assert(await nodeConnector.getBlockCount() > tipBefore, 'competing chain overtakes the original tip')
            assert.notStrictEqual(await nodeConnector.getBlockHash(issueABlock), issueHash, 'the chain actually reorged')

            // 3. Wait for node -> decoder -> indexer rollback.js to drop the orphaned token.
            let tokenAGone = false
            const deadline = Date.now() + 120000
            while (Date.now() < deadline) {
                if (!(await tokenRowExists(TOKENA))) { tokenAGone = true; break }
                await new Promise(r => setTimeout(r, 2000))
            }
            assert.strictEqual(tokenAGone, true, 'the orphaned TOKENA tokens row must be rolled back')

            // THE EXPOSURE (part 1): index_tickers was NOT rolled back, so idA still
            // maps to the orphaned TOKENA even though TOKENA no longer exists on-chain.
            assert.strictEqual(await tickById(idA), TOKENA,
                'index_tickers id ' + idA + ' still resolves to the orphaned TOKENA (not rolled back)')

            // 4. ISSUE TOKENB on the canonical chain. It must take idA + 1, because the
            //    AUTO_INCREMENT high-water did not rewind across the reorg.
            await regtestMinerConnector.setDefaultMiningTime()
            await mintHelper.sendMintV0(issuer, GAS_TICK, 10)
            const issueB = await issueHelper.sendIssueV0(issuer, TOKENB, 1000, 1000, 0, 'tick-id reorg drill B', 1000)
            assert(issueB && issueB.issue, 'TOKENB must be indexed on the canonical chain')
            const idB = await tickerIdByName(TOKENB)
            assert(idB, 'TOKENB resolved an index_tickers id')

            // THE EXPOSURE (part 2): a fresh node (canonical chain only, never saw the
            // orphaned TOKENA) would have assigned TOKENB = idA. This node assigns
            // idA + 1, because idA is still held by the orphan. So the SAME wire `^idA`
            // resolves to TOKENB on a fresh node and to the phantom TOKENA here.
            assert.strictEqual(idB, idA + 1,
                'post-reorg TOKENB took id ' + idB + ' (idA+1), proving the orphaned id poisoned the namespace; ' +
                'a fresh canonical-only node would have given TOKENB id ' + idA)

            // Confirm the divergent interpretation concretely: `^idA` here still points
            // at the phantom orphaned token, which a fresh node would read as TOKENB.
            assert.strictEqual(await tickById(idA), TOKENA,
                'wire ^' + idA + ' resolves to phantom TOKENA on this (reorged) node; a fresh node resolves it to TOKENB -> consensus fork')

            console.log('    [tickid-reorg] CONFIRMED: orphaned id ' + idA + '=' + TOKENA + ' survived rollback; ' +
                'canonical TOKENB took ' + idB + ' (fresh node would give ' + idA + '). Wire ^' + idA +
                ' forks: TOKENA(phantom) here vs TOKENB on a fresh node.')
        } finally {
            await regtestMinerConnector.setDefaultMiningTime()
        }
    })
})
