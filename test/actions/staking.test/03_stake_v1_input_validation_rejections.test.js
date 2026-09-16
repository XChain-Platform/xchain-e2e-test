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

function requireBitcoin () {
    if (typeof COIN_CODE === 'undefined' || COIN_CODE !== 'BTC') this.skip()
}

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

async function setupBadInputAddress () {
    badInputAddr = await cryptoHelper.getNewFundedAddress(
        'malformed-staker', COIN, NETWORK, null, 'legacy', 0, 1
    )
    await gasHelper.ensureGasBalance(badInputAddr, '2000')
}

// Fresh Ed25519 pubkey so no case can collide with an existing stake
// and get rejected for the wrong reason ("already in use").
function freshPubkey () {
    let { publicKey } = crypto.generateKeyPairSync('ed25519')
    return publicKey.export({ format: 'der', type: 'spki' })
        .subarray(12).toString('hex')
}

async function rejectsZeroAmount () {
    // stake-teardown-ok: rejected on the greater-than-zero guard.
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
}

async function rejectsOverPrecisionAmount () {
    // 9 decimal places: past XCHAIN's 8dp, so the AMOUNT format
    // regex rejects it before any balance lookup.
    // stake-teardown-ok: rejected on the AMOUNT format guard.
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
}

async function rejectsMalformedPubkey () {
    // 64 characters so length alone passes, but the leading 'zz'
    // is not hex, so the Ed25519 pubkey pattern rejects it.
    let malformedPubkey = 'zz' + 'a'.repeat(62)
    // stake-teardown-ok: rejected on the SIGNING_PUBKEY format guard.
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
}

async function rejectsInsufficientBalance () {
    // Its own address, funded with far less XCHAIN than it stakes.
    // A separate address keeps the shortfall independent of what the
    // other cases in this block spent.
    let poorAddr = await cryptoHelper.getNewFundedAddress(
        'poor-staker', COIN, NETWORK, null, 'legacy', 0, 1
    )
    await gasHelper.ensureGasBalance(poorAddr, '10')

    // stake-teardown-ok: rejected for an insufficient XCHAIN balance.
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
}

function registerInputValidationTests () {
    before(setupBadInputAddress)
    it('should reject a v1 stake with AMOUNT = 0', rejectsZeroAmount)
    it('should reject a v1 stake with AMOUNT carrying more than 8 decimals', rejectsOverPrecisionAmount)
    it('should reject a v1 stake with a malformed SIGNING_PUBKEY', rejectsMalformedPubkey)
    it('should reject a v1 stake larger than the source XCHAIN balance', rejectsInsufficientBalance)
}

describe('Staking: STAKE, UNSTAKE, DELEGATE (capability model)', function () {
    before(requireBitcoin)
    describe('STAKE v1: Input validation rejections', registerInputValidationTests)
})
