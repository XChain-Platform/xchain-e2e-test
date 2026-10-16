'use strict'

const assert = require('assert')

const { AttestMirrorVenue } = require('../../helpers/attestMirrorVenue')
const { createRail } = require('../../helpers/chainRail')
const { until, untilOrClearDogeStall, diffStateHashes, venueTipProbe } = require('../helpers/mirrorDrillWaits')
const { BARRIER_REASON, isAttributedPark } = require('../helpers/barrierAttribution')
const { HUB_SCHEMA_VERSION } = require('../helpers/hubSchemaVersion')
const XChainIndexerConnector = require('../../../src/XChainIndexerConnector.js')

const MIRROR_TABLE = 'attestation_responses'
const BARRIER_GRACE_S = 90
const STARVED = 0
const PEER = 1

function newContext () {
    const ctx = { venue: null, btc: null, held: null }
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
    const level = await untilOrClearDogeStall(async () => {
        const a = await ctx.statusOf(STARVED)
        const b = await ctx.statusOf(PEER)
        return {
            ok: a.height !== null && b.height !== null &&
                a.height === a.decoder && b.height === b.decoder,
            a: a, b: b,
        }
    }, { timeoutMs: 25 * 60 * 1000, tipProbe: venueTipProbe(ctx.venue, PEER) })
    assert.ok(level.ok, 'the venue indexers never caught the chain before the drill: ' +
        JSON.stringify({ a: level.a, b: level.b }))
    console.log('AT0b baseline: both indexers committed block ' + level.a.height)
}

async function bringUp (ctx, mocha) {
    ctx.btc = await createRail('bitcoin', 'regtest')
    ctx.venue = new AttestMirrorVenue({
        label: 'at0b',
        indexerGraces: { [STARVED]: { attestResponse: BARRIER_GRACE_S } },
    })
    if (!(await ctx.venue.start())) {
        console.log('AT0b SKIPPED: ' + ctx.venue.unavailable)
        return mocha.skip()
    }
    await waitForBaseline(ctx)
}

async function tearDown (ctx) {
    if (!ctx.venue) return
    try { ctx.venue.releaseMirrorTable(STARVED, MIRROR_TABLE) } catch (internal) { /* never armed */ }
    await ctx.venue.stop()
}

async function waitForAttributedPark (ctx) {
    const parked = await until(async () => {
        const status = await ctx.statusOf(STARVED)
        return { ok: isAttributedPark(status), a: status }
    }, 8 * 60 * 1000)
    assert.ok(parked.ok,
        'indexer ' + STARVED + ' never reported ' + BARRIER_REASON + '. Last status ' +
        JSON.stringify(parked.a) + '; proxy ' + JSON.stringify(ctx.venue.mirrorProxyStats(STARVED)) +
        '\n' + ctx.venue.logTail('indexer' + STARVED))
    ctx.held = parked.a.height
    console.log('AT0b: indexer ' + STARVED + ' parked at ' + ctx.held + ' of ' + parked.a.decoder +
        ', stallReason ' + parked.a.reason + ', stallClass ' + parked.a.klass)
    return parked.a
}

function assertWithholdFired (ctx, parked) {
    assert.strictEqual(parked.reason, BARRIER_REASON,
        'the parked indexer reports ' + parked.reason + '. Every mirror barrier reads one global ' +
        'watermark, so a different name here means an earlier barrier was also unsatisfied.')
    const stats = ctx.venue.mirrorProxyStats(STARVED)
    assert.ok(stats.snapshotRowsHeld > 0 || stats.framesDropped > 0 ||
        stats.filters.some((filter) => filter[0] === MIRROR_TABLE),
    'the mirror proxy reports holding nothing for ' + MIRROR_TABLE + ': ' + JSON.stringify(stats))
}

async function assertHubStillServes (ctx) {
    const followed = ctx.venue.indexers[STARVED].followsHub
    const snap = await ctx.venue.hubSnapshot(followed)
        .catch((error) => ({ error: String(error && error.message) }))
    assert.ok(snap && !snap.error,
        'hub ' + followed + ' would not serve its own snapshot route, so the withhold cannot be ' +
        'distinguished from a hub that is down: ' + JSON.stringify(snap))
    assert.strictEqual(Number(snap.schema_version), Number(HUB_SCHEMA_VERSION),
        'the hub is serving schema_version ' + snap.schema_version +
        ' but the mirror consumer demands ' + HUB_SCHEMA_VERSION)
}

