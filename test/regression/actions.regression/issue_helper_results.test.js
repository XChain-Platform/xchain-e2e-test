const assert = require('assert')
const sinon  = require('sinon')

const { transactionHelper, issueHelper } = require('./support/environment')

void describe('issueHelper', function () {

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

    it('[regression:p1] R-ACT-001c: sendIssueV0 returns txHash, issue, and credit', async function () {
        const result = await issueHelper.sendIssueV0(fakeAddr, 'TOKR', 1000, 100, 8, 'desc', 50)

        assert.strictEqual(result.txHash, 'txhash-test')
        assert.ok(result.issue, 'should return issue row')
        assert.ok(result.credit, 'should return credit row')
    })

    it('[regression:p1] R-ACT-001d: sendIssueV1 constructs V1 message with tick and description', async function () {
        global.indexerDatabase.waitForIssue = sinon.stub().resolves({ tick: 'TOKR' })

        await issueHelper.sendIssueV1(fakeAddr, 'TOKR', 'new desc')

        const message = createTxStub.firstCall.args[1]
        assert.strictEqual(message, 'ISSUE|1|TOKR|new desc')
    })

    it('[regression:p1] R-ACT-005a: sendIssueV0 passes addressInfo as first arg to createAndSendTransaction', async function () {
        await issueHelper.sendIssueV0(fakeAddr, 'TOKR', 1000, 100, 8, 'desc', 50)

        assert.strictEqual(createTxStub.firstCall.args[0], fakeAddr)
    })
})
