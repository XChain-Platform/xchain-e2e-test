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
 * E2E acceptance: the DOGE proof barrier and the publish reward (AT9, AT10).
 *
 *   AT9   the BTC block at the close DEFERS on each `unknown` condition the
 *         proof client can be driven into, and CLEARS once the DOGE side is
 *         visible and buried. An empty set is never information: reading "no
 *         signatures found" as "the federation was absent" would evict it all.
 *   AT10  the ELECTED leader's publish reward is written at the close, is
 *         collectable, and is deleted by a rollback of C.
 *
 * RollcallProofClient has FIVE unknown conditions, not all drivable here:
 *   (1) unconfigured or peer unreachable: driven only when the operator supplies
 *       XC_ROLLCALL_DOGE_STOP_CMD / XC_ROLLCALL_DOGE_START_CMD, else it SKIPS.
 *   (2) malformed reply: unreachable from a healthy peer; xchain-indexer's unit suite.
 *   (3) no window cut yet: DRIVEN in its tip-has-not-passed form (the null-hcut
 *       form needs a DOGE genesis later than the BTC window stamp).
 *   (4) cut not buried by ROLLCALL_DOGE_MATURITY: DRIVEN.
 *   (5) peer action-manifest hash differs: asserted as a PRECONDITION (a real
 *       sha256), since arming it means shipping a mismatched image.
 *
 * VENUE: BITCOIN regtest stack (COIN=bitcoin) with the DOGECOIN regtest stack
 * up. E2E_REQUIRE_FEDERATION=1 opts in.
 *
 ********************************************************************/

'use strict'

const assert = require('assert')
const { execFileSync } = require('child_process')

const rc        = require('../helpers/rollcallHelper')
const chainRail = require('../helpers/chainRail')
const cryptoHelper = require('../helpers/core/cryptoHelper')
const stakeHelper  = require('../helpers/stakeHelper')
const sendHelper   = require('../helpers/sendHelper')
const { requireFederationEnv } = require('../helpers/federationGuards')

// How long a stalled tip must stay stalled to count as a deferral, not indexing lag.
const DEFER_OBSERVATION_MS = 45000

// Shared by the parts below; filled in by the before hook.
const st = { ctx: null, E: null, C: null, windowEnd: null, leaderPubkey: null, leaderSource: null }

// Deferring: the indexer tip sits below the node's and refuses to move. Returns its tip.
async function assertDeferredAt(height, why){
    const nodeTip = await nodeConnector.getBlockCount()
    assert.ok(nodeTip >= height,
        'the node must already be at or above ' + height + ' for a deferral to be observable; it is at ' + nodeTip)
    const deadline = Date.now() + DEFER_OBSERVATION_MS
    let tip = await st.ctx.btcTip()
    while (Date.now() < deadline){
        await rc.sleep(5000)
        tip = await st.ctx.btcTip()
        assert.ok(tip < height,
            'AT9: the BTC indexer reached ' + tip + ' while ' + why + '. The close must DEFER, not judge: ' +
            'a wrong "nobody signed" evicts a live validator, a deferral only retries a block.')
    }
    console.log('    deferred at ' + tip + ' (node ' + nodeTip + ') while ' + why)
    return tip
}

async function waitForIndexerToReach(height, why, timeoutMs){
    const deadline = Date.now() + (timeoutMs || 240000)
    let tip = await st.ctx.btcTip()
    while (Date.now() < deadline){
        tip = await st.ctx.btcTip()
        if (tip >= height) return tip
        await rc.sleep(3000)
    }
    assert.fail('AT9: the BTC indexer never reached ' + height + ' after ' + why + '; stuck at ' + tip +
                '. Some OTHER unknown condition still fires: check the DOGE indexer\'s manifest_hash ' +
                'and the BTC indexer\'s DOGE_INDEXER_API_URL.')
}

const dogeTip = () => chainRail.withRail(st.ctx.dogeRail, async () =>
    Number((await indexerConnector.call('getblockhashes', {})).block_index))

const pauseDogeMining  = () => chainRail.withRail(st.ctx.dogeRail, () => regtestMinerConnector.pauseMining())
const resumeDogeMining = () => chainRail.withRail(st.ctx.dogeRail, () => regtestMinerConnector.resumeMining())

// Poll for the `rollcalls` row of the epoch; null when none lands in time.
async function pollRollcallRow(timeoutMs){
    let row = null
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline){
        row = await rc.rollcallRow(st.ctx, st.E)
        if (row) break
        await rc.sleep(2000)
    }
    return row
}

function threeSignerKeys(){ return st.ctx.roster.slice(0, 3).map(r => r.pubkey) }

