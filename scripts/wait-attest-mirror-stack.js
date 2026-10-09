'use strict'

const path = require('path')

const DEPENDENCY_ROOT = path.resolve(__dirname, '..')
const REQUIRED_DEPENDENCIES = Object.freeze(['mariadb'])

const REQUIRED_INDEXER_TABLES = Object.freeze([
    'actions', 'index_addresses', 'index_statuses', 'index_tickers', 'index_transactions',
    'issues', 'price_snapshots', 'transactions',
])

const COIN_CODES = Object.freeze(['BTC', 'LTC', 'DOGE'])

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

function rpcErrorText (error) {
    const text = typeof error === 'object' ? (error.message || JSON.stringify(error)) : String(error)
    return text.slice(0, 200)
}

// Judge a miner health reply by the miner client's own contract: failure arrives inside an HTTP 200 body.
function minerBodyProblem (body) {
    if (!body || typeof body !== 'object') return 'invalid JSON'
    // A top-level error is an unknown method (a miner older than health) or a handler crash.
    if (body.error !== undefined && body.error !== null) return 'JSON-RPC error: ' + rpcErrorText(body.error)
    const result = body.result
    // A reply with no result confirms nothing, so it is not a healthy miner.
    if (result === undefined || result === null) return 'missing result'
    if (typeof result !== 'object') return 'unexpected result'
    // A truthy result.error is how the miner's handlers report their own failures.
    if (result.error) return 'result error: ' + rpcErrorText(result.error)
    if (result.status === 'degraded') return 'degraded: ' + result.reason
    // The miner's cold-start grace answers healthy before its wallet is ready; seeding needs the wallet.
    if (result.reason === 'starting' && !(result.wallet_ready === true && result.mining_started === true)) {
        return 'starting: wallet not ready'
    }
    return ''
}

// Probe one miner's health method and name what is wrong, or return '' when it is usable.
async function minerProblem (url, fetchImpl) {
    let response
    try {
        response = await fetchImpl(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', method: 'health', id: 1 }),
        })
    } catch (_) {
        return 'unreachable'
    }
    if (!response || !response.ok) return 'HTTP ' + (response ? response.status : 'no response')
    let body
    try {
        body = await response.json()
    } catch (_) {
        return 'invalid JSON'
    }
    return minerBodyProblem(body)
}

async function indexerSchemaReady (config, dbName) {
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
            [dbName, ...config.requiredIndexerTables])
        return Number(rows[0].n) === config.requiredIndexerTables.length
    } catch (_) {
        return false
    } finally {
        if (connection) await connection.end().catch(() => {})
    }
}

async function indexerProblem (config, indexer) {
    let response
    try {
        response = await config.fetchImpl(indexer.statusUrl)
    } catch (_) {
        return ' /status'
    }
    if (!response || !response.ok) return ' /status'

    let body = null
    try {
        body = await response.json()
    } catch (_) {}
    if (body && typeof body === 'object' && Object.prototype.hasOwnProperty.call(body, 'schemaReady')) {
        return body.schemaReady === true ? '' : ' schema'
    }
    return await indexerSchemaReady(config, indexer.dbName) ? '' : ' schema'
}

// Name the first check that is not ready yet, or return '' when the whole stack is.
async function stackProblem (config) {
    for (const indexer of config.indexers) {
        const problem = await indexerProblem(config, indexer)
        if (problem) return indexer.coin + ' indexer' + problem
    }
    for (const url of config.minerHealthUrls) {
        const problem = await minerProblem(url, config.fetchImpl)
        if (problem) return 'miner ' + url + ': ' + problem
    }
    return ''
}

async function stackReady (config) {
    return await stackProblem(config) === ''
}

async function waitForStack (config) {
    const deadline = Date.now() + config.timeoutMs
    let problem = ''
    do {
        problem = await stackProblem(config)
        if (!problem) return
        await config.sleep(config.intervalMs)
    } while (Date.now() <= deadline)
    throw new Error('attest-mirror stack did not expose the indexer schema and healthy miners inside ' +
        config.timeoutMs + ' ms; last failure: ' + problem)
}

