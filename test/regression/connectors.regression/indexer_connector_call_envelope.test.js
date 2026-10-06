const assert = require('assert')
const { sinon, axios, mockAxiosPost, XChainIndexerConnector } = require('./support/environment')

void describe('XChainIndexerConnector', function () {

    // A truthy { error } envelope, a top-level JSON-RPC error and a falsy
    // result must each be handled distinctly; these pin the three legs.
    it('[regression:p1] R-CONN-013a : call throws on an { error } envelope inside result', async function () {
        const stub = mockAxiosPost({ error: 'unknown capability' })
        try {
            const indexer = new XChainIndexerConnector('localhost', 3032)
            await assert.rejects(
                () => indexer.getCapabilityValidators('cap', 10, 1),
                /unknown capability/
            )
        } finally {
            stub.restore()
        }
    })

    it('[regression:p1] R-CONN-013b : call throws on a top-level JSON-RPC error', async function () {
        const stub = sinon.stub(axios, 'post').resolves({
            data: { jsonrpc: '2.0', error: { code: -32601, message: 'Method not found' }, id: 1 }
        })
        try {
            const indexer = new XChainIndexerConnector('localhost', 3032)
            await assert.rejects(
                () => indexer.call('getstakesourcebypubkey', {}),
                /Method not found/
            )
        } finally {
            stub.restore()
        }
    })

    it('[regression:p1] R-CONN-013c : call preserves falsy-but-defined results', async function () {
        for (const falsy of [0, '', false]) {
            const stub = mockAxiosPost(falsy)
            try {
                const indexer = new XChainIndexerConnector('localhost', 3032)
                assert.strictEqual(await indexer.call('probe', {}), falsy)
            } finally {
                stub.restore()
            }
        }
    })

    it('[regression:p1] R-CONN-013d : call still returns null on a transport failure', async function () {
        const stub = sinon.stub(axios, 'post').rejects(new Error('ECONNREFUSED'))
        try {
            const indexer = new XChainIndexerConnector('localhost', 3032)
            assert.strictEqual(await indexer.call('probe', {}), null)
        } finally {
            stub.restore()
        }
    })
})
