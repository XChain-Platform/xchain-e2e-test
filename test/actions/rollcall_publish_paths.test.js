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
 * E2E acceptance: ROLLCALL publish paths (AT6).
 *
 * Any number of ROLLCALL actions may land for one epoch, from anyone, and the
 * present set is their UNION, so a publisher can add signers but never remove
 * them. Three consequences:
 *
 *   AT6a  a SWEEPER lands an omitted signature: the leader publishes while one
 *         hub is silent, that hub then signs, and a second hub publishes ONLY
 *         the missing pair, which the close counts as presence.
 *   AT6b  a SELF-PUBLISH lands: with every sweep path shut, the omitted hub
 *         rescues itself in a one-pair action naming itself as publisher.
 *   AT6c  a BELOW-THRESHOLD epoch closes UNROLLED, with no absences and no
 *         reward, so a partition or fee spike cannot evict anyone.
 *
 * The three publish tunables (publishDelayBlocks, electionToleranceBlocks,
 * selfPublishBlocks) are hub POLICY, not consensus, so setting them per hub
 * configures a hub without faking a chain fact. Signatures and DOGE
 * transactions are real, and every verdict is read from the indexers' tables.
 *
 * VENUE: BITCOIN regtest stack, DOGECOIN regtest stack up (rollcallHelper
 * bringUpVenue). E2E_REQUIRE_FEDERATION=1 opts in.
 ********************************************************************/

'use strict'

const assert = require('assert')

const rc = require('../helpers/rollcallHelper')
const { requireFederationEnv } = require('../helpers/federationGuards')

// The hub whose signature is omitted and then rescued.
const OMITTED_HUB = 2
// A publish delay no epoch can reach (the accept window is 12 blocks on regtest).
const NEVER = 999
// Shared by the parts below; filled in by the before hook.
const st = { ctx: null, omittedSource: null, EA: null, EB: null, EC: null }

function setPublishPolicy(policy){
    for (const round of st.ctx.rounds){
        if (policy.publishDelay !== undefined) round.publishDelayBlocks = policy.publishDelay
        if (policy.selfPublish  !== undefined) round.selfPublishBlocks  = policy.selfPublish
    }
}

// The elected leader for `epoch`, read from the engine rather than recomputed,
// so a second copy of the election preimage cannot disagree with the payer.
function leaderIndexFor(epoch){
    const { ctx } = st
    for (const r of ctx.rounds){
        const s = r.getStatus()
        if (s.epoch === epoch && s.leader){
            const idx = ctx.roster.findIndex(x => x.pubkey === String(s.leader).toLowerCase())
            if (idx >= 0) return idx
        }
    }
    return -1
}

// Tick exactly one hub, so a filtered publish is attributable to it.
async function tickOne(i){ await st.ctx.rounds[i].tick() }

// Wait until hub `i` ITSELF holds `n` signatures for `epoch`: waitForGossip
// returns on the mesh-wide maximum, but only the publisher's own count decides
// what its action carries (epoch 4710 landed a single pair that way).
async function waitForHubGossip(i, epoch, n, timeoutMs){
    const deadline = Date.now() + (timeoutMs || 60000)
    let have = 0
    while (Date.now() < deadline){
        const s = st.ctx.rounds[i].getStatus()
        have = (s && s.epoch === epoch) ? Number(s.gossiped_count || 0) : 0
        if (have >= n) return have
        await tickOne(i)
        await rc.sleep(1000)
    }
    assert.fail('hub ' + i + ' holds ' + have + ' of the ' + n + ' signature(s) it needs for epoch ' + epoch)
}

// Let hub `i` publish on this one tick, then shut its publish path again.
async function publishOnce(i){
    st.ctx.rounds[i].publishDelayBlocks = 0
    await tickOne(i)
    st.ctx.rounds[i].publishDelayBlocks = NEVER
}

const lastWire = () => rc.parseWire(st.ctx.publishedWires.slice(-1)[0].payload)

// Poll for the `rollcalls` row of `epoch`; null when none lands in time.
async function pollRollcallRow(epoch){
    let row = null
    const deadline = Date.now() + 180000
    while (Date.now() < deadline){
        row = await rc.rollcallRow(st.ctx, epoch)
        if (row) break
        await rc.sleep(2000)
    }
    return row
}

