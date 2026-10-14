'use strict'

// Lever 2 registrars, driven: the proxy pins the wire against a fake hub.

const assert = require('assert')
const { AttestMirrorVenue, encodeServerTextFrame, readServerFrames } = require('../../helpers/attestMirrorVenue')
const {
    TABLE, OTHER, watermarkFrame, readyFrame, snapshotPage, LIVE_HEIGHTS, httpGet,
    startDrivenProxy, stopDrivenProxy,
} = require('./venue_levers_fixture')

// -----------------------------------------------------------------------
// The pin through the proxy's real paths, against a fake hub on loopback.
// -----------------------------------------------------------------------
function registerDrivenHeightPin () {
    // Shared by the hooks and the tests: the fake hub reads `heights` per request,
    // so a test that reassigns it changes what the next snapshot page carries.
    const ctx = { upstream: null, proxy: null, heights: null }
    beforeEach(() => startDrivenProxy(ctx))
    afterEach(() => stopDrivenProxy(ctx))
    registerDrivenSnapshotPin(ctx)
    registerDrivenStreamPin(ctx)
}

function registerDrivenSnapshotPin (ctx) {
    it('is a byte-for-byte relay with no pin armed', () => relaysUnarmed(ctx))
    it('pins every snapshot page, filtered or not, and counts it', () => pinsEverySnapshotPage(ctx))
    it('serves the hub\'s own heights again once released', () => servesAgainOnRelease(ctx))
    it('forwards the original bytes and counts an absent map when the hub publishes none',
        () => countsAbsentMap(ctx))
}

const proxyPort = (ctx) => ctx.proxy['_server'].address().port

async function relaysUnarmed (ctx) {
    const res = await httpGet(proxyPort(ctx), '/hub-db/snapshot/' + TABLE)
    assert.strictEqual(res.raw, JSON.stringify(snapshotPage(TABLE, ctx.heights)),
        'an unarmed proxy rewrote a snapshot page, so every existing leg is now reading a ' +
        'body this venue re-serialized')
}

async function pinsEverySnapshotPage (ctx) {
    ctx.proxy.pinHeights({ [TABLE]: { BTC: 700 } })
    const port = proxyPort(ctx)

    const pinned = JSON.parse((await httpGet(port, '/hub-db/snapshot/' + TABLE)).raw)
    assert.strictEqual(pinned.heights[TABLE].BTC, 700)
    assert.deepStrictEqual(pinned.rows, [{ id: 1 }, { id: 2 }],
        'the pin held rows back; rows are the OTHER lever and must keep flowing under a pin')
    assert.strictEqual(pinned.watermark, 1788494058)

    // A page for a table nobody withheld still carries the map, because that is
    // where a poll-mode bootstrap reads its baseline.
    const other = JSON.parse((await httpGet(port, '/hub-db/snapshot/' + OTHER)).raw)
    assert.strictEqual(other.heights[TABLE].BTC, 700)
    assert.strictEqual(other.heights[OTHER].BTC, 812)

    assert.strictEqual(ctx.proxy.heightPinStats.snapshot.pinned, 2)
    assert.strictEqual(ctx.proxy.heightPinStats.snapshot.absent, 0)
}

async function servesAgainOnRelease (ctx) {
    const port = proxyPort(ctx)
    ctx.proxy.pinHeights({ [TABLE]: { BTC: 700 } })
    assert.strictEqual(JSON.parse((await httpGet(port, '/hub-db/snapshot/' + TABLE)).raw).heights[TABLE].BTC, 700)
    ctx.proxy.releaseHeights()
    assert.strictEqual(JSON.parse((await httpGet(port, '/hub-db/snapshot/' + TABLE)).raw).heights[TABLE].BTC, 812,
        'the release did not restore the hub\'s real height, so the recovery half of every ' +
        'leg would be asserting against a still-pinned mirror')
}

