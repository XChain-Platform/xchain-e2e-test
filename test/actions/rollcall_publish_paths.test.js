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
 * The union rule is what makes an absence impossible to manufacture: any number
 * of ROLLCALL actions may land for one epoch, from anyone, and the present set
 * is their UNION, so a publisher can add signers but never remove them. This
 * suite drives the three consequences the acceptance list names:
 *
 *   AT6a  a SWEEPER lands an omitted signature. The leader publishes while one
 *         hub is still silent; that hub then signs, and a second hub publishes
 *         ONLY the missing pair, which the close counts as presence.
 *   AT6b  a SELF-PUBLISH lands. With every hub's sweep path shut, the omitted
 *         hub rescues its own signature in a one-pair action naming itself as
 *         publisher, byte-identical to the frozen vector's own self-publish
 *         wire case.
 *   AT6c  a BELOW-THRESHOLD epoch closes UNROLLED, with no absences and no
 *         reward. An epoch that does not reach the strict 2/3 stake bar counts
 *         for nobody, which is what stops a partition or a fee spike from
 *         evicting anyone.
 *
 * HOW THE PUBLISH PATHS ARE STEERED, and why that is honest. RollcallRound's
 * three publish tunables (publishDelayBlocks, electionToleranceBlocks,
 * selfPublishBlocks) are hub POLICY, not consensus: the engine's own comment
 * says no chain rule reads any of them, which is why they live in the hub and
 * not in rollcall_activation.js. Setting them per hub here configures a hub; it
 * does not fake a chain fact. Nothing else about the drive is simulated: the
 * signatures are real, the DOGE transactions are real, and every verdict is read
 * back from the two indexers' own tables.
 *
 * VENUE: bootstrapped on the BITCOIN regtest stack (COIN=bitcoin), with the
 * DOGECOIN regtest stack up. See test/helpers/rollcallHelper.js bringUpVenue for
 * the full precondition list; E2E_REQUIRE_FEDERATION=1 opts in.
 *
 ********************************************************************/

'use strict'

const assert = require('assert')

const rc = require('../helpers/rollcallHelper')
const { requireFederationEnv } = require('../helpers/federationGuards')

// The hub whose signature is omitted and then rescued. Never the pair that has
// to carry quorum on its own.
const OMITTED_HUB = 2

// A publish delay no epoch can reach, so no hub publishes until this suite says
// so. The accept window is 12 blocks on regtest, so anything past that is
// effectively "never" while still being an ordinary integer the engine accepts.
const NEVER = 999

// Shared by the parts below. Filled in by the before hook, read by every leg.
const st = { ctx: null, omittedSource: null, EA: null, EB: null, EC: null }

// ── engine drivers ───────────────────────────────────────────────────────────

// Both tunables are restored after every leg so one leg cannot silently
// change the next one's publish behaviour.
function setPublishPolicy(policy){
    for (let i = 0; i < st.ctx.rounds.length; i++){
        if (policy.publishDelay   !== undefined) st.ctx.rounds[i].publishDelayBlocks = policy.publishDelay
        if (policy.selfPublish    !== undefined) st.ctx.rounds[i].selfPublishBlocks  = policy.selfPublish
    }
}

// The elected leader for `epoch`, as the hubs themselves resolved it. Read
// from the engine rather than recomputed, because the election preimage is
// shared with the BTC close and a second copy here could disagree with the
// one that actually pays.
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

// Tick exactly one hub. driveEpoch's tickAll is the normal path; the publish
// legs need a single engine to act so the sweeper's filtered publish is
// attributable to one hub.
async function tickOne(i){ await st.ctx.rounds[i].tick() }

// Wait until hub `i` ITSELF holds `n` signatures for `epoch`. waitForGossip
// returns on the mesh-wide maximum, and the leg then ticks one specific hub
// to publish: on 2026-09-04 the leader published a single pair for epoch
// 4710 because the other running hub's gossip had reached a third engine
// but not the leader yet. The publishing hub's own count is the only one
// that decides what its action carries.
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
    assert.fail('hub ' + i + ' holds ' + have + ' of the ' + n + ' signature(s) it needs for epoch ' + epoch +
                ' after ' + (timeoutMs || 60000) + 'ms; gossip from a running hub never reached it')
}

// Let hub `i` publish on this one tick, then shut its publish path again.
async function publishOnce(i){
    st.ctx.rounds[i].publishDelayBlocks = 0
    await tickOne(i)
    st.ctx.rounds[i].publishDelayBlocks = NEVER
}

