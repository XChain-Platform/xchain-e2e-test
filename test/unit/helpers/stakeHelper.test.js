'use strict'

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const sinon = require('sinon')
const assert = require('assert')
const transactionHelper = require('../../transactionHelper')
const helper = require('../../helpers/stakeHelper')
const stakeTeardown = require('../../helpers/stakeTeardown')

const addressInfo = { address: 'addr1', privateKey: Buffer.alloc(32), publicKey: Buffer.alloc(33) }

describe('stakeHelper', () => {
    let createTxStub

    beforeEach(() => {
        createTxStub = sinon.stub(transactionHelper, 'createAndSendTransaction').resolves('abc123')
        global.indexerDatabase = {
            waitForStake: sinon.stub().resolves({ id: 220 }),
            waitForUnstake: sinon.stub().resolves({ id: 221 }),
            waitForDelegation: sinon.stub().resolves({ id: 222 }),
            waitForRewardClaim: sinon.stub().resolves({ id: 223 }),
            checkRewardClaim: sinon.stub().resolves({ id: 224, status: 'invalid: no active stake' }),
        }
    })

    afterEach(() => sinon.restore())

    describe('sendStakeV1 (new stake)', () => {
        it('should build correct message', async () => {
            const result = await helper.sendStakeV1(addressInfo, '1000.00000000', 'pubkey123')

            const msg = createTxStub.firstCall.args[1]
            assert.strictEqual(msg, 'STAKE|1|1000.00000000|pubkey123')
            assert.strictEqual(result.txHash, 'abc123')
            assert.deepStrictEqual(result.stake, { id: 220 })
        })

        it('should call waitForStake with source + signingPubkey + txHash', async () => {
            await helper.sendStakeV1(addressInfo, '500', 'pubkey456')
            const waitArg = global.indexerDatabase.waitForStake.firstCall.args[0]
            assert.strictEqual(waitArg.source, 'addr1')
            assert.strictEqual(waitArg.signingPubkey, 'pubkey456')
            assert.strictEqual(waitArg.txHash, 'abc123')
            assert.strictEqual(waitArg.status, 'valid')
        })
    })

    describe('sendStakeV2 (top-up)', () => {
        it('should build correct message', async () => {
            const result = await helper.sendStakeV2(addressInfo, '250.00000000', 'pubkey123')

            const msg = createTxStub.firstCall.args[1]
            assert.strictEqual(msg, 'STAKE|2|250.00000000|pubkey123')
            assert.deepStrictEqual(result.stake, { id: 220 })
        })
    })

    describe('sendUnstakeV0', () => {
        it('should build correct message', async () => {
            const result = await helper.sendUnstakeV0(addressInfo, 'pubkey789')

            const msg = createTxStub.firstCall.args[1]
            assert.strictEqual(msg, 'UNSTAKE|0|pubkey789')
            assert.strictEqual(result.txHash, 'abc123')
            assert.deepStrictEqual(result.unstake, { id: 221 })
        })

        it('should append the optional partial amount', async () => {
            await helper.sendUnstakeV0(addressInfo, 'pubkey789', '250.5')
            const msg = createTxStub.firstCall.args[1]
            assert.strictEqual(msg, 'UNSTAKE|0|pubkey789|250.5')
        })

        it('should call waitForUnstake with source + signingPubkey', async () => {
            await helper.sendUnstakeV0(addressInfo, 'pubkey789')
            const waitArg = global.indexerDatabase.waitForUnstake.firstCall.args[0]
            assert.strictEqual(waitArg.source, 'addr1')
            assert.strictEqual(waitArg.signingPubkey, 'pubkey789')
        })
    })

    // A fixture STAKE joins the venue's real capability set, so every
    // stake this helper creates has to be booked for release and every full
    // UNSTAKE has to discharge it. Wiring, not policy - the policy itself is
    // covered in test/unit/helpers/stakeTeardown.test.js.
    describe('fixture-stake teardown wiring', () => {
        beforeEach(() => stakeTeardown.reset())
        afterEach(() => stakeTeardown.reset())

        it('books a v1 stake for release', async () => {
            await helper.sendStakeV1(addressInfo, '1000.00000000', 'pubkeyTD1')
            const out = stakeTeardown.outstanding()
            assert.strictEqual(out.length, 1)
            assert.strictEqual(out[0].signingPubkey, 'pubkeyTD1')
            assert.strictEqual(out[0].source, 'addr1')
        })

        it('books a v2 top-up onto the same debt', async () => {
            await helper.sendStakeV1(addressInfo, '1000.00000000', 'pubkeyTD2')
            await helper.sendStakeV2(addressInfo, '500.00000000', 'pubkeyTD2')
            assert.strictEqual(stakeTeardown.outstanding().length, 1)
        })

        it('a full UNSTAKE discharges it, a partial one does not', async () => {
            await helper.sendStakeV1(addressInfo, '1000.00000000', 'pubkeyTD3')
            await helper.sendUnstakeV0(addressInfo, 'pubkeyTD3', '250')
            assert.strictEqual(stakeTeardown.outstanding().length, 1,
                'the residual is re-staked, so the pubkey is still a member')
            await helper.sendUnstakeV0(addressInfo, 'pubkeyTD3')
            assert.strictEqual(stakeTeardown.outstanding().length, 0)
        })

        it('books a contract stake under its own contract/tick, and its UNSTAKE clears it', async () => {
            global.indexerDatabase.waitForContractStake = sinon.stub().resolves({ id: 230 })
            global.indexerDatabase.waitForContractUnstake = sinon.stub().resolves({ id: 231 })

            await helper.sendStakeV3(addressInfo, '10.00000000', 'pubkeyTD4', 42, 'TOK')
            const out = stakeTeardown.outstanding()
            assert.strictEqual(out.length, 1)
            assert.strictEqual(out[0].contractIndex, 42)
            assert.strictEqual(out[0].tick, 'TOK')

            await helper.sendUnstakeV1(addressInfo, 'pubkeyTD4', 42, 'TOK')
            assert.strictEqual(stakeTeardown.outstanding().length, 0)
        })
    })

    describe('sendDelegateV0', () => {
        it('should build correct message', async () => {
            const result = await helper.sendDelegateV0(addressInfo, 'newPubkey789')

            const msg = createTxStub.firstCall.args[1]
            assert.strictEqual(msg, 'DELEGATE|0|newPubkey789')
            assert.strictEqual(result.txHash, 'abc123')
            assert.deepStrictEqual(result.delegation, { id: 222 })
        })

        it('should call waitForDelegation once', async () => {
            await helper.sendDelegateV0(addressInfo, 'pk')
            assert(global.indexerDatabase.waitForDelegation.calledOnce)
        })
    })

    describe('sendRevokeDelegationV0', () => {
        it('should build correct message (DELEGATE v2 capability revoke)', async () => {
            const result = await helper.sendRevokeDelegationV0(addressInfo, 'oldPubkey')

            const msg = createTxStub.firstCall.args[1]
            assert.strictEqual(msg, 'DELEGATE|2|oldPubkey')
            assert.strictEqual(result.txHash, 'abc123')
            assert.deepStrictEqual(result.revocation, { id: 222 })
        })

        it('should call waitForDelegation for revocation too', async () => {
            await helper.sendRevokeDelegationV0(addressInfo, 'pk')
            assert(global.indexerDatabase.waitForDelegation.calledOnce)
        })
    })

    describe('sendCollectV0', () => {
        it('should build correct message with no params', async () => {
            const result = await helper.sendCollectV0(addressInfo)

            const msg = createTxStub.firstCall.args[1]
            assert.strictEqual(msg, 'COLLECT|0')
            assert.strictEqual(result.txHash, 'abc123')
            assert.deepStrictEqual(result.claim, { id: 223 })
        })

        it('should append the optional partial amount', async () => {
            await helper.sendCollectV0(addressInfo, '10')
            const msg = createTxStub.firstCall.args[1]
            assert.strictEqual(msg, 'COLLECT|0|10')
        })

        it('should call waitForRewardClaim with source address', async () => {
            await helper.sendCollectV0(addressInfo)
            assert(global.indexerDatabase.waitForRewardClaim.calledOnce)
            const waitArg = global.indexerDatabase.waitForRewardClaim.firstCall.args[0]
            assert.strictEqual(waitArg.source, 'addr1')
        })
    })

    describe('sendCollectInvalid (expected-invalid COLLECT)', () => {
        it('should build the same COLLECT|0 message', async () => {
            const result = await helper.sendCollectInvalid(addressInfo)

            const msg = createTxStub.firstCall.args[1]
            assert.strictEqual(msg, 'COLLECT|0')
            assert.strictEqual(result.txHash, 'abc123')
        })

        it('should poll reward_claims status-agnostically by source + txHash', async () => {
            const result = await helper.sendCollectInvalid(addressInfo)

            // Reads the row back via checkRewardClaim (any status), NOT the
            // valid-only waitForRewardClaim, so a rejected claim is observable.
            assert(global.indexerDatabase.checkRewardClaim.called)
            assert(global.indexerDatabase.waitForRewardClaim.notCalled)
            const arg = global.indexerDatabase.checkRewardClaim.firstCall.args[0]
            assert.strictEqual(arg.source, 'addr1')
            assert.strictEqual(arg.txHash, 'abc123')
            assert.deepStrictEqual(result.claim, { id: 224, status: 'invalid: no active stake' })
        })
    })
})
