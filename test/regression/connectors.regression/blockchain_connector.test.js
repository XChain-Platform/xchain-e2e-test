const assert = require('assert')
const { sinon, mockAxiosPost, BlockchainConnector } = require('./support/environment')

void describe('BlockchainConnector', function () {

    it('[regression:p0] R-CONN-001 : getNetworkInfo returns parsed JSON-RPC response', async function () {
        const node = new BlockchainConnector('localhost', 18443, 'rpcuser', 'rpcpass')
        const networkInfo = { version: 250000, subversion: '/Satoshi:25.0.0/' }

        const stub = mockAxiosPost(networkInfo)
        const result = await node.getNetworkInfo()
        assert.strictEqual(result.version, 250000)
        assert.strictEqual(result.subversion, '/Satoshi:25.0.0/')
        assert.strictEqual(stub.firstCall.args[0], 'http://localhost:18443')
        assert.strictEqual(stub.firstCall.args[1].method, 'getnetworkinfo')
        assert.ok(stub.firstCall.args[2].headers.Authorization.startsWith('Basic '))
    })

    it('[regression:p0] R-CONN-002 : broadcastTx sends raw hex and returns txid', async function () {
        const node = new BlockchainConnector('localhost', 18443, 'rpcuser', 'rpcpass')

        const stub = mockAxiosPost('abc123def456')
        const result = await node.broadcastTx('deadbeef')
        assert.strictEqual(result, 'abc123def456')
        assert.strictEqual(stub.firstCall.args[1].method, 'sendrawtransaction')
        assert.deepStrictEqual(stub.firstCall.args[1].params, ['deadbeef'])
    })

    it('[regression:p0] R-CONN-003 : waitForTx polls until transaction is confirmed', async function () {
        const node = new BlockchainConnector('localhost', 18443, 'rpcuser', 'rpcpass')
        let callCount = 0

        sinon.stub(node, 'getTransactionHex').callsFake(async () => {
            callCount++
            if (callCount < 2) throw new Error('not found')
            return 'aabb'
        })
        node.sleep = sinon.stub().resolves()

        const result = await node.waitForTx('txid123', 10000)
        assert.strictEqual(result, true)
        assert.ok(callCount >= 2, 'should have polled at least twice')
    })

    it('[regression:p0] R-CONN-011a : waitForTx returns false on timeout', async function () {
        const node = new BlockchainConnector('localhost', 18443, 'rpcuser', 'rpcpass')

        sinon.stub(node, 'getTransactionHex').rejects(new Error('not found'))
        node.sleep = sinon.stub().resolves()

        const result = await node.waitForTx('txid123', 100)
        assert.strictEqual(result, false)
    })

    it('[regression:p0] R-CONN-001b : constructor stores URL with Basic Auth credentials', function () {
        const node = new BlockchainConnector('myhost', 18443, 'user1', 'pass1')
        assert.strictEqual(node.url, 'http://myhost:18443')
        assert.strictEqual(node.rpcUser, 'user1')
        assert.strictEqual(node.rpcPassword, 'pass1')
    })
})