// Running roster pubkeys, minus the omitted hub.
function runningPubkeys(){
    return st.ctx.roster.slice(0, st.ctx.rounds.length)
        .filter((internal, i) => i !== OMITTED_HUB).map(r => r.pubkey)
}

const allHubPubkeys = () => st.ctx.roster.slice(0, st.ctx.rounds.length).map(r => r.pubkey)

// Mine through the window end and the DOGE maturity, then to the close block.
async function mineToClose(epoch){
    const { ctx } = st
    await rc.mineBtcTo(ctx, rc.rca().rollcallWindowEndHeight(epoch, ctx.network), 'window end for epoch ' + epoch)
    await rc.mineDoge(ctx, 2 + Number(rc.rca().ROLLCALL_DOGE_MATURITY[ctx.network]) + 2)
    await rc.mineBtcTo(ctx, rc.closeHeightOf(epoch, ctx.network), 'close of epoch ' + epoch)
}

// Take the omitted hub down, bury the epoch, and let the two running hubs sign.
// The skip set is the outage: stop() only stops the engine's own timer, so
// without it waitForGossip ticks the "omitted" hub and it signs anyway.
async function silenceOmittedHubAndSign(epoch){
    const { ctx } = st
    setPublishPolicy({ publishDelay: NEVER, selfPublish: NEVER })
    await ctx.rounds[OMITTED_HUB].stop()
    await rc.mineBtcTo(ctx, epoch + 6, 'burying epoch ' + epoch)
    for (let i = 0; i < ctx.rounds.length; i++) if (i !== OMITTED_HUB) await tickOne(i)
    await rc.waitForGossip(ctx.mvh, epoch, 2, 60000, [OMITTED_HUB])
}

// The elected leader must be one of the two hubs that are up.
function assertLeaderIsRunning(epoch, extra){
    const leaderIdx = leaderIndexFor(epoch)
    assert.ok(leaderIdx >= 0 && leaderIdx < st.ctx.rounds.length && leaderIdx !== OMITTED_HUB,
        'epoch ' + epoch + ': the elected leader must be one of the two hubs that are up, got ' + leaderIdx + (extra || ''))
    return leaderIdx
}

// CHOOSE THE EPOCHS BY THEIR ELECTION. AT6a and AT6b need the elected leader
// to be a running, unsilenced hub, but the election spans the whole key set
// including the idle fourth staker, so a blind draw fails half the runs. The
// order is deterministic given (epoch, key set), so ask which epochs are usable.
// Falls back to the next three when a future capability set cannot be resolved.
async function chooseEpochs(){
    const { ctx } = st
    const tip = await ctx.btcTip()
    const candidates = rc.epochsAfter(tip + 6, ctx.network, 12)
    const usable = []
    for (const e of candidates){
        const idx = await rc.electedLeaderIndex(ctx, e)
        if (idx === null) break                       // cannot look ahead; use the fallback
        if (idx >= 0 && idx < ctx.rounds.length && idx !== OMITTED_HUB) usable.push(e)
        if (usable.length >= 2) break
    }
    if (usable.length >= 2){
        st.EA = usable[0]; st.EB = usable[1]
        st.EC = candidates.find(e => e !== st.EA && e !== st.EB && e > st.EB)
        console.log('    elections resolved ahead: AT6a and AT6b take epochs whose leader is a running hub')
    } else {
        st.EA = candidates[0]; st.EB = candidates[1]; st.EC = candidates[2]
        console.log('    elections could not be resolved ahead of time; taking the next three epochs')
    }
}

async function bringUp(self){
    if (!rc.requireRollcallVenue(self)) return
    if (!requireFederationEnv(self)) return
    const ctx = await rc.bringUpVenue({ hubCount: 3, needSources: 4, requireExactRoster: true,
        dbNamePrefix: 'XChain_BTC_Regtest_ROLLCALLPUB_' })
    st.ctx = ctx
    st.omittedSource = ctx.sourceOf(OMITTED_HUB)
    // AT6a/b need the epoch to ROLL once rescued and fall short until then; AT6c the opposite.
    rc.assertOutageStillRolls(ctx, [ctx.idleSource])
    rc.assertOutageFallsBelowThreshold(ctx, [ctx.idleSource, st.omittedSource, ctx.sourceOf(1)])
    await chooseEpochs()
    console.log('    AT6a epoch ' + st.EA + ', AT6b epoch ' + st.EB + ', AT6c epoch ' + st.EC + '; omitted hub ' + OMITTED_HUB)
}