function lastWire(){
    const wires = st.ctx.publishedWires
    return rc.parseWire(wires[wires.length - 1].payload)
}

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

// The pubkeys of the roster entries the harness runs, minus the omitted hub.
function runningPubkeys(){
    return st.ctx.roster.slice(0, st.ctx.rounds.length)
        .filter((internal, i) => i !== OMITTED_HUB).map(r => r.pubkey)
}

function allHubPubkeys(){
    return st.ctx.roster.slice(0, st.ctx.rounds.length).map(r => r.pubkey)
}

// Mine through the window end and the DOGE maturity, then to the close block.
async function mineToClose(epoch){
    const { ctx } = st
    await rc.mineBtcTo(ctx, rc.rca().rollcallWindowEndHeight(epoch, ctx.network), 'window end for epoch ' + epoch)
    await rc.mineDoge(ctx, 2 + Number(rc.rca().ROLLCALL_DOGE_MATURITY[ctx.network]) + 2)
    await rc.mineBtcTo(ctx, rc.closeHeightOf(epoch, ctx.network), 'close of epoch ' + epoch)
}

// Take the omitted hub down, bury the epoch, and let the two running hubs sign.
// The skip set is the outage. waitForGossip ticks every engine it is not
// told to skip, and RollcallRound.stop() only stops the engine's own
// timer, so without it the "omitted" hub signed and gossiped on the first
// poll: measured in every recorded AT6 epoch (3600, 3630, 3720, 3750),
// hub 2's signature landed within 20 ms of the other two, the leader's
// action then carried three pairs, and there was nothing left to sweep.
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
        'epoch ' + epoch + ': the elected leader must be one of the two hubs that are up, got index ' + leaderIdx +
        (extra || ''))
    return leaderIdx
}

// ── venue hooks ──────────────────────────────────────────────────────────────

// CHOOSE THE EPOCHS BY THEIR ELECTION, rather than taking the next three
// and hoping. AT6a and AT6b both need the elected leader to be a hub this
// harness is RUNNING and is not silencing, and the election is hashOrder
// over the whole oracle_publish key set - which includes the idle fourth
// staker, who runs no hub at all. On a four-member roster with hub 2
// omitted that leaves two usable leaders out of four, so half of all runs
// failed on a draw and the message invited the reader to re-run into
// another draw. The order is deterministic given (epoch, key set), so the
// right move is to ask which epochs are usable and take those.
//
// Falls back to the next three epochs when the engine cannot resolve a
// future epoch's capability set: a run that cannot look ahead is exactly
// the old behaviour, and the leader assertions still say what happened.
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

    // AT6a and AT6b both need the epoch to ROLL once the omitted signature is
    // rescued, and to be short of quorum until it is: that gap is the whole
    // point of a sweeper. AT6c needs the opposite.
    rc.assertOutageStillRolls(ctx, [ctx.idleSource])
    rc.assertOutageFallsBelowThreshold(ctx, [ctx.idleSource, st.omittedSource, ctx.sourceOf(1)])

    await chooseEpochs()
    console.log('    AT6a epoch ' + st.EA + ', AT6b epoch ' + st.EB + ', AT6c epoch ' + st.EC +
                '; omitted hub ' + OMITTED_HUB + ' at source ' + st.omittedSource)
}

// ── AT6a parts ───────────────────────────────────────────────────────────────

// Nobody publishes on the signing tick, so the leader's action carries
// exactly the signatures that had reached it, which is what creates the
// gap a sweeper exists to fill.
async function landLeaderActionOfTwo(){
    const { ctx, EA } = st
    await silenceOmittedHubAndSign(EA)

    const leaderIdx = assertLeaderIsRunning(EA,
        '. The election is hashOrder over the whole oracle_publish key set, which includes the IDLE fourth ' +
        'staker (index ' + rc.IDLE_SEED_INDEX + '), who runs no hub and can win it. The before hook picks ' +
        'epochs whose leader is a running hub, so reaching this means the election could not be resolved ' +
        'ahead of time: re-run, which draws a different epoch.')

    const wiresBefore = ctx.publishedWires.length
    await waitForHubGossip(leaderIdx, EA, 2)
    await publishOnce(leaderIdx)
    assert.strictEqual(ctx.publishedWires.length, wiresBefore + 1,
        'the leader must land exactly one ROLLCALL for epoch ' + EA)

    // Read by field name: a gates-armed venue publishes v1, whose GATES field
    // sits where v0 keeps SIG_COUNT, so positional offsets misread it.
    const leaderWire = lastWire()
    assert.strictEqual(leaderWire.sigCount, 2,
        'the leader\'s action must carry the two signatures it had, not the third it never saw; SIG_COUNT=' +
        leaderWire.sigCount)
    // WAIT for the leader's action to be on chain, do not mine a fixed few
    // blocks and hope. The sweeper's whole job is to publish only what is
    // MISSING, and maybePublish decides that by asking the DOGE side what it
    // already holds - so a sweeper that ticks first sees an empty chain, has
    // nothing to filter, and republishes the whole set.
    await rc.waitForOnChainSigners(ctx, EA, runningPubkeys())
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
        'epoch ' + epoch + ': all three signatures must be gossiped before a sweeper can carry the third, saw ' +
        gossiped)
}

