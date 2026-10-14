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
 * ZC1 fixture: constants, the asker contract, the request-block barrier, the
 * one-block miner, and venue setup and teardown. The driven case lives in
 * zc1_steps.js.
 ********************************************************************/

const assert = require('assert')

const { AttestMirrorVenue } = require('../../helpers/attestMirrorVenue')
const {
    provisionDrillIdentities, waitForVenueIndexersAtTip, startAttestTestServer, deployRequestContract,
} = require('./mirrorDrillFixture')
const { readRequestRow, waitForHeightWithClear } = require('./mirrorDrillWaits')

const FIXED_BODY = '{"score":7,"meta":"zc1-zero-conf"}'

// The fleet default this train ships (xchain-hub AttestationRound.DEFAULT_POLL_MS).
// Passed explicitly because the venue pins 2000 of its own (D8).
const POLL_MS = 3000

// The signed forward margin. Small so the drill closes in seconds, and it must stay
// ABOVE the venue's 2 s gossip-hop budget or `assertTimingInvariants` refuses the
// venue outright: a follower that receives a row after its own stamp has passed
// cannot verify the window it was signed under.
const FORWARD_S = 3

// The §10 bound on mined-to-mirrored. Generous against the §3.4 table's 3-to-15 s
// for `http_get`, and it is the whole point of the flip: at three confirmations the
// same measurement could not start for three blocks.
const MIRRORED_WITHIN_S = 15

// Long enough that nothing under test races the expiry sweep while the miner is
// paused, short enough that the ladder arithmetic stays readable.
const DEADLINE_BLOCKS = 60

const CONTRACT_CODE = `
module.exports = {
    meta: { name: 'Zero Conf Asker', description: 'Requests an attestation answered from a zero-confirmation mirror row.', version: '1.0.0' },
    ask: function(xchain) {
        var requestId = xchain.attestation.request(
            xchain.getInputParam(0),
            xchain.getInputParam(1),
            'handleResponse',
            ['ctx-zc1'],
            { redundancy: 3, deadlineBlocks: ${DEADLINE_BLOCKS} }
        );
        return requestId;
    },
    handleResponse: function(xchain) {
        xchain.state.set('callback_status',  xchain.getInputParam(2));
        xchain.state.set('callback_payload', xchain.getInputParam(3));
        xchain.state.set('callback_context', xchain.getInputParam(4));
    }
};
`

function sleep (ms) { return new Promise((r) => setTimeout(r, ms)) }

async function waitForLocalRequestAtBlock (venue, indexerIndex, request, deps) {
    const d = deps || {}
    const waitForHeight = d.waitForHeight || waitForHeightWithClear
    const readRow = d.readRow || readRequestRow
    const log = d.log || console.log
    const requestId = String(request && request.requestId)
    const rawBlockIndex = request && request.blockIndex
    const blockIndex = Number(rawBlockIndex)
    assert.ok(rawBlockIndex !== null && rawBlockIndex !== undefined &&
        Number.isSafeInteger(blockIndex) && blockIndex >= 0,
        'the standing indexer returned no usable block height for request ' + requestId)

    const committed = await waitForHeight(venue, indexerIndex, blockIndex)
    log('ZC1 BARRIER: request ' + requestId.slice(0, 12) + ' mined at ' + blockIndex +
        ', venue indexer ' + indexerIndex + ' committed ' + (committed && committed.at))
    const local = await readRow(venue, indexerIndex, requestId)
    assert.ok(local, 'the venue indexer holds no v0 request row for ' + requestId +
        ' after committing request block ' + blockIndex)
    assert.strictEqual(Number(local.block_index), blockIndex,
        'the venue request row landed at block ' + local.block_index +
        ' but the standing indexer placed it at ' + blockIndex)
    return local
}

/**
 * Run `work` and mine AT MOST ONE block, and only once the mempool has something.
 *
 * `mineWhile` is the shared shape and it is the wrong one here: it mines every few
 * seconds for as long as the work is pending, so a confirm wait that takes a beat
 * longer than the interval leaves N+1 already on the chain before the round has even
 * started. This mines the one block the EXECUTE needs to confirm and then stops, so
 * the request block is the tip when the round runs, which is the state ZC1 asserts.
 */
async function mineOneBlockFor (work) {
    let settled = false
    const p = Promise.resolve(work()).finally(() => { settled = true })
    let mined = 0
    const miner = (async () => {
        while (!settled && mined < 1) {
            await sleep(1000)
            if (settled) break
            let pool = []
            try { pool = await nodeConnector.getRawMempool() } catch (internal) { pool = [] }
            if (!pool || pool.length === 0) continue
            await regtestMinerConnector.generateBlocks(1)
            mined++
        }
    })()
    try { return await p } finally { await miner; }
}

/** The shared state the driven case reads, filled in by setupVenue. */
function newCtx () {
    return { venue: null, up: false, testServer: null, testUrl: null, contract: null }
}

async function setupVenue (ctx, mocha) {
    // REAL TLS, not http. The provider refuses a non-https payload before it does
    // any network work, so a plain-HTTP server resolves every round provider_error,
    // which reads downstream as a missing mirror row.
    ctx.testServer = await startAttestTestServer({ body: FIXED_BODY })
    ctx.testUrl    = ctx.testServer.url

    const staked = await provisionDrillIdentities({ label: 'zc1', count: 5, redundancy: 3 })
    ctx.venue = new AttestMirrorVenue({
        label: 'zc1', identities: staked.identities, hubExtraEnv: ctx.testServer.hubEnv,
        attestationPollMs: POLL_MS,
        forwardS: FORWARD_S,
    })
    ctx.up = await ctx.venue.start()
    if (!ctx.up) {
        console.log('ZC1 SKIPPED: ' + ctx.venue.unavailable)
        mocha.skip()
        return
    }

    // BEFORE ANY REQUEST. The venue's indexers replay the borrowed chain from
    // scratch, so at this point they are far behind the tip. A request made now
    // sits at a block they have not reached, and its response reads as "not
    // applied" when the node simply has not got there yet.
    await waitForVenueIndexersAtTip(ctx.venue)
    ctx.contract = await deployRequestContract({ label: 'zc1', code: CONTRACT_CODE })
}

async function teardownVenue (ctx) {
    // Said out loud rather than swallowed: a resume that genuinely fails leaves the
    // SHARED miner paused for every drill queued after this one.
    try { await regtestMinerConnector.resumeMining() } catch (e) {
        console.log('ZC1 teardown: resumeMining failed (' + (e && e.message) +
            '); the shared miner may still be paused')
    }
    if (ctx.testServer) await ctx.testServer.close()
    if (ctx.venue) await ctx.venue.stop()
}

module.exports = {
    FIXED_BODY, POLL_MS, FORWARD_S, MIRRORED_WITHIN_S,
    waitForLocalRequestAtBlock, mineOneBlockFor, newCtx, setupVenue, teardownVenue,
}
