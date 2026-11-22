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
 * ZC3 fixture: constants, the contract source and venue setup/teardown. The
 * drill itself lives in zc3_headroom.test.js.
 ********************************************************************/

const { AttestMirrorVenue } = require('../../helpers/attestMirrorVenue')
const {
    provisionDrillIdentities, waitForVenueIndexersAtTip, startAttestTestServer, deployRequestContract,
} = require('./mirrorDrillFixture')

const FIXED_BODY = '{"score":23,"meta":"zc3-headroom"}'

// The drill's window knob, NOT a claim about the fleet default (see the header).
// Long enough to read the draw and stop a hub before any hub's first poll fires.
const POLL_MS = 20000

// A poll can land in the interval between request visibility and stopHub. A fresh
// request changes both the draw and which hub occupies rank 1, so a bounded retry
// turns that race into one discarded request without turning the leg into a hang.
const VICTIM_WINDOW_ATTEMPTS = 4
const FOLLOWED_REDRAW_ATTEMPTS = 8 // rank 1 is a followed hub about 2 draws in 5

const FORWARD_S = 3

// Sixty blocks gives a first ladder segment of twenty (span 60, V2 maxSlots 2, so
// segment = span / 3), which is wide enough that the assertion below is about the
// headroom slot rather than about how fast the shared miner happened to be.
const DEADLINE_BLOCKS = 60

// The request's redundancy, and therefore the exact number of valid signatures the
// round must finalize with once one drawn member is gone.
const REDUNDANCY = 3

const CONTRACT_CODE = `
module.exports = {
    meta: { name: 'Zero Conf Headroom Asker', description: 'Requests an attestation used to measure zero-conf mirror headroom.', version: '1.0.0' },
    ask: function(xchain) {
        var requestId = xchain.attestation.request(
            xchain.getInputParam(0),
            xchain.getInputParam(1),
            'handleResponse',
            ['ctx-zc3'],
            { redundancy: ${REDUNDANCY}, deadlineBlocks: ${DEADLINE_BLOCKS} }
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
    return {
        venue: null, up: false, testServer: null, testUrl: null, contract: null, stoppedHub: null,
    }
}

async function setupZc3 (ctx, mocha) {
    ctx.testServer = await startAttestTestServer({ body: FIXED_BODY })
    ctx.testUrl    = ctx.testServer.url

    const staked = await provisionDrillIdentities({ label: 'zc3', count: 5, redundancy: REDUNDANCY })
    ctx.venue = new AttestMirrorVenue({
        label: 'zc3', identities: staked.identities, hubExtraEnv: ctx.testServer.hubEnv,
        attestationPollMs: POLL_MS, forwardS: FORWARD_S,
    })
    ctx.up = await ctx.venue.start()
    if (!ctx.up) {
        console.log('ZC3 SKIPPED: ' + ctx.venue.unavailable)
        mocha.skip()
        return
    }
    await waitForVenueIndexersAtTip(ctx.venue)
    ctx.contract = await deployRequestContract({ label: 'zc3', code: CONTRACT_CODE })
}

async function teardownZc3 (ctx) {
    // The hub goes back whatever happened, so the venue teardown kills a process it
    // started rather than leaking one, and a re-run finds five hubs.
    if (ctx.venue && ctx.stoppedHub !== null) {
        try { await ctx.venue.startHub(ctx.stoppedHub) } catch (e) {
            console.log('ZC3 teardown: hub ' + ctx.stoppedHub + ' did not restart (' + (e && e.message) + ')')
        }
    }
    if (ctx.testServer) await ctx.testServer.close()
    if (ctx.venue) await ctx.venue.stop()
}

module.exports = {
    POLL_MS, VICTIM_WINDOW_ATTEMPTS, FOLLOWED_REDRAW_ATTEMPTS, REDUNDANCY,
    newCtx, setupZc3, teardownZc3,
}