// UNLOCK THE SWEEPER'S RANK BEFORE TICKING IT. publishDelayBlocks is only
// the first gate in maybePublish; the second is the rank ladder, which
// climbs with BTC HEIGHT (rank r publishes once tip - E >= r * tolerance)
// and a tick at a fixed height cannot pass it. This leg ticks at about
// E + 6, so a rank-3 sweeper on a four-key roster never publishes and the
// assertion below reads as "the sweeper did not sweep" when the engine
// was correctly waiting for block E + 9. Same trap driveEpoch pays for by
// mining forward through the publish phase.
async function unlockSweeperRank(sweeperIdx){
    const { ctx, EA } = st
    const windowEnd = rc.rca().rollcallWindowEndHeight(EA, ctx.network)
    const sweeperRank = Number(ctx.rounds[sweeperIdx].getStatus().our_rank)
    assert.ok(Number.isFinite(sweeperRank) && sweeperRank >= 1,
        'the sweeper hub ' + sweeperIdx + ' must have resolved its election rank for epoch ' + EA +
        ' (got ' + sweeperRank + '); it ticked and signed, so an unresolved order means the capability set ' +
        'at the epoch could not be read')
    const unlockAt = EA + sweeperRank * rc.electionTolerance(ctx.network)
    assert.ok(unlockAt <= windowEnd,
        'sweeper rank ' + sweeperRank + ' unlocks at ' + unlockAt + ', past the accept window end ' + windowEnd)
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
        'a sweeper publishes ONLY what is missing: maybePublish filters out every pair already on chain, so ' +
        'SIG_COUNT must be 1, got ' + sweepWire.sigCount)
    assert.strictEqual(sweepWire.pairs[0].pubkey, ctx.roster[OMITTED_HUB].pubkey,
        'the swept pair must be the omitted hub\'s')
    assert.strictEqual(sweepWire.publisher, ctx.roster[sweeperIdx].pubkey,
        'PUBLISHER names the sweeper, not the leader: the chain pays only the ELECTED leader, so the field is ' +
        'a claim the close checks rather than a race anyone can win')
}

// Wait for the DOGE side to HOLD all three, not for a fixed few blocks:
// the sweep rides the same two-phase lane as the leader's action.
// Two actions, one union. This is the DOGE side's own record.
async function assertUnionOfTwoActions(){
    const { ctx, EA } = st
    await rc.waitForOnChainSigners(ctx, EA, allHubPubkeys())
    const signers = await rc.dogeSigners(ctx, EA)
    assert.strictEqual(signers.length, 3,
        'epoch ' + EA + ': the DOGE side must hold three signers as the UNION of two actions, got ' +
        signers.length)
    assert.strictEqual(new Set(signers.map(s => Number(s.action_index))).size, 2,
        'the three signers must have arrived in TWO separate ROLLCALL actions')
    for (const s of signers)
        assert.strictEqual(String(s.ledger_hash).toLowerCase(), String(signers[0].ledger_hash).toLowerCase(),
            'every counted signature is bound to the same BTC epoch ledger_hash')
}

// The close must then treat the swept hub as PRESENT.
async function assertSweptHubCounted(){
    const { ctx, EA } = st
    await mineToClose(EA)
    const row = await pollRollcallRow(EA)
    assert.ok(row, 'epoch ' + EA + ' wrote no `rollcalls` row at its close block ' + rc.closeHeightOf(EA, ctx.network))
    assert.strictEqual(Number(row.rolled), 1, 'epoch ' + EA + ' must ROLL once the sweeper filled the gap')

    const abs = await rc.absenceRows(ctx, EA)
    assert.ok(!abs.some(r => String(r.source) === st.omittedSource),
        'AT6a: the swept hub must NOT be absent for epoch ' + EA + '; a sweeper that lands a signature the ' +
        'close does not count has rescued nothing. Absent: ' + JSON.stringify(abs.map(r => r.source)))
}

