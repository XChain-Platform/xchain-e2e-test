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
 * VENUE TOOL, not a test: clear a shared regtest venue's oracle_publish set
 * down to the acceptance roster by letting the PROTOCOL evict everything else.
 *
 * WHY THIS EXISTS. AT1 asserts that after K rolled epochs exactly the idle
 * source is absent and getcapabilityvalidators returns exactly three rows.
 * Neither is true on a venue carrying oracle_publish members the harness does
 * not run: they are absent in every epoch (nobody signs for them) and they sit
 * in the capability set forever. So the acceptance suites need a federation that
 * is exactly the roster.
 *
 * AND THEY CANNOT BE UNSTAKED. On the BTC regtest acceptance venue, measured
 * 2026-09-03, the four outsiders were three orphan fixture stakes plus the
 * venue's own validator hub. The fixture path derives each source address from a
 * mnemonic generated per run (test/cryptoHelper.js getNewAddress falls back to
 * bip39.generateMnemonic()), so an orphan fixture stake's key does not survive
 * the run that made it and no UNSTAKE can ever be signed for it. Rebuilding the
 * chain was the only other remedy, and the chain is shared with other lanes.
 *
 * WHAT THIS DOES INSTEAD: exactly what the rail is for. Drive K rolled epochs
 * with every roster hub present. Each outsider is absent in both, its streak
 * reaches K, and the epoch close evicts it with a synthetic UNSTAKE - the same
 * eviction AT1 measures, applied to the stakes that were in the way. After the
 * K-th close the set is the roster alone.
 *
 * THE IDLE SOURCE IS EVICTED TOO, and that is expected rather than collateral:
 * it is absent in those epochs for the same reason. So this tool leaves the
 * venue needing ONE more step before the acceptance run, and says so at the end:
 * bump XC_ROLLCALL_IDLE_GENERATION and re-run rollcallSeedFederation, which
 * mints a fresh idle key at a fresh source address. The three SIGNING sources
 * are present throughout, accumulate no absences, and are untouched - which
 * matters, because their keys are the frozen vector's and STAKE v1 would refuse
 * to restake them from anywhere.
 *
 * IT IS DESTRUCTIVE AND SAYS SO. Every stake it clears is retired for good: the
 * v1 admission rule reads "any valid stake row for this pubkey, EVER", so an
 * evicted key can never be staked again on this chain. That is the ruled
 * behaviour (D4, 2026-09-01), not a defect to route around, but it means a
 * validator hub whose stake is cleared here needs `validator init --force` plus
 * a fresh stake to publish again. Requires XC_ROLLCALL_CLEAR_OUTSIDERS=1 so it
 * cannot be reached by running the tools directory.
 *
 * Lives outside test/actions/** so a venue-mutating run can never join an
 * ordinary suite by accident.
 ********************************************************************/

'use strict'

const assert = require('assert')

const rc = require('../helpers/rollcallHelper')
const { requireFederationEnv } = require('../helpers/federationGuards')

const OPT_IN = 'XC_ROLLCALL_CLEAR_OUTSIDERS'

// How many rolled epochs to drive. Defaults to K, which is what an eviction
// needs. Set higher to AGE A STALE ABSENCE out of the window: the K-streak reads
// the last 2K ROLLED epochs (getRolledRollcallEpochs), so once 2K rolled epochs
// have passed with a source PRESENT, its old absence is outside the window and an
// acceptance run sees a clean streak again. That is the only remedy for a SIGNING
// source, whose address cannot be rotated (STAKE v1 refuses a pubkey that has
// ever been staked), and it is exactly what AT2 leaves behind: AT2 silences a
// live hub on purpose, so every AT1/AT2 run ends with one signing source
// carrying one absence.
const EPOCHS_ENV = 'XC_ROLLCALL_DRIVE_EPOCHS'

