'use strict'

const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')
const ready = require('../../../scripts/wait-attest-mirror-stack')

const HELPER = path.join(__dirname, '..', '..', '..', 'scripts', 'wait-attest-mirror-stack.js')
const fakeMariadb = {
    createConnection: async () => ({
        query: async () => [{ n: ready.REQUIRED_INDEXER_TABLES.length }],
        end: async () => {},
    }),
}

function config (overrides) {
    return Object.assign({
        dbHost: '127.0.0.1', dbPort: 1, dbUser: 'root', dbPassword: 'secret',
        indexerDbName: 'indexer', indexerStatusUrl: 'http://indexer/status',
        minerHealthUrls: ['http://miner-a/', 'http://miner-b/'],
        requiredIndexerTables: ready.REQUIRED_INDEXER_TABLES,
        timeoutMs: 20, intervalMs: 0, sleep: async () => {},
        connect: async () => ({ query: async () => [{ n: ready.REQUIRED_INDEXER_TABLES.length }], end: async () => {} }),
        fetchImpl: async () => ({ ok: true }),
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
            'global.fetch = async () => ({ ok: true })',
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
            connect: async () => ({ query: async () => [{ n: ready.REQUIRED_INDEXER_TABLES.length - 1 }], end: async () => {} }),
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
        }, { mariadb: fakeMariadb }, async () => ({ ok: true }))
        assert.strictEqual(c.indexerStatusUrl, 'http://127.0.0.1:62005/status')
        assert.deepStrictEqual(c.minerHealthUrls,
            ['http://127.0.0.1:62006/', 'http://127.0.0.1:62015/', 'http://127.0.0.1:62021/'])
    })
})
