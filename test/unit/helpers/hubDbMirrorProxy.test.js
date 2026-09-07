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
 * The hub-DB mirror proxy: the per-table, per-edge withhold and delay.
 *
 * WHY THIS SUITE IS NOT OPTIONAL. This lever is a FAULT INJECTOR, and a fault
 * injector that quietly does nothing turns an acceptance test green while proving
 * the opposite of what it claims: the drill would assert that a barrier held when
 * in fact nothing was ever withheld. So the two halves are tested against each
 * other here. With the withhold armed the target table must be absent WHILE A
 * CONTROL TABLE IS STILL SERVED, and releasing must restore it.
 *
 * It runs against a fake upstream on a loopback port. No venue, no hub, no
 * database, no chain: the proxy is HTTP and bytes, and that is all this needs.
 ********************************************************************/

const assert = require('assert')
const http   = require('http')

const {
    HubDbMirrorProxy, snapshotTableOf, mirrorFilterVerdict, filterSnapshotBody,
    readServerFrames, mirrorFrameTable,
    MIRROR_WITHHOLD, MIRROR_DELAY, MIRROR_PASS, MIRROR_DROP, MIRROR_HOLD,
} = require('../../helpers/attestMirrorVenue')

const TARGET  = 'attestation_responses'
const CONTROL = 'price_snapshots'

/** One text frame as a server sends it: FIN, opcode 1, unmasked. */
function serverTextFrame (text) {
    const payload = Buffer.from(text, 'utf8')
    let header
    if (payload.length < 126) {
        header = Buffer.from([0x81, payload.length])
    } else {
        header = Buffer.alloc(4)
        header[0] = 0x81
        header[1] = 126
        header.writeUInt16BE(payload.length, 2)
    }
    return Buffer.concat([header, payload])
}

function rowEvent (table, id) {
    return JSON.stringify({ type: 'row:inserted', table: table, row: { id: id, request_id: 'r' + id } })
}

