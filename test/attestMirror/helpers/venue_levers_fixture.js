'use strict'

// Shared fixtures for the venue levers smoke test: synthetic frames, a complete
// indexer spec, a loopback GET and the fake hub plus proxy the driven pin uses.

const http = require('http')
const { HubDbMirrorProxy } = require('../../helpers/attestMirrorVenue')

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

const ARM = 'XCHAIN_MIRROR_ADMISSION_HEIGHT_REGTEST'
const PIN = { [TABLE]: { BTC: 700 } }

const httpGet = (port, p) => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: port, path: p }, (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => resolve({ status: res.statusCode, raw: Buffer.concat(chunks).toString('utf8') }))
    }).on('error', reject)
})

async function startDrivenProxy (ctx) {
    ctx.heights = LIVE_HEIGHTS()
    ctx.upstream = http.createServer((req, res) => {
        const table = (/^\/hub-db\/snapshot\/([A-Za-z0-9_]+)$/.exec(String(req.url).split('?')[0]) || [])[1]
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(snapshotPage(table || 'unknown', ctx.heights)))
    })
    await new Promise((r) => ctx.upstream.listen(0, '127.0.0.1', r))
    ctx.proxy = new HubDbMirrorProxy(0, ctx.upstream.address().port, 'levers')
    await ctx.proxy.start()
}

async function stopDrivenProxy (ctx) {
    if (ctx.proxy) await ctx.proxy.stop()
    if (ctx.upstream) await new Promise((r) => ctx.upstream.close(r))
}

module.exports = {
    TABLE, OTHER, ARM, PIN, indexerSpec, watermarkFrame, readyFrame, snapshotPage,
    LIVE_HEIGHTS, httpGet, startDrivenProxy, stopDrivenProxy,
}
