/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * Contract Staking: live lifecycle legs NOT covered by contractStaking.test.js:
 *   (1) UNSTAKE v1 begins cooldown, and after cooldown_end_block the sweep
 *       credits the staked tokens back to the staker.
 *   (2) live SLASH: an EXECUTE that calls xchain.contract.slash(pubkey,tick,amt)
 *       writes a slash_events row and reduces the active stake. The contract-slash
 *       emission path was only unit-tested (db.slashContractStake-double-count);
 *       this drives it end-to-end on a live stack.
 *
 * Reads activation_block from the contract_stakes row so it is chain-agnostic
 * (activation delay is 6/24/60 blocks on BTC/LTC/DOGE). Run on BTC for speed.
 ********************************************************************/

const assert        = require('assert')
const crypto        = require('crypto')
const cryptoHelper  = require('../cryptoHelper')
const stakeHelper   = require('../helpers/stakeHelper')
const vmHelper      = require('../helpers/vmHelper')
const gasHelper     = require('../helpers/gasHelper')

function newSigningPubkey(){
    let { publicKey } = crypto.generateKeyPairSync('ed25519')
    return publicKey.export({ format: 'der', type: 'spki' }).subarray(12).toString('hex')
}

// Same contract shape as contractStaking.test.js: exposes a doSlash() method so the
// test can drive xchain.contract.slash through a real EXECUTE.
const STAKE_GATED_CONTRACT = `
    module.exports = {
        isStaked: function() {
            let pubkey = xchain.getInputParam(0)
            let amount = xchain.contract.getStake(pubkey, 'XCHAIN')
            return xchain.math.gte(amount, '100') ? 'yes' : 'no'
        },
        doSlash: function() {
            let pubkey = xchain.getInputParam(0)
            let amount = xchain.getInputParam(1)
            xchain.contract.slash(pubkey, 'XCHAIN', amount)
            return 'ok'
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
// contract_stakes rows for (contract, tick, staker source).
async function stakeRows(contractIndex, tick, source){
    return await q(`SELECT cs.action_index, cs.amount, s.status,
                           cs.activation_block, cs.deactivation_block, cs.block_index
        FROM contract_stakes cs
        JOIN index_tickers   it ON it.id=cs.tick_id
        JOIN index_addresses ia ON ia.id=cs.source_id
        LEFT JOIN index_statuses s ON s.id=cs.status_id
        WHERE cs.target_contract_index=? AND it.tick=? AND ia.address=?
        ORDER BY cs.action_index`, [contractIndex, tick, source])
}
async function unstakeRows(contractIndex, tick, source){
    return await q(`SELECT cu.action_index, cu.amount, s.status, cu.cooldown_end_block, cu.block_index
        FROM contract_unstakes cu
        JOIN index_tickers   it ON it.id=cu.tick_id
        JOIN index_addresses ia ON ia.id=cu.source_id
        LEFT JOIN index_statuses s ON s.id=cu.status_id
        WHERE cu.target_contract_index=? AND it.tick=? AND ia.address=?
        ORDER BY cu.action_index`, [contractIndex, tick, source])
}
async function slashEvents(contractIndex){
    return await q(`SELECT se.id, se.amount, se.destination_id, se.block_index
        FROM slash_events se WHERE se.target_contract_index=? ORDER BY se.id`, [contractIndex])
}
async function tip(){ const r = await q(`SELECT MAX(block_index) h FROM blocks`, []); return Number(r[0].h) }
async function mine(n){ try { await regtestMinerConnector.generateBlocks(n) } catch(e){} }
async function sleep(ms){ return new Promise(r => setTimeout(r, ms)) }
const num = (x) => Number(x)
// Sum of still-active stake (not deactivated as of `atTip`).
function activeAmount(rows, atTip){
    return rows.filter(r => r.status === 'valid' &&
        (r.deactivation_block === null || Number(r.deactivation_block) > atTip))
        .reduce((s, r) => s + num(r.amount), 0)
}
// Mine until the stake's activation_block is reached (chain-calibrated delay).
async function waitActivation(activationBlock){
    let guard = 0
    while ((await tip()) < activationBlock && guard++ < 120) { await mine(1); await sleep(800) }
}

describe('Contract Staking Lifecycle: UNSTAKE cooldown sweep + live SLASH', function () {
    this.timeout(0)
    const COOLDOWN = 20
    let contractIndex

    before(async function () {
        const deployer = await cryptoHelper.getNewFundedAddress('cstake-deployer', COIN, NETWORK, null, 'legacy', 0, 1)
        await gasHelper.ensureGasBalance(deployer, '1000')
        const dep = await vmHelper.sendDeployV1(deployer, STAKE_GATED_CONTRACT, 300000, '', COOLDOWN, 'BURN')
        assert(dep.contract && dep.contract.status === 'valid', 'stakeable contract must deploy clean')
        contractIndex = dep.contract.action_index
        console.log('   stakeable contract', contractIndex, 'cooldown', COOLDOWN)
    })

    it('UNSTAKE v1 → cooldown → sweep returns the staked tokens to the staker', async function () {
        const staker = await cryptoHelper.getNewFundedAddress('cstake-unstaker', COIN, NETWORK, null, 'legacy', 0, 1)
        await gasHelper.ensureGasBalance(staker, '2000')
        const pubkey = newSigningPubkey()

        const s = await stakeHelper.sendStakeV3(staker, '500.00000000', pubkey, contractIndex, 'XCHAIN')
        assert.strictEqual(s.stake.status, 'valid', 'STAKE v3 valid')
        let rows = await stakeRows(contractIndex, 'XCHAIN', staker.address)
        const activation = Number(rows[0].activation_block)
        console.log('   staked 500; activation_block', activation, 'tip', await tip())
        await waitActivation(activation)

        // Unstake → cooldown begins; contract_stakes gets deactivation_block, contract_unstakes row created.
        const u = await stakeHelper.sendUnstakeV1(staker, pubkey, contractIndex, 'XCHAIN')
        assert(u.unstake, 'contract_unstakes row exists')
        const urows = await unstakeRows(contractIndex, 'XCHAIN', staker.address)
        const cooldownEnd = Number(urows[urows.length - 1].cooldown_end_block)
        assert(cooldownEnd >= Number(u.unstake.block_index) + COOLDOWN - 1, 'cooldown_end_block ≈ unstake block + COOLDOWN')
        rows = await stakeRows(contractIndex, 'XCHAIN', staker.address)
        assert(rows.some(r => r.deactivation_block !== null), 'stake row deactivation_block set by unstake')
        console.log('   unstaked; cooldown_end', cooldownEnd, '- waiting for sweep')

        const balDuringCooldown = num(await balanceOf(staker.address, 'XCHAIN'))
        // Advance past cooldown_end_block → sweepUnstakes credits the staked amount back.
        let guard = 0
        while ((await tip()) <= cooldownEnd && guard++ < 90) { await mine(1); await sleep(800) }
        let credited = balDuringCooldown, tries = 25
        while (tries-- > 0) { credited = num(await balanceOf(staker.address, 'XCHAIN')); if (credited > balDuringCooldown) break; await sleep(1000) }
        const delta = credited - balDuringCooldown
        console.log(`   sweep credited +${delta} XCHAIN (during=${balDuringCooldown} after=${credited})`)
        assert.strictEqual(delta, 500, 'sweep returns exactly the unstaked 500 XCHAIN to the staker')
    })

    it('live SLASH: an EXECUTE doSlash writes a slash_events row and reduces the active stake', async function () {
        const staker = await cryptoHelper.getNewFundedAddress('cstake-slashed', COIN, NETWORK, null, 'legacy', 0, 1)
        await gasHelper.ensureGasBalance(staker, '2000')
        const caller = await cryptoHelper.getNewFundedAddress('cstake-slasher', COIN, NETWORK, null, 'legacy', 0, 1)
        await gasHelper.ensureGasBalance(caller, '500')
        const pubkey = newSigningPubkey()

        const s = await stakeHelper.sendStakeV3(staker, '300.00000000', pubkey, contractIndex, 'XCHAIN')
        assert.strictEqual(s.stake.status, 'valid', 'STAKE v3 valid')
        let rows = await stakeRows(contractIndex, 'XCHAIN', staker.address)
        await waitActivation(Number(rows[0].activation_block))
        const atTip1 = await tip()
        const activeBefore = activeAmount(rows, atTip1)
        assert.strictEqual(activeBefore, 300, 'active stake = 300 before slash')
        const slashBefore = (await slashEvents(contractIndex)).length

        // doSlash(pubkey, '120') → xchain.contract.slash(pubkey,'XCHAIN','120')
        const exec = await vmHelper.sendExecuteV0(caller, contractIndex, 'doSlash', [pubkey, '120.00000000'])
        assert.strictEqual(exec.execution.status, 'valid', 'doSlash EXECUTE valid')

        // slash_events row written
        let evs = await slashEvents(contractIndex), tries = 20
        while (evs.length <= slashBefore && tries-- > 0) { await sleep(1000); evs = await slashEvents(contractIndex) }
        assert(evs.length > slashBefore, 'a slash_events row was written by the contract slash')
        const ev = evs[evs.length - 1]
        assert(num(ev.amount) > 0, 'slash_events.amount is non-zero')
        console.log('   slash_events row: amount', String(ev.amount), 'destination_id', String(ev.destination_id))

        // active stake reduced by the slashed amount
        rows = await stakeRows(contractIndex, 'XCHAIN', staker.address)
        const activeAfter = activeAmount(rows, await tip())
        console.log(`   active stake ${activeBefore} -> ${activeAfter} (slashed ${activeBefore - activeAfter})`)
        assert(activeAfter < activeBefore, 'slash reduced the active stake')
        assert.strictEqual(activeBefore - activeAfter, 120, 'slash deducted exactly 120 from the active stake')
    })
})
