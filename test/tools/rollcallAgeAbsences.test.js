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
 * VENUE TOOL, not an acceptance test: age a roster source's stale
 * roll-call absence out of the K-streak window so the acceptance suites
 * can run again on a chain that already carries one.
 *
 * WHY THIS EXISTS. rollcallHelper's precondition (assertRosterStreaksClean)
 * refuses any venue where a roster source carries an absence inside the
 * protocol's window, because a suite that silences a hub would then complete
 * the K-streak and the protocol would evict a frozen vector key for good. Its
 * own failure text names the remedy: drive 2K ROLLED epochs with that source
 * PRESENT until the absence ages out. Nothing implemented that remedy, so a
 * venue with one stale absence (2026-09-08: the idle roster key, absent at
 * epoch 4110 after a stale BTC indexer image dropped a whole epoch, then
 * correctly re-judged on the rebuilt one) could only be recovered by a chain
 * reset and a full re-seed. This is the cheaper path.
 *
 * WHAT IT DOES. Brings the venue up with `allowDirtyStreaks`, which is legal
 * because this run silences NOBODY, then drives ROLLCALL_STREAK_LOOKBACK
 * (2K) epochs in which every roster source is present: the three signing hubs
 * through their engines, and the idle fourth key through a one-pair
 * self-publish built from the seed this harness derives for it (the AT6b
 * shape). Every epoch must ROLL with zero absences, or the run stops there
 * rather than pretending. At the end it re-runs the strict precondition and
 * fails unless it is clean, so a green run IS the proof.
 *
 * WHAT IT DOES NOT DO. It does not touch stakes, does not rotate the idle
 * generation, and cannot undo an EVICTION (an evicted key is retired by the
 * protocol; only a fresh chain helps, as the precondition says).
 *
 * BLOCK BUDGET: 2K epochs of 30 BTC blocks plus each close, so about 4 x 45
 * BTC blocks on regtest, DOGE mined throughout. Roughly 40 to 60 minutes.
 *
 * RUN IT EXPLICITLY (test/tools/ is outside the default glob):
 *
 *   E2E_REQUIRE_FEDERATION=1 XC_ROLLCALL_REGTEST_ACTIVATION=armed \
 *     npx mocha --timeout 0 --exit --require ./test/initialCheck.test.js \
 *     test/tools/rollcallAgeAbsences.test.js
 *
 * with the federation mnemonic and idle generation the venue was seeded from
 * in the environment, and XC_ROLLCALL_GATES_REGTEST_ACTIVATION matching the
 * indexer containers (a half-armed venue reads as a federation-wide absence,
 * which is the opposite of what this tool is for).
 *
 ********************************************************************/

'use strict'

const assert = require('assert')

const rc = require('../helpers/rollcallHelper')
const { requireFederationEnv } = require('../helpers/federationGuards')

