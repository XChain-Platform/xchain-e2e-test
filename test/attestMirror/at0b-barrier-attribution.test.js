'use strict'

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
 * AT0's LAST CLAUSE: the stall is `attest_response_sync_barrier` BY NAME.
 *
 * `at0-anti-wedge.test.js` drives the anti-wedge property itself and drives it
 * green: a hubless BTC indexer parks, its peer advances past it, the starved
 * `attestation_responses` watermark locates the starve, and the parked node
 * resumes with an identical `state_root`. What it could not drive is the REASON
 * STRING, and its own skipped case says why: with a whole hub stopped every
 * barrier starves at once, `anchor_attest_barrier` sits earlier in the same block
 * loop reading the same watermark, so it reports first and the attest-response
 * barrier can never be the observed stall class.
 *
 * That clause needed a lever, the operator ruled for one on 2026-09-04, and this
 * file is the clause driven with it. It lives beside at0 rather than inside it so
 * that a green anti-wedge run is not made to depend on a second venue.
 *
 * TWO THINGS ARE NEEDED, and they do different jobs. Getting this wrong is how a
 * test asserts a barrier held when nothing was ever withheld.
 *
 *   THE WITHHOLD makes the starvation REAL. `venue.withholdMirrorTable` suppresses
 *   `attestation_responses` on one indexer's mirror edge only, passing the
 *   watermark and schema version through, so every other table and every other
 *   barrier keeps flowing while that one table genuinely does not arrive. The hub
 *   still holds the row and still serves it to everyone else, which this drill
 *   asserts, so the fault is provably in delivery to this node.
 *
 *   THE GRACE makes the stall ATTRIBUTABLE. Measured in
 *   `xchain-indexer/src/hub_db_sync.js`: every mirror barrier tests
 *   `streamWatermark >= blockTime + grace`, against one GLOBAL watermark, so the
 *   grace is the only per-barrier term in the system. With `attestResponse` raised
 *   on this indexer and every other barrier left at 0, the attest-response barrier
 *   is the only one that can be unsatisfied, and so it is the one that names
 *   itself. A withhold alone cannot produce a park at all, because the watermark it
 *   deliberately preserves is what the barrier reads.
 *
 * WHY THE RAISED GRACE DOES NOT MAKE BRING-UP IMPOSSIBLE, since a reader will
 * worry about it: the barrier compares against the BLOCK's own protocol time, and
 * on regtest that is the raw stamp. Every historical block is minutes to days old,
 * so `watermark >= blockTime + grace` is trivially true for all of them and the
 * catch-up from genesis is unaffected. Only a block stamped within the grace of now
 * can hold, which is exactly the blocks this drill mines.
 ********************************************************************/

const assert = require('assert')
const dotenv = require('dotenv')
dotenv.config()

const { AttestMirrorVenue } = require('../helpers/attestMirrorVenue')
const { createRail } = require('../helpers/chainRail')
const { until, untilOrClearDogeStall, diffStateHashes, venueTipProbe } = require('./mirrorDrillWaits')
const XChainIndexerConnector = require('../../src/XChainIndexerConnector.js')

// The observable this file exists to pin.
const BARRIER_REASON = 'attest_response_sync_barrier'
const PARKED_CLASSES = ['barrier_defer', 'wedged']

// The mirrored table starved on one edge.
const MIRROR_TABLE = 'attestation_responses'

// The grace raised on indexer 0 alone. Long enough that a 2s poll cannot miss the
// park, short enough that the block it holds is not held for the whole drill.
const BARRIER_GRACE_S = 90

// The indexer whose mirror is starved, and its unaffected peer.
const STARVED = 0
const PEER    = 1

