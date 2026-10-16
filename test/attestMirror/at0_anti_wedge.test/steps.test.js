'use strict'

const assert = require('assert')
const axios = require('axios')

const { AttestMirrorVenue } = require('../../helpers/attestMirrorVenue')
const { createRail } = require('../../helpers/chainRail')
const XChainIndexerConnector = require('../../../src/XChainIndexerConnector.js')

const BARRIER_REASON = 'attest_response_sync_barrier'
const PARKED_CLASSES = ['barrier_defer', 'wedged']

function sleep (ms) { return new Promise((resolve) => setTimeout(resolve, ms)) }

async function until (fn, timeoutMs, intervalMs = 2000) {
    const deadline = Date.now() + timeoutMs
    let last = null
    while (Date.now() < deadline) {
        last = await fn()
        if (last && last.ok) return last
        await sleep(intervalMs)
    }
    return last || { ok: false }
}

function newContext () {
    const ctx = { venue: null, btc: null, stoppedHub: null, baseline: null }
    ctx.statusOf = async (index) => {
        const status = await ctx.venue.statusOf(index)
        return {
            httpStatus: status.httpStatus,
            height: status.body && status.body.indexerBlock !== undefined
                ? Number(status.body.indexerBlock) : null,
            decoder: status.body && status.body.decoderBlock !== undefined
                ? Number(status.body.decoderBlock) : null,
            reason: status.body && status.body.stallReason,
            klass: status.body && status.body.stallClass,
            mirror: status.body && status.body.hubMirror,
        }
    }
    return ctx
}

async function waitForBaseline (ctx) {
    const level = await until(async () => {
        const a = await ctx.statusOf(0)
        const b = await ctx.statusOf(1)
        return {
            ok: a.height !== null && b.height !== null &&
                a.height === a.decoder && b.height === b.decoder,
            a: a, b: b,
        }
    }, 20 * 60 * 1000)
    assert.ok(level.ok, 'the venue indexers never caught the chain before the drill: ' +
        JSON.stringify({ a: level.a, b: level.b }))
    ctx.baseline = level.a.height
    console.log('AT0 baseline: both venue indexers committed block ' + ctx.baseline)
}

async function bringUp (ctx, mocha) {
    ctx.btc = await createRail('bitcoin', 'regtest')
    ctx.venue = new AttestMirrorVenue({ label: 'at0' })
    if (!(await ctx.venue.start())) {
        console.log('AT0 SKIPPED: ' + ctx.venue.unavailable)
        return mocha.skip()
    }
    await waitForBaseline(ctx)
}

async function tearDown (ctx) {
    if (ctx.venue && ctx.stoppedHub !== null) {
        try { await ctx.venue.startHub(ctx.stoppedHub) } catch (internal) { /* teardown follows */ }
    }
    if (ctx.venue) await ctx.venue.stop()
}

async function waitForPark (ctx) {
    const parked = await until(async () => {
        const status = await ctx.statusOf(0)
        return { ok: PARKED_CLASSES.includes(status.klass) && status.reason, a: status }
    }, 10 * 60 * 1000)
    assert.ok(parked.ok, 'indexer 0 never parked at all after its hub was stopped' +
        '; last status ' + JSON.stringify(parked.a) + '\n' + ctx.venue.logTail('indexer0'))
    console.log('AT0: indexer 0 parked at block ' + parked.a.height + ' of ' + parked.a.decoder +
        ', stallReason ' + parked.a.reason + ', stallClass ' + parked.a.klass)
    return parked.a
}

function assertStarvedMirror (parked) {
    const frozen = parked.mirror && parked.mirror.tables && parked.mirror.tables.attestation_responses
    assert.strictEqual(parked.mirror && parked.mirror.connected, false,
        'indexer 0 still reports a connected mirror after its hub was stopped')
    assert.ok(Number.isFinite(Number(frozen)),
        'indexer 0 reports no attestation_responses watermark, so the starve cannot be located')
    return frozen
}

async function waitForPeer (ctx, parked) {
    const peer = await until(async () => {
        const status = await ctx.statusOf(1)
        return { ok: status.height !== null && status.height > parked.height, b: status }
    }, 10 * 60 * 1000)
    assert.ok(peer.ok, 'indexer 1, whose hub is still up, did not advance past indexer 0. ' +
        'The hold is therefore not attributable to the mirror at all: ' + JSON.stringify(peer.b) +
        '\n' + ctx.venue.logTail('indexer1'))
    assert.strictEqual((await ctx.statusOf(0)).height, parked.height,
        'indexer 0 advanced while its hub was down, so the barrier did not hold the block')
    return peer.b
}