// ── AT6b parts ───────────────────────────────────────────────────────────────

async function landLeaderActionOfTwoForB(){
    const { ctx, EB } = st
    await silenceOmittedHubAndSign(EB)

    const leaderIdx = assertLeaderIsRunning(EB)
    const wiresBefore = ctx.publishedWires.length
    await waitForHubGossip(leaderIdx, EB, 2)
    await publishOnce(leaderIdx)
    assert.strictEqual(lastWire().sigCount, 2,
        'the leader\'s action must carry both running hubs\' signatures, or the epoch cannot roll on the ' +
        'self-publish alone; SIG_COUNT=' + lastWire().sigCount)
    // The leader's action must be ON CHAIN before the omitted hub decides to
    // self-publish: maybeSelfPublish asks the DOGE side whether its own
    // signature is already there, and an unresolved read publishes anyway.
    await rc.waitForOnChainSigners(ctx, EB, runningPubkeys())
    return wiresBefore
}

// Every sweep path stays shut. The only route left for the omitted hub's
// signature is the censorship escape hatch: its own one-pair publish.
async function selfPublishOmittedHub(wiresBefore){
    const { ctx, EB } = st
    await ctx.rounds[OMITTED_HUB].start()
    await tickOne(OMITTED_HUB)
    ctx.rounds[OMITTED_HUB].selfPublishBlocks = 1
    await tickOne(OMITTED_HUB)
    ctx.rounds[OMITTED_HUB].selfPublishBlocks = NEVER

    assert.strictEqual(ctx.publishedWires.length, wiresBefore + 2,
        'exactly two actions must have landed for epoch ' + EB + ': the leader\'s, and the self-publish. ' +
        'A third means a sweep path fired despite its delay, and this leg is not measuring what it claims.')
}

// Byte-compare against a wire this harness builds independently, which is
// the same shape the frozen vector pins as its self-publish case.
async function assertSelfWireMatchesVector(){
    const { ctx, EB } = st
    const selfWire = ctx.publishedWires[ctx.publishedWires.length - 1].payload
    const bh = await indexerConnector.call('getblockhashes', { block_index: EB })
    const ledgerHash = String(bh.ledger_hash).toLowerCase()
    const mySig = rc.signCanonical(ctx.roster[OMITTED_HUB].seed, rc.canonical(ctx.network, EB, ledgerHash))
    const expected = rc.buildWire(EB, ledgerHash, ctx.roster[OMITTED_HUB].pubkey,
                                  [{ pubkey: ctx.roster[OMITTED_HUB].pubkey, sig: mySig }])
    assert.strictEqual(selfWire, expected,
        'AT6b: the self-publish wire must be a one-pair ROLLCALL naming the lone signer as PUBLISHER.\n' +
        '  on chain: ' + selfWire + '\n  expected: ' + expected)
}

// Same rule as AT6a: wait for the DOGE side to HOLD it rather than
// mining a fixed few blocks and reading. The two-phase P2SH lane means a
// publish that has returned is not yet a publish that is indexed.
async function assertSelfPublishStored(){
    const { ctx, EB } = st
    const omittedKey = ctx.roster[OMITTED_HUB].pubkey
    await rc.waitForOnChainSigners(ctx, EB, [omittedKey])
    const signers = await rc.dogeSigners(ctx, EB)
    const selfRows = signers.filter(s => String(s.pubkey).toLowerCase() === omittedKey)
    assert.ok(selfRows.length >= 1, 'the self-published signature must be stored on the DOGE side for epoch ' + EB)
    // EVERY stored row for the omitted key must name it as publisher, not just
    // the first one found. A row published by anyone else means a sweep path
    // carried this signature despite being shut, and this leg then measured
    // the sweeper rather than the self-publish: on 2026-09-03 the first row
    // for the key was the leader's three-pair action and the assertion below
    // read it as "wrong publisher" when the real defect was upstream.
    const foreign = selfRows.filter(s => String(s.publisher).toLowerCase() !== omittedKey)
    assert.deepStrictEqual(foreign, [],
        'AT6b: every stored row for the omitted hub\'s key must carry the self-publisher as PUBLISHER; ' +
        'these were published by someone else, so a sweep path fired despite its delay: ' +
        JSON.stringify(foreign.map(s => ({ publisher: String(s.publisher).slice(0, 12), action_index: s.action_index }))))
}