describe('AT0 last clause: the mirror stall is attest_response_sync_barrier by name', function () {
    // Five hubs, two indexers and a catch-up from the chain's genesis.
    this.timeout(45 * 60 * 1000)

    let venue = null
    let up    = false
    let btc   = null
    let held  = null

    async function statusOf (i) {
        const s = await venue.statusOf(i)
        return {
            httpStatus: s.httpStatus,
            height: (s.body && s.body.indexerBlock !== undefined) ? Number(s.body.indexerBlock) : null,
            decoder: (s.body && s.body.decoderBlock !== undefined) ? Number(s.body.decoderBlock) : null,
            reason: s.body && s.body.stallReason,
            klass: s.body && s.body.stallClass,
            mirror: s.body && s.body.hubMirror,
        }
    }

    before(async function () {
        btc = await createRail('bitcoin', 'regtest')
        venue = new AttestMirrorVenue({
            label: 'at0b',
            // Raised on the starved indexer ONLY. Its peer keeps every grace at zero,
            // which is what makes "one parked, one advancing" attributable.
            indexerGraces: { [STARVED]: { attestResponse: BARRIER_GRACE_S } },
        })
        up = await venue.start()
        if (!up) {
            console.log('AT0b SKIPPED: ' + venue.unavailable)
            this.skip()
            return
        }

        // Both level with the decoder before anything is broken, so a later hold is
        // this drill's doing rather than inherited from bring-up.
        const level = await untilOrClearDogeStall(async () => {
            const a = await statusOf(STARVED)
            const b = await statusOf(PEER)
            return {
                ok: a.height !== null && b.height !== null && a.height === a.decoder && b.height === b.decoder,
                a: a, b: b,
            }
        }, { timeoutMs: 25 * 60 * 1000, tipProbe: venueTipProbe(venue, PEER) })
        assert.ok(level.ok, 'the venue indexers never caught the chain before the drill: ' +
            JSON.stringify({ a: level.a, b: level.b }))
        console.log('AT0b baseline: both indexers committed block ' + level.a.height)
    })

    after(async function () {
        if (venue) {
            // Released even if a case failed, so teardown is not fighting an armed fault.
            try { venue.releaseMirrorTable(STARVED, MIRROR_TABLE) } catch (_) { /* never armed */ }
            await venue.stop()
        }
    })

    it('parks the starved indexer on attest_response_sync_barrier while every other barrier stays clear',
        async function () {
            venue.withholdMirrorTable(STARVED, MIRROR_TABLE)
            console.log('AT0b: withholding ' + MIRROR_TABLE + ' on indexer ' + STARVED +
                "'s mirror edge; its hub and every other table are untouched")

            // One block is enough: the barrier arms on EVERY BTC block, with no
            // transaction predicate, because a time-bound row can bind at an empty one.
            await btc.globals.regtestMinerConnector.generateBlocks(1)

            const parked = await until(async () => {
                const a = await statusOf(STARVED)
                return { ok: a.reason === BARRIER_REASON && PARKED_CLASSES.includes(a.klass), a: a }
            }, 8 * 60 * 1000)
            assert.ok(parked.ok,
                'indexer ' + STARVED + ' never reported ' + BARRIER_REASON + '. Last status ' +
                JSON.stringify(parked.a) + '; proxy ' + JSON.stringify(venue.mirrorProxyStats(STARVED)) +
                '\n' + venue.logTail('indexer' + STARVED))
            held = parked.a.height
            console.log('AT0b: indexer ' + STARVED + ' parked at ' + held + ' of ' + parked.a.decoder +
                ', stallReason ' + parked.a.reason + ', stallClass ' + parked.a.klass)

            // THE NAME IS THE CLAIM. Asserted as an equality rather than a match, since
            // the string is the registered stall class and a neighbouring barrier
            // answering instead is exactly what this clause exists to rule out.
            assert.strictEqual(parked.a.reason, BARRIER_REASON,
                'the parked indexer reports ' + parked.a.reason + '. Every mirror barrier reads one global ' +
                'watermark, so a different name here means a barrier EARLIER in the block loop was also ' +
                'unsatisfied, and the attribution this clause needs is gone.')

            // THE INJECTION ACTUALLY FIRED. Without this the case could pass on a venue
            // where nothing was withheld and the grace alone held the block.
            const stats = venue.mirrorProxyStats(STARVED)
            assert.ok(stats.snapshotRowsHeld > 0 || stats.framesDropped > 0 ||
                      stats.filters.some((f) => f[0] === MIRROR_TABLE),
                'the mirror proxy reports holding nothing for ' + MIRROR_TABLE + ': ' + JSON.stringify(stats))

            // THE HUB STILL HAS IT, so the fault is provably in delivery to this node
            // rather than in the federation. Read through the hub's own route.
            const followed = venue.indexers[STARVED].followsHub
            const snap = await venue.hubSnapshot(followed).catch((e) => ({ error: String(e && e.message) }))
            assert.ok(snap && !snap.error,
                'hub ' + followed + ' would not serve its own snapshot route, so the withhold cannot be ' +
                'distinguished from a hub that is down: ' + JSON.stringify(snap))
            assert.strictEqual(Number(snap.schema_version), 5,
                'the hub is serving schema_version ' + snap.schema_version + ' rather than 5')

            // THE PEER IS UNAFFECTED. Same chain, same federation, graces at zero, no
            // withhold: it must get past the height the starved one is holding at.
            const peer = await until(async () => {
                const b = await statusOf(PEER)
                return { ok: b.height !== null && b.height > held, b: b }
            }, 8 * 60 * 1000)
            assert.ok(peer.ok,
                'indexer ' + PEER + ', whose mirror is untouched, did not advance past ' + held +
                '. The hold is therefore not attributable to the withheld table at all: ' +
                JSON.stringify(peer.b) + '\n' + venue.logTail('indexer' + PEER))
            assert.notStrictEqual(peer.b.reason, BARRIER_REASON,
                'the UNSTARVED peer is also reporting ' + BARRIER_REASON + ', so the fault is not edge-scoped')
            console.log('AT0b: peer advanced to ' + peer.b.height + ' with stallReason ' +
                String(peer.b.reason) + ' while the starved node held at ' + held)
        })

    it('resumes and converges on the same state_root once the table is released', async function () {
        assert.ok(held !== null, 'the previous case did not establish a parked height')
        venue.releaseMirrorTable(STARVED, MIRROR_TABLE)
        console.log('AT0b: released ' + MIRROR_TABLE + ' on indexer ' + STARVED +
            ' (the socket is dropped, so the node re-bootstraps and re-pages the table from id 0)')

        const resumed = await untilOrClearDogeStall(async () => {
            const a = await statusOf(STARVED)
            return { ok: a.height !== null && a.height > held, a: a }
        }, { timeoutMs: 15 * 60 * 1000, tipProbe: venueTipProbe(venue, PEER) })
        assert.ok(resumed.ok,
            'indexer ' + STARVED + ' did not get past ' + held + ' after the withhold was released: ' +
            JSON.stringify(resumed.a) + '\n' + venue.logTail('indexer' + STARVED))
        console.log('AT0b: resumed to ' + resumed.a.height)

        const common = await untilOrClearDogeStall(async () => {
            const a = await statusOf(STARVED)
            const b = await statusOf(PEER)
            const h = Math.min(Number(a.height), Number(b.height))
            return { ok: Number.isFinite(h) && h > held, h: h, a: a, b: b }
        }, { timeoutMs: 15 * 60 * 1000, tipProbe: venueTipProbe(venue, PEER) })
        assert.ok(common.ok, 'the two indexers never held a common height past the parked one')

        // NO DIVERGENCE, on the signed roots rather than on height. Two nodes can
        // agree how far they got and disagree about what they committed, and that
        // disagreement is the fork this barrier exists to prevent.
        const conn0 = new XChainIndexerConnector('127.0.0.1', venue.indexers[STARVED].apiPort, null)
        const conn1 = new XChainIndexerConnector('127.0.0.1', venue.indexers[PEER].apiPort, null)
        const h0 = await conn0.call('getblockhashes', { block_index: common.h })
        const h1 = await conn1.call('getblockhashes', { block_index: common.h })
        assert.ok(h0 && !h0.error, 'the starved indexer would not report hashes at ' + common.h + ': ' + JSON.stringify(h0))
        assert.ok(h1 && !h1.error, 'the peer would not report hashes at ' + common.h + ': ' + JSON.stringify(h1))
        const diffs = diffStateHashes(h0, h1)
        assert.deepStrictEqual(diffs, [],
            'the starved-and-resumed indexer and its peer disagree at block ' + common.h + ': ' +
            diffs.join('; ') + '. That is a fork rather than lag, and it is what the barrier and the ' +
            're-bootstrap on release exist to prevent.')
        console.log('AT0b: no divergence at block ' + common.h + '; state_root ' +
            String(h0.state_root).slice(0, 16) + '... identical on both')
    })
})
