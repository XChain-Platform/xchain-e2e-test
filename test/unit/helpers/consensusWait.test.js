'use strict'

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// consensusWait.js's waits are invisible in a green integration run - a mesh
// wait that returns too early looks exactly like a slow venue - so they are
// pinned here against fake hubs: no MariaDB, no Docker, no sockets.
//
// The load-bearing rule is the one the old peers.size check got wrong: a peer
// entry exists from the moment a DIAL STARTS, so readiness is the count of
// peers whose socket is OPEN, never the size of the map.

const assert = require('assert')
const {
    WS_OPEN, waitFor, openPeerCount, meshState, waitForMesh,
    readConfigEverywhere, waitForConfigEverywhere, assertNeverApplied
} = require('../../helpers/consensusWait')

// A hub whose peer map holds `open` OPEN sockets and `connecting` entries that
// are still dialling (ws null), the shape PeerManager actually produces.
function fakeHub(open, connecting, config) {
    const peers = new Map()
    for (let i = 0; i < open; i++)       peers.set('open:' + i,  { ws: { readyState: WS_OPEN }, state: 'open' })
    for (let i = 0; i < connecting; i++) peers.set('dial:' + i,  { ws: null, state: 'connecting' })
    return {
        consensus: {},
        peerManager: { peers },
        db: { getConfig: async () => (config === undefined ? null : config) }
    }
}

describe('consensusWait: deterministic PBFT waits', function () {
    this.timeout(20000)

    describe('mesh readiness', () => {
        it('counts only peers whose socket is OPEN', () => {
            assert.strictEqual(openPeerCount(fakeHub(3, 2)), 3)
            assert.strictEqual(openPeerCount(fakeHub(0, 4)), 0)
            assert.strictEqual(openPeerCount({}), 0)
        })

        it('is NOT ready while a hub is still dialling, even though peers.size is full', () => {
            // The exact false-ready the old check reported: hub 2 holds three
            // peer entries, none of them usable.
            const mvh = { hubs: [fakeHub(3, 0), fakeHub(3, 0), fakeHub(0, 3), fakeHub(3, 0)] }
            const s = meshState(mvh)
            assert.strictEqual(s.ok, false)
            assert.strictEqual(s.expected, 3)
            assert.deepStrictEqual(s.counts, [3, 3, 0, 3])
        })

        it('is ready when every hub holds an open socket to every other hub', () => {
            const mvh = { hubs: [fakeHub(3, 0), fakeHub(3, 0), fakeHub(3, 0), fakeHub(3, 0)] }
            assert.strictEqual(meshState(mvh).ok, true)
        })

        it('is not ready when a hub has no consensus engine', () => {
            const hubs = [fakeHub(1, 0), fakeHub(1, 0)]
            delete hubs[1].consensus
            const s = meshState({ hubs })
            assert.strictEqual(s.ok, false)
            assert.deepStrictEqual(s.missingConsensus, [1])
        })

        it('returns as soon as the mesh forms rather than sleeping out the budget', async () => {
            const mvh = { hubs: [fakeHub(0, 1), fakeHub(0, 1)] }
            setTimeout(() => { mvh.hubs = [fakeHub(1, 0), fakeHub(1, 0)] }, 120)
            const started = Date.now()
            await waitForMesh(mvh, { timeoutMs: 10000, intervalMs: 20 })
            assert.ok(Date.now() - started < 3000, 'waitForMesh sat on the deadline instead of returning early')
        })

        it('throws with the observed per-hub counts when the mesh never forms', async () => {
            const mvh = { hubs: [fakeHub(1, 0), fakeHub(0, 1)] }
            await assert.rejects(
                () => waitForMesh(mvh, { timeoutMs: 200, intervalMs: 20 }),
                /mesh never formed.*saw \[1, 0\]/s)
        })
    })

    describe('config application', () => {
        const sel = { coin: 'BTC', network: 'regtest', module: 'node', key: 'GAS_PRICE', value: '700700' }

        it('reads undefined for a hub with no row and for a hub whose read throws', async () => {
            const broken = fakeHub(0, 0)
            broken.db.getConfig = async () => { throw new Error('connection lost') }
            const seen = await readConfigEverywhere([fakeHub(0, 0), broken, fakeHub(0, 0, { GAS_PRICE: '700700' })], sel)
            assert.deepStrictEqual(seen, [undefined, undefined, '700700'])
        })

        it('waits for a LAGGING follower instead of asserting at a fixed instant', async () => {
            // Lagging-follower shape: the leader resolved, hub 0 had not
            // written yet. A fixed settle asserts once; this waits for it.
            const lagging = fakeHub(0, 0)
            let applied = false
            lagging.db.getConfig = async () => (applied ? { GAS_PRICE: '700700' } : {})
            setTimeout(() => { applied = true }, 150)
            const hubs = [lagging, fakeHub(0, 0, { GAS_PRICE: '700700' })]
            const res = await waitForConfigEverywhere(hubs, sel, { timeoutMs: 10000, intervalMs: 20 })
            assert.strictEqual(res.ok, true)
        })

        it('names the hubs that never applied, and what each of them held', async () => {
            const hubs = [
                fakeHub(0, 0, { GAS_PRICE: '700700' }),
                fakeHub(0, 0, {}),
                fakeHub(0, 0, { GAS_PRICE: 'stale' })
            ]
            await assert.rejects(
                () => waitForConfigEverywhere(hubs, sel, { timeoutMs: 200, intervalMs: 20 }),
                /hub\(s\) 1, 2 did not apply.*"700700".*"stale"/s)
        })
    })

    describe('the negative direction (a round that must not finalize)', () => {
        const sel = { coin: 'BTC', network: 'regtest', module: 'node', key: 'GAS_PRICE', value: '5150' }

        it('holds for the whole window when no hub applies', async () => {
            const hubs = [fakeHub(0, 0, {}), fakeHub(0, 0, null)]
            const res = await assertNeverApplied(hubs, sel, { windowMs: 150, intervalMs: 20 })
            assert.strictEqual(res.ok, true)
            assert.ok(res.polls > 1, 'the window was not actually polled')
        })

        it('fails at the moment a hub applies, not only at the end of the window', async () => {
            const late = fakeHub(0, 0, {})
            let applied = false
            late.db.getConfig = async () => (applied ? { GAS_PRICE: '5150' } : {})
            setTimeout(() => { applied = true }, 100)
            const started = Date.now()
            await assert.rejects(
                () => assertNeverApplied([fakeHub(0, 0, {}), late], sel, { windowMs: 30000, intervalMs: 20 }),
                /hub 1 applied a config that should never finalize/)
            assert.ok(Date.now() - started < 10000, 'the negative wait sat out the whole window before failing')
        })
    })

    describe('waitFor', () => {
        it('carries the last observation out on a timeout', async () => {
            const res = await waitFor(() => ({ ok: false, note: 'still dialling' }), { timeoutMs: 100, intervalMs: 20 })
            assert.strictEqual(res.ok, false)
            assert.strictEqual(res.last.note, 'still dialling')
        })

        it('probes at least once even with a zero budget', async () => {
            let probes = 0
            const res = await waitFor(() => { probes++; return { ok: true } }, { timeoutMs: 0 })
            assert.strictEqual(probes, 1)
            assert.strictEqual(res.ok, true)
        })
    })
})
