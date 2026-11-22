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
 ********************************************************************/

// AT4: after COOLDOWN_BLOCKS the evicted source is credited its swept amount and a fresh STAKE v1 re-enters. Part of rollcall_eviction.test.js.

'use strict'

const assert = require('assert')

const rc = require('../../helpers/rollcallHelper')
const cryptoHelper = require('../../helpers/core/cryptoHelper')
const stakeHelper = require('../../helpers/stakeHelper')
const gasHelper = require('../../helpers/gasHelper')

    // The credit lands through processCooldownCompletions, which is exactly
    // why the eviction must write its `unstakes` rows BEFORE the sweep runs in
    // the same block.
async function xchainBalance(ctx, address){
    const rows = await ctx.idxQuery(
`SELECT b.amount AS amount FROM balances b
   JOIN index_addresses a ON a.id = b.address_id
   JOIN index_tickers   t ON t.id = b.tick_id
  WHERE a.address = ? AND t.tick = 'XCHAIN'`, [address])
    return rows.length ? Number(rows[0].amount) : 0
}

// Mines past the cooldown and waits for the swept amount to be credited back.
async function creditAfterCooldown(st){
    const { ctx, C2, idleSource, evictionRows, cooldownBlocks } = st
    assert.ok(Number.isFinite(cooldownBlocks) && cooldownBlocks > 0,
        'AT4 needs the cooldown derived from AT1\'s synthetic UNSTAKE row')

    const cooldownEnd = C2 + cooldownBlocks
    const swept = evictionRows.reduce((acc, r) => acc + Number(r.amount), 0)
    console.log('    AT4: cooldown ends at ' + cooldownEnd + ', sweeping ' + swept.toFixed(8) +
                ' XCHAIN back to ' + idleSource)

    const balanceBefore = await xchainBalance(ctx, idleSource)

    await rc.mineBtcTo(ctx, cooldownEnd + 2, 'cooldown completion')

    let balanceAfter = balanceBefore
    const deadline = Date.now() + 180000
    while (Date.now() < deadline){
        balanceAfter = await xchainBalance(ctx, idleSource)
        if (balanceAfter >= balanceBefore + swept) break
        await rc.sleep(2000)
    }
    assert.ok(balanceAfter >= balanceBefore + swept,
        'AT4: the evicted source must be credited its swept ' + swept.toFixed(8) + ' XCHAIN at the end of the ' +
        'ordinary cooldown (' + cooldownEnd + '); the balance went ' + balanceBefore + ' to ' + balanceAfter +
        '. Nothing is burned by an eviction: absence is not an offense.')
    return swept
}

async function reenterWithFreshStake(st, swept){
    const { ctx } = st
    // Re-entry. A fresh STAKE v1 with a NEW signing key, because the evicted
    // key is spent (STAKE rejects "SIGNING_PUBKEY already in use"), which is
    // itself part of the contract.
    //
    // THE RE-ENTRY KEY IS PER-GENERATION, for the reason AT1's idle key is.
    // It was the fixed seed 55...55 until 2026-09-03, which made AT4 exactly
    // as one-shot as AT1 was before its own rotation: the first run stakes that pubkey, the
    // run's own assertion proves it is now in oracle_publish, and STAKE v1
    // refuses it forever after ("any valid stake row for this pubkey, EVER"),
    // so the second AT4 run on the same chain fails on its re-entry leg with
    // `invalid: SIGNING_PUBKEY (already in use)`. Measured on the regtest acceptance
    // venue: the first green AT4 left c6822637... staked from the fixed seed,
    // and nothing but a new chain could have run it again. Rotating with
    // XC_ROLLCALL_IDLE_GENERATION costs nothing and makes the suite re-runnable
    // by the same bump AT1 already needs.
    const reentryPubkey = rc.pubkeyForSeed(rc.reentrySeed())
    const stakerAddr = await cryptoHelper.getNewFundedAddress('rollcall-reentry', COIN, NETWORK, null, 'legacy', 0, 0.05)
    await gasHelper.ensureGasBalance(stakerAddr, '30000')
    await utxoTrackerConnector.quiesce({ timeoutMs: 60000, pollMs: 250, regtestMiner: regtestMinerConnector })

    const res = await stakeHelper.sendStakeV1(stakerAddr, swept.toFixed(8), reentryPubkey)
    assert.strictEqual(res.stake.status, 'valid',
        'AT4: a fresh STAKE v1 must re-enter after the cooldown; got ' + res.stake.status)

    const activation = Number(res.stake.activation_block)
    assert.ok(Number.isFinite(activation), 'the re-entering stake must carry an activation_block')
    await rc.mineBtcTo(ctx, activation + 1, 'activation of the re-entering stake')

    const caps = await indexerConnector.getCapabilityValidators('oracle_publish', activation + 1)
    assert.ok(caps.validators.some(v => String(v.pubkey).toLowerCase() === reentryPubkey.toLowerCase()),
        'AT4: the re-entering stake\'s key must be back in the oracle_publish capability set at ' +
        (activation + 1) + '; got ' + JSON.stringify(caps.validators.map(v => v.pubkey)))
}

async function creditsSweptAmountAndReenters(st){
    const swept = await creditAfterCooldown(st)
    await reenterWithFreshStake(st, swept)
}

function register(st){
    it('AT4: after COOLDOWN_BLOCKS the evicted source is credited its swept amount and a fresh STAKE v1 re-enters', async function () { await creditsSweptAmountAndReenters(st) })
}

module.exports = { register }
