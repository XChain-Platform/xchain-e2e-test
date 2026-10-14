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
 **********************************************************************/

// The drill's prologue, one step per function: provider, rail, venue, DOGE reader, tip, contract.

const assert = require('assert')

const { AttestMirrorVenue } = require('../../helpers/attestMirrorVenue')
const chainRail = require('../../helpers/chainRail')
const {
    provisionDrillIdentities, waitForVenueIndexersAtTip, startAttestTestServer, deployRequestContract,
} = require('../helpers/mirrorDrillFixture')
const { configureDogeReconcileIndexer } = require('./hubs_reading.test.js')
const { stageDogeSigner } = require('./signer.test.js')
const { startTipFeed } = require('./tip_feed.test.js')
const {
    HTTP_GET_BODY, REQUEST_REDUNDANCY, FORWARD_S, BATCH_WINDOW_S, CONTRACT_CODE,
    forwardedHubCredentialEnv, llmRunnableHere,
} = require('./config.test.js')


/** Pick the response provider's serving side. Returns nothing; sets ctx.llm / ctx.testServer. */
async function prepareProvider (ctx) {
    ctx.btcNode = nodeConnector
    if (ctx.responseProvider === 'http_get') {
        ctx.llm = { ok: true, why: null }
        ctx.testServer = await startAttestTestServer({ body: HTTP_GET_BODY, path: '/at5-response' })
        console.log('AT5: explicit http_get response mode enabled with the local deterministic TLS fixture')
    } else {
        ctx.llm = llmRunnableHere()
    }
    if (ctx.responseProvider === 'llm' && !ctx.llm.ok) {
        console.log('AT5: the response-carrying window case will SKIP on this box.\n' + ctx.llm.why +
            '\nIt does not fall back to http_get. Set AT5_RESPONSE_PROVIDER=http_get only on an ' +
            'isolated stack whose complete seated roster the harness can adopt.')
    }
}

/** The DOGE rail first: the signer's wallet is funded on it. Returns false when it is unreachable. */
async function openDogeRail (ctx) {
    try {
        ctx.dogeRail = await chainRail.createRail('dogecoin', 'regtest')
        return true
    } catch (e) {
        console.log('AT5 SKIPPED: the DOGE regtest rail is unreachable (' + (e && e.message) +
            '), so the chain this batch rides cannot be driven at all. This is a venue fault with a ' +
            'named cause, not a missing credential.')
        return false
    }
}

/** Stake the drill identities and boot the hub venue. Returns false when the venue is unavailable. */
async function startHubVenue (ctx) {
    ctx.publisher = await stageDogeSigner('at5', ctx.dogeRail)
    // Scoped to the provider this run will request. On the isolated seeded
    // stack the harness can adopt every eligible key for http_get. On a shared
    // chain an inaccessible eligible key makes this call refuse the run.
    const staked = await provisionDrillIdentities({
        label: 'at5', count: 5, redundancy: REQUEST_REDUNDANCY, providers: [ctx.responseProvider],
    })
    // THE HUB CREDENTIAL TRAVELS WITH THE DRILL, not with the venue, and AT1
    // paid for that lesson: the venue builds each hub child's environment from
    // scratch (HUB_CLAUDE_CONFIG_DIR only, by policy), while on the venue box
    // the hub credential is an OAuth token in the harness environment. Every
    // hub's fetch failed with `llm: Set HUB_CLAUDE_CONFIG_DIR` until the token
    // reached the children. Forwarded only when present, never written anywhere.
    ctx.venue = new AttestMirrorVenue({
        label: 'at5',
        identities: staked.identities,
        needsLlm: ctx.responseProvider === 'llm' && ctx.llm.ok,
        forwardS: FORWARD_S,
        batchWindowS: BATCH_WINDOW_S,
        // BOTH, merged: the signer's WIF and the model credential are needed by
        // the same hub children, and passing either alone silently drops the other.
        hubExtraEnv: Object.assign({}, ctx.publisher.env,
            ctx.responseProvider === 'http_get' ? ctx.testServer.hubEnv : forwardedHubCredentialEnv()),
    })
    ctx.up = await ctx.venue.start()
    if (!ctx.up) {
        console.log('AT5 SKIPPED: ' + ctx.venue.unavailable)
        return false
    }
    return true
}

/** The attached DOGE reader, started INSIDE the DOGE rail switch. */
async function startDogeReader (ctx) {
    const { venue } = ctx
    // BEFORE ANY REQUEST, and AFTER the venue exists: this call sat above the
    // venue's construction and dereferenced null in 92 ms on 2026-09-05, so
    // AT5 had never reached its first assertion. The venue indexers are seeded
    // from the standing node and still need to catch its tip before a request
    // made here can be applied on them.
    await waitForVenueIndexersAtTip(venue)
    // THE DOGE READER IS PART OF THE VENUE. A v5 head is judged on DOGE against
    // `capability_snapshots` at its anchor, mirrored from the hub the DOGE indexer
    // follows. The venue hubs write those rows; the STANDING DOGE indexer follows
    // the STANDING hub and never sees them, so every head it judges reads
    // `invalid: insufficient signer stake` (pass 12, 2026-09-05). This second venue
    // spawns one DOGE indexer from the tree that follows venue hub 0 and shares the
    // hub database; the batch actions are read from it. Started INSIDE the DOGE
    // rail switch so the seed clones from the standing DOGE indexer (the rail swaps
    // INDEXER_DB_* for its duration) and the decoder discovered is DOGE's.
    ctx.dogeVenue = await chainRail.withRail(ctx.dogeRail, async () => {
        const dv = new AttestMirrorVenue({
            label: 'at5doge',
            coin: 'dogecoin',
            attachHubs: venue.hubs,
            hubDb: venue.hubDb,
            indexerCount: 1,
            // The harness DECODER_DB_* are Bitcoin's; this venue's decoder is DOGE's.
            useEnvDecoderCredential: false,
        })
        const dvUp = await dv.start()
        assert.ok(dvUp, 'the attached DOGE venue did not start: ' + dv.unavailable)
        return dv
    })
    const dogeVenue = ctx.dogeVenue
    await waitForVenueIndexersAtTip(dogeVenue)
    await configureDogeReconcileIndexer(venue, dogeVenue)
    console.log('AT5: DOGE venue indexer follows hub ' + dogeVenue.indexers[0].followsHub +
        ' and reads ' + dogeVenue.indexers[0].indexerDbName)
}

/** Everything the before-hook does once the rail is up; false means the venue was unavailable. */
async function bootDrill (ctx) {
    if (!(await startHubVenue(ctx))) return false
    await startDogeReader(ctx)
    await startTipFeed(ctx)
    ctx.contract = await deployRequestContract({ label: 'at5', code: CONTRACT_CODE })
    return true
}

module.exports = { prepareProvider, openDogeRail, bootDrill }
