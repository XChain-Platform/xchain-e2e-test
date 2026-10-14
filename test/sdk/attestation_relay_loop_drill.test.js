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
 * XChain Platform E2E - CROSS-CHAIN ATTESTATION RELAY LOOP
 * (Phase 5, spec §12).
 *
 * Drives the whole §12 relay loop on a live multi-chain regtest venue:
 *
 *   1. ORIGIN (LTC): a contract emits ATTEST v0. Off BTC the responsible set is
 *      empty by construction, so before ATTEST_RELAY_ORIGIN this was rejected at
 *      admission; at/above it the request is admitted `pending` and STAMPED with
 *      its origin chain. That stamp is the only marker the relay keys on.
 *   2. HOME (BTC): the request is materialized as ATTEST v3 carrying a
 *      cross_chain quorum, and lands with a real BTC block_index, which is the
 *      entire point of the model (the responsible set and the block-echo check
 *      resolve on the BTC plane exactly as for a native request).
 *   3. HOME (BTC): the existing Phase 2 machinery fulfills it - a real fetch
 *      through the production http_get provider, signed by the request's pinned
 *      responsible set, broadcast as an ordinary ATTEST v1. The home chain fires
 *      NO callback: the contract is not on this chain.
 *   4. ORIGIN (LTC): the response relays back as ATTEST v4, the origin request
 *      flips terminal, the fee settles, and the contract callback is injected on
 *      the chain the contract actually lives on.
 *
 * WHAT STANDS IN FOR WHAT, stated plainly. Both relay legs are on-chain actions
 * carrying a cross_chain quorum; the hub's AttestationRelay is the thing that
 * normally runs the two PBFT rounds and broadcasts them. This drill runs those
 * legs with in-test federation signers, the same way
 * test/actions/realUrlAttestation.test.js stands in for AttestationRound +
 * AttestationPublisher on the single-chain path. The BYTES are not stood in for:
 * the v3/v4 canonicals and wire strings are built by the HUB'S OWN
 * AttestationRelay methods (`xchain-hub/src/attestation/relay.js`), so a
 * hub↔indexer canonical drift fails this drill rather than hiding in it. Every
 * verdict is the deployed indexer's.
 *
 * VENUE (a standard multi-coin `xchain-node` regtest stack):
 *   - BTC + LTC regtest, both indexers carrying the attestation relay code
 *     (src/attest_relay_activation.js present). Both gates are genesis-active on
 *     regtest (ATTEST_RELAY_ACTIVATION regtest: 0, ATTEST_RELAY_ORIGIN regtest:
 *     0), so "gates forced active" needs no override here.
 *   - Run under the BTC e2e env; the LTC rail is built by test/helpers/chainRail
 *     from published host ports + hub-discovered credentials.
 *
 * TWO SIDE EFFECTS ON A SHARED VENUE, both deliberate and both undone/bounded:
 *   a) cross_chain quorum is STAKE-WEIGHTED on regtest (genesis-active), and BTC
 *      resolves that capability from LOCAL stakes. To sign a v3 the drill must
 *      hold >2/3 of cross_chain stake, so it stakes above the live federation and
 *      UNSTAKES again as soon as the v3 has landed (an `after` hook repeats the
 *      unstake if a step failed in between). The XCHAIN behind that stake is
 *      minted in the FIRST step and staked in the LAST step before the v3, which
 *      keeps the window in which the live hub is a stake minority down to a few
 *      blocks rather than the whole run. Still: do not run this drill against a
 *      venue another session is driving XCALL/DEX settlement on.
 *   b) the origin chain verifies cross_chain against the HUB-MIRRORED
 *      capability_snapshots, not local stakes. On a venue whose hub does not
 *      publish a cross_chain snapshot, the drill seeds exactly the rows the
 *      mirror would have carried, at the one snapshot_block the v4 names.
 *
 * RUN:
 *   npm run test:attest-relay-loop
 * or
 *   npx mocha --timeout 0 --exit --require ./test/initial_check.test.js \
 *       test/sdk/attestation_relay_loop_drill.test.js
 *
 * Env knobs: XC974_ORIGIN_COIN (default litecoin), XC974_ATTEST_URL,
 * XC974_REDUNDANCY (1|3|5, default 3), XC974_SKIP_IF_NO_VENUE (default 1).
 ********************************************************************/

'use strict';

const assert = require('assert');

const chainRail = require('../helpers/chainRail');

const { ORIGIN_COIN, ATTEST_URL, REDUNDANCY } = require('./attestation_relay_loop_drill.test/support/config');
const { relayCodec } = require('./attestation_relay_loop_drill.test/support/codec');
const { startMiningPump } = require('./attestation_relay_loop_drill.test/support/rail');
const { unwindRelayStake } = require('./attestation_relay_loop_drill.test/support/stakes');
const { provisionHome } = require('./attestation_relay_loop_drill.test/support/provision');
const { emitOriginRequest } = require('./attestation_relay_loop_drill.test/support/origin');
const { stakeFederation } = require('./attestation_relay_loop_drill.test/support/federation');
const { materializeRequest } = require('./attestation_relay_loop_drill.test/support/materialize');
const { fulfillOnHome } = require('./attestation_relay_loop_drill.test/support/fulfill');
const { relayResponseBack } = require('./attestation_relay_loop_drill.test/support/relayBack');

