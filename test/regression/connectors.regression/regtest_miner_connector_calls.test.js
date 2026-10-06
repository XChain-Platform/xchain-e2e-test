const assert = require('assert')
const { sinon, axios, mockAxiosPost, RegtestMinerConnector } = require('./support/environment')

void describe('RegtestMinerConnector', function () {

    it('[regression:p0] R-CONN-010 : sendFunds returns funding txid', async function () {
        const stub = mockAxiosPost('txid-funded-001')
        try {
            const miner = new RegtestMinerConnector('localhost', 3033)
            const result = await miner.sendFunds('addr1', 1.0)
            assert.strictEqual(result, 'txid-funded-001')
            const body = stub.firstCall.args[1]
            assert.strictEqual(body.method, 'send_funds')
            assert.strictEqual(body.params.address, 'addr1')
            assert.strictEqual(body.params.amount, 1.0)
        } finally {
            stub.restore()
        }
    })

    it('[regression:p0] R-CONN-010b : setMiningTime sends correct params', async function () {
        const stub = mockAxiosPost(true)
        try {
            const miner = new RegtestMinerConnector('localhost', 3033)
            const result = await miner.setMiningTime(1000, 1000)
            assert.strictEqual(result, true)
            const body = stub.firstCall.args[1]
            assert.strictEqual(body.method, 'set_mining_time')
            assert.strictEqual(body.params.max_time, 1000)
            assert.strictEqual(body.params.tx_added_time, 1000)
        } finally {
            stub.restore()
        }
    })

    it('[regression:p0] R-CONN-010c : setDefaultMiningTime calls correct RPC method', async function () {
        const stub = mockAxiosPost(true)
        try {
            const miner = new RegtestMinerConnector('localhost', 3033)
            const result = await miner.setDefaultMiningTime()
            assert.strictEqual(result, true)
            assert.strictEqual(stub.firstCall.args[1].method, 'set_default_mining_time')
        } finally {
            stub.restore()
        }
    })

    it('[regression:p0] R-CONN-011b : ping returns false when service is unreachable', async function () {
        const stub = sinon.stub(axios, 'post').rejects(new Error('ECONNREFUSED'))
        try {
            const miner = new RegtestMinerConnector('localhost', 3033)
            const result = await miner.ping()
            assert.strictEqual(result, false)
        } finally {
            stub.restore()
        }
    })
})