function assertPeerWatermark (parked, peer, frozen) {
    const advanced = peer.mirror && peer.mirror.tables && peer.mirror.tables.attestation_responses
    assert.ok(Number(advanced) > Number(frozen),
        'the live-hub indexer attestation_responses watermark (' + advanced + ') did not advance ' +
        'past the stopped-hub one (' + frozen + '), so nothing distinguishes a starved mirror ' +
        'from a venue that is merely slow')
    console.log('AT0: indexer 1 advanced to ' + peer.height + ' while indexer 0 held at ' +
        parked.height + '; attestation_responses watermark frozen at ' + frozen +
        ' against the peer at ' + advanced)
}

async function parkHublessIndexer (ctx) {
    ctx.stoppedHub = ctx.venue.indexers[0].followsHub
    await ctx.venue.stopHub(ctx.stoppedHub)
    console.log('AT0: stopped hub ' + ctx.stoppedHub + ', which indexer 0 follows')
    await ctx.btc.globals.regtestMinerConnector.generateBlocks(1)
    const parked = await waitForPark(ctx)
    const frozen = assertStarvedMirror(parked)
    const peer = await waitForPeer(ctx, parked)
    assertPeerWatermark(parked, peer, frozen)
}

async function waitForResume (ctx, held) {
    const resumed = await until(async () => {
        const status = await ctx.statusOf(0)
        return { ok: status.height !== null && status.height > held && status.reason !== BARRIER_REASON, a: status }
    }, 15 * 60 * 1000)
    assert.ok(resumed.ok, 'indexer 0 did not resume past block ' + held + ' after its hub returned: ' +
        JSON.stringify(resumed.a) + '\n' + ctx.venue.logTail('indexer0'))
    console.log('AT0: indexer 0 resumed to block ' + resumed.a.height + ', stallReason ' + resumed.a.reason)
    return resumed.a
}

async function commonHeight (ctx, resumedHeight) {
    const common = await until(async () => {
        const a = await ctx.statusOf(0)
        const b = await ctx.statusOf(1)
        const height = Math.min(a.height, b.height)
        return { ok: height >= resumedHeight, h: height }
    }, 10 * 60 * 1000)
    assert.ok(common.ok, 'the two indexers never held a common height at or past the resume point')
    return common.h
}

async function assertMatchingHashes (ctx, height) {
    const conn0 = new XChainIndexerConnector('127.0.0.1', ctx.venue.indexers[0].apiPort, null)
    const conn1 = new XChainIndexerConnector('127.0.0.1', ctx.venue.indexers[1].apiPort, null)
    const h0 = await conn0.call('getblockhashes', { block_index: height })
    const h1 = await conn1.call('getblockhashes', { block_index: height })
    assert.ok(h0 && !h0.error, 'indexer 0 would not report block hashes at ' + height + ': ' + JSON.stringify(h0))
    assert.ok(h1 && !h1.error, 'indexer 1 would not report block hashes at ' + height + ': ' + JSON.stringify(h1))
    for (const field of ['state_root', 'balances_root', 'stakes_root', 'block_merkle_root']) {
        assert.strictEqual(String(h0[field]), String(h1[field]),
            'the two indexers disagree on ' + field + ' at block ' + height +
            ', which is a fork rather than lag: ' + String(h0[field]) + ' vs ' + String(h1[field]))
    }
    console.log('AT0: no divergence at block ' + height + '; state_root ' +
        String(h0.state_root).slice(0, 16) + '... identical on the parked-and-resumed indexer and its peer')
}

async function resumeWithoutDivergence (ctx) {
    assert.ok(ctx.stoppedHub !== null, 'the previous case did not stop a hub')
    const held = (await ctx.statusOf(0)).height
    await ctx.venue.startHub(ctx.stoppedHub)
    console.log('AT0: restarted hub ' + ctx.stoppedHub)
    const resumed = await waitForResume(ctx, held)
    const height = await commonHeight(ctx, resumed.height)
    await assertMatchingHashes(ctx, height)
}

async function readStandingStatus (coin, port) {
    let status = null
    try {
        const response = await axios.get('http://127.0.0.1:' + port + '/status',
            { timeout: 10_000, validateStatus: () => true })
        status = response.status === 200 || response.status === 503 ? response.data : null
    } catch (internal) { status = null }
    assert.ok(status && !status.error,
        coin + ' regtest indexer on ' + port + ' did not answer, so the off-BTC half of ' +
        'AT0 could not be established either way')
    return status
}

async function assertBarrierAbsentOffBtc () {
    for (const [coin, port] of [['LTC', 3224], ['DOGE', 3124]]) {
        const status = await readStandingStatus(coin, port)
        assert.notStrictEqual(status.stallReason, BARRIER_REASON,
            coin + ' armed the BTC-only mirror barrier, so the COIN gate on it is not holding')
        console.log('AT0: ' + coin + ' at block ' + status.indexerBlock + ', stallReason ' +
            String(status.stallReason) + ' (barrier correctly absent)')
    }
}

module.exports = {
    BARRIER_REASON, PARKED_CLASSES, newContext, bringUp, tearDown,
    parkHublessIndexer, resumeWithoutDivergence, assertBarrierAbsentOffBtc,
}