async function bringUp(self){
    if (!rc.requireRollcallVenue(self)) return
    if (!requireFederationEnv(self)) return
    // allowDirtyStreaks: no hub is silenced here, so no K-streak can complete; AT9 takes the DOGE INDEXER down.
    const ctx = await rc.bringUpVenue({ hubCount: 3, needSources: 4, allowDirtyStreaks: true,
                                        dbNamePrefix: 'XChain_BTC_Regtest_ROLLCALLPRF_' })
    st.ctx = ctx
    // The epoch must ROLL for AT10 to have a reward at all.
    rc.assertOutageStillRolls(ctx, [ctx.idleSource])
    const tip = await ctx.btcTip()
    st.E = rc.epochsAfter(tip + 6, ctx.network, 1)[0]
    st.C = rc.closeHeightOf(st.E, ctx.network)
    st.windowEnd = rc.rca().rollcallWindowEndHeight(st.E, ctx.network)
    console.log('    epoch ' + st.E + ': window end ' + st.windowEnd + ', close ' + st.C)
}

async function tearDown(){
    // A paused DOGE miner would leave the venue wedged for the next suite.
    try { await resumeDogeMining() } catch (e) { /* the rail may never have opened */ }
    await rc.tearDownVenue(st.ctx)
}

// Sign, gossip and publish normally: the roll call must really be on chain first.
async function publishAndBuryRollcall(){
    const { ctx, E, windowEnd } = st
    await rc.mineBtcTo(ctx, E + 6, 'burying epoch ' + E)
    const gossiped = await rc.waitForGossip(ctx.mvh, E, 3, 120000, [], ctx)
    assert.ok(gossiped >= 3, 'epoch ' + E + ': expected three gossiped signatures, saw ' + gossiped)
    // CLIMB the rank ladder (rank <= floor((btcTip - E) / ELECTION_TOLERANCE)), to
    // windowEnd - 1: the window end must be mined AFTER the DOGE freeze below.
    const stillOff = await rc.climbPublishLadder(ctx, E, threeSignerKeys(), { maxHeight: windowEnd - 1 })
    // NOT AN ASSERTION: a just-sent pair races the two-phase P2SH lane; the wait below decides.
    if (stillOff.length) console.log('    epoch ' + E + ': ' + stillOff.length + ' signature(s) not yet indexed; waiting for the DOGE side.')
    // A returned publish is not yet indexed: wait for the DOGE side to HOLD all three.
    await rc.waitForOnChainSigners(ctx, E, threeSignerKeys())
    const onChain = await rc.dogeSigners(ctx, E)
    assert.strictEqual(onChain.length, 3, 'epoch ' + E + ': all three signatures must be on the DOGE chain, got ' + onChain.length)
}

// FREEZE DOGE FIRST, then mine the BTC window end: only in that order is the cut
// basis later than the frozen DOGE tip. Returns { maxBlockTime, frozenTipTime }.
async function mineWindowEndUnderFreeze(){
    const { ctx, E, C, windowEnd } = st
    await rc.mineBtcTo(ctx, windowEnd, 'window end for epoch ' + E)
    const windowRow = await indexerConnector.call('getblockhashes', { block_index: windowEnd })
    const maxBlockTime = Number(windowRow.block_time)
    assert.ok(Number.isFinite(maxBlockTime), 'the window-end block ' + windowEnd + ' must carry a stored block_time')
    const dTip = await dogeTip()
    const dRow = await chainRail.withRail(ctx.dogeRail, () => indexerConnector.call('getblockhashes', { block_index: dTip }))
    const frozenTipTime = Number(dRow.block_time)
    assert.ok(frozenTipTime <= maxBlockTime,
        'AT9 conditions (3) and (4) cannot be driven: the frozen DOGE tip stamp (' + frozenTipTime +
        ') is already past the BTC window-end stamp (' + maxBlockTime + '). Pause the DOGE miner BEFORE ' +
        'the window end; if re-runs persist, pauseMining is not honoured.')
    // Mine past the close and hold; mineBtcTo would assert the indexer follows.
    const nodeTip = await nodeConnector.getBlockCount()
    if (nodeTip < C) await regtestMinerConnector.generateBlocks(C - nodeTip + 1)
    return { maxBlockTime, frozenTipTime }
}

