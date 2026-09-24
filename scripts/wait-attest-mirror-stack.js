'use strict'

const path = require('path')

const DEPENDENCY_ROOT = path.resolve(__dirname, '..')
const REQUIRED_DEPENDENCIES = Object.freeze(['mariadb'])

const REQUIRED_INDEXER_TABLES = Object.freeze([
    'actions', 'index_addresses', 'index_statuses', 'index_tickers', 'index_transactions',
    'issues', 'price_snapshots', 'transactions',
])

function loadDependencies (resolveDependency, loadDependency) {
    const resolve = resolveDependency || require.resolve
    const load = loadDependency || require
    const dependencies = {}
    for (const name of REQUIRED_DEPENDENCIES) {
        try {
            const resolved = resolve(name, { paths: [DEPENDENCY_ROOT] })
            dependencies[name] = load(resolved)
        } catch (error) {
            if (!error || error.code !== 'MODULE_NOT_FOUND') throw error
            throw new Error('Missing dependency "' + name + '" in ' + DEPENDENCY_ROOT +
                '; install dependencies in that tree or point the driver at the staged tree that has them.')
        }
    }
    return dependencies
}

function sleep (ms) {
    return new Promise((resolve) => setTimeout(resolve, ms))
}

async function responseOk (url, init, fetchImpl) {
    try {
        const response = await fetchImpl(url, init)
        return !!response && response.ok
    } catch (_) {
        return false
    }
}

async function indexerSchemaReady (config) {
    let connection = null
    try {
        connection = await config.connect({
            host: config.dbHost,
            port: config.dbPort,
            user: config.dbUser,
            password: config.dbPassword,
        })
        const placeholders = config.requiredIndexerTables.map(() => '?').join(', ')
        const rows = await connection.query(
            'SELECT COUNT(DISTINCT table_name) AS n FROM information_schema.tables ' +
            'WHERE table_schema = ? AND table_name IN (' + placeholders + ')',
            [config.indexerDbName, ...config.requiredIndexerTables])
        return Number(rows[0].n) === config.requiredIndexerTables.length
    } catch (_) {
        return false
    } finally {
        if (connection) await connection.end().catch(() => {})
    }
}

async function stackReady (config) {
    if (!await indexerSchemaReady(config)) return false
    if (!await responseOk(config.indexerStatusUrl, undefined, config.fetchImpl)) return false
    for (const url of config.minerHealthUrls) {
        if (!await responseOk(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', method: 'health', id: 1 }),
        }, config.fetchImpl)) return false
    }
    return true
}

async function waitForStack (config) {
    const deadline = Date.now() + config.timeoutMs
    do {
        if (await stackReady(config)) return
        await config.sleep(config.intervalMs)
    } while (Date.now() <= deadline)
    throw new Error('attest-mirror stack did not expose the indexer schema and healthy miners inside ' + config.timeoutMs + ' ms')
}

function configFromEnv (env, dependencies, fetchImpl) {
    const host = env.ATTEST_MIRROR_STACK_HOST || '127.0.0.1'
    const minerPorts = [env.BTC_REGTEST_MINER_API_PORT || env.REGTEST_MINER_API_PORT || env.MINER_HOST_PORT,
        env.LTC_REGTEST_MINER_API_PORT, env.DOGE_REGTEST_MINER_API_PORT].filter(Boolean)
    const required = {
        dbPort: env.DB_HOST_PORT || env.DATABASE_PORT,
        dbPassword: env.DB_PASSWORD || env.INDEXER_DB_PASS,
        indexerPort: env.BTC_INDEXER_API_PORT || env.INDEXER_API_PORT || env.INDEXER_HOST_PORT,
    }
    for (const [key, value] of Object.entries(required)) {
        if (!value) throw new Error('missing stack readiness value ' + key)
    }
    if (minerPorts.length === 0) throw new Error('missing stack readiness value minerPort')
    return {
        dbHost: host,
        dbPort: Number(required.dbPort),
        dbUser: env.INDEXER_DB_USER || 'root',
        dbPassword: required.dbPassword,
        indexerDbName: env.BTC_INDEXER_DB_NAME || env.INDEXER_DB_NAME || 'XChain_BTC_Regtest_Indexer',
        requiredIndexerTables: REQUIRED_INDEXER_TABLES,
        indexerStatusUrl: 'http://' + host + ':' + required.indexerPort + '/status',
        minerHealthUrls: minerPorts.map((port) => 'http://' + host + ':' + port + '/'),
        timeoutMs: Number(env.ATTEST_MIRROR_READY_TIMEOUT_MS || 300000),
        intervalMs: Number(env.ATTEST_MIRROR_READY_INTERVAL_MS || 3000),
        connect: dependencies.mariadb.createConnection,
        fetchImpl: fetchImpl,
        sleep,
    }
}

async function main (runtime) {
    const context = runtime || {}
    const dependencies = loadDependencies(context.resolveDependency, context.loadDependency)
    const config = configFromEnv(context.env || process.env, dependencies, context.fetchImpl || fetch)
    await waitForStack(config)
    const stdout = context.stdout || process.stdout
    stdout.write('attest-mirror stack ready: indexer schema and ' + config.minerHealthUrls.length + ' miner health endpoint(s)\n')
}

module.exports = {
    DEPENDENCY_ROOT,
    REQUIRED_DEPENDENCIES,
    REQUIRED_INDEXER_TABLES,
    loadDependencies,
    responseOk,
    indexerSchemaReady,
    stackReady,
    waitForStack,
    configFromEnv,
    main,
}

if (require.main === module) {
    main().catch((error) => {
        process.stderr.write(error.message + '\n')
        process.exitCode = 1
    })
}
