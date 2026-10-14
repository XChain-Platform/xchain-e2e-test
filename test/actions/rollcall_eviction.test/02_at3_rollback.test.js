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

// AT3: rolling back the evicting close restores the hashes and re-NULLs deactivation_block. Part of rollcall_eviction.test.js.

'use strict'

const assert = require('assert')

const rc = require('../../helpers/rollcallHelper')
const cryptoHelper = require('../../helpers/core/cryptoHelper')

async function snapshotBeforeRollback(st){
    const { ctx, C2, idleSource } = st
    const before = {
        atClose: await indexerConnector.call('getblockhashes', { block_index: C2 }),
        atPrior: await indexerConnector.call('getblockhashes', { block_index: C2 - 1 }),
    }
    const delegationsBefore = await rc.delegationDeactivations(ctx, idleSource)
    return { before, delegationsBefore }
}

// Invalidates the evicting close and returns what the competing chain needs.
async function rollBackClose(st){
    const { C2 } = st
    const tipBefore = await nodeConnector.getBlockCount()
    const closeHash = await nodeConnector.getBlockHash(C2)
    const minerAddr = (await cryptoHelper.getNewAddress('rollcall-reorg-miner', COIN, NETWORK, null, 'legacy', 0)).address

    await nodeConnector.invalidateBlock(closeHash)
    assert.strictEqual(await nodeConnector.getBlockCount(), C2 - 1,
        'the node must roll back to the block before the evicting close')
    return { tipBefore, minerAddr }
}

async function awaitRollback(st){
    const { ctx, E2, idleSource } = st
    // The eviction's undo is TWO separate repairs, which is why both
    // halves are asserted: the orphaned-unstake join re-NULLs the `stakes`
    // stamps, and a dedicated UPDATE keyed on rollcall_absences.evicted = 1
    // re-NULLs the `delegations` stamps, because an eviction writes no
    // DELEGATE-revoke row for the generic repair to find.
    let stakesAfter = null, delegationsAfter = null, rcRow = null, rolledBack = false
    const deadline = Date.now() + 180000
    while (Date.now() < deadline){
        stakesAfter      = await rc.stakeDeactivations(ctx, idleSource)
        delegationsAfter = await rc.delegationDeactivations(ctx, idleSource)
        rcRow            = await rc.rollcallRow(ctx, E2)
        rolledBack = !rcRow &&
                     stakesAfter.every(r => r.deactivation_block === null) &&
                     delegationsAfter.every(r => r.deactivation_block === null)
        if (rolledBack) break
        await rc.sleep(2000)
    }
    return { stakesAfter, delegationsAfter, rcRow }
}

async function assertRolledBack(st, before, delegationsBefore, state){
    const { C2, E2, idleSource } = st
    const { stakesAfter, delegationsAfter, rcRow } = state
    assert.strictEqual(rcRow, null,
        'the `rollcalls` row for epoch ' + E2 + ' must be deleted by the rollback: both BTC-side ROLLCALL ' +
        'tables delete on close_block >= the rollback height, because neither carries a block_index column')
    for (const r of stakesAfter)
        assert.strictEqual(r.deactivation_block, null,
            'AT3: deactivation_block must return to NULL on `stakes` for ' + idleSource + ' / ' +
            String(r.signing_pubkey).slice(0, 16) + '... (got ' + r.deactivation_block + ')')
    if (delegationsBefore.length === 0)
        console.log('    NOTE: the idle source holds no delegations, so the `delegations` half of AT3 has ' +
                    'nothing to assert on this venue. Seed a DELEGATE from the idle source to cover it.')
    for (const r of delegationsAfter)
        assert.strictEqual(r.deactivation_block, null,
            'AT3: deactivation_block must return to NULL on `delegations` for ' + idleSource +
            ' (action_index ' + r.action_index + ', got ' + r.deactivation_block + ')')

    const priorAfter = await indexerConnector.call('getblockhashes', { block_index: C2 - 1 })
    for (const f of ['ledger_hash', 'actions_hash', 'contract_hash', 'stakes_root', 'balances_root', 'state_root'])
        assert.strictEqual(String(priorAfter[f]), String(before.atPrior[f]),
            'AT3: ' + f + ' at C - 1 must survive the rollback unchanged')
}

// Empty competing chain that overtakes the original tip.
async function mineCompetingChain(st, tipBefore, minerAddr){
    const { C2 } = st
    const need = tipBefore - (C2 - 1) + 2
    for (let i = 0; i < need; i++) await nodeConnector.generateBlock(minerAddr, [])
    assert.ok(await nodeConnector.getBlockCount() > tipBefore, 'the competing chain must overtake the original')
}

async function rollBackAndOvertake(st, before, delegationsBefore){
    await regtestMinerConnector.pauseMining()
    try {
        const { tipBefore, minerAddr } = await rollBackClose(st)
        const state = await awaitRollback(st)
        await assertRolledBack(st, before, delegationsBefore, state)
        await mineCompetingChain(st, tipBefore, minerAddr)
    } finally {
        await regtestMinerConnector.resumeMining()
    }
}

async function assertReparse(st, before){
    const { ctx, C2, E2, idleSource, evictionRows } = st
    // Re-parse. The close is a HEIGHT event, not a transaction, so the
    // replacement block at C closes the same epoch against the same unchanged
    // DOGE evidence and must reach the same verdict. The bitcoin BLOCK hash
    // necessarily differs (it is a different block); what must be
    // byte-identical is everything the close decides.
    await rc.mineBtcTo(ctx, C2, 'reparse of the evicting close')
    let after = null
    const deadline = Date.now() + 180000
    while (Date.now() < deadline){
        if (await rc.rollcallRow(ctx, E2)){
            after = await indexerConnector.call('getblockhashes', { block_index: C2 })
            break
        }
        await rc.sleep(2000)
    }
    assert.ok(after,
        'the re-parsed block at ' + C2 + ' wrote no `rollcalls` row for epoch ' + E2 + '. The close is ' +
        'height-driven and the DOGE evidence is unchanged, so the same verdict must be reachable; a missing ' +
        'row means the close deferred on the replay.')
    for (const f of ['ledger_hash', 'actions_hash', 'contract_hash', 'stakes_root', 'balances_root', 'state_root'])
        assert.strictEqual(String(after[f]), String(before.atClose[f]),
            'AT3: ' + f + ' at the re-parsed close ' + C2 + ' must be byte-identical to the original (' +
            String(before.atClose[f]) + ' became ' + String(after[f]) + ')')

    const reEvicted = await rc.evictionUnstakes(ctx, idleSource)
    assert.strictEqual(reEvicted.length, evictionRows.length,
        'the re-parse must mint the same number of synthetic UNSTAKE rows as the original close')
}

async function rollsBackTheEviction(st){
    const { evictionRows } = st
    assert.ok(evictionRows && evictionRows.length,
        'AT3 reads back the eviction AT1 produced; this suite runs in file order')
    const { before, delegationsBefore } = await snapshotBeforeRollback(st)
    await rollBackAndOvertake(st, before, delegationsBefore)
    await assertReparse(st, before)
}

function register(st){
    it('AT3: rolling back the evicting close restores the hashes and re-NULLs deactivation_block on stakes AND delegations', async function () { await rollsBackTheEviction(st) })
}

module.exports = { register }