function requiredValue (value, key) {
    if (!value) throw new Error('missing stack readiness value ' + key)
    return value
}

// Refuse a malformed number up front: a NaN deadline gives up after one probe, a NaN interval spins.
function positiveNumber (env, key, fallback) {
    if (env[key] === undefined || env[key] === '') return fallback
    const value = Number(env[key])
    if (!Number.isFinite(value) || value <= 0) {
        throw new Error('invalid stack readiness value ' + key + ': expected a positive number, got "' + env[key] + '"')
    }
    return value
}

function portNumber (value, key) {
    const port = Number(value)
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('invalid stack readiness value ' + key + ': not a port')
    return port
}

// Read the coins the stack must serve; the attest-mirror stack runs all three.
function readyCoins (env) {
    const coins = (env.ATTEST_MIRROR_READY_COINS || COIN_CODES.join(','))
        .split(',').map((coin) => coin.trim().toUpperCase()).filter(Boolean)
    for (const coin of coins) {
        if (!COIN_CODES.includes(coin)) throw new Error('unknown stack readiness coin ' + coin)
    }
    if (coins.length === 0) throw new Error('missing stack readiness value ATTEST_MIRROR_READY_COINS')
    return coins
}

// Resolve one coin's indexer and miner the way the leg runner exports them; BTC keeps its legacy names.
function coinTargets (env, coin, host) {
    const btc = coin === 'BTC'
    const indexerPort = btc ? env.BTC_INDEXER_API_PORT || env.INDEXER_API_PORT || env.INDEXER_HOST_PORT
        : env[coin + '_INDEXER_API_PORT'] || env[coin + '_INDEXER_HOST_PORT']
    const minerPort = btc ? env.BTC_REGTEST_MINER_API_PORT || env.REGTEST_MINER_API_PORT || env.MINER_HOST_PORT
        : env[coin + '_REGTEST_MINER_API_PORT'] || env[coin + '_MINER_HOST_PORT']
    const dbName = (btc ? env.BTC_INDEXER_DB_NAME || env.INDEXER_DB_NAME : env[coin + '_INDEXER_DB_NAME']) ||
        'XChain_' + coin + '_Regtest_Indexer'
    const indexerKey = coin + ' indexerPort'
    const minerKey = coin + ' minerPort'
    return {
        indexer: { coin, dbName, statusUrl: 'http://' + host + ':' + portNumber(requiredValue(indexerPort, indexerKey), indexerKey) + '/status' },
        minerUrl: 'http://' + host + ':' + portNumber(requiredValue(minerPort, minerKey), minerKey) + '/',
    }
}

function configFromEnv (env, dependencies, fetchImpl) {
    const host = env.ATTEST_MIRROR_STACK_HOST || '127.0.0.1'
    const dbPort = requiredValue(env.DB_HOST_PORT || env.DATABASE_PORT, 'dbPort')
    const dbPassword = requiredValue(env.DB_PASSWORD || env.INDEXER_DB_PASS, 'dbPassword')
    const targets = readyCoins(env).map((coin) => coinTargets(env, coin, host))
    return {
        dbHost: host,
        dbPort: portNumber(dbPort, 'dbPort'),
        dbUser: env.INDEXER_DB_USER || 'root',
        dbPassword,
        requiredIndexerTables: REQUIRED_INDEXER_TABLES,
        indexers: targets.map((target) => target.indexer),
        minerHealthUrls: targets.map((target) => target.minerUrl),
        timeoutMs: positiveNumber(env, 'ATTEST_MIRROR_READY_TIMEOUT_MS', 300000),
        intervalMs: positiveNumber(env, 'ATTEST_MIRROR_READY_INTERVAL_MS', 3000),
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
    minerBodyProblem,
    minerProblem,
    indexerSchemaReady,
    indexerProblem,
    stackProblem,
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
