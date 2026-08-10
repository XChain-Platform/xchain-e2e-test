// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// COLLECT v0 (claim accrued validator rewards) on-chain action.
//
// COLLECT is BTC-only (xchain-indexer/src/actions/collect.js rejects
// COIN !== 'BTC' with 'invalid: ACTION (BTC only)'), so this suite skips off
// bitcoin. Reward accrual itself is driven by PRICE v0 oracle rounds and ATTEST
// fee settlement (the in-process PBFT federation path), which the simple
// action-test pipeline does not exercise; the valid-collect happy path is
// covered there. This suite drives the two on-chain rejection branches that ARE
// deterministic on a single stack, proving COLLECT is decoded, chain-gated,
// stake-gated, and recorded into reward_claims with the right status.

const assert = require('assert')
const crypto = require('crypto')
const cryptoHelper = require('../cryptoHelper')
const stakeHelper = require('../helpers/stakeHelper')
const gasHelper = require('../helpers/gasHelper')

describe('COLLECT v0 (claim accrued validator rewards)', function () {

    before(function () {
        // COLLECT is BTC-only by protocol design; the indexer handler rejects any
        // other chain outright, so these on-chain assertions only run on bitcoin.
        if (COIN_CODE !== 'BTC') {
            console.log('COLLECT is BTC-only, skipping on ' + COIN_CODE)
            this.skip()
        }
    })

    describe('rejects when the source has no active stake', function () {
        it('records the reward_claims row with a "no active stake" status', async function () {
            // A freshly funded address that has never staked has no validator
            // capability, so COLLECT must reject before any reward calculation.
            let addr = await cryptoHelper.getNewFundedAddress(
                'collect-no-stake', COIN, NETWORK, null, 'legacy', 0, 1
            )

            let result = await stakeHelper.sendCollectInvalid(addr)
            assert(result.claim, 'a rejected COLLECT should still record a reward_claims row')
            assert.notStrictEqual(result.claim.status, 'valid',
                'COLLECT without an active stake must not be valid; got status=' + result.claim.status)
            assert.match(result.claim.status, /no active stake/i,
                'rejection reason should mention "no active stake"; got: ' + result.claim.status)
        })
    })

    describe('rejects when the staker has no unclaimed rewards', function () {
        it('records the reward_claims row with a "no unclaimed rewards" status', async function () {
            // Stake enough XCHAIN to qualify, then advance past the activation delay
            // so the stake is observable as active for COLLECT's existence check.
            // With an active stake but zero accrued rewards, COLLECT reaches the
            // reward-total check and rejects with 'no unclaimed rewards'.
            let addr = await cryptoHelper.getNewFundedAddress(
                'collect-no-rewards', COIN, NETWORK, null, 'legacy', 0, 1
            )
            await gasHelper.ensureGasBalance(addr, '2000')

            let { publicKey } = crypto.generateKeyPairSync('ed25519')
            let signingPubkey = publicKey.export({ format: 'der', type: 'spki' })
                .subarray(12).toString('hex')

            let stakeResult = await stakeHelper.sendStakeV1(addr, '1000.00000000', signingPubkey)
            assert(stakeResult.stake, 'stake record should exist before COLLECT')
            assert.strictEqual(stakeResult.stake.status, 'valid', 'stake should be valid')

            // Advance past ACTIVATION_DELAY_BLOCKS so the stake is active. Pause the
            // auto-miner around the deterministic height advance so no stray mempool
            // tx adds an extra block. #3851
            await regtestMinerConnector.pauseMining()
            try {
                await regtestMinerConnector.generateBlocks(7)
            } finally {
                await regtestMinerConnector.resumeMining()
            }

            let result = await stakeHelper.sendCollectInvalid(addr)
            assert(result.claim, 'a rejected COLLECT should still record a reward_claims row')
            assert.notStrictEqual(result.claim.status, 'valid',
                'COLLECT with no accrued rewards must not be valid; got status=' + result.claim.status)
            assert.match(result.claim.status, /no unclaimed rewards/i,
                'rejection reason should mention "no unclaimed rewards"; got: ' + result.claim.status)

            //  partial claim: a trailing AMOUNT decodes cleanly and still
            // reaches the same deterministic rejection (the reward-total check
            // precedes amount validation). Reward ACCRUAL is federation-driven and
            // not exercisable on this pipeline, so the partial happy path is
            // covered by the indexer unit suite instead.
            let partial = await stakeHelper.sendCollectInvalid(addr, '5')
            assert(partial.claim, 'a rejected partial COLLECT should still record a reward_claims row')
            assert.match(partial.claim.status, /no unclaimed rewards/i,
                'partial COLLECT with no rewards should reject identically; got: ' + partial.claim.status)
        })
    })
})
