'use strict'

const assert = require('assert')
const { indexerTip, waitForIndexerAtTip } = require('../helpers/indexerWait')

// Stub db whose tip advances by one per read, starting at `start`.
function stubDb(start, opts) {
    opts = opts || {}
    const s = { tip: start, reads: 0, released: 0 }
    s.getConnection = async () => ({
        query: async () => {
            s.reads++
            if (opts.fail) throw new Error('pool wedged')
            const h = s.tip
            if (opts.advance) s.tip++
            return [{ h }]
        },
        release: async () => { s.released++ }
    })
    return s
}

describe('indexerWait tip helpers', () => {
    it('indexerTip reads the max block and releases the connection', async () => {
        const db = stubDb(42)
        assert.strictEqual(await indexerTip(db), 42)
        assert.strictEqual(db.released, 1)
    })

    it('indexerTip treats an empty table as 0', async () => {
        const db = { getConnection: async () => ({ query: async () => [{ h: null }], release: async () => {} }) }
        assert.strictEqual(await indexerTip(db), 0)
    })

    it('waits for the node tip from the injected getter', async () => {
        const db = stubDb(8, { advance: true })
        const tip = await waitForIndexerAtTip({ db, nodeTip: async () => 10, intervalMs: 1, timeoutMs: 2000 })
        assert.strictEqual(tip, 10)
    })

    it('an explicit target wins and the node getter is not called', async () => {
        const db = stubDb(5)
        let called = false
        const tip = await waitForIndexerAtTip({ db, target: 3, nodeTip: async () => { called = true; return 99 }, intervalMs: 1 })
        assert.strictEqual(tip, 5)
        assert.strictEqual(called, false)
    })

    it('throws on timeout naming the reached tip', async () => {
        const db = stubDb(2)
        await assert.rejects(
            waitForIndexerAtTip({ db, target: 9, intervalMs: 1, timeoutMs: 30 }),
            /did not reach height 9.*tip 2/)
    })

    it('carries a failing read into the timeout message', async () => {
        const db = stubDb(0, { fail: true })
        await assert.rejects(
            waitForIndexerAtTip({ db, target: 1, intervalMs: 1, timeoutMs: 30 }),
            /last read failed: pool wedged/)
    })

    it('requires a target or a node getter', async () => {
        await assert.rejects(waitForIndexerAtTip({ db: stubDb(1) }), /pass opts.target or opts.nodeTip/)
    })
})
