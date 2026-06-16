/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available —
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * Contract Staking Reorg (on-chain) — proves a STAKE v3 contract_stakes row
 * rolls back when its block is orphaned. The capability-staking reorg
 * (stakeReorgDeactivation.test.js) exercises the `unstakes`/`stakes` tables;
 * contract_stakes is a separate dataTable whose block-scoped rollback was not
 * driven on-chain. DEPLOY (earlier surviving block) remains; only the STAKE
 * rolls back, so the staked tokens return to the staker.
 *
 * Mechanism mirrors vmContractReorg/controllerReorg (invalidateblock + empty
 * competing chain). DOGE-skipped — Core 1.14 lacks generateblock.
 ********************************************************************/

const assert       = require('assert')
const crypto       = require('crypto')
const cryptoHelper = require('../cryptoHelper')
const stakeHelper  = require('../helpers/stakeHelper')
const vmHelper     = require('../helpers/vmHelper')
const gasHelper    = require('../helpers/gasHelper')

function newSigningPubkey(){
    let { publicKey } = crypto.generateKeyPairSync('ed25519')
    return publicKey.export({ format: 'der', type: 'spki' }).subarray(12).toString('hex')
}
const STAKE_GATED_CONTRACT = `
    module.exports = {
        isStaked: function() {
            let amount = xchain.contract.getStake(xchain.getInputParam(0), 'XCHAIN')
            return xchain.math.gte(amount, '100') ? 'yes' : 'no'
        }
    };
`
async function q(sql, params){
    const conn = await indexerDatabase.getConnection()
    try { return await conn.query(sql, params) }
    finally { await conn.release() }
}
async function balanceOf(address, tick){
    const rows = await q(`SELECT b.amount FROM balances b
        JOIN index_addresses ia ON ia.id=b.address_id
        JOIN index_tickers it ON it.id=b.tick_id
        WHERE ia.address=? AND it.tick=?`, [address, tick])
    return rows.length ? String(rows[0].amount) : '0'
}
async function stakeRows(contractIndex, tick, source){
    return await q(`SELECT cs.action_index, cs.amount, cs.block_index
        FROM contract_stakes cs
        JOIN index_tickers   it ON it.id=cs.tick_id
        JOIN index_addresses ia ON ia.id=cs.source_id
        WHERE cs.target_contract_index=? AND it.tick=? AND ia.address=?
        ORDER BY cs.action_index`, [contractIndex, tick, source])
}
async function contractExists(ci){
    const rows = await q(`SELECT 1 FROM contracts WHERE action_index=?`, [ci])
    return rows.length > 0
}
async function blockOfAction(actionIndex){
    const rows = await q(`SELECT t.block_index AS b FROM actions a
        JOIN transactions t ON t.tx_index=a.tx_index WHERE a.action_index=?`, [actionIndex])
    return rows.length ? Number(rows[0].b) : null
}
async function tip(){ const r = await q(`SELECT MAX(block_index) h FROM blocks`, []); return Number(r[0].h) }
async function mine(n){ try { await regtestMinerConnector.generateBlocks(n) } catch(e){} }
async function sleep(ms){ return new Promise(r => setTimeout(r, ms)) }
const j = (x) => JSON.stringify(x, (k, v) => typeof v === 'bigint' ? Number(v) : v)

