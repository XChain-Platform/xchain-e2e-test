// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available —
// contact legal@dankest.llc.

const assert = require('assert')
const crypto = require('crypto')
const cryptoHelper = require('../cryptoHelper')
const stakeHelper = require('../helpers/stakeHelper')
const gasHelper = require('../helpers/gasHelper')

/**
 * Stake active-set reorg convergence (on-chain) — proves the indexer's rollback
 * re-NULLs the `deactivation_block` that an orphaned UNSTAKE wrote IN PLACE on a
 * surviving parent stake row.
 *
 * UNSTAKE does not create the stake row; it UPDATEs `deactivation_block =
 * unstake_block + ACTIVATION_DELAY_BLOCKS` on the (much earlier) STAKE row, which
 * lives in a surviving block. The reorg orphans only the UNSTAKE action row — the
 * generic action_index delete removes that row, but the in-place column write on
 * the surviving parent is a separate undo. Without an explicit reset, the parent
 * keeps a non-NULL `deactivation_block`; every active-set read gates on
 * `(deactivation_block IS NULL OR deactivation_block > current_block)`, so once the
 * new chain advances past the stale value the validator silently drops out of the
 * active set on the reorged node while a from-genesis replay keeps it active — a
 * consensus-affecting divergence. This asserts the reset converges the column back
 * to NULL across a real reorg.
 *
 * Mechanism mirrors reorgBalances.test.js: act in block H, pause the auto-miner,
 * `invalidateblock(H)` to orphan the UNSTAKE, then mine an EMPTY competing chain
 * longer than H via `generateBlock(addr, [])` so the orphaned UNSTAKE tx is NOT
 * re-included. The node reorgs onto the empty chain; the decoder records the reorg
 * and the indexer's rollback.js runs.
 */
