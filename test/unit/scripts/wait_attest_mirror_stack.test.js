'use strict'

const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')
const ready = require('../../../scripts/wait-attest-mirror-stack')

const HELPER = path.join(__dirname, '..', '..', '..', 'scripts', 'wait-attest-mirror-stack.js')
const HEALTHY_BODY = { jsonrpc: '2.0', id: 1, result: { status: 'success', reason: 'ok', wallet_ready: true, mining_started: true } }

function healthy () {
    return { ok: true, json: async () => HEALTHY_BODY }
}

const fakeMariadb = {
    createConnection: async () => ({
        query: async () => [{ n: ready.REQUIRED_INDEXER_TABLES.length }],
        end: async () => {},
    }),
}

function config (overrides) {
    return Object.assign({
        dbHost: '127.0.0.1', dbPort: 1, dbUser: 'root', dbPassword: 'secret',
        indexers: [{ coin: 'BTC', dbName: 'indexer', statusUrl: 'http://indexer/status' }],
        minerHealthUrls: ['http://miner-a/', 'http://miner-b/'],
        requiredIndexerTables: ready.REQUIRED_INDEXER_TABLES,
        timeoutMs: 20, intervalMs: 0, sleep: async () => {},
        connect: async () => ({ query: async () => [{ n: ready.REQUIRED_INDEXER_TABLES.length }], end: async () => {} }),
        fetchImpl: async () => healthy(),
    }, overrides || {})
}

describe('attest-mirror stack readiness', function () {
    let fixtureRoot

    beforeEach(function () {
        fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'attest-mirror-ready-'))
        fs.mkdirSync(path.join(fixtureRoot, 'scripts'))
        fs.copyFileSync(HELPER, path.join(fixtureRoot, 'scripts', 'wait-attest-mirror-stack.js'))
    })

    afterEach(function () {
        fs.rmSync(fixtureRoot, { recursive: true, force: true })
    })

    function runFixture (env) {
        return spawnSync(process.execPath, [path.join(fixtureRoot, 'scripts', 'wait-attest-mirror-stack.js')], {
            cwd: fixtureRoot,
            env: Object.assign({}, env),
            encoding: 'utf8',
        })
    }

    function installFakeMariadb () {
        const moduleDir = path.join(fixtureRoot, 'node_modules', 'mariadb')
        fs.mkdirSync(moduleDir, { recursive: true })
        fs.writeFileSync(path.join(moduleDir, 'index.js'), [
            "'use strict'",
            'global.fetch = async () => ({ ok: true, json: async () => (' + JSON.stringify(HEALTHY_BODY) + ') })',
            'module.exports = {',
            '    createConnection: async () => ({',
            '        query: async () => [{ n: 8 }],',
            '        end: async () => {},',
            '    }),',
            '}',
            '',
        ].join('\n'))
    }

    it('diagnoses a missing dependency in one line and exits non-zero without exposing credential values', function () {
        const credentialCanary = ['credential', 'canary', String(Date.now())].join('-')
        const result = runFixture({
            DB_PASSWORD: credentialCanary,
            SERVICE_PASS: credentialCanary,
            SERVICE_SECRET: credentialCanary,
        })
        const expected = 'Missing dependency "mariadb" in ' + fs.realpathSync(fixtureRoot) +
            '; install dependencies in that tree or point the driver at the staged tree that has them.\n'
        assert.strictEqual(result.status, 1)
        assert.strictEqual(result.stdout, '')
        assert.strictEqual(result.stderr, expected)
        assert.strictEqual(result.stderr.split('\n').filter(Boolean).length, 1)
        assert.ok(!result.stderr.includes(credentialCanary))
    })

    it('adds no diagnostic output and follows the ready path when dependencies resolve', function () {
        installFakeMariadb()
        const result = runFixture({
            DB_HOST_PORT: '62000', DB_PASSWORD: 'runtime-only', INDEXER_HOST_PORT: '62005',
            MINER_HOST_PORT: '62006', LTC_REGTEST_MINER_API_PORT: '62015', DOGE_REGTEST_MINER_API_PORT: '62021',
            LTC_INDEXER_HOST_PORT: '62014', DOGE_INDEXER_HOST_PORT: '62020',
        })
        assert.strictEqual(result.status, 0)
        assert.strictEqual(result.stderr, '')
        assert.strictEqual(result.stdout, 'attest-mirror stack ready: indexer schema and 3 miner health endpoint(s)\n')
    })

    it('does not declare readiness when stack configuration is absent', function () {
        installFakeMariadb()
        const result = runFixture({})
        assert.strictEqual(result.status, 1)
        assert.strictEqual(result.stdout, '')
        assert.strictEqual(result.stderr, 'missing stack readiness value dbPort\n')
    })

    it('requires the issues schema, indexer status and every miner health endpoint', async function () {
        const calls = []
        const c = config({ fetchImpl: async (url, init) => { calls.push({ url, init }); return healthy() } })
        assert.strictEqual(await ready.stackReady(c), true)
        assert.deepStrictEqual(calls.map((call) => call.url),
            ['http://indexer/status', 'http://miner-a/', 'http://miner-b/'])
        assert.strictEqual(calls[1].init.method, 'POST')
        assert.match(calls[1].init.body, /"method":"health"/)
    })

    it('trusts schemaReady without querying the pinned table fallback', async function () {
        let connections = 0
        const c = config({
            connect: async () => { connections++; throw new Error('fallback should not run') },
            fetchImpl: async (url) => url.includes('indexer')
                ? { ok: true, json: async () => ({ schemaReady: true }) }
                : healthy(),
        })
        assert.strictEqual(await ready.stackReady(c), true)
        assert.strictEqual(connections, 0)
    })

    it('trusts schemaReady false without accepting a complete pinned table set', async function () {
        let connections = 0
        const c = config({
            connect: async () => { connections++; return { query: async () => [{ n: ready.REQUIRED_INDEXER_TABLES.length }], end: async () => {} } },
            fetchImpl: async (url) => url.includes('indexer')
                ? { ok: true, json: async () => ({ schemaReady: false }) }
                : healthy(),
        })
        assert.strictEqual(await ready.stackReady(c), false)
        assert.strictEqual(connections, 0)
    })

    it('falls back to the pinned table set when /status has no schemaReady field', async function () {
        let connections = 0
        const c = config({
            connect: async () => {
                connections++
                return { query: async () => [{ n: ready.REQUIRED_INDEXER_TABLES.length }], end: async () => {} }
            },
        })
        assert.strictEqual(await ready.stackReady(c), true)
        assert.strictEqual(connections, 1)
    })

    it('waits through a miner race and completes only after health is green', async function () {
        let minerReads = 0
        const c = config({ fetchImpl: async (url) => {
            if (url.includes('miner')) minerReads++
            return !url.includes('miner') || minerReads > 1 ? healthy() : { ok: false, status: 503 }
        } })
        await ready.waitForStack(c)
        assert.ok(minerReads >= 2)
    })

    it('reads all three miner ports from a three-coin stack environment', function () {
        const c = ready.configFromEnv({
            DB_HOST_PORT: '62000', DB_PASSWORD: 'secret', INDEXER_HOST_PORT: '62005',
            MINER_HOST_PORT: '62006', LTC_REGTEST_MINER_API_PORT: '62015', DOGE_REGTEST_MINER_API_PORT: '62021',
            LTC_INDEXER_HOST_PORT: '62014', DOGE_INDEXER_HOST_PORT: '62020',
        }, { mariadb: fakeMariadb }, async () => ({ ok: true }))
        assert.strictEqual(c.indexers[0].statusUrl, 'http://127.0.0.1:62005/status')
        assert.deepStrictEqual(c.minerHealthUrls,
            ['http://127.0.0.1:62006/', 'http://127.0.0.1:62015/', 'http://127.0.0.1:62021/'])
    })
})

