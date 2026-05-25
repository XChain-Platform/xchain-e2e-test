const assert = require('assert')
const crypto = require('crypto')
const cryptoHelper = require('../cryptoHelper')
const stakeHelper = require('../helpers/stakeHelper')
const gasHelper = require('../helpers/gasHelper')

describe('Staking — STAKE, UNSTAKE, DELEGATE (capability model)', function () {

    let stakerAddr = null
    let signingPubkey = null

    before(async function () {
        // STAKE/UNSTAKE/DELEGATE are BTC-only by protocol design — the indexer
        // action handlers (xchain-indexer/src/actions/{stake,unstake,delegate}.js)
        // explicitly reject COIN !== 'BTC' with status='invalid: ACTION (BTC only)',
        // so these tests can only pass on the bitcoin chain.
        if (COIN_CODE !== 'BTC') {
            console.log('STAKE/UNSTAKE/DELEGATE are BTC-only — skipping on ' + COIN_CODE)
            this.skip()
            return
        }
        // Fund a staker address with BTC and XCHAIN
        stakerAddr = await cryptoHelper.getNewFundedAddress(
            "staker", COIN, NETWORK, null, "legacy", 0, 0.01
        )
        // Ensure staker has enough XCHAIN for staking + top-up (default price min_stake = 1000)
        await gasHelper.ensureGasBalance(stakerAddr, '3000')

        // Generate an Ed25519 signing keypair (64 hex chars = 32 byte pubkey)
        let { publicKey } = crypto.generateKeyPairSync('ed25519')
        let spkiDer = publicKey.export({ format: 'der', type: 'spki' })
        signingPubkey = spkiDer.subarray(12).toString('hex') // Strip 12-byte SPKI prefix
    })

    describe('STAKE v1 — Create a new stake', function () {
        it('should stake XCHAIN and create a valid stake record', async function () {
            let result = await stakeHelper.sendStakeV1(stakerAddr, '1000.00000000', signingPubkey)
            assert(result.stake, 'Stake record should exist in DB')
            assert.strictEqual(result.stake.status, 'valid', 'Stake status should be valid')
            assert.strictEqual(parseInt(result.stake.version), 1, 'Version should be 1 (new stake)')
        })

        it('should reject a second v1 stake reusing the same pubkey', async function () {
            // Reusing an active pubkey for a fresh stake should be rejected
            let result = await stakeHelper.sendStakeV1(stakerAddr, '500.00000000', signingPubkey)
            if (result.stake) {
                assert.notStrictEqual(result.stake.status, 'valid', 'Duplicate-pubkey stake should not be valid')
            }
        })
    })

    describe('STAKE v2 — Top up an existing stake', function () {
        it('should accept a top-up to the same pubkey from the same source', async function () {
            // Advance past the activation window so the v1 stake is observable as active for the v2 top-up check
            await regtestMinerConnector.generateBlocks(7)
            let result = await stakeHelper.sendStakeV2(stakerAddr, '500.00000000', signingPubkey)
            assert(result.stake, 'Top-up stake record should exist in DB')
            assert.strictEqual(result.stake.status, 'valid', 'Top-up status should be valid')
            assert.strictEqual(parseInt(result.stake.version), 2, 'Version should be 2 (top-up)')
        })
    })

    describe('UNSTAKE v0 — Begin unstaking by pubkey', function () {
        it('should create an unstake record with cooldown', async function () {
            await regtestMinerConnector.generateBlocks(7)
            let result = await stakeHelper.sendUnstakeV0(stakerAddr, signingPubkey)
            assert(result.unstake, 'Unstake record should exist in DB')
            assert.strictEqual(result.unstake.status, 'valid', 'Unstake status should be valid')
            assert(result.unstake.cooldown_end_block > 0, 'Cooldown end block should be set')
        })
    })

    describe('DELEGATE v0 — Rotate signing key', function () {
        let delegateAddr = null
        let delegatePubkey = null

        before(async function () {
            delegateAddr = await cryptoHelper.getNewFundedAddress(
                "delegator", COIN, NETWORK, null, "legacy", 0, 0.01
            )
            await gasHelper.ensureGasBalance(delegateAddr, '2000')

            let { publicKey } = crypto.generateKeyPairSync('ed25519')
            let spkiDer = publicKey.export({ format: 'der', type: 'spki' })
            delegatePubkey = spkiDer.subarray(12).toString('hex')

            // Stake first
            await stakeHelper.sendStakeV1(delegateAddr, '1000.00000000', delegatePubkey)
            // Advance past ACTIVATION_DELAY_BLOCKS so DELEGATE sees an active stake.
            await regtestMinerConnector.generateBlocks(7)
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
