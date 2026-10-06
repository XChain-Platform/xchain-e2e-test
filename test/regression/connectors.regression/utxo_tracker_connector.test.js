const assert = require('assert')
const { sinon, mockAxiosPost, XChainUtxoTrackerConnector } = require('./support/environment')

void describe('XChainUtxoTrackerConnector', function () {

    it('[regression:p0] R-CONN-004 : getUtxosFromAddress returns UTXO array', async function () {
        const tracker = new XChainUtxoTrackerConnector('localhost', 3030)
        const utxos = [{ txid: 'aabb', vout: 0, value: 100000 }]

        const stub = mockAxiosPost({ utxos })
        const result = await tracker.getUtxosFromAddress('addr1')
        assert.deepStrictEqual(result.utxos, utxos)
        assert.strictEqual(stub.firstCall.args[1].method, 'get_utxos')
        assert.strictEqual(stub.firstCall.args[1].params.address, 'addr1')
    })

    it('[regression:p0] R-CONN-005 : waitForUtxos polls until UTXOs appear', async function () {
        const tracker = new XChainUtxoTrackerConnector('localhost', 3030)
        let callCount = 0

        sinon.stub(tracker, 'getUtxosFromAddress').callsFake(async () => {
            callCount++
            const utxos = callCount >= 2 ? [{ txid: 'aa', vout: 0, value: 1000 }] : []
            return { utxos }
        })
        tracker.sleep = sinon.stub().resolves()

        const result = await tracker.waitForUtxos('addr1', 5000)
        assert.strictEqual(result, true)
        assert.ok(callCount >= 2)
    })

    it('[regression:p0] R-CONN-005b : waitForUtxos returns false on timeout', async function () {
        const tracker = new XChainUtxoTrackerConnector('localhost', 3030)

        sinon.stub(tracker, 'getUtxosFromAddress').resolves({ utxos: [] })
        tracker.sleep = sinon.stub().resolves()

        const result = await tracker.waitForUtxos('addr1', 100)
        assert.strictEqual(result, false)
    })

    it('[regression:p0] R-CONN-004b : constructor stores URL and port', function () {
        const tracker = new XChainUtxoTrackerConnector('myhost', 3030)
        assert.strictEqual(tracker.url, 'http://myhost:3030')
        assert.strictEqual(tracker.port, 3030)
    })
})
