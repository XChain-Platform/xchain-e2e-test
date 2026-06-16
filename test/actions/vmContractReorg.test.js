// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const assert = require('assert')
const cryptoHelper = require('../cryptoHelper')
const vmHelper = require('../helpers/vmHelper')
const gasHelper = require('../helpers/gasHelper')

/**
 * VM Contract Reorg (on-chain) — proves the indexer rolls back EXECUTE-produced contract state
 * across a real chain reorg. Integration tests cover DEPLOY/STAKE/DEPOSIT rollback but cannot run
 * the VM, so contract_state / contract_emissions rollback was never exercised end-to-end.
 *
 * Mechanism: a contract EXECUTE writes contract_state and lands in block H. We pause the auto-miner,
 * `invalidateblock(H)` to orphan it, then mine an EMPTY competing chain longer than H via
 * `generateblock(addr, [])` — which ignores the mempool, so the orphaned EXECUTE tx is NOT
 * re-included. The node reorgs onto the empty chain; the decoder + indexer follow and rollback.js
 * deletes the block-scoped contract_state. We assert the state is gone (the DEPLOY, in an earlier
 * surviving block, remains — so this isolates EXECUTE-state rollback).
 *
 * Requires the reorg primitives added to BlockchainConnector (invalidateBlock / getBlockHash /
 * getBlockCount / generateBlock) — nodeConnector in the e2e harness.
 */
describe('VM Contract Reorg — EXECUTE state rolls back across an on-chain reorg', function () {

    const COUNTER = `
        module.exports = {
            increment: function() {
                var c = parseInt(xchain.state.get('count') || '0');
                xchain.state.set('count', String(c + 1));
                return String(c + 1);
            }
        };
    `

    let deployer = null

    async function q(sql, params) {
        const conn = await indexerDatabase.getConnection()
        try { return await conn.query(sql, params) }
        finally { await conn.release() }
    }
    async function latestState(contractIndex, key) {
        const rows = await q(`SELECT state_value FROM contract_state
            WHERE contract_index=? AND state_key=? ORDER BY action_index DESC LIMIT 1`, [contractIndex, key])
        return rows.length ? rows[0].state_value : null
    }
    // Block height (= node chain height on regtest) of the block that mined a given action.
    async function blockOfAction(actionIndex) {
        const rows = await q(`SELECT t.block_index AS b FROM actions a
            JOIN transactions t ON t.tx_index=a.tx_index WHERE a.action_index=?`, [actionIndex])
        return rows.length ? Number(rows[0].b) : null
    }
    async function contractExists(ci) {
        const rows = await q(`SELECT 1 FROM contracts WHERE action_index=?`, [ci])
        return rows.length > 0
    }

    before(async function () {
        // The reorg is driven by `generateblock(addr, [])` (mine an EMPTY competing chain so the
        // orphaned tx is NOT re-included) — an RPC added in Bitcoin Core 0.19. Dogecoin Core 1.14.x
        // (a 0.13/0.14 base) lacks it and answers HTTP 404 "method not found", so this scenario can't
        // be driven on DOGE regtest. The indexer's reorg-rollback path is chain-agnostic (rollback.js
        // operates on DB rows by block_index) and is proven on BTC + LTC; skip on DOGE as a node
        // capability gap, not a protocol gap.
        if (global.COIN_CODE === 'DOGE') this.skip()
        deployer = await cryptoHelper.getNewFundedAddress('vmreorg-deployer', COIN, NETWORK, null, 'legacy', 0, 1)
        await gasHelper.ensureGasBalance(deployer, '500')
    })

    it('orphaning the EXECUTE block via invalidateblock + empty competing chain rolls back contract_state', async function () {
        // Deploy the counter and run one increment under normal (auto-mined) conditions.
        const dep = await vmHelper.sendDeployV0(deployer, COUNTER, 200000)
        const ci = dep.contract.action_index
        const deployBlock = await blockOfAction(ci)

        const ex = await vmHelper.sendExecuteV0(deployer, ci, 'increment', [])
        assert.strictEqual(ex.execution.status, 'valid')
        assert.strictEqual(await latestState(ci, 'count'), '"1"', 'increment should persist count=1 pre-reorg')

        const executeBlock = await blockOfAction(ex.execution.action_index)
        assert(executeBlock && deployBlock && executeBlock > deployBlock,
            `EXECUTE must be in a later block than DEPLOY (deploy=${deployBlock} execute=${executeBlock}) to isolate state rollback`)

        // Pause the auto-miner BEFORE we touch the chain, so it can't re-mine the orphaned EXECUTE
        // from the mempool while we build the competing chain.
        await regtestMinerConnector.setMiningTime(3600000, 3600000)
        try {
            const tipBefore = await nodeConnector.getBlockCount()
            const executeHash = await nodeConnector.getBlockHash(executeBlock)
            const miner = (await cryptoHelper.getNewAddress('vmreorg-miner', COIN, NETWORK, null, 'legacy', 0)).address

            // Orphan the EXECUTE block (and everything above it).
            await nodeConnector.invalidateBlock(executeHash)
            assert.strictEqual(await nodeConnector.getBlockCount(), executeBlock - 1,
                'node should roll back to the block before the EXECUTE')

            // Build an EMPTY competing chain that overtakes the original tip — the mempool EXECUTE
            // is excluded, so it never re-enters the active chain.
            const need = tipBefore - (executeBlock - 1) + 2
            for (let i = 0; i < need; i++) await nodeConnector.generateBlock(miner, [])
            assert(await nodeConnector.getBlockCount() > tipBefore, 'competing chain must be longer than the original')

            // Wait for the reorg to propagate node → decoder → indexer and rollback.js to run.
            let rolledBack = null
            const deadline = Date.now() + 120000
            while (Date.now() < deadline) {
                rolledBack = await latestState(ci, 'count')
                if (rolledBack === null) break
                await new Promise(r => setTimeout(r, 2000))
            }
            assert.strictEqual(rolledBack, null, 'contract_state count must be rolled back (EXECUTE orphaned)')
            // The DEPLOY was in an earlier, surviving block — the contract itself must remain.
            assert.strictEqual(await contractExists(ci), true, 'the contract (deployed in a surviving block) should remain')
        } finally {
            // Restore normal auto-mining so the stack is left healthy for later suites.
            await regtestMinerConnector.setDefaultMiningTime()
        }
    })
})
