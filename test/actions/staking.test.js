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
const cryptoHelper = require('../cryptoHelper')
const stakeHelper = require('../helpers/stakeHelper')
const gasHelper = require('../helpers/gasHelper')
const transactionHelper = require('../transactionHelper')

describe('Staking: STAKE, UNSTAKE, DELEGATE (capability model)', function () {

    let stakerAddr = null
    let signingPubkey = null

    before(async function () {
        // STAKE/UNSTAKE/DELEGATE are BTC-only by protocol design. The indexer
        // action handlers (xchain-indexer/src/actions/{stake,unstake,delegate}.js)
        // explicitly reject COIN !== 'BTC' with status='invalid: ACTION (BTC only)',
        // so these tests can only pass on the bitcoin chain.
        if (COIN_CODE !== 'BTC') {
            console.log('STAKE/UNSTAKE/DELEGATE are BTC-only, skipping on ' + COIN_CODE)
            this.skip()
            return
        }
        stakerAddr = await cryptoHelper.getNewFundedAddress(
            "staker", COIN, NETWORK, null, "legacy", 0, 1
        )
        // Ensure staker has enough XCHAIN for staking + top-up (default price min_stake = 1000)
        await gasHelper.ensureGasBalance(stakerAddr, '3000')

        // Generate an Ed25519 signing keypair (64 hex chars = 32 byte pubkey)
        let { publicKey } = crypto.generateKeyPairSync('ed25519')
        let spkiDer = publicKey.export({ format: 'der', type: 'spki' })
        signingPubkey = spkiDer.subarray(12).toString('hex') // Strip 12-byte SPKI prefix
    })

    describe('STAKE v1: Create a new stake', function () {
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

    describe('STAKE v2: Top up an existing stake', function () {
        it('should accept a top-up to the same pubkey from the same source', async function () {
            // Advance past the activation window so the v1 stake is observable as active for the v2 top-up check.
            // Pause the auto-miner so no stray mempool tx can add an extra block during the deterministic advance.
            await regtestMinerConnector.pauseMining()
            try {
                await regtestMinerConnector.generateBlocks(7)
            } finally {
                await regtestMinerConnector.resumeMining()
            }
            let result = await stakeHelper.sendStakeV2(stakerAddr, '500.00000000', signingPubkey)
            assert(result.stake, 'Top-up stake record should exist in DB')
            assert.strictEqual(result.stake.status, 'valid', 'Top-up status should be valid')
            assert.strictEqual(parseInt(result.stake.version), 2, 'Version should be 2 (top-up)')
        })
    })

    describe('UNSTAKE v0: Begin unstaking by pubkey', function () {
        it('should create an unstake record with cooldown', async function () {
            // Pause the auto-miner around this deterministic height advance.
            await regtestMinerConnector.pauseMining()
            try {
                await regtestMinerConnector.generateBlocks(7)
            } finally {
                await regtestMinerConnector.resumeMining()
            }
            let result = await stakeHelper.sendUnstakeV0(stakerAddr, signingPubkey)
            assert(result.unstake, 'Unstake record should exist in DB')
            assert.strictEqual(result.unstake.status, 'valid', 'Unstake status should be valid')
            assert(result.unstake.cooldown_end_block > 0, 'Cooldown end block should be set')
        })
    })

    describe('STAKE v2: Top-up validation rejections', function () {
        // Run order: this block lands AFTER the UNSTAKE block above,
        // but the source-mismatch test relies on the pubkey's stake being
        // VISIBLE-AS-ACTIVE at the time of the v2 broadcast. UNSTAKE doesn't
        // deactivate instantly; it sets deactivation_block = unstake_block
        // + ACTIVATION_DELAY_BLOCKS (6), giving the validator a grace
        // period to keep participating. So as long as fewer than 6 blocks
        // elapse between the UNSTAKE block and this v2 broadcast, the
        // stake is still queryable as active and the SOURCE check fires
        // correctly. Don't insert generateBlocks(7) before this block.
        let otherAddr = null

        before(async function () {
            // A second address that does NOT own the original pubkey's stake
            otherAddr = await cryptoHelper.getNewFundedAddress(
                "other-staker", COIN, NETWORK, null, "legacy", 0, 1
            )
            await gasHelper.ensureGasBalance(otherAddr, '2000')
        })

        it('should reject a v2 top-up from a different source address', async function () {
            // signingPubkey already has an active stake from stakerAddr
            // (within UNSTAKE's 6-block deactivation grace period, see
            // block comment above). otherAddr tries to top it up; the
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

    describe('UNSTAKE v0: Rejection paths', function () {
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

    describe('UNSTAKE v0: partial unstake', function () {
        // Self-contained staker so run order in the outer suite cannot disturb
        // the partial-unstake lifecycle asserted here.
        let partialAddr = null
        let partialPubkey = null

        before(async function () {
            partialAddr = await cryptoHelper.getNewFundedAddress(
                'partial-staker', COIN, NETWORK, null, 'legacy', 0, 1
            )
            await gasHelper.ensureGasBalance(partialAddr, '2000')

            let { publicKey } = crypto.generateKeyPairSync('ed25519')
            partialPubkey = publicKey.export({ format: 'der', type: 'spki' })
                .subarray(12).toString('hex')

            let stakeResult = await stakeHelper.sendStakeV1(partialAddr, '1000.00000000', partialPubkey)
            assert.strictEqual(stakeResult.stake.status, 'valid', 'setup stake should be valid')

            // Activate the stake. Pause the auto-miner around the deterministic
            // height advance.
            await regtestMinerConnector.pauseMining()
            try {
                await regtestMinerConnector.generateBlocks(7)
            } finally {
                await regtestMinerConnector.resumeMining()
            }
        })

        it('moves only the requested amount into cooldown', async function () {
            let result = await stakeHelper.sendUnstakeV0(partialAddr, partialPubkey, '400')
            assert(result.unstake, 'partial unstake record should exist in DB')
            assert.strictEqual(result.unstake.status, 'valid', 'partial unstake should be valid')
            assert.strictEqual(Number(result.unstake.amount), 400,
                'unstake amount should be the requested partial, got ' + result.unstake.amount)
            assert(result.unstake.cooldown_end_block > 0, 'cooldown end block should be set')
        })

        it('rejects a second UNSTAKE during the residual\'s activation handoff window', async function () {
            // The residual re-stake activates when the swept rows deactivate
            // (block + 6); until then the pubkey has no unstakeable rows.
            let msg = 'UNSTAKE|0|' + partialPubkey
            let txHash = await transactionHelper.createAndSendTransaction(partialAddr, msg)
            let row = await stakeHelper.waitForAnyUnstake({
                source:        partialAddr.address,
                signingPubkey: partialPubkey,
                txHash:        txHash
            })
            assert(row, 'the rejected unstake row should be recorded')
            assert.notStrictEqual(row.status, 'valid',
                'UNSTAKE inside the handoff window should be rejected; got status=' + row.status)
            assert.match(row.status, /no active stake|in progress/i,
                'rejection reason should mention the re-unstake guard; got: ' + row.status)
        })

        it('after the handoff the residual is unstakeable in full', async function () {
            // Advance past the residual row's activation_block. Pause the
            // auto-miner around the deterministic height advance.
            await regtestMinerConnector.pauseMining()
            try {
                await regtestMinerConnector.generateBlocks(7)
            } finally {
                await regtestMinerConnector.resumeMining()
            }

            let result = await stakeHelper.sendUnstakeV0(partialAddr, partialPubkey)
            assert.strictEqual(result.unstake.status, 'valid', 'residual unstake should be valid')
            assert.strictEqual(Number(result.unstake.amount), 600,
                'residual sweep should be the un-unstaked remainder, got ' + result.unstake.amount)
        })

        it('rejects an over-ask instead of clamping', async function () {
            // Fresh staker: everything above is already unstaking.
            let overAddr = await cryptoHelper.getNewFundedAddress(
                'overask-staker', COIN, NETWORK, null, 'legacy', 0, 1
            )
            await gasHelper.ensureGasBalance(overAddr, '2000')
            let { publicKey } = crypto.generateKeyPairSync('ed25519')
            let overPubkey = publicKey.export({ format: 'der', type: 'spki' })
                .subarray(12).toString('hex')
            let stakeResult = await stakeHelper.sendStakeV1(overAddr, '1000.00000000', overPubkey)
            assert.strictEqual(stakeResult.stake.status, 'valid', 'setup stake should be valid')
            await regtestMinerConnector.pauseMining()
            try {
                await regtestMinerConnector.generateBlocks(7)
            } finally {
                await regtestMinerConnector.resumeMining()
            }

            let msg = 'UNSTAKE|0|' + overPubkey + '|1000.00000001'
            let txHash = await transactionHelper.createAndSendTransaction(overAddr, msg)
            let row = await stakeHelper.waitForAnyUnstake({
                source:        overAddr.address,
                signingPubkey: overPubkey,
                txHash:        txHash
            })
            assert(row, 'the rejected unstake row should be recorded')
            assert.notStrictEqual(row.status, 'valid',
                'over-ask should be rejected, never clamped; got status=' + row.status)
            assert.match(row.status, /AMOUNT/i,
                'rejection reason should mention AMOUNT; got: ' + row.status)
        })
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

    describe('STAKE v1: Input validation rejections', function () {
        // Re-land of the four malformed-input cases: AMOUNT=0, AMOUNT with
        // more than 8 decimals, a malformed SIGNING_PUBKEY, and a stake larger than the source's
        // XCHAIN balance. Each maps to one reject string in
        // xchain-indexer/src/actions/stake.js.
        //
        // Deliberately last in the file: every case uses its own funded
        // address and its own fresh pubkey, and none of them mines, so
        // this block cannot disturb the activation-window ordering the
        // v2/UNSTAKE blocks above depend on. Keep it last.
        //
        // The indexer writes a stakes row for a rejected STAKE too
        // (createStake runs unconditionally, after the status is decided),
        // so each case reads the row back status-agnostically by txHash and
        // asserts the specific rejection reason. Rows are matched on
        // source + txHash rather than pubkey, because a malformed pubkey is
        // stored lowercased and truncated to 64 chars by getOrCreatePubkeyId.
        let badInputAddr = null

        before(async function () {
            badInputAddr = await cryptoHelper.getNewFundedAddress(
                'malformed-staker', COIN, NETWORK, null, 'legacy', 0, 1
            )
            await gasHelper.ensureGasBalance(badInputAddr, '2000')
        })

        // Fresh Ed25519 pubkey so no case can collide with an existing stake
        // and get rejected for the wrong reason ("already in use").
        function freshPubkey () {
            let { publicKey } = crypto.generateKeyPairSync('ed25519')
            return publicKey.export({ format: 'der', type: 'spki' })
                .subarray(12).toString('hex')
        }

        it('should reject a v1 stake with AMOUNT = 0', async function () {
            let msg = 'STAKE|1|0.00000000|' + freshPubkey()
            let txHash = await transactionHelper.createAndSendTransaction(badInputAddr, msg)
            let row = await stakeHelper.waitForAnyStake({
                source: badInputAddr.address,
                txHash: txHash
            })
            assert(row, 'the rejected stake row should be recorded')
            assert.notStrictEqual(row.status, 'valid',
                'a zero-amount stake should be rejected; got status=' + row.status)
            assert.match(row.status, /AMOUNT \(must be greater than 0\)/i,
                'rejection reason should be the greater-than-zero guard; got: ' + row.status)
        })

        it('should reject a v1 stake with AMOUNT carrying more than 8 decimals', async function () {
            // 9 decimal places: past XCHAIN's 8dp, so the AMOUNT format
            // regex rejects it before any balance lookup.
            let msg = 'STAKE|1|1000.123456789|' + freshPubkey()
            let txHash = await transactionHelper.createAndSendTransaction(badInputAddr, msg)
            let row = await stakeHelper.waitForAnyStake({
                source: badInputAddr.address,
                txHash: txHash
            })
            assert(row, 'the rejected stake row should be recorded')
            assert.notStrictEqual(row.status, 'valid',
                'an over-precision amount should be rejected; got status=' + row.status)
            assert.match(row.status, /AMOUNT \(format\)/i,
                'rejection reason should be the AMOUNT format guard; got: ' + row.status)
        })

        it('should reject a v1 stake with a malformed SIGNING_PUBKEY', async function () {
            // 64 characters so length alone passes, but the leading 'zz'
            // is not hex, so the Ed25519 pubkey pattern rejects it.
            let malformedPubkey = 'zz' + 'a'.repeat(62)
            let msg = 'STAKE|1|1000.00000000|' + malformedPubkey
            let txHash = await transactionHelper.createAndSendTransaction(badInputAddr, msg)
            let row = await stakeHelper.waitForAnyStake({
                source: badInputAddr.address,
                txHash: txHash
            })
            assert(row, 'the rejected stake row should be recorded')
            assert.notStrictEqual(row.status, 'valid',
                'a malformed pubkey should be rejected; got status=' + row.status)
            assert.match(row.status, /SIGNING_PUBKEY \(format\)/i,
                'rejection reason should be the pubkey format guard; got: ' + row.status)
        })

        it('should reject a v1 stake larger than the source XCHAIN balance', async function () {
            // Its own address, funded with far less XCHAIN than it stakes.
            // A separate address keeps the shortfall independent of what the
            // other cases in this block spent.
            let poorAddr = await cryptoHelper.getNewFundedAddress(
                'poor-staker', COIN, NETWORK, null, 'legacy', 0, 1
            )
            await gasHelper.ensureGasBalance(poorAddr, '10')

            let msg = 'STAKE|1|1000.00000000|' + freshPubkey()
            let txHash = await transactionHelper.createAndSendTransaction(poorAddr, msg)
            let row = await stakeHelper.waitForAnyStake({
                source: poorAddr.address,
                txHash: txHash
            })
            assert(row, 'the rejected stake row should be recorded')
            assert.notStrictEqual(row.status, 'valid',
                'a stake beyond the balance should be rejected; got status=' + row.status)
            assert.match(row.status, /insufficient funds \(STAKE\)/i,
                'rejection reason should cite insufficient funds; got: ' + row.status)
        })
    })
})
