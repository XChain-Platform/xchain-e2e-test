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
 * AT0, THE ANTI-WEDGE TEST. The mirror barrier must park a BTC indexer whose hub
 * is gone, resume it with no divergence when the hub returns, and never arm at
 * all off BTC.
 *
 * WHY THIS IS THE FIRST DRILL. The barrier has no chain-only escape hatch by
 * design: with the mirror unreachable it is satisfied by nothing, so a hub outage
 * parks the indexer indefinitely rather than letting it guess. That is deliberate,
 * because a missed mirror row is not lag but a permanent fork: the node would
 * commit the block with the callback un-fired while its peers commit it fired, and
 * nothing later re-binds. A design that parks forever has to be proven to UNPARK,
 * and to park for the stated reason rather than for some other stall, which is
 * what the three cases below separate.
 *
 * WHAT MAKES THE PARK ATTRIBUTABLE. One indexer's hub is stopped and the other's
 * is left running. Both follow the same chain, so if the stopped-hub indexer holds
 * while the live-hub indexer advances past it, the hold is the mirror barrier and
 * not the chain, the decoder, or the venue being slow. Asserting a stall reason
 * alone would not establish that: an indexer can carry a stale reason from an
 * earlier barrier it has since cleared.
 *
 * THE OFF-BTC HALF reads the standing LTC and DOGE indexers rather than venue
 * children, because that is where the claim actually has to hold: those two run
 * the same build with the barrier compiled in, gated on COIN === 'BTC'. A venue
 * child pointed at LTC would prove the gate only for a process this test
 * configured, which is the weaker claim.
 ********************************************************************/

const assert = require('assert')
const axios = require('axios')
const dotenv = require('dotenv')
dotenv.config()

const { AttestMirrorVenue } = require('../helpers/attestMirrorVenue')
const { createRail } = require('../helpers/chainRail')
const XChainIndexerConnector = require('../../src/XChainIndexerConnector.js')

// The reason the barrier registers when it defers a block. Spelled here because it
// is the observable contract this test exists to pin.
const BARRIER_REASON = 'attest_response_sync_barrier'

// A parked block is classified by TIMING, not by reason: 'barrier_defer' while it is
// inside the grace and 'wedged' once past it. Either is a legitimate park; what must
// never appear off BTC is the reason itself.
const PARKED_CLASSES = ['barrier_defer', 'wedged']

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }

async function until(fn, timeoutMs, intervalMs = 2000) {
    const deadline = Date.now() + timeoutMs
    let last = null
    while (Date.now() < deadline) {
        last = await fn()
        if (last && last.ok) return last
        await sleep(intervalMs)
    }
    return last || { ok: false }
}