function minerReply (body) {
    return async (url) => url.includes('miner') ? { ok: true, json: async () => body } : healthy()
}

describe('attest-mirror stack readiness: the miner health body', function () {
    const notReady = [
        ['a JSON-RPC error from a miner older than health', { jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'Method not found' } }],
        ['a truthy result.error', { result: { error: 'boom' } }],
        ['a reply with no result', { jsonrpc: '2.0', id: 1 }],
        ['a degraded verdict', { result: { status: 'degraded', reason: 'wallet_not_ready' } }],
        ['a cold-start verdict before the wallet is ready', { result: { status: 'success', reason: 'starting', wallet_ready: false, mining_started: false } }],
    ]
    for (const [name, body] of notReady) {
        it('is not ready on HTTP 200 carrying ' + name, async function () {
            assert.strictEqual(await ready.stackReady(config({ fetchImpl: minerReply(body) })), false)
        })
    }

    it('is not ready when the miner body is not JSON', async function () {
        const fetchImpl = async (url) => url.includes('miner') ? { ok: true, json: async () => { throw new SyntaxError('bad') } } : healthy()
        assert.strictEqual(await ready.stackReady(config({ fetchImpl })), false)
    })

    it('is ready on a cold-start verdict once the wallet is ready and mining started', async function () {
        const body = { result: { status: 'success', reason: 'starting', wallet_ready: true, mining_started: true } }
        assert.strictEqual(await ready.stackReady(config({ fetchImpl: minerReply(body) })), true)
    })

    it('is ready while an operator has paused mining', async function () {
        const body = { result: { status: 'success', reason: 'paused', wallet_ready: true, mining_started: true } }
        assert.strictEqual(await ready.stackReady(config({ fetchImpl: minerReply(body) })), true)
    })

    it('names the miner and its reason when the wait times out', async function () {
        const fetchImpl = minerReply({ jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'Method not found' } })
        await assert.rejects(ready.waitForStack(config({ fetchImpl })), (error) => {
            assert.match(error.message, /^attest-mirror stack did not expose the indexer schema and healthy miners inside 20 ms/)
            assert.match(error.message, /miner http:\/\/miner-a\/: JSON-RPC error: Method not found/)
            return true
        })
    })
})