describe('ROLLCALL venue tool: let the protocol clear every oracle_publish source outside the roster', function () {
    // K rolled epochs of 30 BTC blocks with their closes, plus the DOGE publish
    // interleaving, plus burial for the deactivations to take effect.
    this.timeout(60 * 60 * 1000)

    let ctx = null
    let outsiders = []
    let K = null, driveCount = null

    before(async function () {
        if (!rc.requireRollcallVenue(this)) return
        if (!requireFederationEnv(this)) return
        if (String(process.env[OPT_IN] || '') !== '1'){
            console.log('    [skip] ' + OPT_IN + ' is not 1. This tool EVICTS every staked oracle_publish ' +
                        'source outside the acceptance roster, and an evicted signing key can never be staked ' +
                        'again on this chain. Set ' + OPT_IN + '=1 to opt in.')
            this.skip()
            return
        }

        // allowDirtyStreaks because this tool is the remedy for a dirty streak
        // rather than a victim of one, and it is safe here for one measurable
        // reason: every epoch below is driven with silentHubs EMPTY, so no roster
        // source can gain an absence and no streak can complete.
        ctx = await rc.bringUpVenue({ hubCount: 3, needSources: 4, allowDirtyStreaks: true })
        K   = Number(rc.rca().ROLLCALL_EVICT_MISSES)
        assert.ok(Number.isFinite(K) && K >= 1, 'ROLLCALL_EVICT_MISSES must be a positive integer, got ' + K)
        const asked = parseInt(process.env[EPOCHS_ENV], 10)
        driveCount = (Number.isFinite(asked) && asked >= 1) ? asked : K
        console.log('\n    driving ' + driveCount + ' rolled epoch(s) (K = ' + K + ', lookback window 2K = ' +
                    (2 * K) + ' rolled epochs)')

        const rosterSources = new Set(ctx.roster.map(r => String(ctx.fed.byPubkey.get(r.pubkey))))
        const bySource = new Map()
        for (const v of ctx.fed.weights)
            if (!rosterSources.has(String(v.source)) && !bySource.has(String(v.source)))
                bySource.set(String(v.source), Number(v.weight))
        outsiders = Array.from(bySource.entries()).map(([source, weight]) => ({ source, weight }))

        console.log('\n    roster sources : ' + Array.from(rosterSources).join(', '))
        if (!outsiders.length){
            console.log('    outsiders      : none. The venue is already exactly the roster; nothing to clear.')
            return
        }
        console.log('    outsiders      : ' + outsiders.length + ', total weight ' +
                    outsiders.reduce((a, o) => a + o.weight, 0))
        for (const o of outsiders) console.log('        ' + o.source + '   weight ' + o.weight)
        console.log('    Each will be absent in ' + K + ' rolled epoch(s) and evicted by the close. Their ' +
                    'signing keys are retired for good on this chain.')
    })

    after(async function () { await rc.tearDownVenue(ctx) })

    it('drives the rolled epochs, evicting every outsider and ageing the absence window', async function () {
        if (!ctx) this.skip()
        // With no outsiders AND no explicit epoch count there is nothing to do,
        // and moving a venue for no reason is its own hazard. An explicit count is
        // a window-ageing run, which is worth doing on a clean roster.
        if (!outsiders.length && !parseInt(process.env[EPOCHS_ENV], 10)){
            console.log('    no outsiders and no ' + EPOCHS_ENV + '; nothing to do, leaving the venue alone')
            this.skip()
            return
        }

        const tip = await ctx.btcTip()
        const epochs = rc.epochsAfter(tip + 6, ctx.network, driveCount)
        console.log('    driving epoch(s) ' + epochs.join(', ') + ' with all three hubs present')

        let lastClose = null
        for (const epoch of epochs){
            const row = await rc.driveEpoch(ctx, epoch, { silentHubs: [] })
            // A close that does not ROLL counts for nobody (D39) and no streak
            // forms, so an unrolled epoch here is a stall rather than progress:
            // say which epoch and what the responsible set was, because the two
            // causes (quorum arithmetic and a signature that never landed) are
            // told apart by that field.
            assert.strictEqual(Number(row.rolled), 1,
                'epoch ' + epoch + ' closed UNROLLED, so it counts for nobody and no outsider streak forms. ' +
                'responsible_set_json=' + String(row.responsible_set_json) +
                '. Either the roster\'s weight does not clear 3 * present > 2 * total against the outsider ' +
                'weight (re-seed heavier), or a hub\'s signature never reached the DOGE chain.')
            lastClose = Number(row.close_block)
            const absent = (await rc.absenceRows(ctx, epoch)).map(r =>
                String(r.source) + (Number(r.evicted) === 1 ? ' EVICTED' : ''))
            console.log('    epoch ' + epoch + ' ROLLED at ' + lastClose + '; absent: ' + absent.join(', '))
        }

        // The deactivation the eviction stamps takes effect at
        // close + ACTIVATION_DELAY_BLOCKS, so the capability read has to be
        // taken past it. Derived from a row the eviction itself wrote rather
        // than from a constant this process cannot see; a pure window-ageing run
        // evicted nothing and has no such row, so it uses the same delay the
        // acceptance suites derive and simply reads one block past it.
        let activationDelay = 6
        if (outsiders.length){
            const stakeRows = await rc.stakeDeactivations(ctx, outsiders[0].source)
            const stamped = stakeRows.filter(r => r.deactivation_block !== null)
            assert.ok(stamped.length >= 1,
                'the close did not stamp deactivation_block on ' + outsiders[0].source + '\'s stake row(s), so no ' +
                'eviction happened for it. Absence rows above say whether it was counted absent at all.')
            activationDelay = Number(stamped[0].deactivation_block) - lastClose
        }
        const readAt = lastClose + activationDelay + 1
        await rc.mineBtcTo(ctx, readAt, 'burial of the evictions')

        const caps = await indexerConnector.call('getstakeweightsbycapability', {
            capability: 'oracle_publish', block_index: readAt,
        })
        assert.ok(caps && !caps.error, 'getstakeweightsbycapability failed: ' + JSON.stringify(caps && caps.error))
        const still = (caps.validators || [])
            .filter(v => outsiders.some(o => o.source === String(v.source)))
            .map(v => String(v.source))
        assert.deepStrictEqual(still, [],
            'these outsider source(s) are STILL in oracle_publish at block ' + readAt + ' (close + ' +
            activationDelay + ' + 1): ' + JSON.stringify(still) + '. The acceptance suites cannot run until ' +
            'they are gone.')

        console.log('\n    oracle_publish at ' + readAt + ': ' + (caps.validators || []).length + ' key(s), ' +
                    caps.source_count + ' source(s)')
        for (const v of (caps.validators || []))
            console.log('        ' + String(v.pubkey).slice(0, 16) + '...  weight ' + v.weight +
                        '  source ' + v.source)

        // The idle source was absent for the same K epochs, so it is evicted
        // too. That is not a failure of this tool, it is the next step.
        const idlePubkey = ctx.roster[rc.IDLE_SEED_INDEX].pubkey
        const idleStillIn = (caps.validators || [])
            .some(v => String(v.pubkey).toLowerCase() === idlePubkey)
        console.log('\n    NEXT STEP: the idle source ' + ctx.idleSource + ' was absent in those epochs too and ' +
                    'is ' + (idleStillIn ? 'STILL in the set (unexpected: check its absence rows)' : 'EVICTED') +
                    '.\n    Bump XC_ROLLCALL_IDLE_GENERATION and re-run test/tools/rollcallSeedFederation.test.js ' +
                    'to mint a fresh idle key at a fresh source address, then run the acceptance suites. The ' +
                    'three signing sources were present throughout and carry no absences.')
    })
})
