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
 *
 * The three levers the barrier-family legs (bf1 to bf8) are built on, each
 * driven on its own BEFORE any leg exists:
 *
 *   1. the per-INDEX env overlay, which is the only seam that can run indexer 0
 *      under one rule and indexer 1 under another on one venue;
 *   2. the height PIN, the only lever that can hold a watermark-keyed member,
 *      because withholding a table passes watermark and heartbeat frames through
 *      by design;
 *   3. `repoRoot`, which decides whose BYTES the acceptance evidence is about.
 *
 * WHY IT LIVES IN THIS DIRECTORY AND STILL STARTS NOTHING. The legs beside it
 * are the venue's, so the levers belong beside the legs; but a lever proven only
 * by a leg is proven by the most expensive venue in the suite, in a run that also
 * needs the rail, a hub federation and two indexers. Nothing here spawns a child,
 * touches a database or reaches the rail: the pure decision layer is called with
 * synthetic payloads and the proxy is driven against a fake hub on loopback, the
 * same way `test/unit/helpers/hubDbMirrorProxy.test.js` drives the row levers.
 *
 * The one thing it reads from outside the package is the indexer's own source,
 * to derive the barrier family. That is deliberate: the venue pins graces over
 * EIGHT keys and the indexer reports NINE reasons, and a test that hardcoded
 * either number would go green through the exact gap it exists to watch.
 ********************************************************************/

const assert = require('assert')
const http   = require('http')
const os     = require('os')
const path   = require('path')
const fs     = require('fs')

const venueHelperPath = require.resolve('../helpers/attestMirrorVenue')
const {
    AttestMirrorVenue, HubDbMirrorProxy,
    buildIndexerEnv, indexerEnvOverlay, resolveRepoRoot,
    pinHeightsInPayload, pinHeightsInFrameText, encodeServerTextFrame,
    readServerFrames, HEIGHT_PIN_FRAME_TYPES,
    MIRROR_BARRIERS, mirrorBarrierReasons, gracedBarrierReason, ungracedMirrorBarrierReasons,
} = require('../helpers/attestMirrorVenue')

const TABLE = 'cross_chain_matches'
const OTHER = 'attestation_responses'

// A complete indexer spec, so `buildIndexerEnv` is exercised exactly as the venue
// calls it rather than through its error paths.
function indexerSpec (over) {
    return Object.assign({
        coin: 'BTC', network: 'regtest', apiPort: 41010,
        indexerDbName: 'xc_venue_Ixr0', mirrorDbName: 'xc_venue_Mir0',
        hubApiUrl: 'http://127.0.0.1:41002',
        db:      { host: '127.0.0.1', port: 3399, user: 'venue', pass: 'venue' },
        decoder: { host: '127.0.0.1', port: 3306, name: 'btc_decoder', user: 'ro', pass: 'ro' },
        node:    { host: '127.0.0.1', port: 18443, user: 'n', pass: 'n' },
        tracker: { host: '127.0.0.1', port: 3005 },
        feeDestination: 'bcrt1qexample',
        path: '/usr/bin', home: '/tmp',
    }, over || {})
}

// The three carriers, as the hub will serve them once the producer ships: the
// heartbeat, the frame every reconnect reads, and one of the ten snapshot pages.
function watermarkFrame (heights) {
    const f = { type: 'watermark', ts: 1788494058 }
    if (heights) f.heights = heights
    return f
}

function readyFrame (heights) {
    const f = {
        type: 'ready',
        max_ids: { cross_chain_matches: 91, attestation_responses: 40 },
        watermark: 1788494058, watermark_interval_ms: 15000,
    }
    if (heights) f.heights = heights
    return f
}

function snapshotPage (table, heights) {
    const p = {
        table: table, rows: [{ id: 1 }, { id: 2 }], count: 2,
        watermark: 1788494058, schema_version: 7,
    }
    if (heights) p.heights = heights
    return p
}

const LIVE_HEIGHTS = () => ({
    cross_chain_matches:   { BTC: 812, LTC: 5501 },
    attestation_responses: { BTC: 812 },
})

