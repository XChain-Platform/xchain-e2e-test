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
 * ZC2 fixture: constants, the contract source, venue setup/teardown and the
 * reorg mechanics. The drill itself lives in zc2_remine.test.js.
 ********************************************************************/

const assert = require('assert')

const { AttestMirrorVenue } = require('../../helpers/attestMirrorVenue')
const {
    provisionDrillIdentities, waitForVenueIndexersAtTip, startAttestTestServer, deployRequestContract,
} = require('./mirrorDrillFixture')
const cryptoHelper = require('../../helpers/core/cryptoHelper')

const FIXED_BODY = '{"score":13,"meta":"zc2-remine"}'

const POLL_MS   = 3000
const FORWARD_S = 3

// Generous, so nothing under test races the expiry sweep while blocks are being
// orphaned, remade and then mined 25 deep.
const DEADLINE_BLOCKS = 90

// How far past the orphan point the competing chain is built. Two is enough to make
// it strictly longer than what it replaces, which is what makes the node switch.
const COMPETING_OVERSHOOT = 2

// The standing BTC utxo-tracker's reorg recovery window (xchain-utxo-tracker
// DEFAULT_UNDO_BLOCKS for BTC). A reorg deeper than this halts that tracker for
// every drill after this one.
const TRACKER_UNDO_BLOCKS = 12

// The blocks mined after the re-bind before the reward assertion. The spec's own
// figure: long enough that a second settle triggered by anything late would have
// landed and be visible, rather than being absent because nothing has run yet.
const SETTLE_BLOCKS = 25

// A REAL ESCROW, because the money half of this drill is a statement about how many
// times an escrow is split. Without feeTick/feeAmount the request is fee=none,
// fee_amount is NULL and there is no attest_fee row to count. Chosen so the split
// leaves a positive whole share at every responsible-set size the ladder can reach:
// XCHAIN's ISSUE row carries decimals 0 on this chain (measured 2026-09-05), so a
// unit here is a whole XCHAIN and 6 divides usefully by 3, 4, 5 and 6.
const FEE_XCHAIN = '6'

const CONTRACT_CODE = `
module.exports = {
    meta: { name: 'Zero Conf Remine Asker', description: 'Requests an attestation whose zero-conf response is remined into a new block.', version: '1.0.0' },
    ask: function(xchain) {
        var requestId = xchain.attestation.request(
            xchain.getInputParam(0),
            xchain.getInputParam(1),
            'handleResponse',
            ['ctx-zc2'],
            { redundancy: 3, deadlineBlocks: ${DEADLINE_BLOCKS}, feeTick: 'XCHAIN', feeAmount: '${FEE_XCHAIN}' }
        );
        return requestId;
    },
    handleResponse: function(xchain) {
        xchain.state.set('callback_status',  xchain.getInputParam(2));
        xchain.state.set('callback_payload', xchain.getInputParam(3));
    }
};
`

function newCtx () {
    return { venue: null, up: false, testServer: null, testUrl: null, contract: null, minerAddr: null }
}

async function setupZc2 (ctx, mocha) {
    // REAL TLS, not http. The provider refuses a non-https payload before it does
    // any network work, so a plain-HTTP server resolves every round provider_error,
    // which reads downstream as a missing mirror row.
    ctx.testServer = await startAttestTestServer({ body: FIXED_BODY })
    ctx.testUrl    = ctx.testServer.url

    const staked = await provisionDrillIdentities({ label: 'zc2', count: 5, redundancy: 3 })
    ctx.venue = new AttestMirrorVenue({
        label: 'zc2', identities: staked.identities, hubExtraEnv: ctx.testServer.hubEnv,
        attestationPollMs: POLL_MS, forwardS: FORWARD_S,
    })
    ctx.up = await ctx.venue.start()
    if (!ctx.up) {
        console.log('ZC2 SKIPPED: ' + ctx.venue.unavailable)
        mocha.skip()
        return
    }

    // BEFORE ANY REQUEST. The venue's indexers replay the borrowed chain from
    // scratch, so at this point they are far behind the tip.
    await waitForVenueIndexersAtTip(ctx.venue)
    ctx.contract = await deployRequestContract({ label: 'zc2', code: CONTRACT_CODE })
    // The competing chain's coinbase destination. Its own address, so the orphaned
    // chain's coinbases and the new one's are never confused.
    ctx.minerAddr = (await cryptoHelper.getNewAddress('zc2-miner', COIN, NETWORK, null, 'legacy', 0)).address
}

