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
 *         visible and buried. Deferral is the safe outcome and an empty set is
 *         never information: reading "no signatures found" as "the whole
 *         federation was absent" would evict all of it.
 *   AT10  the ELECTED leader's publish reward is written at the close, is
 *         collectable, and is deleted by a rollback of C.
 *
 * WHAT "ALL THE UNKNOWN CONDITIONS" ACTUALLY MEANS HERE. RollcallProofClient has
 * FIVE, not three, and they are not equally drivable from a suite that may not
 * reconfigure the venue:
 *
 *   (1) unconfigured, or the peer unreachable  - a DEPLOYMENT condition. Driven
 *       only when the operator supplies XC_ROLLCALL_DOGE_STOP_CMD /
 *       XC_ROLLCALL_DOGE_START_CMD; otherwise this leg SKIPS with that reason.
 *   (2) the reply is malformed                 - not reachable from a healthy
 *       peer; covered by xchain-indexer's own unit suite.
 *   (3) no window cut yet (null hcut, or the DOGE tip has not passed the window
 *       end)                                   - DRIVEN below, in its
 *       tip-has-not-passed form. The null-hcut form needs a DOGE chain whose
 *       genesis is later than the BTC window stamp, which no running venue is.
 *   (4) the cut is not buried by ROLLCALL_DOGE_MATURITY - DRIVEN below.
 *   (5) the peer's action-manifest hash differs from ours - a DEPLOYMENT
 *       condition, and the one that is easy to leave out and fatal to leave
 *       out. Asserted as a PRECONDITION (the DOGE indexer must report a real
 *       sha256) rather than driven, because arming it means shipping a
 *       deliberately mismatched image.
 *
 * So this suite drives conditions (3) and (4) plus the clear, and (1) when the
 * operator hands it the commands. The rest are named, not skipped silently.
 *
 * VENUE: bootstrapped on the BITCOIN regtest stack (COIN=bitcoin), with the
 * DOGECOIN regtest stack up. E2E_REQUIRE_FEDERATION=1 opts in.
 *
 ********************************************************************/

'use strict'

const assert = require('assert')
const { execFileSync } = require('child_process')

const rc        = require('../helpers/rollcallHelper')
const chainRail = require('../helpers/chainRail')
const cryptoHelper = require('../cryptoHelper')
const stakeHelper  = require('../helpers/stakeHelper')
const sendHelper   = require('../helpers/sendHelper')
const { requireFederationEnv } = require('../helpers/federationGuards')

// How long a stalled tip must stay stalled before it counts as a deferral rather
// than as ordinary indexing lag. Three DOGE-free polls at the indexer's own block
// cadence is comfortably past the point where a healthy indexer would have moved.
const DEFER_OBSERVATION_MS = 45000