async function assertPeerAdvances (ctx) {
    const peer = await until(async () => {
        const status = await ctx.statusOf(PEER)
        return { ok: status.height !== null && status.height > ctx.held, b: status }
    }, 8 * 60 * 1000)
    assert.ok(peer.ok,
        'indexer ' + PEER + ', whose mirror is untouched, did not advance past ' + ctx.held +
        '. The hold is therefore not attributable to the withheld table at all: ' +
        JSON.stringify(peer.b) + '\n' + ctx.venue.logTail('indexer' + PEER))
    assert.notStrictEqual(peer.b.reason, BARRIER_REASON,
        'the UNSTARVED peer is also reporting ' + BARRIER_REASON + ', so the fault is not edge-scoped')
    console.log('AT0b: peer advanced to ' + peer.b.height + ' with stallReason ' +
        String(peer.b.reason) + ' while the starved node held at ' + ctx.held)
}

async function parkOnAttributedBarrier (ctx) {
    ctx.venue.withholdMirrorTable(STARVED, MIRROR_TABLE)
    console.log('AT0b: withholding ' + MIRROR_TABLE + ' on indexer ' + STARVED +
        "'s mirror edge; its hub and every other table are untouched")
    await ctx.btc.globals.regtestMinerConnector.generateBlocks(1)
    const parked = await waitForAttributedPark(ctx)
    assertWithholdFired(ctx, parked)
    await assertHubStillServes(ctx)
    await assertPeerAdvances(ctx)
}

async function waitForResume (ctx) {
    const resumed = await untilOrClearDogeStall(async () => {
        const status = await ctx.statusOf(STARVED)
        return { ok: status.height !== null && status.height > ctx.held, a: status }
    }, { timeoutMs: 15 * 60 * 1000, tipProbe: venueTipProbe(ctx.venue, PEER) })
    assert.ok(resumed.ok,
        'indexer ' + STARVED + ' did not get past ' + ctx.held + ' after the withhold was released: ' +
        JSON.stringify(resumed.a) + '\n' + ctx.venue.logTail('indexer' + STARVED))
    console.log('AT0b: resumed to ' + resumed.a.height)
}

async function waitForCommonHeight (ctx) {
    const common = await untilOrClearDogeStall(async () => {
        const a = await ctx.statusOf(STARVED)
        const b = await ctx.statusOf(PEER)
        const height = Math.min(Number(a.height), Number(b.height))
        return { ok: Number.isFinite(height) && height > ctx.held, h: height }
    }, { timeoutMs: 15 * 60 * 1000, tipProbe: venueTipProbe(ctx.venue, PEER) })
    assert.ok(common.ok, 'the two indexers never held a common height past the parked one')
    return common.h
}

async function assertConvergedAt (ctx, height) {
    const conn0 = new XChainIndexerConnector('127.0.0.1', ctx.venue.indexers[STARVED].apiPort, null)
    const conn1 = new XChainIndexerConnector('127.0.0.1', ctx.venue.indexers[PEER].apiPort, null)
    const h0 = await conn0.call('getblockhashes', { block_index: height })
    const h1 = await conn1.call('getblockhashes', { block_index: height })
    assert.ok(h0 && !h0.error, 'the starved indexer would not report hashes at ' + height + ': ' + JSON.stringify(h0))
    assert.ok(h1 && !h1.error, 'the peer would not report hashes at ' + height + ': ' + JSON.stringify(h1))
    const diffs = diffStateHashes(h0, h1)
    assert.deepStrictEqual(diffs, [],
        'the starved-and-resumed indexer and its peer disagree at block ' + height + ': ' +
        diffs.join('; ') + '. That is a fork rather than lag.')
    console.log('AT0b: no divergence at block ' + height + '; state_root ' +
        String(h0.state_root).slice(0, 16) + '... identical on both')
}

async function releaseAndConverge (ctx) {
    assert.ok(ctx.held !== null, 'the previous case did not establish a parked height')
    ctx.venue.releaseMirrorTable(STARVED, MIRROR_TABLE)
    console.log('AT0b: released ' + MIRROR_TABLE + ' on indexer ' + STARVED +
        ' (the socket is dropped, so the node re-bootstraps and re-pages the table from id 0)')
    await waitForResume(ctx)
    const height = await waitForCommonHeight(ctx)
    await assertConvergedAt(ctx, height)
}

module.exports = { newContext, bringUp, tearDown, parkOnAttributedBarrier, releaseAndConverge }