// Everything the steps hand to each other lives on one context object.
function newContext() {
    return {
        stopMiningPump: null,
        homeRail: null,          // BTC, the chain initialCheck bootstrapped
        originRail: null,        // LTC (or DOGE), built by chainRail
        codec: null,
        originOperator: null,
        originContract: null,
        originRequestId: null,
        originRequest: null,     // the v0 row on the origin chain
        homeOperator: null,
        relaySigner: null,       // the cross_chain federation key
        relayStakeSource: null,  // the address holding the drill's cross_chain stake
        relayStakeAmount: null,
        relayStakeUnwound: false,
        attestStakeSources: [],
        responsibleValidators: [],
        snapshotBlock: null,
        homeResponseActionIndex: null,
        realBody: null,
        realMeta: null,
    };
}

// Build the origin rail, or return the reason this venue cannot run the drill.
async function buildOriginRail(ctx) {
    try {
        ctx.originRail = await chainRail.createRail(ORIGIN_COIN, global.NETWORK);
    } catch (e) {
        if (process.env.XC974_SKIP_IF_NO_VENUE === '0') throw e;
        return 'no ' + ORIGIN_COIN + ' rail (' + e.message + ')';
    }
    const failures = await chainRail.railFailures(ctx.originRail);
    if (!failures.length) return null;
    if (process.env.XC974_SKIP_IF_NO_VENUE === '0')
        throw new Error('origin rail unavailable: ' + failures.join(', '));
    return 'origin rail unavailable (' + failures.join(', ') + ')';
}

async function prepareDrill(ctx, mocha) {
    if (String(global.COIN_CODE) !== 'BTC') {
        console.log('    [relay-loop] the home chain is BTC by protocol; skipping on ' + global.COIN_CODE);
        return mocha.skip();
    }
    assert.notStrictEqual(String(global.NETWORK), 'mainnet', 'this drill never runs against mainnet');
    ctx.codec = relayCodec();
    ctx.homeRail = chainRail.captureCurrentRail();

    const skipReason = await buildOriginRail(ctx);
    if (skipReason) {
        console.log('    [relay-loop] ' + skipReason + '; skipping');
        return mocha.skip();
    }
    console.log('    [relay-loop] home=' + ctx.homeRail.code + ' origin=' + ctx.originRail.code +
                ' url=' + ATTEST_URL + ' redundancy=' + REDUNDANCY);
    ctx.stopMiningPump = startMiningPump(ctx.homeRail);
}

async function unwindAfterV3(ctx) {
    await unwindRelayStake(ctx, 'post-v3');
    // The pinned snapshot is historical, so unwinding cannot invalidate the v3
    // that already landed; the venue's live federation is a majority again.
    assert(ctx.relayStakeUnwound);
}

describe('[drill] cross-chain attestation relay loop (origin -> BTC -> origin)', function () {
    this.timeout(0);
    const ctx = newContext();

    before(function () { return prepareDrill(ctx, this); });
    after(async function () {
        await unwindRelayStake(ctx, 'teardown');
        if (ctx.stopMiningPump) ctx.stopMiningPump();
    });

    // Provisioning runs FIRST, and it is the slow part: the drill's cross_chain
    // majority is assembled out of MAX_MINT-sized XCHAIN mints, dozens of them,
    // each its own confirmed transaction. Done after the origin request it would
    // burn most of the request's DEADLINE_BLOCKS window (the origin chain keeps
    // mining while BTC is minting), and a request that expires mid-drill fails at
    // the v4 with a misleading "REQUEST already expired". Nothing here touches the
    // capability sets: minting gas is invisible to quorum, and the STAKE that is
    // NOT invisible happens later, in the step just before the v3.
    it('HOME: provisions funded sources and the XCHAIN the drill federation will stake', () => provisionHome(ctx));
    it('ORIGIN: a contract emits ATTEST v0 and the indexer admits it as relay-eligible', () => emitOriginRequest(ctx));
    it('HOME: stakes the request\'s responsible attestation keys and the cross_chain majority', () => stakeFederation(ctx));
    it('HOME: ATTEST v3 materializes the origin request onto BTC with a real BTC block_index', () => materializeRequest(ctx));
    it('HOME: the drill\'s cross_chain stake is unwound now that the v3 has pinned its snapshot', () => unwindAfterV3(ctx));
    it('HOME: a real http_get fetch is signed by the pinned set and fulfills the request as an ordinary v1', () => fulfillOnHome(ctx));
    it('ORIGIN: ATTEST v4 relays the response back, settles the request and injects the callback', () => relayResponseBack(ctx));
});