describe('ROLLCALL acceptance: the DOGE proof barrier and the publish reward (AT9, AT10)', function () {
    this.timeout(45 * 60 * 1000)

    let ctx = null
    let E = null, C = null, windowEnd = null
    let leaderPubkey = null, leaderSource = null

    // The BTC indexer is deferring when its tip sits below the node's and refuses
    // to move for a sustained window. Returns the tip it settled on.
    async function assertDeferredAt(height, why){
        const nodeTip = await nodeConnector.getBlockCount()
        assert.ok(nodeTip >= height,
            'the node must already be at or above ' + height + ' for a deferral to be observable; it is at ' + nodeTip)
        const deadline = Date.now() + DEFER_OBSERVATION_MS
        let tip = await ctx.btcTip()
        while (Date.now() < deadline){
            await rc.sleep(5000)
            tip = await ctx.btcTip()
            assert.ok(tip < height,
                'AT9: the BTC indexer reached ' + tip + ' while ' + why + '. The close must DEFER rather than ' +
                'judge: an absence is an eviction, so a wrong "nobody signed" costs a live validator its stake, ' +
                'while a deferral costs a block that will be retried.')
        }
        console.log('    deferred at ' + tip + ' (node ' + nodeTip + ') while ' + why)
        return tip
    }

    async function waitForIndexerToReach(height, why, timeoutMs){
        const deadline = Date.now() + (timeoutMs || 240000)
        let tip = await ctx.btcTip()
        while (Date.now() < deadline){
            tip = await ctx.btcTip()
            if (tip >= height) return tip
            await rc.sleep(3000)
        }
        assert.fail('AT9: the BTC indexer never reached ' + height + ' after ' + why + '; it is stuck at ' + tip +
                    '. The barrier cleared on paper but the block still will not index, so some OTHER unknown ' +
                    'condition is still firing: check the DOGE indexer\'s manifest_hash and the BTC indexer\'s ' +
                    'DOGE_INDEXER_API_URL.')
    }

    async function dogeTip(){
        return await chainRail.withRail(ctx.dogeRail, async () =>
            Number((await indexerConnector.call('getblockhashes', {})).block_index))
    }

    async function pauseDogeMining(){
        await chainRail.withRail(ctx.dogeRail, async () => { await regtestMinerConnector.pauseMining() })
    }
    async function resumeDogeMining(){
        await chainRail.withRail(ctx.dogeRail, async () => { await regtestMinerConnector.resumeMining() })
    }

    before(async function () {
        if (!rc.requireRollcallVenue(this)) return
        if (!requireFederationEnv(this)) return

        // allowDirtyStreaks: this suite SILENCES NO HUB. Every roster hub signs
        // every epoch it drives, so no roster source can gain an absence here and
        // no K-streak can complete: a stale absence carried by a signing source
        // cannot make this run evict anybody, and driving rolled epochs with
        // every hub present is exactly what ages such an absence out of the
        // lookback window. AT9 takes the DOGE INDEXER down, not a hub, which is
        // why that leg does not disqualify the exemption. Without this the file
        // is unrunnable for 2K rolled epochs after any run that left a signing
        // source absent, and the venue has no other way to age the window.
        ctx = await rc.bringUpVenue({ hubCount: 3, needSources: 4, allowDirtyStreaks: true,
                                      dbNamePrefix: 'XChain_BTC_Regtest_ROLLCALLPRF_' })

        // The epoch must ROLL for AT10 to have a reward at all.
        rc.assertOutageStillRolls(ctx, [ctx.idleSource])

        const tip = await ctx.btcTip()
        E = rc.epochsAfter(tip + 6, ctx.network, 1)[0]
        C = rc.closeHeightOf(E, ctx.network)
        windowEnd = rc.rca().rollcallWindowEndHeight(E, ctx.network)
        console.log('    epoch ' + E + ': window end ' + windowEnd + ', close ' + C)
    })

    after(async function () {
        // A paused DOGE miner would leave the venue wedged for the next suite.
        try { await resumeDogeMining() } catch (e) { /* the rail may never have opened */ }
        await rc.tearDownVenue(ctx)
    })

    // ── AT9 ──────────────────────────────────────────────────────────────────

    it('AT9: the close DEFERS on each drivable unknown condition and clears once the DOGE cut is visible and buried', async function () {
        // Sign, gossip and publish normally. The barrier is about VISIBILITY of
        // the DOGE evidence, not about its absence, so the roll call must really
        // be on chain before any of the deferrals below mean anything.
        await rc.mineBtcTo(ctx, E + 6, 'burying epoch ' + E)
        const gossiped = await rc.waitForGossip(ctx.mvh, E, 3, 120000, [], ctx)
        assert.ok(gossiped >= 3, 'epoch ' + E + ': expected three gossiped signatures, saw ' + gossiped)
        // CLIMB the rank ladder; do not tick in place. A hub may publish only at
        // `rank <= floor((btcTip - E) / ELECTION_TOLERANCE)`, so two ticks at
        // E + 6 unlock ranks 0..2 on regtest and the rank-3 hub is barred for the
        // whole run however long anything waits afterwards. Measured 2026-09-04,
        // epoch 5700: all three hubs signed, ranks 0 and 2 landed, and this leg
        // then spent its two-minute wait on a signature no hub was allowed to
        // send. The ceiling is windowEnd - 1 because the window end must be mined
        // AFTER the DOGE freeze below, or conditions (3) and (4) are undrivable.
        const stillOff = await rc.climbPublishLadder(ctx, E, ctx.roster.slice(0, 3).map(r => r.pubkey),
                                                     { maxHeight: windowEnd - 1 })
        // NOT AN ASSERTION, deliberately. The ladder's last tick can publish and
        // the read that follows it races the two-phase P2SH lane: a pair sent
        // seconds ago is on neither chain nor index yet, so "still off chain at
        // the ceiling" is the ordinary shape of a publish that just happened
        // (measured 2026-09-04 on epoch 5910: ranks 2 and 3 both published and
        // this read still saw one key short). The wait below is what decides,
        // because it mines DOGE and polls, and its message now names both causes.
        if (stillOff.length)
            console.log('    epoch ' + E + ': ' + stillOff.length + ' signature(s) not yet indexed at the ladder ' +
                        'ceiling (' + stillOff.map(k => k.slice(0, 12)).join(', ') + '); waiting for the DOGE side.')
        // A ROLLCALL rides the two-phase P2SH lane, so a publish that has
        // returned is not yet indexed: wait for the DOGE side to HOLD all three
        // rather than mining a fixed few blocks and reading (the race both AT6
        // legs lost on 2026-09-03).
        await rc.waitForOnChainSigners(ctx, E, ctx.roster.slice(0, 3).map(r => r.pubkey))

        const onChain = await rc.dogeSigners(ctx, E)
        assert.strictEqual(onChain.length, 3,
            'epoch ' + E + ': all three signatures must be on the DOGE chain before the barrier legs run, got ' +
            onChain.length + '. Otherwise a "deferral" below could just be an epoch nobody published.')

        // FREEZE DOGE FIRST, then mine the BTC window end. Both chains are mined
        // in real time, so the cut basis (the BTC header stamp at E + 12) is later
        // than the frozen DOGE tip stamp only in this order. Reversing it makes
        // condition (3) undrivable, which is why the assert below says so by name
        // rather than failing as an unexplained early clear.
        await pauseDogeMining()
        let frozenTipTime = null
        let maxBlockTime  = null
        try {
            // The BTC window-end header stamp is the cut basis. Everything past
            // this point turns on whether the DOGE chain has passed it.
            await rc.mineBtcTo(ctx, windowEnd, 'window end for epoch ' + E)
            const windowRow = await indexerConnector.call('getblockhashes', { block_index: windowEnd })
            maxBlockTime = Number(windowRow.block_time)
            assert.ok(Number.isFinite(maxBlockTime),
                'the window-end block ' + windowEnd + ' must carry a stored block_time; the close throws ' +
                'RollcallProofUnavailableError without one')

            const dTip = await dogeTip()
            const dRow = await chainRail.withRail(ctx.dogeRail, async () =>
                await indexerConnector.call('getblockhashes', { block_index: dTip }))
            frozenTipTime = Number(dRow.block_time)
            assert.ok(frozenTipTime <= maxBlockTime,
                'AT9 conditions (3) and (4) cannot be driven: the frozen DOGE tip stamp (' + frozenTipTime +
                ') is already past the BTC window-end stamp (' + maxBlockTime + '). The DOGE miner must be paused ' +
                'BEFORE the BTC window end is mined, and this run reached that block too slowly. Re-run; if it ' +
                'persists, the DOGE miner is not honouring pauseMining.')

            // Mine the node past the close and hold there. generateBlocks is used
            // directly rather than mineBtcTo, because mineBtcTo asserts the indexer
            // follows and here it must NOT.
            const nodeTip = await nodeConnector.getBlockCount()
            if (nodeTip < C) await regtestMinerConnector.generateBlocks(C - nodeTip + 1)

            // ── condition (1): the peer is unreachable ──────────────────────
            //
            // Driven inside the freeze so the restart cannot clear conditions (3)
            // and (4) before they are measured.
            if (process.env.XC_ROLLCALL_DOGE_STOP_CMD && process.env.XC_ROLLCALL_DOGE_START_CMD){
                execFileSync('/bin/sh', ['-c', process.env.XC_ROLLCALL_DOGE_STOP_CMD], { stdio: 'inherit' })
                try {
                    await assertDeferredAt(C, 'the DOGE indexer is stopped (condition 1: peer unreachable)')
                } finally {
                    execFileSync('/bin/sh', ['-c', process.env.XC_ROLLCALL_DOGE_START_CMD], { stdio: 'inherit' })
                }
            } else {
                console.log('    [skip] AT9 condition (1), peer unreachable: needs XC_ROLLCALL_DOGE_STOP_CMD and ' +
                            'XC_ROLLCALL_DOGE_START_CMD to take the DOGE indexer down and back up. Named rather ' +
                            'than skipped silently: the condition is real and is untested on this run.')
            }

            // ── condition (3): the DOGE tip has not passed the window end ────
            //
            // The proof client sees tip_block_time <= maxBlockTime and answers
            // unknown, so the close throws and the block is retried forever.
            await assertDeferredAt(C, 'the DOGE tip stamp ' + frozenTipTime + ' has not passed the window end ' +
                                      maxBlockTime + ' (condition 3)')

            // ── condition (4): the cut exists but is not buried ──────────────
            //
            // One DOGE block past the cut basis satisfies condition (3) and fails
            // condition (4): tip is hcut + 1, and the maturity is 2.
            await chainRail.withRail(ctx.dogeRail, async () => {
                await regtestMinerConnector.generateBlocks(1)
                await utxoTrackerConnector.quiesce({ timeoutMs: 60000, pollMs: 250, regtestMiner: regtestMinerConnector })
            })
            const probe = await chainRail.withRail(ctx.dogeRail, async () =>
                await indexerConnector.call('getrollcallsigners', {
                    network: ctx.network, epoch_height: E, max_block_time: maxBlockTime,
                    pubkeys: ctx.roster.slice(0, 3).map(r => r.pubkey), publishers: [],
                }))
            const maturity = Number(rc.rca().ROLLCALL_DOGE_MATURITY[ctx.network])
            assert.ok(Number.isFinite(Number(probe.hcut)),
                'AT9 condition (4): the DOGE peer must now report a real hcut, got ' + JSON.stringify(probe.hcut))
            assert.ok(Number(probe.tip_block_index) < Number(probe.hcut) + maturity,
                'AT9 condition (4) cannot be driven: the DOGE tip ' + probe.tip_block_index + ' is already buried ' +
                'past hcut ' + probe.hcut + ' + maturity ' + maturity + '. Mine fewer DOGE blocks for this leg.')
            await assertDeferredAt(C, 'the DOGE cut ' + probe.hcut + ' is not buried by ' + maturity +
                                      ' blocks (condition 4)')
        } finally {
            await resumeDogeMining()
        }

        // ── the clear ────────────────────────────────────────────────────────
        await rc.mineDoge(ctx, Number(rc.rca().ROLLCALL_DOGE_MATURITY[ctx.network]) + 2)
        const tip = await waitForIndexerToReach(C, 'the DOGE cut became visible and buried')
        assert.ok(tip >= C, 'the BTC indexer must advance through the close once the barrier clears')

        let row = null
        const deadline = Date.now() + 120000
        while (Date.now() < deadline){
            row = await rc.rollcallRow(ctx, E)
            if (row) break
            await rc.sleep(2000)
        }
        assert.ok(row, 'epoch ' + E + ' wrote no `rollcalls` row after the barrier cleared')
        assert.strictEqual(Number(row.rolled), 1,
            'AT9: once the DOGE evidence is visible and buried, the epoch must ROLL. An epoch that rolls UNROLLED ' +
            'here means the close saw an empty set where the DOGE side holds three signatures, which is the ' +
            'exact misreading the barrier exists to prevent.')
        assert.strictEqual(Number(row.close_block), C)
    })

    // ── AT10 ─────────────────────────────────────────────────────────────────

    it('AT10: the elected leader\'s reward is written and collectable, and a rollback of C deletes it', async function () {
        const rewards = await rc.rollcallRewards(ctx, E)
        assert.strictEqual(rewards.length, 1,
            'AT10: the close must mint exactly ONE rollcall_publish reward for epoch ' + E + ', to the ELECTED ' +
            'leader only. Paying whoever published first would be a fee-bidding race no hub can bump, since ' +
            'there is no fee-bump or RBF path anywhere in the hub. Got ' + rewards.length + ': ' +
            JSON.stringify(rewards))

        const reward = rewards[0]
        leaderPubkey = String(reward.signing_pubkey).toLowerCase()
        leaderSource = String(reward.source)

        assert.strictEqual(String(reward.amount), String(rc.rca().ROLLCALL_REWARD_AMOUNT),
            'AT10: the reward is the frozen ROLLCALL_REWARD_AMOUNT, never a value from the wire')
        assert.strictEqual(Number(reward.round_reference), E, 'round_reference is the epoch height')
        assert.strictEqual(Number(reward.round_qualifier), 0, 'round_qualifier is 0 for a roll-call publish')
        assert.strictEqual(Number(reward.block_index), E,
            'AT10: block_index is the EARN block (the epoch), which is what makes the reward collectable ' +
            'immediately at the close rather than at some later height')
        assert.strictEqual(Number(reward.derive_block_index), C,
            'AT10: derive_block_index is the MATERIALIZATION block (the close). This is the field a rollback of ' +
            'C deletes on, and without it a reorg to any height in (E, C] would leave a COLLECT-spendable credit ' +
            'that a from-genesis replay has not derived, which is a ledger-hashed fork.')

        // The leader must be the key the election picked, not whoever published.
        const status = ctx.rounds.map(r => r.getStatus()).find(s => s.epoch === E && s.leader)
        if (status)
            assert.strictEqual(leaderPubkey, String(status.leader).toLowerCase(),
                'AT10: the paid key must be the one the hubs elected. The hub election and the BTC close share ' +
                'the same ordering function and the same XROLLCALL preimage, so a disagreement here means one ' +
                'side has drifted and the chain is paying a validator the federation did not elect.')

        // Collectable, by the exact arithmetic the COLLECT handler gates on.
        const tipNow = await ctx.btcTip()
        const unclaimed = await rc.unclaimedRewardTotal(ctx, leaderSource, tipNow)
        assert.ok(unclaimed >= Number(rc.rca().ROLLCALL_REWARD_AMOUNT),
            'AT10: the leader\'s unclaimed reward total at ' + tipNow + ' is ' + unclaimed + ', which does not ' +
            'cover the ' + rc.rca().ROLLCALL_REWARD_AMOUNT + ' just minted. Collectability is ' +
            'SUM(validator_rewards) minus SUM(valid reward_claims), both scoped by source_id and block_index; ' +
            'there is no collected flag on the row.')

        // A real COLLECT, when the harness holds the leader source's key. Seeding
        // the federation from XC_ROLLCALL_FEDERATION_MNEMONIC is what makes that
        // true; without it the arithmetic above is the strongest honest claim.
        const leaderAddrInfo = ctx.sourceAddressInfo.get(leaderSource)
        if (!leaderAddrInfo){
            console.log('    [skip] AT10 on-chain COLLECT: the harness does not hold the key for the elected ' +
                        'leader\'s staking source ' + leaderSource + '. Seed the federation from ' +
                        'XC_ROLLCALL_FEDERATION_MNEMONIC (address index i for roster entry i) to drive it.')
        } else {
            // FUND THE PROTOCOL REWARD POOL FIRST, when it cannot cover the claim.
            //
            // COLLECT debits the protocol REWARD address and refuses with
            // "invalid: insufficient reward pool" when its balance is under the
            // claim. That address is credited by ATTEST fees on FULFILLED requests
            // and by nothing a roll-call venue does on its own, so on a chain that
            // has never fulfilled an attestation it sits at whatever it was
            // seeded with. Measured on this regtest chain: 2 XCHAIN against a 40
            // XCHAIN claim, which is why AT10's on-chain leg was the ladder's last
            // red for days while every other assertion in the file was green.
            //
            // Topping it up is legitimate rather than a fudge: the pool is an
            // ordinary balance at a protocol address, this drill is asserting the
            // COLLECT path rather than the economics that fill it, and the credit
            // path itself is exercised by the attest ladder instead. The SEND is a
            // real on-chain transaction, so the balance the handler reads is real.
            const rewardAddress = await rc.protocolRewardAddress(ctx)
            const poolBefore    = await rc.addressTickBalance(ctx, rewardAddress, 'XCHAIN')
            // SIZE THE POOL ON THE WHOLE CLAIM, not on this run's single reward.
            // A COLLECT with no AMOUNT claims the source's ENTIRE unclaimed total
            // (`collect.js`: rewardAmount is getUnclaimedRewardTotal, and only an
            // explicit partial AMOUNT narrows it), so the pool must cover THAT.
            // Measured 2026-09-04: the pool was topped up to cover a 10 XCHAIN
            // reward, the leader's accumulated total was 110, and the handler
            // refused `insufficient reward pool` with the funding step having
            // decided there was nothing to do. `unclaimed` above is the same
            // arithmetic the handler runs.
            const claimNeeds    = Math.max(Number(rc.rca().ROLLCALL_REWARD_AMOUNT), Number(unclaimed))
            // BOTH READS MUST BE LOUD. `protocolRewardAddress` and
            // `addressTickBalance` each answer null on a failure they swallow;
            // a null here must fail the drill rather than skip the funding step,
            // or the run goes on to a COLLECT the handler refuses for an unfunded
            // pool while the drill's own log says nothing about the pool.
            // Measured 2026-09-04: two consecutive runs failed
            // `insufficient reward pool` with no `[AT10]` line in either.
            assert.ok(rewardAddress,
                'AT10: the protocol REWARD address did not resolve, so the pool can neither be read nor funded. ' +
                'It comes from the indexer\'s own per-chain role map (protocolAddressRoles); a null here is a ' +
                'broken sibling resolve, not a chain without a reward pool.')
            assert.ok(poolBefore !== null,
                'AT10: the protocol REWARD pool balance at ' + rewardAddress + ' could not be read. That read ' +
                'returns null only when its query throws, so this is an instrument fault and must not be taken ' +
                'as "the pool needs no funding".')
            console.log('    [AT10] reward pool ' + rewardAddress + ' holds ' + poolBefore +
                        ' XCHAIN; the leader\'s unclaimed total is ' + unclaimed + ', so the COLLECT will claim ' +
                        claimNeeds + '.')
            if (poolBefore < claimNeeds){
                const short = claimNeeds - poolBefore
                // Headroom, not the exact shortfall: the close can mint another
                // reward between this read and the COLLECT, and the pool is read
                // at the COLLECT's own (block, action) index.
                const topUp = String(Math.ceil(short + Number(rc.rca().ROLLCALL_REWARD_AMOUNT) * 4))
                console.log('    [AT10] protocol REWARD pool holds ' + poolBefore + ' XCHAIN against a ' +
                            claimNeeds + ' XCHAIN claim (this epoch\'s ' + rc.rca().ROLLCALL_REWARD_AMOUNT +
                            ' plus the leader\'s earlier uncollected rewards); funding it with ' + topUp +
                            ' XCHAIN so the COLLECT path can be driven.')
                await rc.mineWhile(ctx, () =>
                    sendHelper.sendSendV0(leaderAddrInfo, 'XCHAIN', topUp, rewardAddress))
                const poolAfter = await rc.addressTickBalance(ctx, rewardAddress, 'XCHAIN')
                assert.ok(poolAfter !== null && poolAfter >= claimNeeds,
                    'AT10: the reward pool is still ' + poolAfter + ' XCHAIN after funding it with ' +
                    topUp + ' against a claim of ' + claimNeeds + '; the COLLECT below would fail on the pool ' +
                    'rather than on its own logic.')
            }

            const res = await rc.mineWhile(ctx, () => stakeHelper.sendCollectV0(leaderAddrInfo))
            assert.strictEqual(String(res.claim.status), 'valid',
                'AT10: a COLLECT from the leader\'s staking source must be valid; got ' + res.claim.status)
            assert.ok(Number(res.claim.amount) >= Number(rc.rca().ROLLCALL_REWARD_AMOUNT),
                'AT10: the claim must carry at least the roll-call publish reward, got ' + res.claim.amount)
        }

        // The rollback. C is the MATERIALIZATION block, and the reward's own
        // block_index (E) sits far below it, so only the derive-block delete can
        // remove this row. That is the assertion worth making.
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

            // Read the rollback BEFORE the competing chain exists, the way AT3
            // does. The close is a height event, so the replacement block at C
            // re-closes the same epoch and re-derives the same reward; asserting
            // "gone" after that block is mined races the re-parse and can only
            // pass by luck.
            let after = null, row = null, gone = false
            const deadline = Date.now() + 180000
            while (Date.now() < deadline){
                after = await rc.rollcallRewards(ctx, E)
                row   = await rc.rollcallRow(ctx, E)
                gone  = (after.length === 0) && (row === null)
                if (gone) break
                await rc.sleep(2000)
            }
            assert.deepStrictEqual(after, [],
                'AT10: a rollback of the close block ' + C + ' must delete the rollcall_publish reward for epoch ' +
                E + '. Its own block_index is ' + E + ', far below the rollback height, so the earn-block delete ' +
                'cannot reach it: only `DELETE FROM validator_rewards WHERE derive_block_index >= ?` can. A row ' +
                'surviving here is a COLLECT-spendable credit a freshly synced node does not have.')
            assert.strictEqual(row, null,
                'the `rollcalls` row for epoch ' + E + ' must be deleted with it')

            const need = tipBefore - (C - 1) + 2
            for (let i = 0; i < need; i++) await nodeConnector.generateBlock(minerAddr, [])
            assert.ok(await nodeConnector.getBlockCount() > tipBefore, 'the competing chain must overtake the original')
        } finally {
            await regtestMinerConnector.resumeMining()
        }

        // The re-parse must derive the reward exactly ONCE again: the delete
        // above plus one re-derivation, never a survivor beside a fresh row.
        await rc.mineBtcTo(ctx, C, 'reparse of the close')
        let rederived = []
        const deadline2 = Date.now() + 180000
        while (Date.now() < deadline2){
            rederived = await rc.rollcallRewards(ctx, E)
            if (rederived.length) break
            await rc.sleep(2000)
        }
        assert.strictEqual(rederived.length, 1,
            'AT10: the re-parsed close at ' + C + ' must mint the reward exactly once again, got ' +
            rederived.length + ': ' + JSON.stringify(rederived))
        assert.strictEqual(String(rederived[0].signing_pubkey).toLowerCase(), leaderPubkey,
            'the re-derived reward must go to the same elected leader')
        assert.strictEqual(Number(rederived[0].derive_block_index), C)
    })
})
