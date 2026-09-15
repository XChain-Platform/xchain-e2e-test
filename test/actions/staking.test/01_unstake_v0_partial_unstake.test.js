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
const transactionHelper = require('../../transactionHelper')

// Self-contained staker so run order in the outer suite cannot disturb
// the partial-unstake lifecycle asserted here.
let partialAddr = null
let partialPubkey = null

function requireBitcoin () {
    if (typeof COIN_CODE === 'undefined' || COIN_CODE !== 'BTC') this.skip()
}

async function setupPartialUnstake () {
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
}

async function movesRequestedAmountIntoCooldown () {
    let result = await stakeHelper.sendUnstakeV0(partialAddr, partialPubkey, '400')
    assert(result.unstake, 'partial unstake record should exist in DB')
    assert.strictEqual(result.unstake.status, 'valid', 'partial unstake should be valid')
    assert.strictEqual(Number(result.unstake.amount), 400,
        'unstake amount should be the requested partial, got ' + result.unstake.amount)
    assert(result.unstake.cooldown_end_block > 0, 'cooldown end block should be set')
}

async function rejectsUnstakeDuringHandoff () {
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
}

async function unstakesResidualAfterHandoff () {
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
}

async function rejectsOverAsk () {
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
}

function registerPartialUnstakeTests () {
    before(setupPartialUnstake)
    it('moves only the requested amount into cooldown', movesRequestedAmountIntoCooldown)
    it('rejects a second UNSTAKE during the residual\'s activation handoff window', rejectsUnstakeDuringHandoff)
    it('after the handoff the residual is unstakeable in full', unstakesResidualAfterHandoff)
    it('rejects an over-ask instead of clamping', rejectsOverAsk)
}

describe('Staking: STAKE, UNSTAKE, DELEGATE (capability model)', function () {
    before(requireBitcoin)
    describe('UNSTAKE v0: partial unstake', registerPartialUnstakeTests)
})
