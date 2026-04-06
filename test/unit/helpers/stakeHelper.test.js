'use strict'

const sinon = require('sinon')
const assert = require('assert')
const transactionHelper = require('../../transactionHelper')
const helper = require('../../helpers/stakeHelper')

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
        }
    })

    afterEach(() => sinon.restore())

    describe('sendStakeV0', () => {
        it('should build correct message', async () => {
            const result = await helper.sendStakeV0(addressInfo, '1', 'BTC,LTC', 'pubkey123')

            const msg = createTxStub.firstCall.args[1]
            assert.strictEqual(msg, 'STAKE|0|1|BTC,LTC|pubkey123')
            assert.strictEqual(result.txHash, 'abc123')
            assert.deepStrictEqual(result.stake, { id: 220 })
        })

        it('should use empty string for null chains', async () => {
            await helper.sendStakeV0(addressInfo, '2', null, 'pubkey456')

            const msg = createTxStub.firstCall.args[1]
            assert.strictEqual(msg, 'STAKE|0|2||pubkey456')
        })

        it('should call waitForStake with correct args', async () => {
            await helper.sendStakeV0(addressInfo, '1', 'BTC', 'pk')
            const waitArg = global.indexerDatabase.waitForStake.firstCall.args[0]
            assert.strictEqual(waitArg.tier, '1')
            assert.strictEqual(waitArg.source, 'addr1')
        })
    })

    describe('sendUnstakeV0', () => {
        it('should build correct message', async () => {
            const result = await helper.sendUnstakeV0(addressInfo, '1')

            const msg = createTxStub.firstCall.args[1]
            assert.strictEqual(msg, 'UNSTAKE|0|1')
            assert.strictEqual(result.txHash, 'abc123')
            assert.deepStrictEqual(result.unstake, { id: 221 })
        })

        it('should call waitForUnstake once', async () => {
            await helper.sendUnstakeV0(addressInfo, '2')
            assert(global.indexerDatabase.waitForUnstake.calledOnce)
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
        it('should build correct message', async () => {
            const result = await helper.sendRevokeDelegationV0(addressInfo, 'oldPubkey')

            const msg = createTxStub.firstCall.args[1]
            assert.strictEqual(msg, 'REVOKE_DELEGATION|0|oldPubkey')
            assert.strictEqual(result.txHash, 'abc123')
            assert.deepStrictEqual(result.revocation, { id: 222 })
        })

        it('should call waitForDelegation for revocation too', async () => {
            await helper.sendRevokeDelegationV0(addressInfo, 'pk')
            assert(global.indexerDatabase.waitForDelegation.calledOnce)
        })
    })

    describe('sendClaimRewardsV0', () => {
        it('should build correct message with no params', async () => {
            const result = await helper.sendClaimRewardsV0(addressInfo)

            const msg = createTxStub.firstCall.args[1]
            assert.strictEqual(msg, 'CLAIM_REWARDS|0')
            assert.strictEqual(result.txHash, 'abc123')
            assert.deepStrictEqual(result.claim, { id: 223 })
        })

        it('should call waitForRewardClaim with source address', async () => {
            await helper.sendClaimRewardsV0(addressInfo)
            assert(global.indexerDatabase.waitForRewardClaim.calledOnce)
            const waitArg = global.indexerDatabase.waitForRewardClaim.firstCall.args[0]
            assert.strictEqual(waitArg.source, 'addr1')
        })
    })
})