// Condition (1): peer unreachable. Driven inside the freeze so the restart cannot clear (3) and (4).
async function driveUnreachablePeer(){
    if (process.env.XC_ROLLCALL_DOGE_STOP_CMD && process.env.XC_ROLLCALL_DOGE_START_CMD){
        execFileSync('/bin/sh', ['-c', process.env.XC_ROLLCALL_DOGE_STOP_CMD], { stdio: 'inherit' })
        try {
            await assertDeferredAt(st.C, 'the DOGE indexer is stopped (condition 1: peer unreachable)')
        } finally {
            execFileSync('/bin/sh', ['-c', process.env.XC_ROLLCALL_DOGE_START_CMD], { stdio: 'inherit' })
        }
    } else {
        console.log('    [skip] AT9 condition (1), peer unreachable: needs XC_ROLLCALL_DOGE_STOP_CMD and ' +
                    'XC_ROLLCALL_DOGE_START_CMD. Real, and untested on this run.')
    }
}

// Condition (4): one DOGE block past the cut basis satisfies (3) and fails (4).
async function driveUnburiedCut(maxBlockTime){
    const { ctx, E, C } = st
    await chainRail.withRail(ctx.dogeRail, async () => {
        await regtestMinerConnector.generateBlocks(1)
        await utxoTrackerConnector.quiesce({ timeoutMs: 60000, pollMs: 250, regtestMiner: regtestMinerConnector })
    })
    const probe = await chainRail.withRail(ctx.dogeRail, () => indexerConnector.call('getrollcallsigners', {
        network: ctx.network, epoch_height: E, max_block_time: maxBlockTime, pubkeys: threeSignerKeys(), publishers: [],
    }))
    const maturity = Number(rc.rca().ROLLCALL_DOGE_MATURITY[ctx.network])
    assert.ok(Number.isFinite(Number(probe.hcut)),
        'AT9 condition (4): the DOGE peer must now report a real hcut, got ' + JSON.stringify(probe.hcut))
    assert.ok(Number(probe.tip_block_index) < Number(probe.hcut) + maturity,
        'AT9 condition (4) cannot be driven: the DOGE tip ' + probe.tip_block_index + ' is already buried ' +
        'past hcut ' + probe.hcut + ' + maturity ' + maturity)
    await assertDeferredAt(C, 'the DOGE cut ' + probe.hcut + ' is not buried by ' + maturity + ' blocks (condition 4)')
}

async function driveDeferralsUnderFreeze(){
    await pauseDogeMining()
    try {
        const { maxBlockTime, frozenTipTime } = await mineWindowEndUnderFreeze()
        await driveUnreachablePeer()
        // Condition (3): tip_block_time <= maxBlockTime answers unknown, so the close retries.
        await assertDeferredAt(st.C, 'the DOGE tip stamp ' + frozenTipTime + ' has not passed ' + maxBlockTime + ' (condition 3)')
        await driveUnburiedCut(maxBlockTime)
    } finally {
        await resumeDogeMining()
    }
}

async function assertBarrierClears(){
    const { ctx, E, C } = st
    await rc.mineDoge(ctx, Number(rc.rca().ROLLCALL_DOGE_MATURITY[ctx.network]) + 2)
    const tip = await waitForIndexerToReach(C, 'the DOGE cut became visible and buried')
    assert.ok(tip >= C, 'the BTC indexer must advance through the close once the barrier clears')
    const row = await pollRollcallRow(120000)
    assert.ok(row, 'epoch ' + E + ' wrote no `rollcalls` row after the barrier cleared')
    assert.strictEqual(Number(row.rolled), 1,
        'AT9: once the DOGE evidence is visible and buried the epoch must ROLL; UNROLLED means the close ' +
        'saw an empty set where the DOGE side holds three signatures, the misreading the barrier prevents.')
    assert.strictEqual(Number(row.close_block), C)
}

async function assertRewardMinted(){
    const { ctx, E, C } = st
    const rewards = await rc.rollcallRewards(ctx, E)
    assert.strictEqual(rewards.length, 1,
        'AT10: the close must mint exactly ONE rollcall_publish reward for epoch ' + E + ', to the ELECTED ' +
        'leader only (paying the first publisher is a fee race no hub can bump). Got ' + rewards.length +
        ': ' + JSON.stringify(rewards))
    const reward = rewards[0]
    st.leaderPubkey = String(reward.signing_pubkey).toLowerCase()
    st.leaderSource = String(reward.source)
    assert.strictEqual(String(reward.amount), String(rc.rca().ROLLCALL_REWARD_AMOUNT),
        'AT10: the reward is the frozen ROLLCALL_REWARD_AMOUNT, never a value from the wire')
    assert.strictEqual(Number(reward.round_reference), E, 'round_reference is the epoch height')
    assert.strictEqual(Number(reward.round_qualifier), 0, 'round_qualifier is 0 for a roll-call publish')
    assert.strictEqual(Number(reward.block_index), E,
        'AT10: block_index is the EARN block (the epoch), so the reward is collectable at the close')
    assert.strictEqual(Number(reward.derive_block_index), C,
        'AT10: derive_block_index is the MATERIALIZATION block (the close), the field a rollback of C ' +
        'deletes on; without it a reorg into (E, C] leaves a COLLECT-spendable credit a replay never derives.')
}

