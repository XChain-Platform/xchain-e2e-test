const assert = require('assert')
const { sinon, axios, mockAxiosPost, XChainHubConnector } = require('./support/environment')

describe('XChainHubConnector', function () {

    it('[regression:p0] R-CONN-008 : getAllConfig returns full service configuration', async function () {
        const config = { bitcoin: { regtest: { node: { host: 'n' } } } }
        const stub = mockAxiosPost(config)
        try {
            const hub = new XChainHubConnector(['http://localhost:10000'])
            const result = await hub.getAllConfig()
            assert.deepStrictEqual(result, config)
        } finally {
            stub.restore()
        }
    })

    it('[regression:p0] R-CONN-009 : multi-endpoint failover tries all validators', async function () {
        const callOrder = []
        const stub = sinon.stub(axios, 'post').callsFake(async (url) => {
            callOrder.push(url)
            if (url === 'http://hub1:10000') {
                throw new Error('ECONNREFUSED')
            }
            return { data: { jsonrpc: '2.0', result: 'ok', id: 1 } }
        })
        try {
            const hub = new XChainHubConnector(['http://hub1:10000', 'http://hub2:10000'])
            const result = await hub.ping()
            assert.strictEqual(result, true)
            assert.strictEqual(callOrder[0], 'http://hub1:10000')
            assert.strictEqual(callOrder[1], 'http://hub2:10000')
        } finally {
            stub.restore()
        }
    })

    it('[regression:p0] R-CONN-009b : _call returns null when all endpoints fail', async function () {
        const stub = sinon.stub(axios, 'post').rejects(new Error('ECONNREFUSED'))
        try {
            const hub = new XChainHubConnector(['http://hub1:10000', 'http://hub2:10000'])
            const result = await hub.ping()
            assert.strictEqual(result, false)
        } finally {
            stub.restore()
        }
    })

})