const THREE_COIN_ENV = Object.freeze({
    DB_HOST_PORT: '62000', DB_PASSWORD: 'secret-canary', INDEXER_HOST_PORT: '62005', MINER_HOST_PORT: '62006',
    LTC_INDEXER_HOST_PORT: '62014', LTC_MINER_HOST_PORT: '62015', DOGE_INDEXER_HOST_PORT: '62020', DOGE_MINER_HOST_PORT: '62021',
})

function envWith (overrides) {
    return ready.configFromEnv(Object.assign({}, THREE_COIN_ENV, overrides), { mariadb: fakeMariadb }, async () => healthy())
}

describe('attest-mirror stack readiness: every coin', function () {
    it('builds one indexer per coin with its own database and status URL', function () {
        assert.deepStrictEqual(envWith({}).indexers, [
            { coin: 'BTC', dbName: 'XChain_BTC_Regtest_Indexer', statusUrl: 'http://127.0.0.1:62005/status' },
            { coin: 'LTC', dbName: 'XChain_LTC_Regtest_Indexer', statusUrl: 'http://127.0.0.1:62014/status' },
            { coin: 'DOGE', dbName: 'XChain_DOGE_Regtest_Indexer', statusUrl: 'http://127.0.0.1:62020/status' },
        ])
    })

    it('refuses a missing second-coin indexer port by name without echoing the password', function () {
        assert.throws(() => envWith({ LTC_INDEXER_HOST_PORT: '' }), (error) => {
            assert.strictEqual(error.message, 'missing stack readiness value LTC indexerPort')
            assert.ok(!error.message.includes('secret-canary'))
            return true
        })
    })

    it('refuses a missing third-coin miner port instead of probing fewer miners', function () {
        assert.throws(() => envWith({ DOGE_MINER_HOST_PORT: '' }), /missing stack readiness value DOGE minerPort/)
    })

    it('accepts a single-coin stack when the coin list says so', function () {
        const c = envWith({ ATTEST_MIRROR_READY_COINS: 'btc', LTC_INDEXER_HOST_PORT: '', DOGE_MINER_HOST_PORT: '' })
        assert.deepStrictEqual(c.indexers.map((indexer) => indexer.coin), ['BTC'])
        assert.deepStrictEqual(c.minerHealthUrls, ['http://127.0.0.1:62006/'])
    })

    it('refuses an unknown coin in the coin list', function () {
        assert.throws(() => envWith({ ATTEST_MIRROR_READY_COINS: 'BTC,XYZ' }), /unknown stack readiness coin XYZ/)
    })

    it('uses the pinned-table fallback for a second coin whose status omits schemaReady', async function () {
        const fetched = []
        const c = config({
            indexers: [{ coin: 'BTC', dbName: 'btc', statusUrl: 'http://btc/status' }, { coin: 'LTC', dbName: 'ltc', statusUrl: 'http://ltc/status' }],
            connect: async () => ({ query: async (sql, args) => [{ n: args[0] === 'ltc' ? 1 : ready.REQUIRED_INDEXER_TABLES.length }], end: async () => {} }),
            fetchImpl: async (url) => { fetched.push(url); return healthy() },
        })
        assert.strictEqual(await ready.stackProblem(c), 'LTC indexer schema')
        assert.deepStrictEqual(fetched, ['http://btc/status', 'http://ltc/status'])
    })
})

describe('attest-mirror stack readiness: timing values', function () {
    for (const key of ['ATTEST_MIRROR_READY_TIMEOUT_MS', 'ATTEST_MIRROR_READY_INTERVAL_MS']) {
        for (const value of ['300s', 'abc', '0', '-5']) {
            it('refuses ' + key + '=' + value + ' instead of polling with NaN or zero', function () {
                assert.throws(() => envWith({ [key]: value }), new RegExp('invalid stack readiness value ' + key))
            })
        }
    }

    it('keeps the defaults when the timing values are unset', function () {
        const c = envWith({})
        assert.strictEqual(c.timeoutMs, 300000)
        assert.strictEqual(c.intervalMs, 3000)
    })

    it('refuses a database port that is not a port', function () {
        assert.throws(() => envWith({ DB_HOST_PORT: 'db' }), /invalid stack readiness value dbPort: not a port/)
    })
})
