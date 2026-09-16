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


let stakerAddr = null
let signingPubkey = null

async function setupStaking () {
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
}

function createStakeTests () {
it('should stake XCHAIN and create a valid stake record', async function () {
    let result = await stakeHelper.sendStakeV1(stakerAddr, '1000.00000000', signingPubkey)
    assert(result.stake, 'Stake record should exist in DB')
    assert.strictEqual(result.stake.status, 'valid', 'Stake status should be valid')
    assert.strictEqual(parseInt(result.stake.version), 1, 'Version should be 1 (new stake)')
})
it('should reject a second v1 stake reusing the same pubkey', async function () {
    // Reusing an active pubkey for a fresh stake must be rejected, and this
    // case is driven through the NEGATIVE-path helper for a reason worth
    // stating: sendStakeV1 waits for a row at status=valid and THROWS when
    // none lands, so a rejection driven through it can only pass while the
    // rejection is broken. It failed for exactly that reason on the
    // 2026-09-06 bitcoin matrix leg, and the poll's own line said which of
    // the two explanations it was - `last indexer lag 0 blocks`, so the
    // indexer was current and had refused the duplicate, rather than a
    // venue that had fallen behind.
    // stake-teardown-ok: rejected for pubkey reuse, so it adds no stake and
    // joins no capability set; the pubkey's stake was booked by the
    // sendStakeV1 above that created it.
    let msg = "STAKE|1|500.00000000|" + signingPubkey
    let txHash = await transactionHelper.createAndSendTransaction(stakerAddr, msg)
    let row = await stakeHelper.waitForAnyStake({
        source:        stakerAddr.address,
        signingPubkey: signingPubkey,
        txHash:        txHash
    })
    assert(row, 'the duplicate-pubkey stake should be recorded even when rejected')
    assert.notStrictEqual(row.status, 'valid',
        'a second v1 stake on an already-active pubkey should not be valid; got status=' + row.status)
})
}

function topUpStakeTest () {
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
}

function beginUnstakeTest () {
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
}

function topUpSourceRejectionTest () {
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
    // stake-teardown-ok: rejected for source ownership, so it adds no
    // stake and joins no capability set; the pubkey's real stake was
    // booked by the sendStakeV1 that created it.
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

}

function topUpFreshKeyRejectionTest () {
it('should reject a v2 top-up against a fresh (never-staked) pubkey', async function () {
    // Generate a NEW pubkey that no one has staked.
    let { publicKey } = crypto.generateKeyPairSync('ed25519')
    let freshPubkey = publicKey.export({ format: 'der', type: 'spki' }).subarray(12).toString('hex')

    // stake-teardown-ok: rejected as "no active stake to top up", so no
    // stake row ever goes valid and nothing joins a capability set.
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
}

function unstakeRejectionTest () {
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
}

describe('Staking: STAKE, UNSTAKE, DELEGATE (capability model)', function () {
    before(setupStaking)
    describe('STAKE v1: Create a new stake', createStakeTests)
    describe('STAKE v2: Top up an existing stake', topUpStakeTest)
    describe('UNSTAKE v0: Begin unstaking by pubkey', beginUnstakeTest)
    describe('STAKE v2: Top-up validation rejections', topUpSourceRejectionTest)
    describe('STAKE v2: Top-up validation rejections', topUpFreshKeyRejectionTest)
    describe('UNSTAKE v0: Rejection paths', unstakeRejectionTest)
})
