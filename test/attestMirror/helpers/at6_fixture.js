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
 * AT6 fixture: constants, the asker contract, venue setup and teardown, and the
 * stale on-chain response broadcast. The case steps live in at6_steps.js.
 ********************************************************************/

const assert = require('assert')

const { AttestMirrorVenue } = require('../../helpers/attestMirrorVenue')
const {
    provisionDrillIdentities, waitForVenueIndexersAtTip, startAttestTestServer, deployRequestContract, withWedgeClear,
} = require('./mirrorDrillFixture')
const { settleOrReport } = require('./mirrorDrillWaits')
const cryptoHelper      = require('../../helpers/core/cryptoHelper')
const attestationHelper = require('../../helpers/attestationHelper')

const FIXED_BODY = '{"score":19,"meta":"at6-flagday"}'

// The verdict the chain handler pins for an on-chain v1 whose request is
// mirror-era. Spelled out because it IS the observable: it is a stored verdict a
// replay re-derives, so a change to the string is a consensus change.
const MIRROR_ERA_VERDICT = 'invalid: ATTEST v1 after mirror activation'

// The verdict that would appear instead if the gate were ordered after the
// already-terminal check. Named so the ordering assertion can say what it caught.
const ALREADY_VERDICT_PREFIX = 'invalid: REQUEST already'

const DEADLINE_BLOCKS = 60
const BURIAL_BLOCKS   = 6

// The per-signer split floors at the GAS token's ISSUE decimals (attest/index.js
// `feeCap = min(8, gasDecimals)`), so the pool keeps a remainder of at most one
// unit in the last place per signer. Anything beyond that is a carve-out.
// MEASURED 2026-09-05 on the standing BTC regtest indexer: XCHAIN's one valid
// ISSUE row carries `decimals 0`, so a unit here is a WHOLE XCHAIN. The earlier
// value of 8 assumed a divisible token and would have failed the residual bound
// on any widened set.
const FEE_DECIMALS = 0

// The request fee each of this drill's two requests escrows, in XCHAIN. Small
// against the owner's minted gas, and chosen so the split leaves a POSITIVE whole
// share for every responsible-set size the widening ladder can reach (3 to 6):
// 6 / 3 = 2, 6 / 4 = 1, 6 / 5 = 1. With `2` (pass 5, 2026-09-05) a 3-way split
// floored to 0 at 0 decimals, the writer was never called, and the whole escrow
// stayed in the REWARD pool with no `attest_fee` row to read.
const FEE_XCHAIN = '6'

const CONTRACT_CODE = `
module.exports = {
    meta: { name: 'Mirror Flag Day Asker', description: 'Requests an attestation across the mirror flag day boundary.', version: '1.0.0' },
    ask: function(xchain) {
        var requestId = xchain.attestation.request(
            xchain.getInputParam(0),
            xchain.getInputParam(1),
            'handleResponse',
            ['ctx-at6'],
            // A REAL ESCROW, because the money half of this drill is a statement
            // about how the escrow is split: without feeTick/feeAmount the request
            // is fee=none, fee_amount is NULL, and the split assertions cannot even
            // start (measured 2026-09-05: DecimalError on the null). The fee payer is
            // the EXECUTE caller, the contract owner, whom the fixture mints gas to.
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

/** The shared state the AT6 cases read, filled in by setupVenue. */
function newCtx () {
    return { venue: null, up: false, testServer: null, testUrl: null, contract: null, broadcaster: null }
}

/** Fund the relayer that puts the stale on-chain v1 on the chain. */
async function fundRelayer (ctx) {
    // Whoever relays an on-chain v1 pays its transaction fee and nothing else;
    // it is deliberately NOT one of the stakers, so the escrow assertions cannot
    // be confused by the relayer also being a payee.
    // WRAPPED, and safe to retry: `getNewFundedAddress` mints gas internally
    // (100 XCHAIN seed) so it reaches a `status=valid` wait and starves under the
    // wedge, and it is keyed by label, so a second attempt re-funds this same
    // relayer rather than minting another identity.
    ctx.broadcaster = await withWedgeClear('funding the at6 relayer',
        () => cryptoHelper.getNewFundedAddress('at6-relayer', COIN, NETWORK, null, 'legacy', 0, 0.02))
    await regtestMinerConnector.generateBlocks(2)
    await settleOrReport('at6')
}

async function setupVenue (ctx, mocha) {
    // REAL TLS, not http. The provider refuses a non-https payload before it
    // does any network work, so a plain-HTTP server here resolves every round
    // provider_error, which reads downstream as a missing mirror row.
    ctx.testServer = await startAttestTestServer({ body: FIXED_BODY })
    ctx.testUrl    = ctx.testServer.url

    const staked = await provisionDrillIdentities({ label: 'at6', count: 5, redundancy: 3 })
    ctx.venue = new AttestMirrorVenue({ label: 'at6', identities: staked.identities, hubExtraEnv: ctx.testServer.hubEnv })
    ctx.up = await ctx.venue.start()
    if (!ctx.up) {
        console.log('AT6 SKIPPED: ' + ctx.venue.unavailable)
        mocha.skip()
        return
    }

    // BEFORE ANY REQUEST. The venue's indexers replay the borrowed chain from
    // scratch, so at this point they are far behind the tip. A request made now
    // sits at a block they have not reached, and its response reads as "not
    // applied" when the node simply has not got there yet.
    await waitForVenueIndexersAtTip(ctx.venue)
    ctx.contract = await deployRequestContract({ label: 'at6', code: CONTRACT_CODE })
    await fundRelayer(ctx)
}

async function teardownVenue (ctx) {
    if (ctx.testServer) await ctx.testServer.close()
    if (ctx.venue) await ctx.venue.stop()
}

/** The wire a stale legacy publisher would put on chain for this request. */
async function broadcastStaleOnChainResponse (ctx, requestId, label) {
    const validators = [
        new attestationHelper.MockAttestationValidator(),
        new attestationHelper.MockAttestationValidator(),
        new attestationHelper.MockAttestationValidator(),
    ]
    const sent = await attestationHelper.broadcastAttestationResponse(ctx.broadcaster, {
        requestId: requestId,
        providerId: 'http_get',
        responsePayload: FIXED_BODY,
        status: 'ok',
        meta: '',
        validators: validators,
        network: NETWORK,
    })
    await regtestMinerConnector.generateBlocks(1)
    await settleOrReport('at6')
    // THE HELPER RETURNS THE HASH AS A BARE STRING (`createAndSendTransaction`
    // ends in `return spentTxHash != null ? spentTxHash : txHash`), not an
    // object. Reading `.txHash` off it declared a broadcast that the log showed
    // succeeding, two transactions and all, as "not broadcast" (2026-09-05).
    // Same defect shape as the option-shape faults: check the SHAPE first.
    const txHash = (typeof sent === 'string') ? sent : (sent && sent.txHash)
    assert.ok(txHash,
        label + ': the on-chain ATTEST v1 was not broadcast, so the gate was never offered anything')
    return String(txHash)
}

module.exports = {
    FIXED_BODY, MIRROR_ERA_VERDICT, ALREADY_VERDICT_PREFIX, DEADLINE_BLOCKS, BURIAL_BLOCKS, FEE_DECIMALS,
    newCtx, setupVenue, teardownVenue, broadcastStaleOnChainResponse,
}
