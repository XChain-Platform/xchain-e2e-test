/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 *
 * XChain E2E Test - the legacy on-chain ATTEST response path
 *
 * A case that needs an `attestation_responses` row to appear from an ON-CHAIN
 * ATTEST v1 broadcast can only run where the response mirror is NOT armed. Above
 * the activation height the indexer refuses that transaction outright with
 * `invalid: ATTEST v1 after mirror activation` (xchain-indexer
 * src/actions/attest.js:612), so the row the case waits for can never exist and
 * the case fails on a timeout that says nothing about the product.
 *
 * WHY THIS IS NOT FIXABLE BY MIGRATING THE CASES. In the mirror era a response is
 * not broadcast at all: it finalizes over P2P across a hub federation and reaches
 * the indexer as a mirrored row, so producing one needs a multi-hub venue with a
 * staked responsible set. That is the AttestMirrorVenue the AT0-AT6 ladder in
 * test/attestMirror/ runs on. The three-coin matrix stack has ONE hub and no
 * validators, so there is nothing there that could ever mint a response row.
 * These cases are legacy-era by construction and their mirror-era counterparts
 * live in that ladder, not here.
 *
 * MEASURED 2026-09-06, release matrix run 34015867460: nine cases across
 * attestation, realUrlAttestation, realUrlAttestationFailures and
 * attestationWidening failed exactly this way, and the indexer log carries ten
 * `ATTEST v1 after mirror activation` refusals against zero response rows. They
 * were read as a product defect for a day.
 *
 * THE ACTIVATION MAP IS THE AUTHORITY, and it is deliberately seamless: the
 * canonical copy is xchain-documentation/protocol/constants.js, twinned into
 * xchain-indexer and xchain-hub, and the resolver is a plain
 * `requestBlock >= threshold` over a module-level constant with no environment
 * variable, no config key and no injected parameter (see the reasoning written
 * out in test/attestMirror/at6-flag-day.test.js). Regtest is armed at 0 and no
 * block index is below 0, so EVERY regtest request that can exist is mirror-era.
 *
 * The map below decides only whether to skip a test. It cannot fork settlement,
 * which is why a local copy is acceptable here where it would not be in a
 * consensus path. It is asserted equal to the indexer's vendored copy by
 * attestLegacyResponsePath.test.js whenever that sibling is checked out, so a
 * flag-day edit that leaves this behind is caught rather than silently
 * re-enabling nine tests that cannot pass.
 *
 ********************************************************************/

'use strict';

// Value-identical to ATTEST_RESPONSE_MIRROR_ACTIVATION. null = unratified (mirror
// OFF, legacy path runs byte for byte); a number = armed at that BTC block index.
const ATTEST_RESPONSE_MIRROR_ACTIVATION = {
    mainnet: null,
    testnet: null,
    regtest: 0
};

// True when no request on this network can be legacy-era, i.e. the on-chain v1
// response path is unreachable and a case that depends on it cannot pass.
//
// Unknown networks return false, which RUNS the case rather than skipping it: a
// missing entry is a misconfiguration, and failing loudly on a network nobody
// declared is better than silently skipping coverage on it.
function isLegacyResponsePathUnreachable(network) {
    const threshold = ATTEST_RESPONSE_MIRROR_ACTIVATION[network];
    if (threshold === null || threshold === undefined) return false;
    // Armed at or below the first legal block index, so there is no legacy-era
    // request left to construct. Armed ABOVE it still leaves early blocks legacy,
    // and those cases stay runnable.
    return threshold <= 0;
}

// Skip the current mocha case when it needs a response row the on-chain path can
// no longer produce. Call as the FIRST statement of the case, passing `this`.
function skipIfResponseMirrorEra(ctx, network) {
    if (!isLegacyResponsePathUnreachable(network)) return false;
    console.log('ATTEST response mirror is armed from genesis on ' + network +
        ', so an on-chain v1 response is refused and no attestation_responses row ' +
        'can appear; the mirror-era equivalent runs in test/attestMirror/. Skipping.');
    ctx.skip();
    return true;
}

module.exports = {
    ATTEST_RESPONSE_MIRROR_ACTIVATION,
    isLegacyResponsePathUnreachable,
    skipIfResponseMirrorEra
};
