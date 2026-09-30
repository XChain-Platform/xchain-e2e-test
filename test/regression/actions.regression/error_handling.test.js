const assert = require('assert')
const sinon  = require('sinon')

const { transactionHelper, issueHelper } = require('./support/environment')

void describe('error handling', function () {

    let createTxStub

    beforeEach(function () {
        createTxStub = sinon.stub(transactionHelper, 'createAndSendTransaction').resolves('txhash-test')

        global.indexerDatabase.waitForIssue  = sinon.stub().resolves({ tick: 'TOKR', status: 'valid' })
        global.indexerDatabase.waitForSend   = sinon.stub().resolves({ tick: 'TOKR', status: 'valid' })
        global.indexerDatabase.waitForCredit = sinon.stub().resolves({ tick: 'TOKR', amount: '100' })
        global.indexerDatabase.waitForDebit  = sinon.stub().resolves({ tick: 'TOKR', amount: '100' })
        global.indexerDatabase.waitForMint   = sinon.stub().resolves({ tick: 'TOKR', status: 'valid' })
    })

    afterEach(function () {
        sinon.restore()
    })

    const fakeAddr = { address: 'addr1', privateKey: Buffer.alloc(32, 1), publicKey: Buffer.alloc(33, 2) }

    it('[regression:p1] R-ACT-007: action helper propagates createAndSendTransaction errors', async function () {
        createTxStub.restore()
        sinon.stub(transactionHelper, 'createAndSendTransaction').rejects(new Error('encoder down'))

        await assert.rejects(
            () => issueHelper.sendIssueV0(fakeAddr, 'TOKR', 1000, 100, 8, 'desc', 50),
            /encoder down/
        )
    })
})