describe('Stake Reorg — UNSTAKE rolls back, deactivation_block re-NULLs on the surviving stake row', function () {

    let stakerAddr = null
    let signingPubkey = null

    before(async function () {
        // STAKE/UNSTAKE are BTC-only by protocol design — the indexer action
        // handlers reject COIN !== 'BTC'. The reorg is also driven by `generateBlock`
        // (Bitcoin Core 0.19 RPC), which DOGE/LTC node bases may lack — but capability
        // staking only runs on BTC anyway, so the BTC-only gate covers both.
        if (COIN_CODE !== 'BTC') {
            console.log('STAKE/UNSTAKE are BTC-only — skipping stake-reorg drill on ' + COIN_CODE)
            this.skip()
            return
        }
        stakerAddr = await cryptoHelper.getNewFundedAddress(
            'stakereorg-staker', COIN, NETWORK, null, 'legacy', 0, 1
        )
        await gasHelper.ensureGasBalance(stakerAddr, '3000')

        // Ed25519 signing keypair (64 hex chars = 32-byte pubkey; strip 12-byte SPKI prefix).
        let { publicKey } = crypto.generateKeyPairSync('ed25519')
        signingPubkey = publicKey.export({ format: 'der', type: 'spki' }).subarray(12).toString('hex')
    })

    async function q(sql, params) {
        const conn = await indexerDatabase.getConnection()
        try { return await conn.query(sql, params) }
        finally { await conn.release() }
    }

    // deactivation_block on the stakes row for this signing pubkey (NULL when active).
    async function deactivationOf(pubkey) {
        const rows = await q(
            `SELECT s.deactivation_block AS d, st.status AS status
             FROM stakes s
             JOIN index_pubkeys p ON p.id = s.signing_pubkey_id
             JOIN index_statuses st ON st.id = s.status_id
             WHERE LOWER(p.pubkey) = LOWER(?)
             ORDER BY s.action_index DESC LIMIT 1`,
            [pubkey]
        )
        return rows.length ? { deactivation: rows[0].d === null ? null : Number(rows[0].d), status: rows[0].status } : null
    }
    async function blockOfAction(actionIndex) {
        const rows = await q(
            `SELECT t.block_index AS b FROM actions a
             JOIN transactions t ON t.tx_index = a.tx_index WHERE a.action_index = ?`,
            [actionIndex]
        )
        return rows.length ? Number(rows[0].b) : null
    }

    it('orphaning the UNSTAKE block clears the stale deactivation_block and keeps the stake valid', async function () {
        // STAKE in an early block — the helper waits for confirmation+indexing, so it
        // lands in a surviving block below the UNSTAKE we will orphan.
        const stakeRes = await stakeHelper.sendStakeV1(stakerAddr, '1000.00000000', signingPubkey)
        assert(stakeRes.stake, 'STAKE must be indexed')
        assert.strictEqual(stakeRes.stake.status, 'valid', 'STAKE status should be valid')
        let pre = await deactivationOf(signingPubkey)
        assert(pre && pre.deactivation === null, 'stake should be active (deactivation_block NULL) before UNSTAKE')

        // Advance so the STAKE block is strictly below the UNSTAKE block.
        await regtestMinerConnector.generateBlocks(7)

        // UNSTAKE — sets deactivation_block = unstake_block + ACTIVATION_DELAY_BLOCKS
        // on the surviving STAKE row.
        const unstakeRes = await stakeHelper.sendUnstakeV0(stakerAddr, signingPubkey)
        assert(unstakeRes.unstake, 'UNSTAKE must be indexed')
        const stamped = await deactivationOf(signingPubkey)
        assert(stamped && stamped.deactivation !== null,
            'UNSTAKE must stamp deactivation_block on the surviving stake row (got ' + JSON.stringify(stamped) + ')')

        const unstakeBlock = await blockOfAction(unstakeRes.unstake.action_index)
        assert(unstakeBlock, 'UNSTAKE block height resolved')

        // Pause the auto-miner so it cannot re-mine the orphaned UNSTAKE from the mempool.
        await regtestMinerConnector.setMiningTime(3600000, 3600000)
        try {
            const tipBefore   = await nodeConnector.getBlockCount()
            const unstakeHash = await nodeConnector.getBlockHash(unstakeBlock)
            const miner       = (await cryptoHelper.getNewAddress('stakereorg-miner', COIN, NETWORK, null, 'legacy', 0)).address

            // Orphan the UNSTAKE block (and everything above it).
            await nodeConnector.invalidateBlock(unstakeHash)
            assert.strictEqual(await nodeConnector.getBlockCount(), unstakeBlock - 1,
                'node rolled back to the block before the UNSTAKE')

            // Empty competing chain that overtakes the original tip — the mempool UNSTAKE is excluded.
            const need = tipBefore - (unstakeBlock - 1) + 2
            for (let i = 0; i < need; i++) await nodeConnector.generateBlock(miner, [])
            assert(await nodeConnector.getBlockCount() > tipBefore, 'competing chain must be longer than the original')

            // Wait for node → decoder → indexer rollback.js to re-NULL the stale stamp.
            let after = null
            const deadline = Date.now() + 120000
            while (Date.now() < deadline) {
                after = await deactivationOf(signingPubkey)
                if (after && after.deactivation === null) break
                await new Promise(r => setTimeout(r, 2000))
            }

            // The surviving STAKE row must be back to active (deactivation_block NULL) and still valid —
            // exactly what a from-genesis replay (with the UNSTAKE never mined) would produce.
            assert(after, 'stake row must still exist after the reorg (STAKE was in a surviving block)')
            assert.strictEqual(after.deactivation, null,
                'deactivation_block must be re-NULLed after the UNSTAKE is orphaned (got ' + JSON.stringify(after) + ')')
            assert.strictEqual(after.status, 'valid', 'surviving stake must remain valid')
        } finally {
            // Restore normal auto-mining so the stack is healthy for later suites.
            await regtestMinerConnector.setDefaultMiningTime()
        }
    })
})
