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

describe('ROLLCALL acceptance: sweeper, self-publish and the below-threshold epoch (AT6)', function () {
    this.timeout(45 * 60 * 1000)

    let ctx = null
    let omittedSource = null
    let EA = null, EB = null, EC = null

    // Both tunables are restored after every leg so one leg cannot silently
    // change the next one's publish behaviour.
    function setPublishPolicy(policy){
        for (let i = 0; i < ctx.rounds.length; i++){
            if (policy.publishDelay   !== undefined) ctx.rounds[i].publishDelayBlocks = policy.publishDelay
            if (policy.selfPublish    !== undefined) ctx.rounds[i].selfPublishBlocks  = policy.selfPublish
        }
    }

    // The elected leader for `epoch`, as the hubs themselves resolved it. Read
    // from the engine rather than recomputed, because the election preimage is
    // shared with the BTC close and a second copy here could disagree with the
    // one that actually pays.
    function leaderIndexFor(epoch){
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
    async function tickOne(i){ await ctx.rounds[i]._tick() }

    before(async function () {
        if (!rc.requireRollcallVenue(this)) return
        if (!requireFederationEnv(this)) return

        ctx = await rc.bringUpVenue({ hubCount: 3, needSources: 4, dbNamePrefix: 'XChain_BTC_Regtest_ROLLCALLPUB_' })
        omittedSource = ctx.sourceOf(OMITTED_HUB)

        // AT6a and AT6b both need the epoch to ROLL once the omitted signature is
        // rescued, and to be short of quorum until it is: that gap is the whole
        // point of a sweeper. AT6c needs the opposite.
        rc.assertOutageStillRolls(ctx, [ctx.idleSource])
        rc.assertOutageFallsBelowThreshold(ctx, [ctx.idleSource, omittedSource, ctx.sourceOf(1)])

        const tip = await ctx.btcTip()
        const epochs = rc.epochsAfter(tip + 6, ctx.network, 3)
        EA = epochs[0]; EB = epochs[1]; EC = epochs[2]
        console.log('    AT6a epoch ' + EA + ', AT6b epoch ' + EB + ', AT6c epoch ' + EC +
                    '; omitted hub ' + OMITTED_HUB + ' at source ' + omittedSource)
    })

    after(async function () { await rc.tearDownVenue(ctx) })

    // ── AT6a ─────────────────────────────────────────────────────────────────

    it('AT6a: a sweeper lands the signature the leader omitted, and the close counts it as presence', async function () {
        const closeBlock = rc.closeHeightOf(EA, ctx.network)
        const windowEnd  = rc.rca().rollcallWindowEndHeight(EA, ctx.network)

        // Nobody publishes on the signing tick, so the leader's action carries
        // exactly the signatures that had reached it, which is what creates the
        // gap a sweeper exists to fill.
        setPublishPolicy({ publishDelay: NEVER, selfPublish: NEVER })
        await ctx.rounds[OMITTED_HUB].stop()

        await rc.mineBtcTo(ctx, EA + 6, 'burying epoch ' + EA)
        for (let i = 0; i < ctx.rounds.length; i++) if (i !== OMITTED_HUB) await tickOne(i)
        await rc.waitForGossip(ctx.mvh, EA, 2, 60000)

        const leaderIdx = leaderIndexFor(EA)
        assert.ok(leaderIdx >= 0 && leaderIdx !== OMITTED_HUB,
            'epoch ' + EA + ': the elected leader must be one of the two hubs that are up, got index ' + leaderIdx +
            '. The election is hashOrder over the oracle_publish keys, so a leader landing on the stopped hub is a ' +
            'seeding accident: re-run, or stop a different hub.')

        const wiresBefore = ctx.publishedWires.length
        ctx.rounds[leaderIdx].publishDelayBlocks = 0
        await tickOne(leaderIdx)
        ctx.rounds[leaderIdx].publishDelayBlocks = NEVER
        assert.strictEqual(ctx.publishedWires.length, wiresBefore + 1,
            'the leader must land exactly one ROLLCALL for epoch ' + EA)

        const leaderWire = ctx.publishedWires[ctx.publishedWires.length - 1].payload.split('|')
        assert.strictEqual(Number(leaderWire[5]), 2,
            'the leader\'s action must carry the two signatures it had, not the third it never saw; SIG_COUNT=' +
            leaderWire[5])
        await rc.mineDoge(ctx, 3)

        // The omitted hub comes back, signs, and gossips. Its own sweep path stays
        // shut, so anything that lands its signature is somebody else sweeping.
        await ctx.rounds[OMITTED_HUB].start()
        await tickOne(OMITTED_HUB)
        const gossiped = await rc.waitForGossip(ctx.mvh, EA, 3, 60000)
        assert.ok(gossiped >= 3,
            'epoch ' + EA + ': all three signatures must be gossiped before a sweeper can carry the third, saw ' +
            gossiped)

        const sweeperIdx = [0, 1, 2].find(i => i !== leaderIdx && i !== OMITTED_HUB)
        ctx.rounds[sweeperIdx].publishDelayBlocks = 0
        await tickOne(sweeperIdx)
        ctx.rounds[sweeperIdx].publishDelayBlocks = NEVER
        assert.strictEqual(ctx.publishedWires.length, wiresBefore + 2,
            'the sweeper must land a second ROLLCALL for epoch ' + EA)

        const sweepWire = ctx.publishedWires[ctx.publishedWires.length - 1].payload.split('|')
        assert.strictEqual(Number(sweepWire[5]), 1,
            'a sweeper publishes ONLY what is missing: _maybePublish filters out every pair already on chain, so ' +
            'SIG_COUNT must be 1, got ' + sweepWire[5])
        assert.strictEqual(String(sweepWire[6]).toLowerCase(), ctx.roster[OMITTED_HUB].pubkey,
            'the swept pair must be the omitted hub\'s')
        assert.strictEqual(String(sweepWire[4]).toLowerCase(), ctx.roster[sweeperIdx].pubkey,
            'PUBLISHER names the sweeper, not the leader: the chain pays only the ELECTED leader, so the field is ' +
            'a claim the close checks rather than a race anyone can win')

        await rc.mineDoge(ctx, 3)

        // Two actions, one union. This is the DOGE side's own record.
        const signers = await rc.dogeSigners(ctx, EA)
        assert.strictEqual(signers.length, 3,
            'epoch ' + EA + ': the DOGE side must hold three signers as the UNION of two actions, got ' +
            signers.length)
        assert.strictEqual(new Set(signers.map(s => Number(s.action_index))).size, 2,
            'the three signers must have arrived in TWO separate ROLLCALL actions')
        for (const s of signers)
            assert.strictEqual(String(s.ledger_hash).toLowerCase(), String(signers[0].ledger_hash).toLowerCase(),
                'every counted signature is bound to the same BTC epoch ledger_hash')

        // The close must then treat the swept hub as PRESENT.
        await rc.mineBtcTo(ctx, windowEnd, 'window end for epoch ' + EA)
        await rc.mineDoge(ctx, 2 + Number(rc.rca().ROLLCALL_DOGE_MATURITY[ctx.network]) + 2)
        await rc.mineBtcTo(ctx, closeBlock, 'close of epoch ' + EA)

        let row = null
        const deadline = Date.now() + 180000
        while (Date.now() < deadline){
            row = await rc.rollcallRow(ctx, EA)
            if (row) break
            await rc.sleep(2000)
        }
        assert.ok(row, 'epoch ' + EA + ' wrote no `rollcalls` row at its close block ' + closeBlock)
        assert.strictEqual(Number(row.rolled), 1, 'epoch ' + EA + ' must ROLL once the sweeper filled the gap')

        const abs = await rc.absenceRows(ctx, EA)
        assert.ok(!abs.some(r => String(r.source) === omittedSource),
            'AT6a: the swept hub must NOT be absent for epoch ' + EA + '; a sweeper that lands a signature the ' +
            'close does not count has rescued nothing. Absent: ' + JSON.stringify(abs.map(r => r.source)))
    })

    // ── AT6b ─────────────────────────────────────────────────────────────────

    it('AT6b: the omitted hub rescues its own signature with a one-pair self-publish', async function () {
        const closeBlock = rc.closeHeightOf(EB, ctx.network)
        const windowEnd  = rc.rca().rollcallWindowEndHeight(EB, ctx.network)

        setPublishPolicy({ publishDelay: NEVER, selfPublish: NEVER })
        await ctx.rounds[OMITTED_HUB].stop()

        await rc.mineBtcTo(ctx, EB + 6, 'burying epoch ' + EB)
        for (let i = 0; i < ctx.rounds.length; i++) if (i !== OMITTED_HUB) await tickOne(i)
        await rc.waitForGossip(ctx.mvh, EB, 2, 60000)

        const leaderIdx = leaderIndexFor(EB)
        assert.ok(leaderIdx >= 0 && leaderIdx !== OMITTED_HUB,
            'epoch ' + EB + ': the elected leader must be one of the two hubs that are up, got index ' + leaderIdx)

        const wiresBefore = ctx.publishedWires.length
        ctx.rounds[leaderIdx].publishDelayBlocks = 0
        await tickOne(leaderIdx)
        ctx.rounds[leaderIdx].publishDelayBlocks = NEVER
        await rc.mineDoge(ctx, 3)

        // Every sweep path stays shut. The only route left for the omitted hub's
        // signature is the censorship escape hatch: its own one-pair publish.
        await ctx.rounds[OMITTED_HUB].start()
        await tickOne(OMITTED_HUB)
        ctx.rounds[OMITTED_HUB].selfPublishBlocks = 1
        await tickOne(OMITTED_HUB)
        ctx.rounds[OMITTED_HUB].selfPublishBlocks = NEVER

        assert.strictEqual(ctx.publishedWires.length, wiresBefore + 2,
            'exactly two actions must have landed for epoch ' + EB + ': the leader\'s, and the self-publish. ' +
            'A third means a sweep path fired despite its delay, and this leg is not measuring what it claims.')

        // Byte-compare against a wire this harness builds independently, which is
        // the same shape the frozen vector pins as its self-publish case.
        const selfWire = ctx.publishedWires[ctx.publishedWires.length - 1].payload
        const bh = await indexerConnector.call('getblockhashes', { block_index: EB })
        const ledgerHash = String(bh.ledger_hash).toLowerCase()
        const mySig = rc.signCanonical(ctx.roster[OMITTED_HUB].seed, rc.canonical(ctx.network, EB, ledgerHash))
        const expected = rc.buildWire(EB, ledgerHash, ctx.roster[OMITTED_HUB].pubkey,
                                      [{ pubkey: ctx.roster[OMITTED_HUB].pubkey, sig: mySig }])
        assert.strictEqual(selfWire, expected,
            'AT6b: the self-publish wire must be a one-pair ROLLCALL naming the lone signer as PUBLISHER.\n' +
            '  on chain: ' + selfWire + '\n  expected: ' + expected)

        await rc.mineDoge(ctx, 3)
        const signers = await rc.dogeSigners(ctx, EB)
        const selfRow = signers.find(s => String(s.pubkey).toLowerCase() === ctx.roster[OMITTED_HUB].pubkey)
        assert.ok(selfRow, 'the self-published signature must be stored on the DOGE side for epoch ' + EB)
        assert.strictEqual(String(selfRow.publisher).toLowerCase(), ctx.roster[OMITTED_HUB].pubkey,
            'the stored row must carry the self-publisher as PUBLISHER')

        await rc.mineBtcTo(ctx, windowEnd, 'window end for epoch ' + EB)
        await rc.mineDoge(ctx, 2 + Number(rc.rca().ROLLCALL_DOGE_MATURITY[ctx.network]) + 2)
        await rc.mineBtcTo(ctx, closeBlock, 'close of epoch ' + EB)

        let row = null
        const deadline = Date.now() + 180000
        while (Date.now() < deadline){
            row = await rc.rollcallRow(ctx, EB)
            if (row) break
            await rc.sleep(2000)
        }
        assert.ok(row, 'epoch ' + EB + ' wrote no `rollcalls` row at its close block ' + closeBlock)
        assert.strictEqual(Number(row.rolled), 1, 'epoch ' + EB + ' must ROLL with all three signatures on chain')
        const abs = await rc.absenceRows(ctx, EB)
        assert.ok(!abs.some(r => String(r.source) === omittedSource),
            'AT6b: a hub that self-published must NOT be absent for epoch ' + EB + '. Absent: ' +
            JSON.stringify(abs.map(r => r.source)))
    })

    // ── AT6c ─────────────────────────────────────────────────────────────────

    it('AT6c: a below-threshold epoch closes UNROLLED, with no absences and no reward', async function () {
        const closeBlock = rc.closeHeightOf(EC, ctx.network)
        const windowEnd  = rc.rca().rollcallWindowEndHeight(EC, ctx.network)

        // Only hub 0 signs. The precondition in before() already established that
        // this falls short of the strict 2/3 bar on this venue's weights.
        setPublishPolicy({ publishDelay: 0, selfPublish: NEVER })
        await ctx.rounds[1].stop()
        await ctx.rounds[2].stop()

        await rc.mineBtcTo(ctx, EC + 6, 'burying epoch ' + EC)
        await tickOne(0)
        await rc.mineDoge(ctx, 3)
        await tickOne(0)
        await rc.mineDoge(ctx, 3)

        await rc.mineBtcTo(ctx, windowEnd, 'window end for epoch ' + EC)
        await rc.mineDoge(ctx, 2 + Number(rc.rca().ROLLCALL_DOGE_MATURITY[ctx.network]) + 2)
        await rc.mineBtcTo(ctx, closeBlock, 'close of epoch ' + EC)

        let row = null
        const deadline = Date.now() + 180000
        while (Date.now() < deadline){
            row = await rc.rollcallRow(ctx, EC)
            if (row) break
            await rc.sleep(2000)
        }
        await ctx.rounds[1].start()
        await ctx.rounds[2].start()

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
    })
})
