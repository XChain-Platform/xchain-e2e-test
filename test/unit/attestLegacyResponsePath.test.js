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
 ********************************************************************/

const assert = require('assert')
const fs     = require('fs')
const path   = require('path')

const {
    ATTEST_RESPONSE_MIRROR_ACTIVATION,
    isLegacyResponsePathUnreachable,
    skipIfResponseMirrorEra
} = require('../helpers/attestLegacyResponsePath')

describe('the legacy on-chain ATTEST response path guard', function () {

    // The guard decides only whether to SKIP, so a local copy of the activation map
    // cannot fork settlement. It can, however, drift after a flag day and silently
    // re-enable nine cases that cannot pass, which is the failure this closes. The
    // indexer's vendored copy is the nearest authority a sibling checkout has.
    it('carries the same activation map as the indexer it is predicting', function () {
        const sibling = path.join(__dirname, '..', '..', '..', 'xchain-indexer',
            'src', 'attest_response_mirror_activation.js')
        if (!fs.existsSync(sibling)) {
            console.log('xchain-indexer not checked out beside this repo; parity unchecked')
            this.skip()
            return
        }
        const theirs = require(sibling).ATTEST_RESPONSE_MIRROR_ACTIVATION
        assert.deepStrictEqual(ATTEST_RESPONSE_MIRROR_ACTIVATION, theirs,
            'the local activation map has drifted from xchain-indexer. A flag-day edit ' +
            'that lands on one side only makes this guard skip cases that now CAN run, ' +
            'or run cases that now cannot. Copy the indexer value across.')
    })

    describe('isLegacyResponsePathUnreachable', function () {

        it('is false on an unratified network, where the legacy path runs byte for byte', function () {
            assert.strictEqual(isLegacyResponsePathUnreachable('mainnet'), false)
            assert.strictEqual(isLegacyResponsePathUnreachable('testnet'), false)
        })

        it('is true on regtest, armed at 0, where no request can be legacy-era', function () {
            assert.strictEqual(isLegacyResponsePathUnreachable('regtest'), true)
        })

        it('RUNS rather than skips on a network with no entry, so a typo fails loudly', function () {
            // The inverse would silently drop coverage on any network someone forgot
            // to declare, which is the harder failure to notice.
            assert.strictEqual(isLegacyResponsePathUnreachable('bitcoin-regtest'), false)
            assert.strictEqual(isLegacyResponsePathUnreachable(undefined), false)
        })

        it('leaves early blocks runnable when a network arms ABOVE genesis', function () {
            // A future testnet arming at a real height still has legacy-era requests
            // below it, and those cases must keep running rather than skip wholesale.
            const saved = ATTEST_RESPONSE_MIRROR_ACTIVATION.testnet
            try {
                ATTEST_RESPONSE_MIRROR_ACTIVATION.testnet = 150780
                assert.strictEqual(isLegacyResponsePathUnreachable('testnet'), false)
            } finally {
                ATTEST_RESPONSE_MIRROR_ACTIVATION.testnet = saved
            }
        })
    })

    describe('skipIfResponseMirrorEra', function () {

        it('skips and reports true on a mirror-era network', function () {
            let skipped = false
            const ctx = { skip: () => { skipped = true } }
            assert.strictEqual(skipIfResponseMirrorEra(ctx, 'regtest'), true)
            assert.strictEqual(skipped, true)
        })

        it('does not touch the case on a legacy-era network', function () {
            let skipped = false
            const ctx = { skip: () => { skipped = true } }
            assert.strictEqual(skipIfResponseMirrorEra(ctx, 'mainnet'), false)
            assert.strictEqual(skipped, false)
        })
    })
})