// The leader must be the key the election picked, not whoever published.
function assertLeaderWasElected(){
    const status = st.ctx.rounds.map(r => r.getStatus()).find(s => s.epoch === st.E && s.leader)
    if (status)
        assert.strictEqual(st.leaderPubkey, String(status.leader).toLowerCase(),
            'AT10: the paid key must be the one the hubs elected; the hub election and the BTC close share ' +
            'one ordering function and XROLLCALL preimage, so a mismatch means one side has drifted.')
}

// Collectable, by the exact arithmetic the COLLECT handler gates on.
async function assertRewardCollectable(){
    const tipNow = await st.ctx.btcTip()
    const unclaimed = await rc.unclaimedRewardTotal(st.ctx, st.leaderSource, tipNow)
    assert.ok(unclaimed >= Number(rc.rca().ROLLCALL_REWARD_AMOUNT),
        'AT10: the leader\'s unclaimed reward total at ' + tipNow + ' is ' + unclaimed + ', which does not ' +
        'cover the ' + rc.rca().ROLLCALL_REWARD_AMOUNT + ' just minted (SUM(validator_rewards) minus ' +
        'SUM(valid reward_claims) by source_id and block_index).')
    return unclaimed
}

// FUND THE PROTOCOL REWARD POOL when it cannot cover the claim: COLLECT refuses
// "insufficient reward pool", and only ATTEST fees credit it. The SEND is real.
async function fundRewardPool(leaderAddrInfo, unclaimed){
    const { ctx } = st
    const rewardAddress = await rc.protocolRewardAddress(ctx)
    const poolBefore    = await rc.addressTickBalance(ctx, rewardAddress, 'XCHAIN')
    // Size on the WHOLE claim: a COLLECT with no AMOUNT claims the ENTIRE unclaimed total.
    const claimNeeds    = Math.max(Number(rc.rca().ROLLCALL_REWARD_AMOUNT), Number(unclaimed))
    // BOTH READS MUST BE LOUD: a swallowed null must fail, not skip the funding.
    assert.ok(rewardAddress,
        'AT10: the protocol REWARD address did not resolve (indexer protocolAddressRoles), so the pool ' +
        'can be neither read nor funded.')
    assert.ok(poolBefore !== null,
        'AT10: the protocol REWARD pool balance at ' + rewardAddress + ' could not be read; that is an ' +
        'instrument fault, not "the pool needs no funding".')
    console.log('    [AT10] reward pool ' + rewardAddress + ' holds ' + poolBefore +
                ' XCHAIN; the leader\'s unclaimed total is ' + unclaimed + ', so the COLLECT will claim ' +
                claimNeeds + '.')
    if (poolBefore >= claimNeeds) return
    // Headroom, not the exact shortfall: the close can mint another reward before the COLLECT.
    const short = claimNeeds - poolBefore
    const topUp = String(Math.ceil(short + Number(rc.rca().ROLLCALL_REWARD_AMOUNT) * 4))
    console.log('    [AT10] pool holds ' + poolBefore + ' XCHAIN against a ' + claimNeeds +
                ' XCHAIN claim; funding it with ' + topUp + ' XCHAIN so the COLLECT can be driven.')
    await rc.mineWhile(ctx, () =>
        sendHelper.sendSendV0(leaderAddrInfo, 'XCHAIN', topUp, rewardAddress))
    const poolAfter = await rc.addressTickBalance(ctx, rewardAddress, 'XCHAIN')
    assert.ok(poolAfter !== null && poolAfter >= claimNeeds,
        'AT10: the reward pool is still ' + poolAfter + ' XCHAIN after funding it with ' + topUp +
        ' against a claim of ' + claimNeeds)
}

