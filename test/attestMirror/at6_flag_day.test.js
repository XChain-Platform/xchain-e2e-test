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
 * AT6, THE FLAG DAY. Above the height the chain stops being a delivery route for
 * a response, and the money moves accordingly.
 *
 * The spec's own test: a request below the height is served on chain as today; at
 * or above it an on-chain v1 is `invalid`, the mirror row applies, `attest_bcast`
 * is not written and the `attest_fee` split carries the whole escrow.
 *
 * THE BELOW-HEIGHT HALF IS NOT DRIVABLE ON REGTEST AND IS SKIPPED, with the
 * measurement in the skipped case's comment. In short:
 * `ATTEST_RESPONSE_MIRROR_ACTIVATION.regtest` is 0 and the resolver is a plain
 * `requestBlock >= threshold` over a module-level constant with no environment
 * variable, no config key and no injected seam, so every regtest request that can
 * exist is mirror-era. There is no legal block index below 0.
 *
 * WHAT THE DRIVEN CASE PROVES, and why the ordering inside it is the interesting
 * part. A stale hub still running the legacy publisher would broadcast an on-chain
 * v1 for a mirror-era request. If the chain handler accepted it, the callback would
 * fire twice and the escrow would settle twice, once from the chain and once from
 * the applier. So the drill broadcasts exactly that transaction, WHILE THE REQUEST
 * IS STILL PENDING, which is the moment it would do the damage, and then requires
 * that the mirror row applies anyway. Two v1 rows end up in `attests` for one
 * request and telling them apart is the assertion: the chain one carries a
 * transaction position, the synthesized one carries NULL.
 *
 * THE SIGNATURES ON THAT v1 ARE DELIBERATELY NOT REAL, and the assertion is what
 * makes that sound. The flag-day gate is the FIRST request-derived branch in the
 * handler, before signature verification, so a structurally valid wire is enough to
 * reach it. The drill asserts the EXACT verdict string; had the rejection come from
 * the signatures instead, the string would be a different one and the case would
 * fail. Signing with the real responsible keys would prove nothing extra and would
 * put a second implementation of the canonical in the test tree.
 *
 * ON THE FEE ASSERTIONS AND THE SHARED ROSTER: the split is over the responsible
 * set the INDEXER recomputes, which is drawn from every qualifying staked key on
 * the chain and is not this drill's to control. So nothing here asserts who was
 * paid or how many were paid. It asserts the two things the flag day actually
 * changes: no `attest_bcast` row exists at all, and the amounts paid add back up to
 * the escrow rather than to the escrow minus a broadcast carve-out.
 *
 * SERIALIZED, not parallel: this drill stakes into the one standing regtest roster.
 ********************************************************************/

const assert = require('assert')
const dotenv = require('dotenv')
dotenv.config()

const { newCtx, setupVenue, teardownVenue } = require('./helpers/at6_fixture')
const { refusesOnChainV1AndSettles, refusesForSameReasonWhenFulfilled } = require('./helpers/at6_steps')

function registerBelowHeightSkip () {
/**
 * NOT DRIVABLE ON REGTEST, and this is a measurement rather than an omission.
 *
 * AT6's first clause asks for a request BELOW the activation height, served on
 * chain exactly as it is today. On regtest there is no such request and there
 * cannot be one:
 *
 *   ATTEST_RESPONSE_MIRROR_ACTIVATION = { mainnet: null, testnet: null, regtest: 0 }
 *   isResponseMirrorActive(requestBlock, network) => requestBlock >= threshold
 *
 * The map is a module-level constant in `xchain-indexer/src/attest_response_mirror_activation.js`
 * and its twin in the hub, and the resolver reads it directly: no environment
 * variable, no config key, no injected parameter. Regtest is armed at 0 and no
 * block index is below 0, so every regtest request that can exist is mirror-era.
 * The unit tiers on both sides reach this case by mutating the exported object
 * or stubbing the exported function in-process, which an out-of-process venue
 * child cannot do.
 *
 * THREE WAYS TO CLOSE IT, all of them the operator's rather than this drill's:
 *   1. accept the in-process coverage as the whole of the below-height claim.
 *      The hub's era-partition guard already sweeps heights either side of a
 *      temporarily raised regtest activation, and the indexer's ATTEST battery
 *      drives the legacy path with the gate stubbed off;
 *   2. give the activation resolver a regtest-only override on the pattern
 *      `ATTEST_RESPONSE_FORWARD_S_OVERRIDE` already sets, which would make this
 *      case drivable as written, at the cost of an env-settable seam in a
 *      consensus constant;
 *   3. drive it on testnet after the height is armed, where a genuine below is
 *      the whole history that precedes it. That is AT-T1's territory.
 *
 * Option 2 is the only one that makes THIS drill green, and it is a change to a
 * consensus surface, so it is not a test author's call to make.
 */
it.skip('serves a request below the activation height on chain (not drivable on regtest: see comment)',
    async function () {
        assert.fail('unreachable: regtest is armed at height 0')
    })
}

describe('AT6: above the flag day the chain cannot deliver a response, and the escrow reflects it', function () {
    this.timeout(90 * 60 * 1000)

    const ctx = newCtx()

    before(async function () {
        await setupVenue(ctx, this)
    })

    after(async function () {
        await teardownVenue(ctx)
    })

    it('refuses an on-chain v1, applies the mirror row anyway, and settles the whole escrow', async function () {
        await refusesOnChainV1AndSettles(ctx)
    })

    it('still refuses an on-chain v1 for the SAME reason once the request is fulfilled', async function () {
        await refusesForSameReasonWhenFulfilled(ctx)
    })

    registerBelowHeightSkip()
})
