const assert = require('assert')
const { mockAxiosPost, XChainEncoderConnector } = require('./support/environment')

void describe('XChainEncoderConnector', function () {

    it('[regression:p0] R-CONN-006 : createTx returns PSBT with correct encoding type', async function () {
        const psbtResult = { encoding: 'opreturn', psbt: 'deadbeef' }
        const stub = mockAxiosPost(psbtResult)
        try {
            const encoder = new XChainEncoderConnector('localhost', 3031)
            const result = await encoder.createTx(
                [], 'pubkey1', [], { action: 'ISSUE' }, null, null, false, null, 'changeAddr'
            )
            assert.strictEqual(result.encoding, 'opreturn')
            assert.strictEqual(result.psbt, 'deadbeef')
            const body = stub.firstCall.args[1]
            assert.strictEqual(body.method, 'create_tx')
            assert.strictEqual(body.params.pubkey, 'pubkey1')
            assert.strictEqual(body.params.change, 'changeAddr')
        } finally {
            stub.restore()
        }
    })

    it('[regression:p0] R-CONN-006b : ping returns true on success', async function () {
        const stub = mockAxiosPost(true)
        try {
            const encoder = new XChainEncoderConnector('localhost', 3031)
            const result = await encoder.ping()
            assert.strictEqual(result, true)
        } finally {
            stub.restore()
        }
    })

    it('[regression:p0] R-CONN-006c : createTx passes all 12 parameters correctly', async function () {
        const stub = mockAxiosPost({ encoding: 'opreturn', psbt: 'hex' })
        try {
            const encoder = new XChainEncoderConnector('localhost', 3031)
            await encoder.createTx(
                ['utxo1'], 'pk', [{ addr: 'a', value: 1000 }],
                'ISSUE|0|TOKC', Buffer.from('raw'), 546, true, 'P2SH',
                'changeAddr', 'p2shHash', 'p2shHex', 'compKey'
            )
            const params = stub.firstCall.args[1].params
            assert.deepStrictEqual(params.utxos, ['utxo1'])
            assert.strictEqual(params.pubkey, 'pk')
            assert.strictEqual(params.data, 'ISSUE|0|TOKC')
            assert.strictEqual(params.fee, 546)
            assert.strictEqual(params.rbf, true)
            assert.strictEqual(params.encoding, 'P2SH')
            assert.strictEqual(params.change, 'changeAddr')
            assert.strictEqual(params.p2shHash, 'p2shHash')
            assert.strictEqual(params.p2shHex, 'p2shHex')
            assert.strictEqual(params.compressedPubKey, 'compKey')
        } finally {
            stub.restore()
        }
    })
})
