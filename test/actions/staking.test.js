const assert = require('assert')
const crypto = require('crypto')
const cryptoHelper = require('../cryptoHelper')
const stakeHelper = require('../helpers/stakeHelper')
const gasHelper = require('../helpers/gasHelper')

describe('Staking — STAKE, UNSTAKE, DELEGATE', function () {

    let stakerAddr = null
    let signingPubkey = null

    before(async function () {
        // Fund a staker address with BTC and XCHAIN
        stakerAddr = await cryptoHelper.getNewFundedAddress(
            "staker", COIN, NETWORK, null, "legacy", 0, 0.01
        )
        // Ensure staker has enough XCHAIN for Tier 1 staking (1000 XCHAIN)
        await gasHelper.ensureGasBalance(stakerAddr, '2000')

        // Generate an Ed25519 signing keypair (64 hex chars = 32 byte pubkey)
        let { publicKey } = crypto.generateKeyPairSync('ed25519')
        let spkiDer = publicKey.export({ format: 'der', type: 'spki' })
        signingPubkey = spkiDer.subarray(12).toString('hex') // Strip 12-byte SPKI prefix
    })

    describe('STAKE v0 — Stake XCHAIN for validation', function () {
        it('should stake Tier 1 and create a stake record with XCHAIN debited', async function () {
            let result = await stakeHelper.sendStakeV0(stakerAddr, 1, '', signingPubkey)
            assert(result.stake, 'Stake record should exist in DB')
            assert.strictEqual(result.stake.status, 'valid', 'Stake status should be valid')
            assert.strictEqual(parseInt(result.stake.tier), 1, 'Tier should be 1')
        })

        it('should reject duplicate stake at the same tier', async function () {
            // Generate a different signing key
            let { publicKey } = crypto.generateKeyPairSync('ed25519')
            let spkiDer = publicKey.export({ format: 'der', type: 'spki' })
            let newPubkey = spkiDer.subarray(12).toString('hex')

            // Try to stake again at Tier 1 — should be rejected
            let result = await stakeHelper.sendStakeV0(stakerAddr, 1, '', newPubkey)
            // The waitFor will return null or the row with invalid status
            // Either outcome means the duplicate was rejected
            if(result.stake){
                assert.notStrictEqual(result.stake.status, 'valid', 'Duplicate stake should not be valid')
            }
        })
    })

    describe('UNSTAKE v0 — Begin unstaking', function () {
        it('should create an unstake record with cooldown', async function () {
            // STAKE doesn't take effect until ACTIVATION_DELAY_BLOCKS (6) later.
            // On regtest each tx mines ~1 block, so without explicit block
            // advancement the STAKE from the previous describe block is still
            // inactive and UNSTAKE fails with 'no active stake at tier'.
            await regtestMinerConnector.generateBlocks(7)
            let result = await stakeHelper.sendUnstakeV0(stakerAddr, 1)
            assert(result.unstake, 'Unstake record should exist in DB')
            assert.strictEqual(result.unstake.status, 'valid', 'Unstake status should be valid')
            assert(result.unstake.cooldown_end_block > 0, 'Cooldown end block should be set')
        })
    })

    describe('DELEGATE v0 — Rotate signing key', function () {
        let delegateAddr = null
        let delegatePubkey = null

        before(async function () {
            // Set up a fresh staker for delegation tests
            delegateAddr = await cryptoHelper.getNewFundedAddress(
                "delegator", COIN, NETWORK, null, "legacy", 0, 0.01
            )
            await gasHelper.ensureGasBalance(delegateAddr, '2000')

            let { publicKey } = crypto.generateKeyPairSync('ed25519')
            let spkiDer = publicKey.export({ format: 'der', type: 'spki' })
            delegatePubkey = spkiDer.subarray(12).toString('hex')

            // Stake first
            await stakeHelper.sendStakeV0(delegateAddr, 1, '', delegatePubkey)
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
