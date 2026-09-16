// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const assert = require('assert')
const crypto = require('crypto')
const cryptoHelper = require('../../cryptoHelper')
const stakeHelper = require('../../helpers/stakeHelper')
const gasHelper = require('../../helpers/gasHelper')

describe('Staking: STAKE, UNSTAKE, DELEGATE (capability model)', function () {
    before(async function () {
        if (typeof COIN_CODE === 'undefined' || COIN_CODE !== 'BTC') this.skip()
    })

    describe('DELEGATE v0: Rotate signing key', function () {
        let delegateAddr = null
        let delegatePubkey = null

        before(async function () {
            delegateAddr = await cryptoHelper.getNewFundedAddress(
                "delegator", COIN, NETWORK, null, "legacy", 0, 1
            )
            await gasHelper.ensureGasBalance(delegateAddr, '2000')

            let { publicKey } = crypto.generateKeyPairSync('ed25519')
            let spkiDer = publicKey.export({ format: 'der', type: 'spki' })
            delegatePubkey = spkiDer.subarray(12).toString('hex')

            // Stake first
            await stakeHelper.sendStakeV1(delegateAddr, '1000.00000000', delegatePubkey)
            // Advance past ACTIVATION_DELAY_BLOCKS so DELEGATE sees an active stake.
            // Pause the auto-miner around this deterministic height advance.
            await regtestMinerConnector.pauseMining()
            try {
                await regtestMinerConnector.generateBlocks(7)
            } finally {
                await regtestMinerConnector.resumeMining()
            }
        })

        it('should delegate to a new signing key', async function () {
            let { publicKey } = crypto.generateKeyPairSync('ed25519')
            let spkiDer = publicKey.export({ format: 'der', type: 'spki' })
            let newPubkey = spkiDer.subarray(12).toString('hex')

            let result = await stakeHelper.sendDelegateV0(delegateAddr, newPubkey)
            assert(result.delegation, 'Delegation record should exist in DB')
            assert.strictEqual(result.delegation.status, 'valid', 'Delegation status should be valid')
        })
    })
})