describe('VENUE TOOL: age stale roll-call absences out of the streak window', function () {
    this.timeout(90 * 60 * 1000)

    let ctx = null
    let epochs = []

    before(async function () {
        if (!rc.requireRollcallVenue(this)) return
        if (!requireFederationEnv(this)) return

        ctx = await rc.bringUpVenue({ hubCount: 3, needSources: 4, allowDirtyStreaks: true,
            dbNamePrefix: 'XChain_BTC_Regtest_ROLLCALLAGE_' })

        const prior = ctx.streaks ? Number(ctx.streaks.priorAbsences) : NaN
        assert.ok(Number.isFinite(prior),
            'the streak precondition could not be read on this venue (public roll-call reads unreachable); ' +
            'nothing to age and nothing to prove')
        if (prior === 0){
            console.log('    [age] no roster source carries an absence inside the window; nothing to do')
            this.skip()
            return
        }

        // Choose epochs from an indexer that is LEVEL with the node. After a long
        // catch-up the indexer can trail the node by hundreds of blocks; epochs
        // chosen from the trailing tip are already past by the engines' first
        // tick, which signs only the newest signable epoch (measured 2026-09-08:
        // chosen 6390 from a trailing tip, the engines' first line was 6480).
        // DOGE is nudged while waiting because a close cannot advance without it.
        const levelDeadline = Date.now() + 10 * 60 * 1000
        let nodeTip = Number(await nodeConnector.getBlockCount())
        let idxTip  = await ctx.btcTip()
        while (idxTip < nodeTip && Date.now() < levelDeadline){
            await rc.mineDoge(ctx, 2)
            await rc.sleep(2000)
            nodeTip = Number(await nodeConnector.getBlockCount())
            idxTip  = await ctx.btcTip()
        }
        assert.ok(idxTip >= nodeTip,
            'the BTC indexer (' + idxTip + ') is still behind the node (' + nodeTip + ') after 10 minutes; epochs chosen ' +
            'now would be stale before the engines see them')
        console.log('    [age] BTC indexer level with the node at ' + idxTip)

        const lookback = Number(rc.rca().ROLLCALL_STREAK_LOOKBACK)
        const tip = await ctx.btcTip()
        epochs = rc.epochsAfter(tip + 6, ctx.network, lookback)
        console.log('    [age] ' + prior + ' source(s) dirty (' + (ctx.streaks.dirty || []).join(', ') + '); driving ' +
                    lookback + ' rolled epoch(s) with all ' + ctx.roster.length + ' sources present: ' + epochs.join(', '))

        // A venue whose BTC chain was reset while DOGE was not still carries the
        // OLD chain's ROLLCALL rows, keyed by the same epoch heights. The peer read
        // is first-seen per (epoch, pubkey), so at such a height a fresh signature
        // is shadowed by the stale row and dropped on ledger_hash: the epoch either
        // stays unrolled (ages nothing) or, worse, ROLLS with a bogus absence on a
        // SIGNING key. Measured 2026-09-08 at epoch 4470 (three v0 rows from DOGE
        // blocks 2526-2533 shadowed the three engines). None of the chosen epochs
        // has happened on this chain yet, so ANY row at those heights is foreign.
        const keys = ctx.roster.map(r => r.pubkey)
        for (const E of epochs){
            const have = await rc.onChainSigners(ctx, E, keys)
            assert.strictEqual(have.size, 0,
                'epoch ' + E + ' already carries ' + have.size + ' ROLLCALL signer row(s) on the DOGE side (' +
                Array.from(have).map(k => k.slice(0, 8)).join(', ') + ') although the BTC chain has not reached it: ' +
                'rows from a pre-reset chain. A fresh signature from the same key would be shadowed and dropped, so ' +
                'this epoch cannot roll cleanly. Mine the BTC chain past the last such height first ' +
                '(tmp/zc-probe/probe-doge-legacy-epochs.js lists them) and re-run.')
        }
    })

    after(async function () { await rc.tearDownVenue(ctx) })

    it('every driven epoch ROLLS with every roster source present', async function () {
        if (!ctx || !epochs.length) this.skip()

        const idle = ctx.roster[rc.IDLE_SEED_INDEX]
        assert.ok(idle && idle.seed && idle.pubkey, 'the roster carries no idle entry with a seed; cannot self-publish for it')

        for (const E of epochs){
            const windowEnd = Number(rc.rca().rollcallWindowEndHeight(E, ctx.network))
            const row = await rc.driveEpoch(ctx, E, {
                silentHubs: [],
                // BEFORE the rank-ladder climb, not after it. The close counts a
                // DOGE row only if its block is stamped no later than the BTC
                // window-end block, and the climb mines BTC up to that block
                // whenever a high rank has to unlock. Measured 2026-09-08: with
                // the publish in afterPublish, epoch 4350 counted the idle key by
                // one second and epoch 4380 (idle elected leader, so every engine
                // was a sweeper up to rank 3) stamped the cut at 04:48:07 and
                // parsed the idle's action at 04:48:33, ABSENT. Here BTC sits at
                // about E + 6 and the cut is six blocks away.
                beforePublish: async () => {
                    const tip = await ctx.btcTip()
                    assert.ok(tip < windowEnd - 1,
                        'epoch ' + E + ': BTC tip ' + tip + ' is already at the window end ' + windowEnd +
                        ', so a publish now would stamp after the cut and read as the absence this tool exists to age')
                    // The idle key never signs through an engine (that is what
                    // makes it idle), so it is present only through the
                    // censorship escape hatch: its own one-pair action, over the
                    // form this epoch takes on this venue (v1 with the full list
                    // when the gates rail is armed, v0 otherwise).
                    const bh = await indexerConnector.call('getblockhashes', { block_index: E })
                    const ledgerHash = String(bh.ledger_hash).toLowerCase()
                    const gates = rc.gatesForEpoch(E, ctx.network)
                    const sig = rc.signCanonical(idle.seed, rc.canonical(ctx.network, E, ledgerHash, gates))
                    const wire = rc.buildWire(E, ledgerHash, idle.pubkey, [{ pubkey: idle.pubkey, sig: sig }], gates)
                    await rc.publishWire(ctx, wire)
                    // Indexed BEFORE the window-end cut, or the close reads it as
                    // the very absence this tool is here to age out.
                    await rc.waitForOnChainSigners(ctx, E, [idle.pubkey])
                },
            })
            assert.strictEqual(Number(row.rolled), 1,
                'epoch ' + E + ' did not ROLL; an unrolled epoch is skipped by the streak walk and ages nothing')
            const absent = await rc.absenceRows(ctx, E)
            assert.strictEqual(absent.length, 0,
                'epoch ' + E + ' rolled with ' + absent.length + ' absence(s) (' +
                absent.map(a => String(a.source)).join(', ') + '); every source had to be present, ' +
                'and a new absence here makes the window dirtier, not cleaner')
            console.log('    [age] epoch ' + E + ' ROLLED, 0 absent')
        }
    })

    it('the strict precondition is clean afterwards', async function () {
        if (!ctx || !epochs.length) this.skip()
        // The exact check every acceptance suite runs at bringUpVenue, in its
        // strict form: it throws with the remaining absences if any is still
        // inside the window, which is the only verdict that matters here.
        const res = await rc.assertRosterStreaksClean(ctx, false)
        assert.ok(res && Number(res.priorAbsences) === 0,
            'the precondition read ' + JSON.stringify(res) + ' after the drive')
        console.log('    [age] precondition clean: ' + res.sourcesRead + ' source(s) read, 0 inside the window')
    })
})
