// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// Validator onboarding ("step 2") - the on-chain half of bringing a real hub
// online as a capability validator:
//
//   `xchain-node validator init`  (offline) prints the hub's Ed25519 signing
//   pubkey  →  THIS test funds a fresh address, mints XCHAIN gas, and broadcasts
//   STAKE v1 of that pubkey  →  after ACTIVATION_DELAY_BLOCKS the indexer's
//   effective-set query reports the pubkey as a qualified validator for every
//   default capability. That `getcapabilityvalidators` RPC is exactly what the
//   hub's PBFT quorum reads, so membership here == the hub being recognised.
//
// The pubkey is NOT hardcoded: it is injected via the e2e container's env as
// VALIDATOR_PUBKEY (add `VALIDATOR_PUBKEY=<hex>` to xchain-node's
// <coin>-<network> config file; every key there is passed to the container).
// Unset ⇒ the suite skips, so CI and other operators are unaffected.

const assert = require('assert')
const cryptoHelper = require('../cryptoHelper')
const stakeHelper = require('../helpers/stakeHelper')
const gasHelper = require('../helpers/gasHelper')

describe('Validator onboarding - STAKE the hub signing pubkey into the active capability set', function () {

    // Hub Ed25519 signing pubkey (32-byte / 64-hex), from `xchain-node validator status`.
    const VALIDATOR_PUBKEY = (process.env.VALIDATOR_PUBKEY || '').trim().toLowerCase()

    // 2500 XCHAIN clears every default capability threshold (price/cross_chain/
    // attestation = 1000, oracle_publish = 500) and also full_node (2000).
    const STAKE_AMOUNT = '2500.00000000'

    // getcapabilityvalidators honours the caller-supplied threshold over the
    // venue's local MIN_STAKE config - assert against each documented minimum.
    const CAPABILITIES = [
        { name: 'price',          minStake: '1000' },
        { name: 'cross_chain',    minStake: '1000' },
        { name: 'oracle_publish', minStake: '500'  },
        { name: 'attestation',    minStake: '1000' }
    ]

    let stakerAddr = null
    let stakeBlock = null   // indexer height at which the STAKE was indexed

    // Effective signer set for `capability` at the indexer's latest indexed block.
    async function membership(capability, minStake) {
        const health = await indexerConnector.health()
        assert(health && health.lastIndexedBlock !== null, 'indexer health should report lastIndexedBlock')
        const result = await indexerConnector.getCapabilityValidators(capability, health.lastIndexedBlock, minStake)
        assert(result, 'getcapabilityvalidators should answer')
        assert(!result.error, 'getcapabilityvalidators should not error; got: ' + result.error)
        return result.validators.map(v => String(v.pubkey).toLowerCase())
    }

    before(async function () {
        // STAKE / capability staking is BTC-only by protocol design (the indexer
        // action handlers reject COIN !== 'BTC').
        if (COIN_CODE !== 'BTC') {
            console.log('Validator staking is BTC-only - skipping onboarding on ' + COIN_CODE)
            this.skip()
            return
        }
        if (!VALIDATOR_PUBKEY) {
            console.log('VALIDATOR_PUBKEY not set - skipping validator onboarding. Get it with ' +
                '`xchain-node validator status`, then add VALIDATOR_PUBKEY=<hex> to the ' +
                'bitcoin-regtest config file so it reaches the e2e container.')
            this.skip()
            return
        }
        assert.strictEqual(VALIDATOR_PUBKEY.length, 64,
            'VALIDATOR_PUBKEY must be a 32-byte (64-hex) Ed25519 key; got length ' + VALIDATOR_PUBKEY.length)

        stakerAddr = await cryptoHelper.getNewFundedAddress(
            'validator-onboard', COIN, NETWORK, null, 'legacy', 0, 1
        )
        // Mint enough XCHAIN to cover the 2500 stake + the STAKE protocol fee.
        await gasHelper.ensureGasBalance(stakerAddr, '3000')
    })

    it('stakes the hub pubkey and the indexer records it as a valid stake', async function () {
        const res = await stakeHelper.sendStakeV1(stakerAddr, STAKE_AMOUNT, VALIDATOR_PUBKEY)
        assert(res.stake, 'STAKE must be indexed')
        assert.strictEqual(res.stake.status, 'valid', 'STAKE status should be valid')

        const health = await indexerConnector.health()
        assert(health && health.lastIndexedBlock !== null, 'indexer health should report lastIndexedBlock')
        stakeBlock = Number(health.lastIndexedBlock)
    })

    it('after the activation delay, the hub pubkey qualifies for every default capability', async function () {
        assert(stakeBlock !== null, 'previous step must have indexed the STAKE')

        // Mine past ACTIVATION_DELAY_BLOCKS (BTC = 6) and wait for the indexer to
        // reach that height - effective-set reads are block-scoped, so reading
        // before the activation block is indexed would assert against the old set.
        await regtestMinerConnector.generateBlocks(7)
        const ok = await indexerConnector.waitForIndexedBlock(stakeBlock + 7, 90000)
        assert(ok, 'indexer did not reach block ' + (stakeBlock + 7) + ' in time')

        for (const cap of CAPABILITIES) {
            const set = await membership(cap.name, cap.minStake)
            assert(set.includes(VALIDATOR_PUBKEY),
                `hub pubkey should be in the '${cap.name}' capability set (min_stake ${cap.minStake}); ` +
                `set had ${set.length} validator(s)`)
        }
    })
})
