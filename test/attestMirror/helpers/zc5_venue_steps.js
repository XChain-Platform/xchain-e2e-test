'use strict'

// Venue boot, teardown and reorg primitives for zc5_flag_day.test.js. Pure
// extraction: bodies are unchanged. `ctx` carries
// { venue, up, testServer, testUrl, contract, minerAddr }.

const assert = require('assert')

const { AttestMirrorVenue } = require('../../helpers/attestMirrorVenue')
const {
    provisionDrillIdentities, waitForVenueIndexersAtTip, startAttestTestServer, deployRequestContract,
} = require('./mirrorDrillFixture')
const { jsonSafe } = require('./mirrorDrillWaits')
const cryptoHelper           = require('../../helpers/core/cryptoHelper')
const XChainIndexerConnector = require('../../../src/XChainIndexerConnector.js')
const {
    FIXED_BODY, POLL_MS, FORWARD_S, CONTRACT_CODE, COMPETING_OVERSHOOT, TRACKER_UNDO_BLOCKS,
} = require('./zc5_fixture')

async function startZc5Venue (ctx, mocha) {
    ctx.testServer = await startAttestTestServer({ body: FIXED_BODY })
    ctx.testUrl    = ctx.testServer.url

    const staked = await provisionDrillIdentities({ label: 'zc5', count: 5, redundancy: 3 })
    ctx.venue = new AttestMirrorVenue({
        label: 'zc5', identities: staked.identities, hubExtraEnv: ctx.testServer.hubEnv,
        attestationPollMs: POLL_MS, forwardS: FORWARD_S,
    })
    ctx.up = await ctx.venue.start()
    if (!ctx.up) {
        console.log('ZC5 SKIPPED: ' + ctx.venue.unavailable)
        mocha.skip()
        return false
    }
    return true
}

async function finishZc5Setup (ctx) {
    await waitForVenueIndexersAtTip(ctx.venue)
    ctx.contract = await deployRequestContract({ label: 'zc5', code: CONTRACT_CODE })
    // The competing chain's coinbase destination. Its own address, so the orphaned
    // chain's coinbases and the new one's are never confused, and so the replacement
    // block cannot be the invalidated block over again.
    ctx.minerAddr = (await cryptoHelper.getNewAddress('zc5-miner', COIN, NETWORK, null, 'legacy', 0)).address
}

async function bootZc5 (ctx, mocha) {
    if (!(await startZc5Venue(ctx, mocha))) return
    await finishZc5Setup(ctx)
}

async function teardownZc5 (ctx) {
    try { await regtestMinerConnector.resumeMining() } catch (e) {
        console.log('ZC5 teardown: resumeMining failed (' + (e && e.message) +
            '); the shared miner may still be paused')
    }
    if (ctx.testServer) await ctx.testServer.close()
    if (ctx.venue) await ctx.venue.stop()
}

/** Every signed root one venue indexer reports at a height. */
async function rootsAt (ctx, indexerIndex, height) {
    const ix   = ctx.venue.indexers[indexerIndex]
    const conn = new XChainIndexerConnector('127.0.0.1', ix.apiPort, null)
    const got  = await conn.call('getblockhashes', { block_index: Number(height) })
    assert.ok(got && !got.error,
        'indexer ' + indexerIndex + ' would not report hashes at ' + height + ': ' + jsonSafe(got))
    return got
}

/** Orphan everything at and above `height` and replace it with EMPTY blocks. */
async function orphanFrom (ctx, height, label) {
    const tipBefore = Number(await nodeConnector.getBlockCount())
    const depth = tipBefore - height + 1
    assert.ok(depth <= TRACKER_UNDO_BLOCKS,
        label + ': orphaning from ' + height + ' at tip ' + tipBefore + ' is ' + depth +
        ' blocks deep, past the standing utxo-tracker\'s ' + TRACKER_UNDO_BLOCKS + '-block undo ' +
        'window; the tracker would halt and need a resync.')
    const hash = await nodeConnector.getBlockHash(height)
    await nodeConnector.invalidateBlock(hash)
    const rolled = Number(await nodeConnector.getBlockCount())
    assert.strictEqual(rolled, height - 1,
        label + ': the node sits at ' + rolled + ' after invalidating block ' + height)
    const need = tipBefore - (height - 1) + COMPETING_OVERSHOOT
    for (let i = 0; i < need; i++) await nodeConnector.generateBlock(ctx.minerAddr, [])
    const tipAfter = Number(await nodeConnector.getBlockCount())
    assert.ok(tipAfter > tipBefore,
        label + ': the competing chain reached ' + tipAfter + ', which does not overtake ' + tipBefore)
    assert.notStrictEqual(await nodeConnector.getBlockHash(height), hash,
        label + ': block ' + height + ' still has its original hash, so nothing actually reorged')
    return { tipBefore: tipBefore, tipAfter: tipAfter }
}

async function settleAfterReorg (label) {
    const status = await utxoTrackerConnector.quiesce({
        timeoutMs: 4 * 60 * 1000, pollMs: 500, regtestMiner: regtestMinerConnector,
    }).catch((e) => ({ ready: false, error: String(e && e.message) }))
    if (!status || !status.ready) {
        console.log('ZC5 ' + label + ': the stack did not settle after the reorg (' +
            JSON.stringify(status) + '); the harness barrier will say so')
    }
}

module.exports = { bootZc5, teardownZc5, rootsAt, orphanFrom, settleAfterReorg }