// Nobody publishes on the signing tick, so the leader's action carries exactly
// the signatures that had reached it: the gap a sweeper (AT6a) or self-publish (AT6b) fills.
async function landLeaderActionOfTwo(epoch){
    const { ctx } = st
    await silenceOmittedHubAndSign(epoch)
    const leaderIdx = assertLeaderIsRunning(epoch,
        '. The election spans the IDLE fourth staker (index ' + rc.IDLE_SEED_INDEX + '), who runs no hub; ' +
        'the before hook picks running-hub epochs, so it could not be resolved ahead: re-run.')
    const wiresBefore = ctx.publishedWires.length
    await waitForHubGossip(leaderIdx, epoch, 2)
    await publishOnce(leaderIdx)
    assert.strictEqual(ctx.publishedWires.length, wiresBefore + 1,
        'the leader must land exactly one ROLLCALL for epoch ' + epoch)
    // By field name: a v1 wire keeps GATES where v0 keeps SIG_COUNT.
    assert.strictEqual(lastWire().sigCount, 2,
        'the leader\'s action must carry the two signatures it had; SIG_COUNT=' + lastWire().sigCount)
    // WAIT for the leader's action on chain: maybePublish filters by what the
    // DOGE side holds, so an early sweeper sees nothing and republishes the set.
    await rc.waitForOnChainSigners(ctx, epoch, runningPubkeys())
    return { leaderIdx, wiresBefore }
}

// The omitted hub comes back, signs, and gossips. Its own sweep path stays
// shut, so anything that lands its signature is somebody else sweeping.
async function reviveOmittedHub(epoch){
    const { ctx } = st
    await ctx.rounds[OMITTED_HUB].start()
    await tickOne(OMITTED_HUB)
    const gossiped = await rc.waitForGossip(ctx.mvh, epoch, 3, 60000)
    assert.ok(gossiped >= 3,
        'epoch ' + epoch + ': all three signatures must be gossiped before a sweeper can carry the third, saw ' + gossiped)
}

// UNLOCK THE SWEEPER'S RANK BEFORE TICKING IT. Past publishDelayBlocks the
// rank ladder climbs with BTC HEIGHT (rank r publishes once tip - E >= r *
// tolerance); a tick near E + 6 leaves a rank-3 sweeper correctly waiting.
async function unlockSweeperRank(sweeperIdx){
    const { ctx, EA } = st
    const windowEnd = rc.rca().rollcallWindowEndHeight(EA, ctx.network)
    const sweeperRank = Number(ctx.rounds[sweeperIdx].getStatus().our_rank)
    assert.ok(Number.isFinite(sweeperRank) && sweeperRank >= 1,
        'the sweeper hub ' + sweeperIdx + ' must have resolved its election rank for epoch ' + EA +
        ' (got ' + sweeperRank + ')')
    const unlockAt = EA + sweeperRank * rc.electionTolerance(ctx.network)
    assert.ok(unlockAt <= windowEnd,
        'sweeper rank ' + sweeperRank + ' unlocks at ' + unlockAt + ', past the window end ' + windowEnd)
    await rc.mineBtcTo(ctx, unlockAt, 'unlocking rank ' + sweeperRank + ' for the sweeper')
}

async function landSweeperAction(leaderIdx, wiresBefore){
    const { ctx, EA } = st
    const sweeperIdx = [0, 1, 2].find(i => i !== leaderIdx && i !== OMITTED_HUB)
    await unlockSweeperRank(sweeperIdx)
    await publishOnce(sweeperIdx)
    assert.strictEqual(ctx.publishedWires.length, wiresBefore + 2,
        'the sweeper must land a second ROLLCALL for epoch ' + EA)
    const sweepWire = lastWire()
    assert.strictEqual(sweepWire.sigCount, 1,
        'a sweeper publishes ONLY what is missing (SIG_COUNT 1), got ' + sweepWire.sigCount)
    assert.strictEqual(sweepWire.pairs[0].pubkey, ctx.roster[OMITTED_HUB].pubkey,
        'the swept pair must be the omitted hub\'s')
    assert.strictEqual(sweepWire.publisher, ctx.roster[sweeperIdx].pubkey,
        'PUBLISHER names the sweeper, not the leader: the close pays only the ELECTED leader')
}

