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

    it('[regression:p1] R-ACT-001: sendIssueV0 constructs correct pipe-delimited message', async function () {
        await issueHelper.sendIssueV0(fakeAddr, 'MYTOKEN', 1000, 100, 8, 'Test', 50)

        assert.ok(createTxStub.calledOnce)
        const message = createTxStub.firstCall.args[1]
        assert.ok(message.startsWith('ISSUE|0|'), 'should start with ISSUE|0|')
        assert.ok(message.includes('MYTOKEN'), 'should include tick')
        assert.ok(message.includes('1000'), 'should include maxSupply')
        assert.ok(message.includes('100'), 'should include maxMint')
        assert.ok(message.includes('8'), 'should include decimals')
        assert.ok(message.includes('Test'), 'should include description')
        assert.ok(message.includes('50'), 'should include mintSupply')
    })

    it('[regression:p1] R-ACT-001b: sendIssueV0 calls waitForIssue and waitForCredit', async function () {
        await issueHelper.sendIssueV0(fakeAddr, 'TOKR', 1000, 100, 8, 'desc', 50)

        assert.ok(global.indexerDatabase.waitForIssue.calledOnce, 'waitForIssue should be called')
        assert.ok(global.indexerDatabase.waitForCredit.calledOnce, 'waitForCredit should be called')

        // Verify filter args
        const issueFilter = global.indexerDatabase.waitForIssue.firstCall.args[0]
        assert.strictEqual(issueFilter.source, 'addr1')
        assert.strictEqual(issueFilter.tick, 'TOKR')
        assert.strictEqual(issueFilter.status, 'valid')
    })
})