async function assertSelfPublishedHubCounted(){
    const { ctx, EB } = st
    await mineToClose(EB)
    const row = await pollRollcallRow(EB)
    assert.ok(row, 'epoch ' + EB + ' wrote no `rollcalls` row at its close block ' + rc.closeHeightOf(EB, ctx.network))
    assert.strictEqual(Number(row.rolled), 1, 'epoch ' + EB + ' must ROLL with all three signatures on chain')
    const abs = await rc.absenceRows(ctx, EB)
    assert.ok(!abs.some(r => String(r.source) === st.omittedSource),
        'AT6b: a hub that self-published must NOT be absent for epoch ' + EB + '. Absent: ' +
        JSON.stringify(abs.map(r => r.source)))
}

// ── AT6c parts ───────────────────────────────────────────────────────────────

// Only hub 0 signs. The precondition in before() already established that
// this falls short of the strict 2/3 bar on this venue's weights.
// Returns the epoch's `rollcalls` row, or null if none landed.
async function closeWithOnlyHubZero(){
    const { ctx, EC } = st
    setPublishPolicy({ publishDelay: 0, selfPublish: NEVER })
    await ctx.rounds[1].stop()
    await ctx.rounds[2].stop()

    await rc.mineBtcTo(ctx, EC + 6, 'burying epoch ' + EC)
    await tickOne(0)
    await rc.mineDoge(ctx, 3)
    await tickOne(0)
    await rc.mineDoge(ctx, 3)

    await mineToClose(EC)
    const row = await pollRollcallRow(EC)
    await ctx.rounds[1].start()
    await ctx.rounds[2].start()
    return row
}

async function assertClosedUnrolled(row){
    const { ctx, EC } = st
    assert.ok(row,
        'epoch ' + EC + ' wrote no `rollcalls` row. An UNROLLED epoch still writes its row, and that row is ' +
        'what the dashboard\'s consecutive-unrolled alarm reads, so a missing one is a broken detector rather ' +
        'than a quiet chain.')
    assert.strictEqual(Number(row.rolled), 0,
        'AT6c: epoch ' + EC + ' must close UNROLLED. Quorum is measured over the WHOLE federation, not over ' +
        'who answered, so one signer out of four sources cannot roll it.')
    assert.strictEqual(row.responsible_set_json, null,
        'AT6c: an UNROLLED epoch pins no responsible set. That field exists to pin K-streak membership, and ' +
        'an epoch that counts for nobody has none.')

    const abs = await rc.absenceRows(ctx, EC)
    assert.deepStrictEqual(abs, [],
        'AT6c: an UNROLLED epoch must write NO absences. It counts for nobody, which is exactly what stops a ' +
        'partition or a fee spike from evicting a live federation. Got ' + JSON.stringify(abs))
}

async function assertNoRewardAndNoStreak(){
    const { ctx, EC } = st
    const rewards = await rc.rollcallRewards(ctx, EC)
    assert.deepStrictEqual(rewards, [],
        'AT6c: an UNROLLED epoch must mint no rollcall_publish reward. The reward is written after the quorum ' +
        'gate, so a row here means a leader was paid for an epoch the chain did not count. Got ' +
        JSON.stringify(rewards))

    // The absence of a verdict must not leak into the next epoch's streak
    // either: an unrolled epoch is skipped by the K-streak walk, never counted.
    const lookback = await ctx.idxQuery(
        'SELECT epoch_height, rolled FROM rollcalls WHERE epoch_height = ?', [EC])
    assert.strictEqual(Number(lookback[0].rolled), 0,
        'getRolledRollcallEpochs filters on rolled = 1, so this row must stay 0 or it would enter a K-streak')
}

// ── suites ───────────────────────────────────────────────────────────────────

function describeSweeper(){
    it('AT6a: a sweeper lands the signature the leader omitted, and the close counts it as presence', async function () {
        const { leaderIdx, wiresBefore } = await landLeaderActionOfTwo()
        await reviveOmittedHub(st.EA)
        await landSweeperAction(leaderIdx, wiresBefore)
        await assertUnionOfTwoActions()
        await assertSweptHubCounted()
    })
}

function describeSelfPublish(){
    it('AT6b: the omitted hub rescues its own signature with a one-pair self-publish', async function () {
        const wiresBefore = await landLeaderActionOfTwoForB()
        await selfPublishOmittedHub(wiresBefore)
        await assertSelfWireMatchesVector()
        await assertSelfPublishStored()
        await assertSelfPublishedHubCounted()
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