// Two actions, one union, read from the DOGE side's own record.
async function assertUnionOfTwoActions(){
    const { ctx, EA } = st
    await rc.waitForOnChainSigners(ctx, EA, allHubPubkeys())
    const signers = await rc.dogeSigners(ctx, EA)
    assert.strictEqual(signers.length, 3,
        'epoch ' + EA + ': the DOGE side must hold three signers as the UNION of two actions, got ' + signers.length)
    assert.strictEqual(new Set(signers.map(s => Number(s.action_index))).size, 2,
        'the three signers must have arrived in TWO separate ROLLCALL actions')
    for (const s of signers)
        assert.strictEqual(String(s.ledger_hash).toLowerCase(), String(signers[0].ledger_hash).toLowerCase(),
            'every counted signature is bound to the same BTC epoch ledger_hash')
}

// The close must then treat the rescued hub as PRESENT (AT6a swept, AT6b self-published).
async function assertRescuedHubCounted(epoch, tag){
    const { ctx } = st
    await mineToClose(epoch)
    const row = await pollRollcallRow(epoch)
    assert.ok(row, 'epoch ' + epoch + ' wrote no `rollcalls` row at its close block ' + rc.closeHeightOf(epoch, ctx.network))
    assert.strictEqual(Number(row.rolled), 1, 'epoch ' + epoch + ' must ROLL once the omitted signature is on chain')
    const abs = await rc.absenceRows(ctx, epoch)
    assert.ok(!abs.some(r => String(r.source) === st.omittedSource),
        tag + ': the rescued hub must NOT be absent for epoch ' + epoch + '; a signature the close does ' +
        'not count has rescued nothing. Absent: ' + JSON.stringify(abs.map(r => r.source)))
}

// Every sweep path stays shut: only the omitted hub's own one-pair publish remains.
async function selfPublishOmittedHub(wiresBefore){
    const { ctx, EB } = st
    const omitted = ctx.rounds[OMITTED_HUB]
    await omitted.start()
    await tickOne(OMITTED_HUB)
    omitted.selfPublishBlocks = 1
    await tickOne(OMITTED_HUB)
    omitted.selfPublishBlocks = NEVER
    assert.strictEqual(ctx.publishedWires.length, wiresBefore + 2,
        'exactly two actions must land for epoch ' + EB + ': the leader\'s and the self-publish; ' +
        'a third means a sweep path fired despite its delay')
}

// Byte-compare against a wire built independently (the frozen vector's self-publish shape).
async function assertSelfWireMatchesVector(){
    const { ctx, EB } = st
    const selfWire = ctx.publishedWires[ctx.publishedWires.length - 1].payload
    const bh = await indexerConnector.call('getblockhashes', { block_index: EB })
    const ledgerHash = String(bh.ledger_hash).toLowerCase()
    const mySig = rc.signCanonical(ctx.roster[OMITTED_HUB].seed, rc.canonical(ctx.network, EB, ledgerHash))
    const key = ctx.roster[OMITTED_HUB].pubkey
    const expected = rc.buildWire(EB, ledgerHash, key, [{ pubkey: key, sig: mySig }])
    assert.strictEqual(selfWire, expected,
        'AT6b: the self-publish wire must be a one-pair ROLLCALL naming the lone signer as PUBLISHER.\n' +
        '  on chain: ' + selfWire + '\n  expected: ' + expected)
}

async function assertSelfPublishStored(){
    const { ctx, EB } = st
    const omittedKey = ctx.roster[OMITTED_HUB].pubkey
    await rc.waitForOnChainSigners(ctx, EB, [omittedKey])
    const signers = await rc.dogeSigners(ctx, EB)
    const selfRows = signers.filter(s => String(s.pubkey).toLowerCase() === omittedKey)
    assert.ok(selfRows.length >= 1, 'the self-published signature must be stored on the DOGE side for epoch ' + EB)
    // EVERY stored row for the omitted key must name it as publisher: any other
    // row means a shut sweep path fired and this leg measured the sweeper.
    const foreign = selfRows.filter(s => String(s.publisher).toLowerCase() !== omittedKey)
    assert.deepStrictEqual(foreign, [],
        'AT6b: every stored row for the omitted hub\'s key must carry the self-publisher as PUBLISHER; ' +
        'a sweep path fired despite its delay: ' +
        JSON.stringify(foreign.map(s => ({ publisher: String(s.publisher).slice(0, 12), action_index: s.action_index }))))
}

