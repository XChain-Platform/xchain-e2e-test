'use strict'

const assert = require('assert')
const ready = require('../../../scripts/wait-attest-mirror-stack')

function config (overrides) {
    return Object.assign({
        dbHost: '127.0.0.1', dbPort: 1, dbUser: 'root', dbPassword: 'secret',
        indexerDbName: 'indexer', indexerStatusUrl: 'http://indexer/status',
        minerHealthUrls: ['http://miner-a/', 'http://miner-b/'],
        timeoutMs: 20, intervalMs: 0, sleep: async () => {},
        connect: async () => ({ query: async () => [{ n: 1 }], end: async () => {} }),
        fetchImpl: async () => ({ ok: true }),
    }, overrides || {})
}

describe('attest-mirror stack readiness', function () {
    it('requires the issues schema, indexer status and every miner health endpoint', async function () {
        const calls = []
        const c = config({ fetchImpl: async (url, init) => { calls.push({ url, init }); return { ok: true } } })
        assert.strictEqual(await ready.stackReady(c), true)
        assert.deepStrictEqual(calls.map((call) => call.url),
            ['http://indexer/status', 'http://miner-a/', 'http://miner-b/'])
        assert.strictEqual(calls[1].init.method, 'POST')
        assert.match(calls[1].init.body, /"method":"health"/)
    })

    it('does not probe services until the indexer schema exists', async function () {
        let fetched = false
        const c = config({
            connect: async () => ({ query: async () => [{ n: 0 }], end: async () => {} }),
            fetchImpl: async () => { fetched = true; return { ok: true } },
        })
        assert.strictEqual(await ready.stackReady(c), false)
        assert.strictEqual(fetched, false)
    })

    it('waits through a miner race and completes only after health is green', async function () {
        let minerReads = 0
        const c = config({ fetchImpl: async (url) => {
            if (url.includes('miner')) minerReads++
            return { ok: !url.includes('miner') || minerReads > 1 }
        } })
        await ready.waitForStack(c)
        assert.ok(minerReads >= 2)
    })

    it('reads all three miner ports from a three-coin stack environment', function () {
        const c = ready.configFromEnv({
            DB_HOST_PORT: '62000', DB_PASSWORD: 'secret', INDEXER_HOST_PORT: '62005',
            MINER_HOST_PORT: '62006', LTC_REGTEST_MINER_API_PORT: '62015', DOGE_REGTEST_MINER_API_PORT: '62021',
        })
        assert.strictEqual(c.indexerStatusUrl, 'http://127.0.0.1:62005/status')
        assert.deepStrictEqual(c.minerHealthUrls,
            ['http://127.0.0.1:62006/', 'http://127.0.0.1:62015/', 'http://127.0.0.1:62021/'])
    })
})