// A real COLLECT, when the harness holds the leader source's key (seeded from
// XC_ROLLCALL_FEDERATION_MNEMONIC); otherwise the arithmetic above is the claim.
async function driveCollect(unclaimed){
    const { ctx, leaderSource } = st
    const leaderAddrInfo = ctx.sourceAddressInfo.get(leaderSource)
    if (!leaderAddrInfo){
        console.log('    [skip] AT10 on-chain COLLECT: no key held for the elected leader\'s staking source ' +
                    leaderSource + '. Seed the federation from XC_ROLLCALL_FEDERATION_MNEMONIC.')
        return
    }
    await fundRewardPool(leaderAddrInfo, unclaimed)
    const res = await rc.mineWhile(ctx, () => stakeHelper.sendCollectV0(leaderAddrInfo))
    assert.strictEqual(String(res.claim.status), 'valid',
        'AT10: a COLLECT from the leader\'s staking source must be valid; got ' + res.claim.status)
    assert.ok(Number(res.claim.amount) >= Number(rc.rca().ROLLCALL_REWARD_AMOUNT),
        'AT10: the claim must carry at least the roll-call publish reward, got ' + res.claim.amount)
}

// Read BEFORE the competing chain exists: the replacement block at C re-derives the reward.
async function assertRollbackDeletes(){
    const { ctx, E, C } = st
    let after = null, row = null
    const deadline = Date.now() + 180000
    while (Date.now() < deadline){
        after = await rc.rollcallRewards(ctx, E)
        row   = await rc.rollcallRow(ctx, E)
        if ((after.length === 0) && (row === null)) break
        await rc.sleep(2000)
    }
    assert.deepStrictEqual(after, [],
        'AT10: a rollback of the close block ' + C + ' must delete the rollcall_publish reward for epoch ' +
        E + '; only the derive_block_index delete can reach it, and a survivor is a credit a fresh node lacks.')
    assert.strictEqual(row, null,
        'the `rollcalls` row for epoch ' + E + ' must be deleted with it')
}

// The rollback: only the derive-block delete can remove the row (block_index E is far below C).
async function rollbackCloseBlock(){
    const { ctx, E, C } = st
    const beforeCount = (await rc.rollcallRewards(ctx, E)).length
    assert.strictEqual(beforeCount, 1, 'the reward must still be present before the rollback')
    await regtestMinerConnector.pauseMining()
    try {
        const tipBefore = await nodeConnector.getBlockCount()
        const closeHash = await nodeConnector.getBlockHash(C)
        const minerAddr = (await cryptoHelper.getNewAddress('rollcall-reward-reorg', COIN, NETWORK, null, 'legacy', 0)).address
        await nodeConnector.invalidateBlock(closeHash)
        assert.strictEqual(await nodeConnector.getBlockCount(), C - 1,
            'the node must roll back to the block before the close')
        await assertRollbackDeletes()

        const need = tipBefore - (C - 1) + 2
        for (let i = 0; i < need; i++) await nodeConnector.generateBlock(minerAddr, [])
        assert.ok(await nodeConnector.getBlockCount() > tipBefore, 'the competing chain must overtake the original')
    } finally {
        await regtestMinerConnector.resumeMining()
    }
}

// The re-parse must derive the reward exactly ONCE again, never a survivor beside a fresh row.
async function assertRederivedOnce(){
    const { ctx, E, C } = st
    await rc.mineBtcTo(ctx, C, 'reparse of the close')
    let rederived = []
    const deadline = Date.now() + 180000
    while (Date.now() < deadline){
        rederived = await rc.rollcallRewards(ctx, E)
        if (rederived.length) break
        await rc.sleep(2000)
    }
    assert.strictEqual(rederived.length, 1,
        'AT10: the re-parsed close at ' + C + ' must mint the reward exactly once again, got ' +
        rederived.length + ': ' + JSON.stringify(rederived))
    assert.strictEqual(String(rederived[0].signing_pubkey).toLowerCase(), st.leaderPubkey,
        'the re-derived reward must go to the same elected leader')
    assert.strictEqual(Number(rederived[0].derive_block_index), C)
}

const describeProofBarrier = () => it('AT9: the close DEFERS on each drivable unknown condition and clears once the DOGE cut is visible and buried', async function () {
    await publishAndBuryRollcall()
    await driveDeferralsUnderFreeze()
    await assertBarrierClears()
})

const describePublishReward = () => it('AT10: the elected leader\'s reward is written and collectable, and a rollback of C deletes it', async function () {
    await assertRewardMinted()
    assertLeaderWasElected()
    await driveCollect(await assertRewardCollectable())
    await rollbackCloseBlock()
    await assertRederivedOnce()
})

describe('ROLLCALL acceptance: the DOGE proof barrier and the publish reward (AT9, AT10)', function () {
    this.timeout(45 * 60 * 1000)
    before(async function () { await bringUp(this) })
    after(tearDown)
    describe('AT9: the DOGE proof barrier', describeProofBarrier)
    describe('AT10: the publish reward', describePublishReward)
})