describe('hubDbMirrorProxy: the per-table mirror fault injection', () => {

    describe('snapshotTableOf', () => {

        it('names the table a snapshot request is for, with or without a query', () => {
            assert.strictEqual(snapshotTableOf('/hub-db/snapshot/attestation_responses'), TARGET)
            assert.strictEqual(snapshotTableOf('/hub-db/snapshot/attestation_responses?since_id=0&limit=10000'), TARGET)
        })

        // The socket must never be mistaken for a snapshot: it is handled on the
        // upgrade, and filtering it as a route would break the whole mirror.
        it('does not claim the subscribe socket or any other path', () => {
            assert.strictEqual(snapshotTableOf('/hub-db/subscribe'), null)
            assert.strictEqual(snapshotTableOf('/status'), null)
            assert.strictEqual(snapshotTableOf('/hub-db/snapshot/'), null)
            assert.strictEqual(snapshotTableOf('/prefix/hub-db/snapshot/attestation_responses'), null)
            assert.strictEqual(snapshotTableOf(''), null)
        })
    })

    describe('mirrorFilterVerdict', () => {

        it('passes everything when no filter is armed', () => {
            assert.strictEqual(mirrorFilterVerdict(null, 0, 1000), MIRROR_PASS)
        })

        it('drops indefinitely under a withhold', () => {
            const f = { mode: MIRROR_WITHHOLD }
            assert.strictEqual(mirrorFilterVerdict(f, 0, 1000), MIRROR_DROP)
            assert.strictEqual(mirrorFilterVerdict(f, 0, 10 ** 9), MIRROR_DROP,
                'a withhold that expires is a delay, and the two modes must not blur')
        })

        it('holds a row under a delay until its time is up, then passes it', () => {
            const f = { mode: MIRROR_DELAY, delayMs: 5000 }
            assert.strictEqual(mirrorFilterVerdict(f, 1000, 1000), MIRROR_HOLD)
            assert.strictEqual(mirrorFilterVerdict(f, 1000, 5999), MIRROR_HOLD)
            assert.strictEqual(mirrorFilterVerdict(f, 1000, 6000), MIRROR_PASS)
            assert.strictEqual(mirrorFilterVerdict(f, 1000, 60000), MIRROR_PASS)
        })

        it('holds rather than passing when the clock is unreadable, which fails closed', () => {
            assert.strictEqual(mirrorFilterVerdict({ mode: MIRROR_DELAY, delayMs: 5 }, null, 1000), MIRROR_HOLD)
        })

        it('refuses a mode it does not know instead of silently passing traffic', () => {
            assert.throws(() => mirrorFilterVerdict({ mode: 'sometimes' }, 0, 0), /unknown mirror filter mode/)
        })
    })

    describe('filterSnapshotBody', () => {

        const body = () => ({
            table: TARGET, rows: [{ id: 1 }, { id: 2 }], count: 2,
            watermark: 1788494058, schema_version: 5,
        })

        // THE CENTRAL REQUIREMENT. Suppress these two and every barrier starves,
        // which is the blunt fault this lever exists to avoid.
        it('preserves the watermark and the schema version while removing every row', () => {
            const out = filterSnapshotBody(body(), TARGET, { mode: MIRROR_WITHHOLD }, new Map(), 1000)
            assert.deepStrictEqual(out.body.rows, [])
            assert.strictEqual(out.body.count, 0, 'count must describe what is actually served')
            assert.strictEqual(out.body.watermark, 1788494058,
                'the watermark was altered, which starves every barrier instead of one table')
            assert.strictEqual(out.body.schema_version, 5,
                'the schema version was altered, which parks the whole mirror by design')
            assert.strictEqual(out.held, 2)
        })

        it('does not mutate the body it was given', () => {
            const original = body()
            filterSnapshotBody(original, TARGET, { mode: MIRROR_WITHHOLD }, new Map(), 1000)
            assert.strictEqual(original.rows.length, 2)
        })

        it('serves rows whose delay has elapsed and holds the rest, by first-seen', () => {
            const seen = new Map([[TARGET + ':1', 0]])
            const out = filterSnapshotBody(body(), TARGET, { mode: MIRROR_DELAY, delayMs: 500 }, seen, 1000)
            assert.deepStrictEqual(out.body.rows.map((r) => r.id), [1],
                'row 1 was first seen 1000ms ago and its delay is 500ms, so it is due; row 2 is seen now')
            assert.strictEqual(out.held, 1)
        })

        it('leaves a body alone when no filter is armed', () => {
            const out = filterSnapshotBody(body(), TARGET, null, new Map(), 1000)
            assert.strictEqual(out.body.rows.length, 2)
        })
    })

    describe('readServerFrames', () => {

        it('reads a run of complete text frames', () => {
            const buf = Buffer.concat([serverTextFrame('{"a":1}'), serverTextFrame('{"b":2}')])
            const out = readServerFrames(buf)
            assert.deepStrictEqual(out.frames.map((f) => f.text), ['{"a":1}', '{"b":2}'])
            assert.strictEqual(out.rest.length, 0)
        })

        // The property that keeps the proxy from corrupting the stream: a partial
        // frame is carried forward whole rather than forwarded in halves.
        it('keeps a partial frame as a remainder instead of guessing at it', () => {
            const whole = serverTextFrame('{"hello":"world"}')
            const out = readServerFrames(whole.subarray(0, whole.length - 3))
            assert.deepStrictEqual(out.frames, [])
            assert.strictEqual(out.rest.length, whole.length - 3)
        })

        it('reads a 16-bit length frame, which is where the hub\'s rows land', () => {
            const text = JSON.stringify({ type: 'row:inserted', table: TARGET, row: { id: 1, blob: 'x'.repeat(400) } })
            const out = readServerFrames(serverTextFrame(text))
            assert.strictEqual(out.frames.length, 1)
            assert.strictEqual(out.frames[0].text, text)
        })

        it('marks a control frame opaque rather than decoding it as text', () => {
            const ping = Buffer.from([0x89, 0x00])
            const out = readServerFrames(ping)
            assert.strictEqual(out.frames.length, 1)
            assert.strictEqual(out.frames[0].opaque, true,
                'a control frame decoded as text would be filtered on its contents and could be dropped')
        })

        it('marks a fragmented frame opaque, so it is forwarded untouched', () => {
            const first = Buffer.from([0x01, 0x03]) // FIN clear, text opcode
            const out = readServerFrames(Buffer.concat([first, Buffer.from('abc')]))
            assert.strictEqual(out.frames[0].opaque, true)
        })
    })

    describe('mirrorFrameTable', () => {

        it('names the table for a row event', () => {
            assert.strictEqual(mirrorFrameTable(rowEvent(TARGET, 1)), TARGET)
            assert.strictEqual(mirrorFrameTable(JSON.stringify({ type: 'row:deleted', table: CONTROL })), CONTROL)
        })

        // These two must ALWAYS pass: the watermark is what keeps every other
        // barrier satisfied, and the ready frame carries the id ceilings.
        it('claims no table for a watermark or ready frame, so they can never be filtered', () => {
            assert.strictEqual(mirrorFrameTable(JSON.stringify({ type: 'watermark', ts: 1788494058 })), null)
            assert.strictEqual(mirrorFrameTable(JSON.stringify({ type: 'ready', max_ids: { a: 1 } })), null)
        })

        it('claims no table for a frame it cannot parse', () => {
            assert.strictEqual(mirrorFrameTable('not json'), null)
        })
    })

    describe('the proxy end to end, against a fake hub', () => {

        let upstream = null
        let proxy    = null
        let served   = []

        const get = (port, path) => new Promise((resolve, reject) => {
            http.get({ host: '127.0.0.1', port: port, path: path }, (res) => {
                const chunks = []
                res.on('data', (c) => chunks.push(c))
                res.on('end', () => {
                    try { resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }) }
                    catch (e) { reject(e) }
                })
            }).on('error', reject)
        })

        beforeEach(async () => {
            served = []
            upstream = http.createServer((req, res) => {
                const table = snapshotTableOf(req.url)
                served.push(req.url)
                res.writeHead(200, { 'content-type': 'application/json' })
                res.end(JSON.stringify({
                    table: table, rows: [{ id: 1 }, { id: 2 }], count: 2,
                    watermark: 1788494058, schema_version: 5,
                }))
            })
            await new Promise((r) => upstream.listen(0, '127.0.0.1', r))
            proxy = new HubDbMirrorProxy(0, upstream.address().port, 'unit')
            await proxy.start()
        })

        afterEach(async () => {
            if (proxy) await proxy.stop()
            if (upstream) await new Promise((r) => upstream.close(r))
        })

        it('is a transparent relay with nothing armed', async () => {
            const res = await get(proxy._server.address().port, '/hub-db/snapshot/' + TARGET)
            assert.strictEqual(res.body.rows.length, 2,
                'the proxy filtered a table nobody asked it to filter, so every drill using it is suspect')
            assert.strictEqual(res.body.watermark, 1788494058)
        })

        // FALSIFICATION, HALF ONE: armed, the target must be empty AND the control
        // table must still be served. Either half alone passes on a proxy that
        // withholds everything, which would starve every barrier.
        it('withholds ONLY the named table, while a control table keeps flowing', async () => {
            proxy.withholdTable(TARGET)
            const port = proxy._server.address().port

            const target = await get(port, '/hub-db/snapshot/' + TARGET)
            assert.deepStrictEqual(target.body.rows, [],
                'the withhold did not suppress the target table, so a drill asserting a starved mirror ' +
                'would be asserting against a mirror that was fed normally')
            assert.strictEqual(target.body.count, 0)
            assert.strictEqual(target.body.watermark, 1788494058,
                'the watermark must survive a withhold or every barrier starves, not just this one')

            const control = await get(port, '/hub-db/snapshot/' + CONTROL)
            assert.strictEqual(control.body.rows.length, 2,
                'the control table was suppressed too, so this is a blunt outage rather than the ' +
                'per-table fault the barrier attribution depends on')
        })

        // FALSIFICATION, HALF TWO: releasing must restore it. A lever that cannot be
        // released cannot show an indexer resuming, which is half of the anti-wedge
        // claim.
        it('restores the table on release', async () => {
            const port = proxy._server.address().port
            proxy.withholdTable(TARGET)
            assert.deepStrictEqual((await get(port, '/hub-db/snapshot/' + TARGET)).body.rows, [])
            proxy.releaseTable(TARGET)
            assert.strictEqual((await get(port, '/hub-db/snapshot/' + TARGET)).body.rows.length, 2,
                'the table did not come back after release')
        })

        it('holds a delayed table\'s rows and serves them once the delay elapses', async () => {
            const port = proxy._server.address().port
            proxy.delayTable(TARGET, 10_000)
            const held = await get(port, '/hub-db/snapshot/' + TARGET)
            assert.deepStrictEqual(held.body.rows, [], 'a delayed row was served immediately')

            // Age the ledger rather than sleeping: the clock is the only input, and a
            // real ten-second wait in a unit suite is a fixed settle by another name.
            for (const key of proxy.seen.keys()) proxy.seen.set(key, Date.now() - 20_000)
            const due = await get(port, '/hub-db/snapshot/' + TARGET)
            assert.strictEqual(due.body.rows.length, 2, 'the rows never became due')
        })

        it('passes every non-snapshot path through untouched', async () => {
            proxy.withholdTable(TARGET)
            const res = await get(proxy._server.address().port, '/status')
            assert.strictEqual(res.status, 200)
            assert.ok(served.includes('/status'), 'the request never reached the hub')
        })

        it('counts what it held, so a drill can say the injection actually fired', async () => {
            proxy.withholdTable(TARGET)
            await get(proxy._server.address().port, '/hub-db/snapshot/' + TARGET)
            assert.strictEqual(proxy.stats.snapshotRowsHeld, 2)
        })
    })
})
