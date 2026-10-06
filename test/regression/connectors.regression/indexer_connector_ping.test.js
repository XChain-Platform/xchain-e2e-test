const assert = require('assert')
const { sinon, axios, mockAxiosPost, XChainIndexerConnector } = require('./support/environment')

void describe('XChainIndexerConnector', function () {

    it('[regression:p0] R-CONN-007 : ping verifies indexer is reachable', async function () {
        const stub = mockAxiosPost(true)
        try {
            const indexer = new XChainIndexerConnector('localhost', 3032)
            const result = await indexer.ping()
            assert.strictEqual(result, true)
        } finally {
            stub.restore()
        }
    })

    it('[regression:p0] R-CONN-007b : ping returns false on failure', async function () {
        const stub = sinon.stub(axios, 'post').rejects(new Error('ECONNREFUSED'))
        try {
            const indexer = new XChainIndexerConnector('localhost', 3032)
            const result = await indexer.ping()
            assert.strictEqual(result, false)
        } finally {
            stub.restore()
        }
    })
})