describe('attestMirror venue levers (pure: no venue, no children, no database, no rail)', () => {

    // -----------------------------------------------------------------------
    // Lever 1: the per-index env overlay (F28)
    // -----------------------------------------------------------------------
    describe('lever 1: the per-INDEX env overlay', () => {

        const ARM = 'XCHAIN_MIRROR_ADMISSION_HEIGHT_REGTEST'

        it('arms indexer 0 and leaves indexer 1 inert, which is the whole point of it', () => {
            const perIndex = { 0: { [ARM]: '0' } }
            const armed = buildIndexerEnv(indexerSpec({ extraEnv: indexerEnvOverlay(perIndex, 0) }))
            const inert = buildIndexerEnv(indexerSpec({ extraEnv: indexerEnvOverlay(perIndex, 1) }))

            assert.strictEqual(armed[ARM], '0',
                'the overlay did not reach indexer 0, so nothing can arm one node of a two-node venue')
            assert.ok(!(ARM in inert),
                'the overlay reached indexer 1 as well, so the two nodes would run the SAME rule and ' +
                'a flag-day leg would compare a node against itself')

            // Every OTHER key identical: an overlay that also perturbed the mirror
            // database or the hub url would make the two nodes differ for a second
            // reason and the leg could not attribute the divergence to the rule.
            const strippedArmed = Object.assign({}, armed)
            delete strippedArmed[ARM]
            assert.deepStrictEqual(strippedArmed, inert,
                'the overlay changed more than the key it was given')
        })

        it('applies LAST, so an overlay can override a venue-wide key', () => {
            // HUB_DB_SYNC_POLL_INTERVAL is set venue-wide inside buildIndexerEnv; an
            // overlay merged FIRST could only add keys, never change one, which is the
            // wrong half of the job.
            const base = buildIndexerEnv(indexerSpec())
            assert.strictEqual(base.HUB_DB_SYNC_POLL_INTERVAL, '5000')
            const over = buildIndexerEnv(indexerSpec({
                extraEnv: indexerEnvOverlay({ 1: { HUB_DB_SYNC_POLL_INTERVAL: '250' } }, 1),
            }))
            assert.strictEqual(over.HUB_DB_SYNC_POLL_INTERVAL, '250',
                'the overlay lost to the venue-wide value, so it is merged in the wrong order and can ' +
                'never change a rule the venue already sets')
        })

        it('leaves the environment byte-identical when nothing is overlaid', () => {
            const before = JSON.stringify(buildIndexerEnv(indexerSpec()))
            for (const perIndex of [undefined, null, {}, { 1: { A: 'b' } }, { 0: {} }, { 0: 'not-an-object' }]) {
                const after = JSON.stringify(buildIndexerEnv(indexerSpec({
                    extraEnv: indexerEnvOverlay(perIndex, 0),
                })))
                assert.strictEqual(after, before,
                    'an unset overlay changed the environment for ' + JSON.stringify(perIndex) +
                    ', so every existing leg on this venue is now running a different child')
                assert.strictEqual(indexerEnvOverlay(perIndex, 0), null,
                    'an unset overlay must be null rather than an empty object, or buildIndexerEnv ' +
                    'takes a branch it did not take before')
            }
        })

        it('stringifies values, because a number in a spawn environment throws', () => {
            const out = indexerEnvOverlay({ 0: { A: 0, B: true } }, 0)
            assert.deepStrictEqual(out, { A: '0', B: 'true' })
        })

        it('is carried on the venue as a per-index map', () => {
            const venue = new AttestMirrorVenue({ label: 'levers', indexerEnv: { 0: { [ARM]: '0' } } })
            assert.deepStrictEqual(venue.indexerEnv, { 0: { [ARM]: '0' } })
            assert.deepStrictEqual(new AttestMirrorVenue({ label: 'levers' }).indexerEnv, {},
                'an unset venue must carry an empty overlay map, not undefined')
        })
    })

    // -----------------------------------------------------------------------
    // Lever 2: the heights pin (F16, C18)
    // -----------------------------------------------------------------------
    describe('lever 2: the heights pin, on all three carriers', () => {

        const PIN = { [TABLE]: { BTC: 700 } }

        it('pins the watermark heartbeat while ts keeps flowing', () => {
            const out = pinHeightsInPayload(watermarkFrame(LIVE_HEIGHTS()), PIN)
            assert.strictEqual(out.pinned, 1)
            assert.strictEqual(out.changed, true)
            assert.strictEqual(out.payload.heights[TABLE].BTC, 700)
            assert.strictEqual(out.payload.heights[TABLE].LTC, 5501,
                'the pin froze a chain nobody pinned, so an unrelated chain would stall too')
            assert.strictEqual(out.payload.heights[OTHER].BTC, 812,
                'the pin froze a table nobody pinned')
            assert.strictEqual(out.payload.ts, 1788494058,
                'the pin touched ts, which the stream-stall detector reads: that stalls the whole ' +
                'stream instead of one member and every barrier starves at once')
        })

        it('pins the ready frame, which is what a reconnect reads', () => {
            const out = pinHeightsInPayload(readyFrame(LIVE_HEIGHTS()), PIN)
            assert.strictEqual(out.payload.heights[TABLE].BTC, 700)
            assert.deepStrictEqual(out.payload.max_ids, { cross_chain_matches: 91, attestation_responses: 40 })
            assert.strictEqual(out.payload.watermark, 1788494058)
            assert.strictEqual(out.payload.watermark_interval_ms, 15000)
        })

        it('pins a REST snapshot page, which is what a poll-mode bootstrap reads', () => {
            const out = pinHeightsInPayload(snapshotPage(TABLE, LIVE_HEIGHTS()), PIN)
            assert.strictEqual(out.payload.heights[TABLE].BTC, 700)
            assert.deepStrictEqual(out.payload.rows, [{ id: 1 }, { id: 2 }],
                'the pin dropped or rewrote rows, which is the row lever\'s job and not this one\'s')
            assert.strictEqual(out.payload.count, 2)
            assert.strictEqual(out.payload.watermark, 1788494058)
            assert.strictEqual(out.payload.schema_version, 7)
        })

        // C18: one carrier left live and the follower re-reads the true height the
        // first time it reconnects or polls, so the leg passes for the wrong reason.
        it('pins ALL THREE carriers, not a subset', () => {
            const carriers = {
                watermark: watermarkFrame(LIVE_HEIGHTS()),
                ready:     readyFrame(LIVE_HEIGHTS()),
                snapshot:  snapshotPage(TABLE, LIVE_HEIGHTS()),
            }
            for (const [name, payload] of Object.entries(carriers)) {
                const out = pinHeightsInPayload(payload, PIN)
                assert.strictEqual(out.changed, true, name + ' was not pinned at all')
                assert.strictEqual(out.payload.heights[TABLE].BTC, 700,
                    'the ' + name + ' carrier escaped the pin, so a reconnect or a poll re-establishes ' +
                    'the true height and the member under test clears on its own')
            }
        })

        it('is a visible no-op when the hub publishes no heights at all', () => {
            const frame = watermarkFrame(null)
            const out = pinHeightsInPayload(frame, PIN)
            assert.strictEqual(out.absent, true, 'an absent heights map must be reported, not swallowed')
            assert.strictEqual(out.pinned, 0)
            assert.strictEqual(out.changed, false)
            assert.strictEqual(out.payload, frame, 'the payload must pass through untouched')
            assert.ok(!('heights' in out.payload),
                'the pin INVENTED a heights map: that tests a wire shape no hub produces')
        })

        it('counts an entry it could not overlay instead of creating one', () => {
            const live = LIVE_HEIGHTS()
            const missingChain = pinHeightsInPayload(watermarkFrame(live), { [OTHER]: { LTC: 9 } })
            assert.strictEqual(missingChain.pinned, 0)
            assert.strictEqual(missingChain.unmatched, 1)
            assert.strictEqual(missingChain.changed, false)
            assert.ok(!('LTC' in missingChain.payload.heights[OTHER]),
                'the pin created a chain the hub does not publish')

            const missingTable = pinHeightsInPayload(watermarkFrame(live), { bridge_transfers: { BTC: 9 } })
            assert.strictEqual(missingTable.pinned, 0)
            assert.strictEqual(missingTable.unmatched, 1)
            assert.ok(!('bridge_transfers' in missingTable.payload.heights),
                'the pin created a table the hub does not publish')
        })

        it('does not mutate the payload it was given', () => {
            const live = LIVE_HEIGHTS()
            const frame = watermarkFrame(live)
            const snapshot = JSON.stringify(frame)
            pinHeightsInPayload(frame, PIN)
            assert.strictEqual(JSON.stringify(frame), snapshot,
                'the pin mutated its input, so a caller still holding the original sees a pinned height')
        })

        it('claims only the two frame types that carry heights', () => {
            assert.deepStrictEqual(Array.from(HEIGHT_PIN_FRAME_TYPES), ['watermark', 'ready'])
            const row = JSON.stringify({ type: 'row:inserted', table: TABLE, row: { id: 7 } })
            const out = pinHeightsInFrameText(row, PIN)
            assert.strictEqual(out.type, null, 'a row event was claimed by the height pin')
            assert.strictEqual(out.text, null, 'a row event must be forwarded as its original bytes')
            assert.strictEqual(pinHeightsInFrameText('not json', PIN).type, null)
        })

        it('re-encodes a pinned frame so the reader can read it back', () => {
            const out = pinHeightsInFrameText(JSON.stringify(watermarkFrame(LIVE_HEIGHTS())), PIN)
            assert.strictEqual(out.type, 'watermark')
            const bytes = encodeServerTextFrame(out.text)
            const read = readServerFrames(bytes)
            assert.strictEqual(read.frames.length, 1)
            assert.strictEqual(read.rest.length, 0)
            assert.strictEqual(JSON.parse(read.frames[0].text).heights[TABLE].BTC, 700)

            // The 16-bit length form is where a real heights map lands once every table
            // and chain is in it, so it has to round-trip too.
            const big = encodeServerTextFrame(JSON.stringify({ type: 'watermark', ts: 1, pad: 'x'.repeat(400) }))
            const readBig = readServerFrames(big)
            assert.strictEqual(readBig.frames.length, 1)
            assert.strictEqual(JSON.parse(readBig.frames[0].text).pad.length, 400)
        })

        it('refuses a pin it cannot apply rather than arming a silent no-op', () => {
            const proxy = new HubDbMirrorProxy(0, 1, 'levers')
            assert.throws(() => proxy.pinHeights(null), /non-empty/)
            assert.throws(() => proxy.pinHeights({}), /non-empty/)
            assert.throws(() => proxy.pinHeights({ [TABLE]: {} }), /non-empty/)
            assert.throws(() => proxy.pinHeights({ [TABLE]: { BTC: 'soon' } }), /not a finite height/)
            assert.strictEqual(proxy.heightPin, null)
        })
    })

    // -----------------------------------------------------------------------
    // The pin through the proxy's real paths, against a fake hub on loopback.
    // -----------------------------------------------------------------------
    describe('lever 2, driven: the proxy pins the wire, not just the decision layer', () => {

        let upstream = null
        let proxy    = null
        let heights  = null

        const get = (port, p) => new Promise((resolve, reject) => {
            http.get({ host: '127.0.0.1', port: port, path: p }, (res) => {
                const chunks = []
                res.on('data', (c) => chunks.push(c))
                res.on('end', () => resolve({ status: res.statusCode, raw: Buffer.concat(chunks).toString('utf8') }))
            }).on('error', reject)
        })

        beforeEach(async () => {
            heights = LIVE_HEIGHTS()
            upstream = http.createServer((req, res) => {
                const table = (/^\/hub-db\/snapshot\/([A-Za-z0-9_]+)$/.exec(String(req.url).split('?')[0]) || [])[1]
                res.writeHead(200, { 'content-type': 'application/json' })
                res.end(JSON.stringify(snapshotPage(table || 'unknown', heights)))
            })
            await new Promise((r) => upstream.listen(0, '127.0.0.1', r))
            proxy = new HubDbMirrorProxy(0, upstream.address().port, 'levers')
            await proxy.start()
        })

        afterEach(async () => {
            if (proxy) await proxy.stop()
            if (upstream) await new Promise((r) => upstream.close(r))
        })

        it('is a byte-for-byte relay with no pin armed', async () => {
            const res = await get(proxy._server.address().port, '/hub-db/snapshot/' + TABLE)
            assert.strictEqual(res.raw, JSON.stringify(snapshotPage(TABLE, heights)),
                'an unarmed proxy rewrote a snapshot page, so every existing leg is now reading a ' +
                'body this venue re-serialized')
        })

        it('pins every snapshot page, filtered or not, and counts it', async () => {
            proxy.pinHeights({ [TABLE]: { BTC: 700 } })
            const port = proxy._server.address().port

            const pinned = JSON.parse((await get(port, '/hub-db/snapshot/' + TABLE)).raw)
            assert.strictEqual(pinned.heights[TABLE].BTC, 700)
            assert.deepStrictEqual(pinned.rows, [{ id: 1 }, { id: 2 }],
                'the pin held rows back; rows are the OTHER lever and must keep flowing under a pin')
            assert.strictEqual(pinned.watermark, 1788494058)

            // A page for a table nobody withheld still carries the map, because that is
            // where a poll-mode bootstrap reads its baseline.
            const other = JSON.parse((await get(port, '/hub-db/snapshot/' + OTHER)).raw)
            assert.strictEqual(other.heights[TABLE].BTC, 700)
            assert.strictEqual(other.heights[OTHER].BTC, 812)

            assert.strictEqual(proxy.heightPinStats.snapshot.pinned, 2)
            assert.strictEqual(proxy.heightPinStats.snapshot.absent, 0)
        })

        it('serves the hub\'s own heights again once released', async () => {
            const port = proxy._server.address().port
            proxy.pinHeights({ [TABLE]: { BTC: 700 } })
            assert.strictEqual(JSON.parse((await get(port, '/hub-db/snapshot/' + TABLE)).raw).heights[TABLE].BTC, 700)
            proxy.releaseHeights()
            assert.strictEqual(JSON.parse((await get(port, '/hub-db/snapshot/' + TABLE)).raw).heights[TABLE].BTC, 812,
                'the release did not restore the hub\'s real height, so the recovery half of every ' +
                'leg would be asserting against a still-pinned mirror')
        })

        it('forwards the original bytes and counts an absent map when the hub publishes none', async () => {
            heights = null
            proxy.pinHeights({ [TABLE]: { BTC: 700 } })
            const res = await get(proxy._server.address().port, '/hub-db/snapshot/' + TABLE)
            assert.strictEqual(res.raw, JSON.stringify(snapshotPage(TABLE, null)))
            assert.strictEqual(proxy.heightPinStats.snapshot.absent, 1,
                'an armed pin that found no heights map must say so: that is the signal that the ' +
                'hub-side producer has not shipped, and it must never read as a pass')
            assert.strictEqual(proxy.heightPinStats.snapshot.pinned, 0)
        })

        it('pins the stream frames and leaves a row event\'s bytes alone', () => {
            // The frame path, driven directly with a socket that only collects bytes:
            // the upgrade handshake is the WebSocket protocol's business and not this
            // lever's, and `_forwardFrame` is where every byte decision is made.
            const written = []
            const socket = { destroyed: false, write: (b) => written.push(Buffer.from(b)) }
            proxy.pinHeights({ [TABLE]: { BTC: 700 } })

            const send = (obj) => {
                const bytes = encodeServerTextFrame(JSON.stringify(obj))
                proxy._forwardFrame(socket, readServerFrames(bytes).frames[0])
                return bytes
            }

            send(watermarkFrame(LIVE_HEIGHTS()))
            send(readyFrame(LIVE_HEIGHTS()))
            const rowBytes = send({ type: 'row:inserted', table: TABLE, row: { id: 9 } })

            const out = written.map((b) => readServerFrames(b).frames[0])
            assert.strictEqual(JSON.parse(out[0].text).heights[TABLE].BTC, 700, 'the heartbeat escaped the pin')
            assert.strictEqual(JSON.parse(out[0].text).ts, 1788494058, 'the heartbeat lost its ts')
            assert.strictEqual(JSON.parse(out[1].text).heights[TABLE].BTC, 700, 'the ready frame escaped the pin')
            assert.strictEqual(JSON.parse(out[1].text).max_ids.cross_chain_matches, 91)
            assert.ok(written[2].equals(rowBytes),
                'a row event was re-encoded by the height pin; rows must be forwarded verbatim')

            assert.strictEqual(proxy.heightPinStats.watermark.pinned, 1)
            assert.strictEqual(proxy.heightPinStats.ready.pinned, 1)
        })

        it('refuses to let a leg claim a pin that rewrote nothing', async () => {
            const venue = new AttestMirrorVenue({ label: 'levers' })
            venue.indexers = [{ index: 0, mirrorProxy: proxy }]
            const port = proxy._server.address().port

            heights = null
            venue.pinMirrorHeights(0, { [TABLE]: { BTC: 700 } })
            await get(port, '/hub-db/snapshot/' + TABLE)
            assert.throws(() => venue.assertMirrorHeightPinObserved(0, { carriers: ['snapshot'] }),
                /rewrote nothing on snapshot/,
                'a pin that never rewrote a byte was accepted, which is exactly how a barrier leg ' +
                'reads green against a hub that publishes no heights')

            heights = LIVE_HEIGHTS()
            await get(port, '/hub-db/snapshot/' + TABLE)
            const stats = venue.assertMirrorHeightPinObserved(0, { carriers: ['snapshot'] })
            assert.strictEqual(stats.snapshot.pinned, 1)
            venue.releaseMirrorHeights(0)
            assert.strictEqual(proxy.heightPin, null)
        })
    })

    // -----------------------------------------------------------------------
    // Lever 3: repoRoot (B4)
    // -----------------------------------------------------------------------
    describe('lever 3: the tree the venue\'s children are spawned from', () => {

        const CHILD = path.join('xchain-e2e-test', 'test', 'helpers', 'attestMirrorVenue.js')

        it('defaults to the checkout this venue file itself lives in', () => {
            const root = resolveRepoRoot(undefined, {})
            // Same FILE, not merely a file of the same name: a shared tree beside this
            // lane holds a file at the identical relative path, and a prefix check would
            // pass against it while the children ran someone else's uncommitted bytes.
            assert.strictEqual(fs.realpathSync(path.join(root, CHILD)), fs.realpathSync(venueHelperPath),
                'the default repoRoot does not contain THIS venue file, so the children would run ' +
                'a different checkout than the leg believes it is testing')
            assert.strictEqual(new AttestMirrorVenue({ label: 'levers' }).repoRoot, root)
        })

        it('takes an env override, and an explicit root beats it', () => {
            const root = resolveRepoRoot(undefined, {})
            assert.strictEqual(resolveRepoRoot(undefined, { XCHAIN_VENUE_REPO_ROOT: root }), root)
            assert.strictEqual(resolveRepoRoot(root, { XCHAIN_VENUE_REPO_ROOT: os.tmpdir() }), root,
                'an ambient env beat an explicit root, so a leg that pins its own tree cannot')
        })

        it('refuses an explicit root with no children in it, instead of timing out on boot', () => {
            assert.throws(() => resolveRepoRoot(os.tmpdir(), {}), /has no xchain-hub\/src\/api\.js/)
            assert.throws(() => resolveRepoRoot(undefined, { XCHAIN_VENUE_REPO_ROOT: os.tmpdir() }),
                /XCHAIN_VENUE_REPO_ROOT/)
        })

        it('ignores an unrelated environment, so UNSET is what it always was', () => {
            assert.strictEqual(resolveRepoRoot(undefined, { XCHAIN_HUB_PATH: os.tmpdir() }),
                resolveRepoRoot(undefined, {}),
                'XCHAIN_HUB_PATH redirected this venue; it is read by multiValidatorHubHelper alone')
        })
    })

    // -----------------------------------------------------------------------
    // The family, and the member the venue's grace pinning cannot see (B12, F15)
    // -----------------------------------------------------------------------
    describe('the barrier family versus the grace table the venue pins over', () => {

        it('reads NINE reasons from the indexer while the grace table has EIGHT keys', () => {
            assert.strictEqual(mirrorBarrierReasons().length, 9,
                'the mirror barrier family changed size; a leg enumerating it from /status is now ' +
                'asserting the wrong count')
            assert.strictEqual(MIRROR_BARRIERS.length, 8)
        })

        it('names the gap rather than inventing a grace to close it', () => {
            assert.deepStrictEqual(ungracedMirrorBarrierReasons(), ['snapshot_sync_barrier'],
                'the set of barriers the venue CANNOT pin a grace for changed; a leg that leaves one ' +
                'of them at its frozen grace parks every block behind it')
            assert.ok(!Object.prototype.hasOwnProperty.call(
                require('../../../xchain-indexer/src/hub_db_sync.js').HUB_SYNC_WATERMARK_GRACE_S, 'snapshot'),
                'a grace key was added for the snapshot member; the venue must stop treating it as ' +
                'the ungraced one')
        })

        it('derives every graced key\'s reason from the indexer, so a rename is loud', () => {
            for (const key of MIRROR_BARRIERS) {
                const reason = gracedBarrierReason(key)
                assert.ok(mirrorBarrierReasons().includes(reason),
                    'grace key ' + key + ' names ' + reason + ', which the indexer does not report')
            }
            assert.strictEqual(gracedBarrierReason('anchorAttest'), 'anchor_attest_barrier',
                'the one member whose reason is not <key>_sync_barrier')
            assert.throws(() => gracedBarrierReason('notABarrier'), /names no barrier reason/)
        })

        it('excludes the two _barrier reasons that are not keyed on the mirror watermark', () => {
            for (const outsider of ['bridge_proof_barrier', 'call_presence_barrier']) {
                assert.ok(!mirrorBarrierReasons().includes(outsider),
                    outsider + ' was counted as a mirror barrier; it is not watermark-keyed and a leg ' +
                    'would wait for a grace that cannot reach it')
            }
        })
    })
})
