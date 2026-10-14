'use strict'

// Lever 2 registrars, decision layer: the heights pin on payloads and frames.

const assert = require('assert')
const {
    HubDbMirrorProxy, pinHeightsInPayload, pinHeightsInFrameText, encodeServerTextFrame,
    readServerFrames, HEIGHT_PIN_FRAME_TYPES,
} = require('../../helpers/attestMirrorVenue')
const {
    TABLE, OTHER, PIN, watermarkFrame, readyFrame, snapshotPage, LIVE_HEIGHTS,
} = require('./venue_levers_fixture')

// -----------------------------------------------------------------------
// Lever 2: the heights pin (F16, C18)
// -----------------------------------------------------------------------
function registerHeightPinLever () {
    registerHeightPinCarriers()
    registerHeightPinEdges()
    registerHeightPinFrames()
}

function registerHeightPinCarriers () {
    registerHeightPinFirstCarriers()
    registerHeightPinAllCarriers()
}

function registerHeightPinFirstCarriers () {
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
}

function registerHeightPinAllCarriers () {
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
}

function registerHeightPinEdges () {
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
}

function registerHeightPinFrames () {
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
}

module.exports = { registerHeightPinLever }
