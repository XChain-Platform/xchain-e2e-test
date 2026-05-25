const assert = require('assert')
const crypto = require('crypto')
const cryptoHelper = require('../cryptoHelper')
const stakeHelper = require('../helpers/stakeHelper')
const gasHelper = require('../helpers/gasHelper')
const transactionHelper = require('../transactionHelper')

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

    describe('STAKE v2 — Top-up validation rejections', function () {
        // Run order: this block lands AFTER `UNSTAKE v0 — Begin unstaking`,
        // but the source-mismatch test relies on the pubkey's stake being
        // VISIBLE-AS-ACTIVE at the time of the v2 broadcast. UNSTAKE doesn't
        // deactivate instantly — it sets deactivation_block = unstake_block
        // + ACTIVATION_DELAY_BLOCKS (6), giving the validator a grace
        // period to keep participating. So as long as fewer than 6 blocks
        // elapse between the UNSTAKE block and this v2 broadcast, the
        // stake is still queryable as active and the SOURCE check fires
        // correctly. Don't insert generateBlocks(7) before this block.
        let otherAddr = null

        before(async function () {
            // A second address that does NOT own the original pubkey's stake
            otherAddr = await cryptoHelper.getNewFundedAddress(
                "other-staker", COIN, NETWORK, null, "legacy", 0, 0.01
            )
            await gasHelper.ensureGasBalance(otherAddr, '2000')
        })

        it('should reject a v2 top-up from a different source address', async function () {
            // signingPubkey already has an active stake from stakerAddr
            // (within UNSTAKE's 6-block deactivation grace period — see
            // block comment above). otherAddr tries to top it up — the
            // indexer must reject as "SOURCE (does not own this stake)".
            let msg = "STAKE|2|500.00000000|" + signingPubkey
            let txHash = await transactionHelper.createAndSendTransaction(otherAddr, msg)
            let row = await stakeHelper.waitForAnyStake({
                source:        otherAddr.address,
                signingPubkey: signingPubkey,
                txHash:        txHash
            })
            assert(row, 'top-up row should be recorded (even when rejected)')
            assert.notStrictEqual(row.status, 'valid',
                'top-up from a different source should be rejected; got status=' + row.status)
            assert.match(row.status, /SOURCE/i,
                'rejection reason should mention SOURCE; got: ' + row.status)
        })

        it('should reject a v2 top-up against a fresh (never-staked) pubkey', async function () {
            // Generate a NEW pubkey that no one has staked.
            let { publicKey } = crypto.generateKeyPairSync('ed25519')
            let freshPubkey = publicKey.export({ format: 'der', type: 'spki' }).subarray(12).toString('hex')

            let msg = "STAKE|2|500.00000000|" + freshPubkey
            let txHash = await transactionHelper.createAndSendTransaction(stakerAddr, msg)
            let row = await stakeHelper.waitForAnyStake({
                source:        stakerAddr.address,
                signingPubkey: freshPubkey,
                txHash:        txHash
            })
            assert(row, 'top-up row should be recorded (even when rejected)')
            assert.notStrictEqual(row.status, 'valid',
                'top-up against a fresh pubkey should be rejected; got status=' + row.status)
            assert.match(row.status, /no active stake to top up/i,
                'rejection reason should mention "no active stake to top up"; got: ' + row.status)
        })
    })

    describe('STAKE v1 — Input validation rejections', function () {
        // Each test broadcasts a malformed STAKE and asserts the indexer
        // records the row with the specific `invalid: ...` status. These
        // exercise the defensive validations in stake.js — the wallet's
        // StakeForm rejects most of these client-side, but the e2e suite
        // goes straight through the encoder so we get coverage on the
        // indexer's own guards.
        let validatorAddr = null

        before(async function () {
            validatorAddr = await cryptoHelper.getNewFundedAddress(
                "validator-input", COIN, NETWORK, null, "legacy", 0, 0.01
            )
            await gasHelper.ensureGasBalance(validatorAddr, '50')   // small balance for insufficient-funds test
        })

        it('should reject AMOUNT=0', async function () {
            let { publicKey } = crypto.generateKeyPairSync('ed25519')
            let pk = publicKey.export({ format: 'der', type: 'spki' }).subarray(12).toString('hex')
            let txHash = await transactionHelper.createAndSendTransaction(stakerAddr, "STAKE|1|0|" + pk)
            let row = await stakeHelper.waitForAnyStake({ source: stakerAddr.address, signingPubkey: pk, txHash })
            assert(row, 'rejected STAKE row should still be recorded')
            assert.notStrictEqual(row.status, 'valid')
            assert.match(row.status, /AMOUNT/i,
                'rejection should mention AMOUNT; got: ' + row.status)
        })

        it('should reject AMOUNT with too many decimals', async function () {
            let { publicKey } = crypto.generateKeyPairSync('ed25519')
            let pk = publicKey.export({ format: 'der', type: 'spki' }).subarray(12).toString('hex')
            // 9 fractional digits — exceeds the 8-digit cap
            let txHash = await transactionHelper.createAndSendTransaction(stakerAddr, "STAKE|1|10.123456789|" + pk)
            let row = await stakeHelper.waitForAnyStake({ source: stakerAddr.address, signingPubkey: pk, txHash })
            assert(row, 'rejected STAKE row should still be recorded')
            assert.notStrictEqual(row.status, 'valid')
            assert.match(row.status, /AMOUNT/i,
                'rejection should mention AMOUNT format; got: ' + row.status)
        })

        it('should reject a SIGNING_PUBKEY that is not 64 hex chars', async function () {
            // Short (32 chars) — should fail the format regex
            let shortPk = 'a'.repeat(32)
            let txHash = await transactionHelper.createAndSendTransaction(stakerAddr, "STAKE|1|100|" + shortPk)
            let row = await stakeHelper.waitForAnyStake({ source: stakerAddr.address, signingPubkey: shortPk, txHash })
            assert(row, 'rejected STAKE row should still be recorded')
            assert.notStrictEqual(row.status, 'valid')
            assert.match(row.status, /SIGNING_PUBKEY/i,
                'rejection should mention SIGNING_PUBKEY; got: ' + row.status)
        })

        it('should reject STAKE when AMOUNT exceeds source balance', async function () {
            let { publicKey } = crypto.generateKeyPairSync('ed25519')
            let pk = publicKey.export({ format: 'der', type: 'spki' }).subarray(12).toString('hex')
            // validatorAddr has 50 XCHAIN; ask for 10000.
            let txHash = await transactionHelper.createAndSendTransaction(validatorAddr, "STAKE|1|10000|" + pk)
            let row = await stakeHelper.waitForAnyStake({ source: validatorAddr.address, signingPubkey: pk, txHash })
            assert(row, 'rejected STAKE row should still be recorded')
            assert.notStrictEqual(row.status, 'valid')
            assert.match(row.status, /insufficient/i,
                'rejection should mention insufficient funds; got: ' + row.status)
        })
    })

    describe('UNSTAKE v0 — Rejection paths', function () {
        it('should reject UNSTAKE against an unknown pubkey', async function () {
            let { publicKey } = crypto.generateKeyPairSync('ed25519')
            let unknownPubkey = publicKey.export({ format: 'der', type: 'spki' }).subarray(12).toString('hex')

            let msg = "UNSTAKE|0|" + unknownPubkey
            let txHash = await transactionHelper.createAndSendTransaction(stakerAddr, msg)
            let row = await stakeHelper.waitForAnyUnstake({
                source:        stakerAddr.address,
                signingPubkey: unknownPubkey,
                txHash:        txHash
            })
            assert(row, 'unstake row should be recorded (even when rejected)')
            assert.notStrictEqual(row.status, 'valid',
                'UNSTAKE against an unknown pubkey should be rejected; got status=' + row.status)
            assert.match(row.status, /no active stake/i,
                'rejection reason should mention "no active stake"; got: ' + row.status)
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