async function teardownZc2 (ctx) {
    try { await regtestMinerConnector.resumeMining() } catch (e) {
        console.log('ZC2 teardown: resumeMining failed (' + (e && e.message) +
            '); the shared miner may still be paused')
    }
    if (ctx.testServer) await ctx.testServer.close()
    if (ctx.venue) await ctx.venue.stop()
}

/**
 * Orphan everything at and above `height` and replace it with EMPTY blocks.
 *
 * `generateBlock(address, [])` mines a block containing its coinbase and nothing
 * else, ignoring the mempool entirely, which keeps a transaction that just
 * returned to the mempool from being mined straight back into the replacement
 * chain. Copied from AT4 deliberately rather than shared: the reorg mechanics are
 * the thing under test in both, and a shared copy would let a change to one
 * silently change what the other proves.
 */
async function orphanFrom (ctx, height, label) {
    const tipBefore = Number(await nodeConnector.getBlockCount())
    const depth = tipBefore - height + 1
    assert.ok(depth <= TRACKER_UNDO_BLOCKS,
        label + ': orphaning from ' + height + ' at tip ' + tipBefore + ' is ' + depth +
        ' blocks deep, past the standing utxo-tracker\'s ' + TRACKER_UNDO_BLOCKS + '-block undo ' +
        'window; the tracker would halt and need a resync. Fewer blocks must land between the ' +
        'request and the reorg.')
    const hash = await nodeConnector.getBlockHash(height)
    await nodeConnector.invalidateBlock(hash)
    const rolled = Number(await nodeConnector.getBlockCount())
    assert.strictEqual(rolled, height - 1,
        label + ': the node sits at ' + rolled + ' after invalidating block ' + height +
        ', expected ' + (height - 1))

    const need = tipBefore - (height - 1) + COMPETING_OVERSHOOT
    for (let i = 0; i < need; i++) await nodeConnector.generateBlock(ctx.minerAddr, [])
    const tipAfter = Number(await nodeConnector.getBlockCount())
    assert.ok(tipAfter > tipBefore,
        label + ': the competing chain reached ' + tipAfter + ', which does not overtake ' +
        tipBefore + ', so the node would not switch to it')
    assert.notStrictEqual(await nodeConnector.getBlockHash(height), hash,
        label + ': block ' + height + ' still has its original hash, so nothing actually reorged')
    return { tipBefore: tipBefore, tipAfter: tipAfter, orphanedHash: hash }
}

/**
 * Leave the stack QUIESCENT before handing back to the harness.
 *
 * The global afterEach barrier gives the stack 15 s to reach mempool-empty with
 * the tracker level with the node, and fails the case if it does not. A deliberate
 * reorg is the one thing on this venue that legitimately leaves the tracker tens
 * of blocks behind, so the case waits the tracker in itself.
 */
async function settleAfterReorg (label) {
    const status = await utxoTrackerConnector.quiesce({
        timeoutMs: 4 * 60 * 1000, pollMs: 500, regtestMiner: regtestMinerConnector,
    }).catch((e) => ({ ready: false, error: String(e && e.message) }))
    if (!status || !status.ready) {
        console.log('ZC2 ' + label + ': the stack did not settle after the reorg (' +
            JSON.stringify(status) + '); the harness barrier will say so')
    }
}

module.exports = {
    SETTLE_BLOCKS, newCtx, setupZc2, teardownZc2, orphanFrom, settleAfterReorg,
}