// Only hub 0 signs (below the strict 2/3 bar, per before()). Returns the row or null.
async function closeWithOnlyHubZero(){
    const { ctx, EC } = st
    setPublishPolicy({ publishDelay: 0, selfPublish: NEVER })
    await ctx.rounds[1].stop(); await ctx.rounds[2].stop()
    await rc.mineBtcTo(ctx, EC + 6, 'burying epoch ' + EC)
    for (let n = 0; n < 2; n++){ await tickOne(0); await rc.mineDoge(ctx, 3) }
    await mineToClose(EC)
    const row = await pollRollcallRow(EC)
    await ctx.rounds[1].start(); await ctx.rounds[2].start()
    return row
}

async function assertClosedUnrolled(row){
    const { ctx, EC } = st
    assert.ok(row,
        'epoch ' + EC + ' wrote no `rollcalls` row. An UNROLLED epoch still writes its row (the ' +
        'consecutive-unrolled alarm reads it), so a missing one is a broken detector.')
    assert.strictEqual(Number(row.rolled), 0,
        'AT6c: epoch ' + EC + ' must close UNROLLED: quorum is over the WHOLE federation, not who answered.')
    assert.strictEqual(row.responsible_set_json, null,
        'AT6c: an UNROLLED epoch pins no responsible set (it counts for nobody)')
    const abs = await rc.absenceRows(ctx, EC)
    assert.deepStrictEqual(abs, [],
        'AT6c: an UNROLLED epoch must write NO absences (a partition must not evict a live federation). Got ' +
        JSON.stringify(abs))
}

async function assertNoRewardAndNoStreak(){
    const { ctx, EC } = st
    const rewards = await rc.rollcallRewards(ctx, EC)
    assert.deepStrictEqual(rewards, [],
        'AT6c: an UNROLLED epoch must mint no rollcall_publish reward (written after the quorum gate). Got ' +
        JSON.stringify(rewards))
    // An unrolled epoch is skipped by the K-streak walk, never counted.
    const lookback = await ctx.idxQuery('SELECT epoch_height, rolled FROM rollcalls WHERE epoch_height = ?', [EC])
    assert.strictEqual(Number(lookback[0].rolled), 0,
        'getRolledRollcallEpochs filters on rolled = 1, so this row must stay 0 or it would enter a K-streak')
}

function describeSweeper(){
    it('AT6a: a sweeper lands the signature the leader omitted, and the close counts it as presence', async function () {
        const { leaderIdx, wiresBefore } = await landLeaderActionOfTwo(st.EA)
        await reviveOmittedHub(st.EA)
        await landSweeperAction(leaderIdx, wiresBefore)
        await assertUnionOfTwoActions()
        await assertRescuedHubCounted(st.EA, 'AT6a')
    })
}

function describeSelfPublish(){
    it('AT6b: the omitted hub rescues its own signature with a one-pair self-publish', async function () {
        const { wiresBefore } = await landLeaderActionOfTwo(st.EB)
        await selfPublishOmittedHub(wiresBefore)
        await assertSelfWireMatchesVector()
        await assertSelfPublishStored()
        await assertRescuedHubCounted(st.EB, 'AT6b')
    })
}

function describeBelowThreshold(){
    it('AT6c: a below-threshold epoch closes UNROLLED, with no absences and no reward', async function () {
        const row = await closeWithOnlyHubZero()
        await assertClosedUnrolled(row)
        await assertNoRewardAndNoStreak()
    })
}

describe('ROLLCALL acceptance: sweeper, self-publish and the below-threshold epoch (AT6)', function () {
    this.timeout(45 * 60 * 1000)
    before(async function () { await bringUp(this) })
    after(async function () { await rc.tearDownVenue(st.ctx) })
    describe('AT6a: sweeper', describeSweeper)
    describe('AT6b: self-publish', describeSelfPublish)
    describe('AT6c: below-threshold epoch', describeBelowThreshold)
})