describe('AT0 anti-wedge: the mirror barrier parks a hubless BTC indexer and never arms off BTC', function () {
    // Five hub processes, two indexers and their schemas, plus a hub restart.
    this.timeout(45 * 60 * 1000)

    let venue = null
    let up = false
    let btc = null
    let stoppedHub = null
    let baseline = null

    // Committed height and stall state, read off the indexer's own /status so this
    // test touches no venue internals.
    async function statusOf(i) {
        const s = await venue.statusOf(i)
        return {
            httpStatus: s.httpStatus,
            height: (s.body && s.body.indexerBlock !== undefined) ? Number(s.body.indexerBlock) : null,
            decoder: (s.body && s.body.decoderBlock !== undefined) ? Number(s.body.decoderBlock) : null,
            reason: s.body && s.body.stallReason,
            klass: s.body && s.body.stallClass,
            // Where a starved mirror actually shows, per table. The reason string cannot
            // locate it, because several barriers share one stream and only the first to
            // time out names itself.
            mirror: s.body && s.body.hubMirror
        }
    }

    before(async function () {
        btc = await createRail('bitcoin', 'regtest')
        venue = new AttestMirrorVenue({ label: 'at0' })
        up = await venue.start()
        if (!up) {
            console.log('AT0 SKIPPED: ' + venue.unavailable)
            this.skip()
            return
        }

        // Both indexers level with the decoder before anything is broken, so a later
        // hold is attributable to this test rather than inherited from bring-up.
        const level = await until(async () => {
            const a = await statusOf(0)
            const b = await statusOf(1)
            return { ok: a.height !== null && b.height !== null && a.height === a.decoder && b.height === b.decoder,
                     a: a, b: b }
        }, 20 * 60 * 1000)
        assert.ok(level.ok, 'the venue indexers never caught the chain before the drill: ' +
            JSON.stringify({ a: level.a, b: level.b }))
        baseline = level.a.height
        console.log('AT0 baseline: both venue indexers committed block ' + baseline)
    })

    after(async function () {
        // Bring the hub back even if a case failed, so the venue teardown and any
        // following drill do not inherit a half-stopped federation.
        if (venue && stoppedHub !== null) {
            try { await venue.startHub(stoppedHub) } catch (_) { /* teardown follows */ }
        }
        if (venue) await venue.stop()
    })

    it('parks the BTC indexer behind the mirror when its hub is gone, while its peer advances', async function () {
        stoppedHub = venue.indexers[0].followsHub
        await venue.stopHub(stoppedHub)
        console.log('AT0: stopped hub ' + stoppedHub + ', which indexer 0 follows')

        // One block is enough: the barrier arms on EVERY BTC block, with no
        // transaction predicate, because a time-bound row can bind at an empty block.
        await btc.globals.regtestMinerConnector.generateBlocks(1)

        const parked = await until(async () => {
            const a = await statusOf(0)
            return { ok: PARKED_CLASSES.includes(a.klass) && a.reason, a: a }
        }, 10 * 60 * 1000)
        assert.ok(parked.ok, 'indexer 0 never parked at all after its hub was stopped' +
            '; last status ' + JSON.stringify(parked.a) + '\n' + venue.logTail('indexer0'))
        console.log('AT0: indexer 0 parked at block ' + parked.a.height + ' of ' + parked.a.decoder +
            ', stallReason ' + parked.a.reason + ', stallClass ' + parked.a.klass)

        // THE MIRROR IS WHAT STARVED, which is the claim, and the watermark is where it
        // shows. Reading the reason string cannot establish this: several barriers share
        // one starved stream and only the first of them gets to name itself.
        const frozen = parked.a.mirror && parked.a.mirror.tables &&
                       parked.a.mirror.tables.attestation_responses
        assert.strictEqual(parked.a.mirror && parked.a.mirror.connected, false,
            'indexer 0 still reports a connected mirror after its hub was stopped')
        assert.ok(Number.isFinite(Number(frozen)),
            'indexer 0 reports no attestation_responses watermark, so the starve cannot be located')

        // The attribution half. Indexer 1's hub is untouched, so it must get past the
        // height indexer 0 is holding at; without this the park could be the chain.
        const peer = await until(async () => {
            const b = await statusOf(1)
            return { ok: b.height !== null && b.height > parked.a.height, b: b }
        }, 10 * 60 * 1000)
        assert.ok(peer.ok, 'indexer 1, whose hub is still up, did not advance past indexer 0. ' +
            'The hold is therefore not attributable to the mirror at all: ' + JSON.stringify(peer.b) +
            '\n' + venue.logTail('indexer1'))
        assert.strictEqual((await statusOf(0)).height, parked.a.height,
            'indexer 0 advanced while its hub was down, so the barrier did not hold the block')

        // And the peer's own watermark moved while the parked one's did not, which is the
        // difference between a starved mirror and a slow venue.
        const advanced = peer.b.mirror && peer.b.mirror.tables &&
                         peer.b.mirror.tables.attestation_responses
        assert.ok(Number(advanced) > Number(frozen),
            'the live-hub indexer attestation_responses watermark (' + advanced + ') did not advance ' +
            'past the stopped-hub one (' + frozen + '), so nothing distinguishes a starved mirror ' +
            'from a venue that is merely slow')
        console.log('AT0: indexer 1 advanced to ' + peer.b.height + ' while indexer 0 held at ' +
            parked.a.height + '; attestation_responses watermark frozen at ' + frozen +
            ' against the peer at ' + advanced)
    })

    // PARKED PENDING AN OPERATOR RULING, not skipped as an inconvenience.
    //
    // AT0 as written names `attest_response_sync_barrier` as the reason on `/status`.
    // Driven on this venue, that reason CANNOT appear when a whole hub is stopped:
    // `anchor_attest_barrier` sits earlier in the same block loop and reads the same
    // starved stream watermark, so it reports first and both indexers carry it. The
    // anti-wedge property AT0 exists to prove is fully covered by the case above; only
    // the reason string is unreachable. Two ways to close it, and the choice changes what
    // the milestone tests, so it is not this drill's to make:
    //   1. give the venue a route-level fault injection that withholds ONLY
    //      `attestation_responses` so the earlier barriers stay satisfied, then this case
    //      becomes drivable as written;
    //   2. re-word AT0 to the shape the case above already asserts.
    it.skip('names attest_response_sync_barrier specifically (needs ruling: see comment)', async function () {
        const a = await statusOf(0)
        assert.strictEqual(a.reason, BARRIER_REASON)
        assert.ok(PARKED_CLASSES.includes(a.klass))
    })

    it('resumes with no divergence when the hub returns', async function () {
        assert.ok(stoppedHub !== null, 'the previous case did not stop a hub')
        const held = (await statusOf(0)).height

        await venue.startHub(stoppedHub)
        console.log('AT0: restarted hub ' + stoppedHub)

        const resumed = await until(async () => {
            const a = await statusOf(0)
            return { ok: a.height !== null && a.height > held && a.reason !== BARRIER_REASON, a: a }
        }, 15 * 60 * 1000)
        assert.ok(resumed.ok, 'indexer 0 did not resume past block ' + held + ' after its hub returned: ' +
            JSON.stringify(resumed.a) + '\n' + venue.logTail('indexer0'))
        console.log('AT0: indexer 0 resumed to block ' + resumed.a.height + ', stallReason ' + resumed.a.reason)

        // NO DIVERGENCE, on the signed triple rather than on height alone. Two nodes
        // can agree on how far they got and disagree about what they committed, and
        // that disagreement is the fork this barrier exists to prevent.
        const common = await until(async () => {
            const a = await statusOf(0)
            const b = await statusOf(1)
            const h = Math.min(a.height, b.height)
            return { ok: h >= resumed.a.height, h: h, a: a, b: b }
        }, 10 * 60 * 1000)
        assert.ok(common.ok, 'the two indexers never held a common height at or past the resume point')

        const at = common.h
        const conn0 = new XChainIndexerConnector('127.0.0.1', venue.indexers[0].apiPort, null)
        const conn1 = new XChainIndexerConnector('127.0.0.1', venue.indexers[1].apiPort, null)
        const h0 = await conn0.call('getblockhashes', { block_index: at })
        const h1 = await conn1.call('getblockhashes', { block_index: at })
        assert.ok(h0 && !h0.error, 'indexer 0 would not report block hashes at ' + at + ': ' + JSON.stringify(h0))
        assert.ok(h1 && !h1.error, 'indexer 1 would not report block hashes at ' + at + ': ' + JSON.stringify(h1))

        for (const field of ['state_root', 'balances_root', 'stakes_root', 'block_merkle_root']) {
            assert.strictEqual(String(h0[field]), String(h1[field]),
                'the two indexers disagree on ' + field + ' at block ' + at +
                ', which is a fork rather than lag: ' + String(h0[field]) + ' vs ' + String(h1[field]))
        }
        console.log('AT0: no divergence at block ' + at + '; state_root ' + String(h0.state_root).slice(0, 16) +
            '... identical on the parked-and-resumed indexer and its peer')
    })

    it('never arms the barrier on LTC or DOGE', async function () {
        // The standing indexers, which run the same build with the barrier compiled in
        // and gated on the home chain. Read directly rather than through the venue,
        // which only ever stands up BTC children.
        for (const [coin, port] of [['LTC', 3224], ['DOGE', 3124]]) {
            // `/status` is an HTTP endpoint rather than a JSON-RPC method, so it is read
            // directly; the stall fields live nowhere else.
            let status = null
            try {
                const res = await axios.get('http://127.0.0.1:' + port + '/status',
                    { timeout: 10_000, validateStatus: () => true })
                status = (res.status === 200 || res.status === 503) ? res.data : null
            } catch (_) { status = null }
            if (!status || status.error) {
                // Absent rather than contradicting: say so instead of passing quietly.
                assert.fail(coin + ' regtest indexer on ' + port + ' did not answer, so the off-BTC half of ' +
                    'AT0 could not be established either way')
            }
            assert.notStrictEqual(status.stallReason, BARRIER_REASON,
                coin + ' armed the BTC-only mirror barrier, so the COIN gate on it is not holding')
            console.log('AT0: ' + coin + ' at block ' + status.indexerBlock + ', stallReason ' +
                String(status.stallReason) + ' (barrier correctly absent)')
        }
    })
})