describe('Contract Staking Reorg — a STAKE v3 row rolls back when its block is orphaned', function () {
    this.timeout(0)

    before(async function () {
        if (global.COIN_CODE === 'DOGE') this.skip()   // generateblock unavailable on Core 1.14
    })

    it('orphaning the STAKE block rolls back contract_stakes while the contract survives', async function () {
        const deployer = await cryptoHelper.getNewFundedAddress('csreorg-deployer', COIN, NETWORK, null, 'legacy', 0, 1)
        await gasHelper.ensureGasBalance(deployer, '1000')
        const dep = await vmHelper.sendDeployV1(deployer, STAKE_GATED_CONTRACT, 300000, '', 20, 'BURN')
        assert(dep.contract && dep.contract.status === 'valid', 'stakeable contract deploys clean')
        const ci = dep.contract.action_index
        await mine(2)   // bury the DEPLOY so the STAKE is isolatable in a later block

        const staker = await cryptoHelper.getNewFundedAddress('csreorg-staker', COIN, NETWORK, null, 'legacy', 0, 1)
        await gasHelper.ensureGasBalance(staker, '2000')
        const pubkey = newSigningPubkey()

        const s = await stakeHelper.sendStakeV3(staker, '400.00000000', pubkey, ci, 'XCHAIN')
        assert.strictEqual(s.stake.status, 'valid', 'STAKE v3 valid pre-reorg')
        let rows = await stakeRows(ci, 'XCHAIN', staker.address)
        assert.strictEqual(rows.length, 1, 'one contract_stakes row pre-reorg')
        // Use the contract_stakes row's OWN block_index as the authoritative mined
        // block (blockOfAction via transactions can disagree). Invalidate the lower
        // of the two so the stake is definitely inside the orphaned range.
        const rowBlock = Number(rows[0].block_index)
        const txBlock  = await blockOfAction(rows[0].action_index)
        const stakeBlock = Math.min(rowBlock, txBlock || rowBlock)
        const deployBlock = await blockOfAction(ci)
        assert(stakeBlock && deployBlock && stakeBlock > deployBlock,
            `STAKE must be in a later block than DEPLOY (deploy=${deployBlock} stake=${stakeBlock} rowBlock=${rowBlock} txBlock=${txBlock})`)
        console.log('   staked 400; rowBlock', rowBlock, 'txBlock', txBlock, '-> invalidate', stakeBlock, '(deploy', deployBlock + ')')

        // Make sure the INDEXER has caught up to the node tip before we reorg, so the
        // stake block is definitely processed and the rollback has something to undo.
        let settle = 0
        while ((await tip()) < (await nodeConnector.getBlockCount()) && settle++ < 60) { await sleep(1000) }
        console.log('   indexer tip', await tip(), 'node tip', await nodeConnector.getBlockCount())

        // ── Reorg out the STAKE block ──
        await regtestMinerConnector.setMiningTime(3600000, 3600000)
        try {
            const tipBefore = await nodeConnector.getBlockCount()
            const stakeHash = await nodeConnector.getBlockHash(stakeBlock)
            const miner = (await cryptoHelper.getNewAddress('csreorg-miner', COIN, NETWORK, null, 'legacy', 0)).address

            await nodeConnector.invalidateBlock(stakeHash)
            assert.strictEqual(await nodeConnector.getBlockCount(), stakeBlock - 1, 'rolled back to before the STAKE')

            const need = tipBefore - (stakeBlock - 1) + 2
            for (let i = 0; i < need; i++) await nodeConnector.generateBlock(miner, [])
            assert(await nodeConnector.getBlockCount() > tipBefore, 'competing chain overtakes the original')

            let rolled = null
            const deadline = Date.now() + 180000
            while (Date.now() < deadline) {
                rolled = await stakeRows(ci, 'XCHAIN', staker.address)
                if (rolled.length === 0) break
                await sleep(2000)
            }
            console.log('   indexer tip after reorg', await tip(), 'node tip', await nodeConnector.getBlockCount())
            console.log('   contract_stakes after reorg:', j(rolled))
            assert.strictEqual(rolled.length, 0, 'STAKE v3 contract_stakes row rolled back (stake reverted)')
            assert.strictEqual(await contractExists(ci), true, 'the contract (earlier surviving block) remains')
            console.log('   DEPLOY survived; only the STAKE rolled back — isolation OK')
        } finally {
            await regtestMinerConnector.setDefaultMiningTime()
        }
    })
})