async function countsAbsentMap (ctx) {
    ctx.heights = null
    ctx.proxy.pinHeights({ [TABLE]: { BTC: 700 } })
    const res = await httpGet(proxyPort(ctx), '/hub-db/snapshot/' + TABLE)
    assert.strictEqual(res.raw, JSON.stringify(snapshotPage(TABLE, null)))
    assert.strictEqual(ctx.proxy.heightPinStats.snapshot.absent, 1,
        'an armed pin that found no heights map must say so: that is the signal that the ' +
        'hub-side producer has not shipped, and it must never read as a pass')
    assert.strictEqual(ctx.proxy.heightPinStats.snapshot.pinned, 0)
}

function registerDrivenStreamPin (ctx) {
    it('pins the stream frames and leaves a row event\'s bytes alone', () => streamPinsFrames(ctx))
    it('refuses to let a leg claim a pin that rewrote nothing', () => refusesEmptyPinClaim(ctx))
}

// The frame path, driven directly with a socket that only collects bytes:
// the upgrade handshake is the WebSocket protocol's business and not this
// lever's, and `_forwardFrame` is where every byte decision is made.
function sendStreamFrames (ctx) {
    const written = []
    const socket = { destroyed: false, write: (b) => written.push(Buffer.from(b)) }
    ctx.proxy.pinHeights({ [TABLE]: { BTC: 700 } })

    const send = (obj) => {
        const bytes = encodeServerTextFrame(JSON.stringify(obj))
        ctx.proxy['_forwardFrame'](socket, readServerFrames(bytes).frames[0])
        return bytes
    }

    send(watermarkFrame(LIVE_HEIGHTS()))
    send(readyFrame(LIVE_HEIGHTS()))
    const rowBytes = send({ type: 'row:inserted', table: TABLE, row: { id: 9 } })
    return { written, rowBytes }
}

async function streamPinsFrames (ctx) {
    const { written, rowBytes } = sendStreamFrames(ctx)

    const out = written.map((b) => readServerFrames(b).frames[0])
    assert.strictEqual(JSON.parse(out[0].text).heights[TABLE].BTC, 700, 'the heartbeat escaped the pin')
    assert.strictEqual(JSON.parse(out[0].text).ts, 1788494058, 'the heartbeat lost its ts')
    assert.strictEqual(JSON.parse(out[1].text).heights[TABLE].BTC, 700, 'the ready frame escaped the pin')
    assert.strictEqual(JSON.parse(out[1].text).max_ids.cross_chain_matches, 91)
    assert.ok(written[2].equals(rowBytes),
        'a row event was re-encoded by the height pin; rows must be forwarded verbatim')

    assert.strictEqual(ctx.proxy.heightPinStats.watermark.pinned, 1)
    assert.strictEqual(ctx.proxy.heightPinStats.ready.pinned, 1)
}

async function refusesEmptyPinClaim (ctx) {
    const venue = new AttestMirrorVenue({ label: 'levers' })
    venue.indexers = [{ index: 0, mirrorProxy: ctx.proxy }]
    const port = ctx.proxy['_server'].address().port

    ctx.heights = null
    venue.pinMirrorHeights(0, { [TABLE]: { BTC: 700 } })
    await httpGet(port, '/hub-db/snapshot/' + TABLE)
    assert.throws(() => venue.assertMirrorHeightPinObserved(0, { carriers: ['snapshot'] }),
        /rewrote nothing on snapshot/,
        'a pin that never rewrote a byte was accepted, which is exactly how a barrier leg ' +
        'reads green against a hub that publishes no heights')

    ctx.heights = LIVE_HEIGHTS()
    await httpGet(port, '/hub-db/snapshot/' + TABLE)
    const stats = venue.assertMirrorHeightPinObserved(0, { carriers: ['snapshot'] })
    assert.strictEqual(stats.snapshot.pinned, 1)
    venue.releaseMirrorHeights(0)
    assert.strictEqual(ctx.proxy.heightPin, null)
}

module.exports = { registerDrivenHeightPin }
