#!/usr/bin/env node
'use strict'

const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')
const axios = require('axios')
const WebSocket = require('ws')

const REPO_ROOT = path.resolve(__dirname, '..')
const HUBS = Object.freeze({
    'hub-a': { portEnv: 'HUB_A_HOST_PORT', port: 64230, database: 'XChain_Hub_A' },
    'hub-b': { portEnv: 'HUB_B_HOST_PORT', port: 64232, database: 'XChain_Hub_B' },
})
const INDEXERS = Object.freeze([
    { id: 'btc-indexer', coin: 'BTC', role: 'failover', portEnv: 'BTC_INDEXER_HOST_PORT',
        port: 64205, database: 'XChain_BTC_Regtest_Indexer' },
    { id: 'ltc-indexer', coin: 'LTC', role: 'failover', portEnv: 'LTC_INDEXER_HOST_PORT',
        port: 64214, database: 'XChain_LTC_Regtest_Indexer' },
    { id: 'doge-indexer', coin: 'DOGE', role: 'failover', portEnv: 'DOGE_INDEXER_HOST_PORT',
        port: 64224, database: 'XChain_DOGE_Regtest_Indexer' },
    { id: 'btc-indexer-control', coin: 'BTC', role: 'pinned-control',
        portEnv: 'BTC_CONTROL_INDEXER_HOST_PORT', port: 64207,
        database: 'XChain_BTC_Regtest_Control_Indexer' },
])
const MINERS = Object.freeze([
    { portEnv: 'BTC_MINER_HOST_PORT', port: 64206 },
    { portEnv: 'LTC_MINER_HOST_PORT', port: 64215 },
    { portEnv: 'DOGE_MINER_HOST_PORT', port: 64225 },
])
const MAX_OUTPUT_BYTES = 1024 * 1024

function setting (env, name, fallback) {
    return env[name] === undefined || env[name] === '' ? fallback : env[name]
}

function portSetting (env, name, fallback) {
    const value = Number(setting(env, name, fallback))
    if (!Number.isInteger(value) || value < 1 || value > 65535)
        throw new Error(name + ' must be a TCP port')
    return value
}

function createConfig (env) {
    const nodeDir = path.resolve(setting(env, 'XCHAIN_HUB_FAILOVER_NODE_DIR',
        path.join(REPO_ROOT, '..', 'xchain-node')))
    const composeFile = path.resolve(setting(env, 'XCHAIN_HUB_FAILOVER_COMPOSE_FILE',
        path.join(nodeDir, '.github/hub-failover/compose.yml')))
    return {
        env,
        docker: setting(env, 'XCHAIN_HUB_FAILOVER_DOCKER', 'docker'),
        project: setting(env, 'XCHAIN_HUB_FAILOVER_PROJECT', 'hub-failover'),
        composeFile,
        stateFile: path.resolve(setting(env, 'XCHAIN_HUB_FAILOVER_STATE_FILE',
            path.join(REPO_ROOT, 'tmp/hub-failover-driver-state.json'))),
        feedKey: setting(env, 'HUB_FEED_API_KEY', 'hub-failover-feed'),
        bulkKey: setting(env, 'HUB_API_KEY', 'hub-failover-bulk'),
        readyTimeoutMs: Number(setting(env, 'XCHAIN_HUB_FAILOVER_READY_TIMEOUT_MS', 120000)),
    }
}

function runCommand (command, args, options) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, Object.assign({ stdio: ['ignore', 'pipe', 'pipe'] }, options))
        let stdout = ''
        let stderr = ''
        const append = (current, chunk) => {
            const value = current + chunk.toString('utf8')
            if (Buffer.byteLength(value) > MAX_OUTPUT_BYTES)
                throw new Error('command output exceeded ' + MAX_OUTPUT_BYTES + ' bytes')
            return value
        }
        child.stdout.on('data', (chunk) => {
            try { stdout = append(stdout, chunk) } catch (error) { child.kill('SIGTERM'); reject(error) }
        })
        child.stderr.on('data', (chunk) => {
            try { stderr = append(stderr, chunk) } catch (error) { child.kill('SIGTERM'); reject(error) }
        })
        child.once('error', reject)
        child.once('exit', (code, signal) => {
            if (code === 0) return resolve({ stdout, stderr })
            reject(new Error(command + ' failed (' + (signal || 'exit ' + code) + '): ' + stderr.trim()))
        })
    })
}

function composeArgs (config, args) {
    return ['compose', '-p', config.project, '-f', config.composeFile, ...args]
}

async function compose (config, args) {
    if (!fs.existsSync(config.composeFile))
        throw new Error('two-hub failover compose file not found at ' + config.composeFile)
    return runCommand(config.docker, composeArgs(config, args), { cwd: path.dirname(config.composeFile) })
}

async function dbRows (config, database, sql) {
    const command = 'exec mariadb --batch --skip-column-names -uroot ' +
        '-p"$MARIADB_ROOT_PASSWORD" "$1" -e "$2"'
    const result = await compose(config, ['exec', '-T', 'db', 'sh', '-ec', command, 'sh', database, sql])
    const trimmed = result.stdout.trim()
    return trimmed ? trimmed.split(/\r?\n/).map((line) => line.split('\t')) : []
}

async function runningServices (config) {
    const result = await compose(config, ['ps', '--status', 'running', '--services'])
    return new Set(result.stdout.trim().split(/\r?\n/).filter(Boolean))
}

function hostPort (env, row) {
    return portSetting(env, row.portEnv, row.port)
}

function readReadyFrame (config, hubId) {
    const hub = HUBS[hubId]
    if (!hub) throw new Error('unknown two-hub failover hub ' + hubId)
    const port = hostPort(config.env, hub)
    return new Promise((resolve, reject) => {
        let settled = false
        const ws = new WebSocket('ws://127.0.0.1:' + port + '/hub-db/subscribe', {
            headers: { Authorization: 'Bearer ' + config.feedKey },
        })
        const finish = (fn, value) => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            try { ws.close() } catch (error) {}
            fn(value)
        }
        const timer = setTimeout(() => finish(reject,
            new Error(hubId + ' did not publish a ready frame')), config.readyTimeoutMs)
        ws.on('message', (data) => {
            let frame
            try { frame = JSON.parse(data.toString()) } catch (error) { return }
            if (frame.type === 'ready') finish(resolve, frame)
        })
        ws.once('error', (error) => finish(reject, error))
        ws.once('close', () => finish(reject, new Error(hubId + ' closed before its ready frame')))
    })
}

async function indexerStatus (config, indexer) {
    const port = hostPort(config.env, indexer)
    const response = await axios.get('http://127.0.0.1:' + port + '/status', {
        timeout: 30000,
        validateStatus: () => true,
    })
    if (!response.data || typeof response.data !== 'object')
        throw new Error(indexer.id + ' returned no JSON status')
    return response.data
}

function followedValue (mirror) {
    const sources = [mirror, mirror && mirror.selector, mirror && mirror.hubSelector]
    const keys = ['followedHub', 'followed', 'hubUrl', 'currentUrl', 'current', 'address']
    for (const source of sources) {
        if (!source || typeof source !== 'object') continue
        for (const key of keys) {
            if (typeof source[key] === 'string' && source[key]) return source[key]
        }
    }
    return null
}

function hubIdFromAddress (address) {
    if (typeof address !== 'string') return null
    if (/(^|\/)hub-a(?::|\/|$)/.test(address) || /:64230(?:\/|$)/.test(address)) return 'hub-a'
    if (/(^|\/)hub-b(?::|\/|$)/.test(address) || /:64232(?:\/|$)/.test(address)) return 'hub-b'
    return null
}

function normalizeIndexer (definition, status) {
    const mirror = status.hubMirror
    if (!mirror || typeof mirror !== 'object') throw new Error(definition.id + ' status lacks hubMirror')
    const followedHub = hubIdFromAddress(followedValue(mirror))
    if (!followedHub) throw new Error(definition.id + ' status lacks a recognized followed hub')
    const moveCount = Number(mirror.moveCount)
    if (!Number.isInteger(moveCount) || moveCount < 0)
        throw new Error(definition.id + ' status lacks hubMirror.moveCount')
    return {
        id: definition.id,
        coin: definition.coin,
        role: definition.role,
        followedHub,
        indexerBlock: Number(status.indexerBlock),
        stallReason: status.stallReason || null,
        hubMirror: {
            connected: mirror.connected === true,
            bootstrapped: mirror.bootstrapped === true,
            moveCount,
        },
    }
}

function readState (config) {
    if (!fs.existsSync(config.stateFile)) return null
    return JSON.parse(fs.readFileSync(config.stateFile, 'utf8'))
}

function writeState (config, state) {
    fs.mkdirSync(path.dirname(config.stateFile), { recursive: true })
    const temporary = config.stateFile + '.' + process.pid + '.tmp'
    fs.writeFileSync(temporary, JSON.stringify(state) + '\n', { mode: 0o600 })
    fs.renameSync(temporary, config.stateFile)
}

async function rowPresence (config, hubId, state) {
    if (!state) return false
    const sql = 'SELECT COUNT(*) FROM oracle_prices WHERE source_address=' + quoteSql(state.sourceAddress) +
        ' AND source_chain=\'BTC\' AND action_index=' + Number(state.actionIndex)
    const rows = await dbRows(config, HUBS[hubId].database, sql)
    return Number(rows[0] && rows[0][0]) > 0
}

async function deliveryEvidence (config, state) {
    if (!state) return { complete: false, delivered: new Set() }
    const database = INDEXERS.find((row) => row.id === 'btc-indexer').database
    const pending = await dbRows(config, database,
        'SELECT COUNT(*) FROM pending_hub_pushes WHERE id=' + Number(state.pushId))
    const rows = await dbRows(config, database,
        'SELECT hub_address, status FROM hub_push_deliveries WHERE push_id=' + Number(state.pushId))
    return {
        complete: Number(pending[0] && pending[0][0]) === 0,
        delivered: new Set(rows.filter((row) => row[1] === 'delivered')
            .map((row) => hubIdFromAddress(row[0])).filter(Boolean)),
    }
}

async function observeHubs (config, services, state) {
    const delivery = await deliveryEvidence(config, state)
    return Promise.all(Object.keys(HUBS).map(async (id) => {
        const running = services.has(id)
        const frame = running ? await readReadyFrame(config, id) : null
        const present = await rowPresence(config, id, state)
        const reportSeen = state && (delivery.complete || delivery.delivered.has(id))
        return {
            id,
            running,
            caught_up: running ? frame.caught_up : false,
            reports: reportSeen ? [state.reportId] : [],
            rows: { oracle_prices: present ? [state.rowKey] : [] },
        }
    }))
}

async function observe (config) {
    const [services, statuses] = await Promise.all([
        runningServices(config),
        Promise.all(INDEXERS.map((indexer) => indexerStatus(config, indexer))),
    ])
    const state = readState(config)
    return {
        hubs: await observeHubs(config, services, state),
        indexers: INDEXERS.map((definition, index) => normalizeIndexer(definition, statuses[index])),
    }
}

function quoteSql (value) {
    return "'" + String(value).replace(/\\/g, '\\\\').replace(/'/g, "''") + "'"
}

function oraclePayload (actionIndex, sourceAddress, generation) {
    return {
        source_chain: 'BTC', source_address: sourceAddress, coin: 'BTC', tick: 'HF15B', fiat: 'USD',
        value: '1', fee: null, memo: 'hub failover drill', block_time: Math.floor(Date.now() / 1000),
        action_index: actionIndex, push_generation: generation,
    }
}

async function pushCatchupRow (config, hubId, payload) {
    const response = await axios.post('http://127.0.0.1:' + hostPort(config.env, HUBS[hubId]), {
        jsonrpc: '2.0', id: 1, method: 'pushoracleprice', params: payload,
    }, {
        timeout: 30000,
        headers: { 'x-api-key': config.bulkKey },
    })
    const body = response.data || {}
    const rejection = body.error || (body.result && body.result.error) ||
        (body.result && body.result.accepted === false && body.result.reason)
    if (rejection) throw new Error('surviving hub refused the catch-up row: ' + JSON.stringify(rejection))
    if (!body.result || body.result.accepted !== true)
        throw new Error('surviving hub did not accept the catch-up row')
}

async function queueReport (config) {
    const services = await runningServices(config)
    const survivors = Object.keys(HUBS).filter((hubId) => services.has(hubId))
    if (survivors.length !== 1) throw new Error('queue-report requires exactly one running hub')
    const actionIndex = Date.now() * 1000 + crypto.randomInt(0, 1000)
    const generationRows = await dbRows(config, 'XChain_BTC_Regtest_Indexer',
        "SELECT generation FROM push_generations WHERE coin='BTC' LIMIT 1")
    const generation = Number(generationRows[0] && generationRows[0][0]) || 0
    const reportPayload = oraclePayload(actionIndex, 'hf15b-report-' + actionIndex, generation)
    const sql = 'INSERT INTO pending_hub_pushes ' +
        '(push_type, action_index, payload, status, attempts, created_at) VALUES ' +
        `('oracle_price',${actionIndex},${quoteSql(JSON.stringify(reportPayload))},'pending',0,NOW()); ` +
        'SELECT LAST_INSERT_ID()'
    const rows = await dbRows(config, 'XChain_BTC_Regtest_Indexer', sql)
    const pushId = Number(rows[rows.length - 1] && rows[rows.length - 1][0])
    if (!Number.isInteger(pushId) || pushId < 1) throw new Error('failed to enqueue the outage report')
    const catchupActionIndex = actionIndex + 1
    const sourceAddress = 'hf15b-catchup-' + catchupActionIndex
    await pushCatchupRow(config, survivors[0],
        oraclePayload(catchupActionIndex, sourceAddress, generation))
    const rowKey = 'BTC:' + sourceAddress + ':' + catchupActionIndex
    const state = {
        pushId, actionIndex: catchupActionIndex, sourceAddress,
        reportId: 'push:' + pushId, rowKey,
    }
    writeState(config, state)
    return { reportId: state.reportId, table: 'oracle_prices', rowKey }
}

async function postMiner (config, miner, blocks, id) {
    const response = await axios.post('http://127.0.0.1:' + hostPort(config.env, miner), {
        jsonrpc: '2.0', id, method: 'generate_blocks', params: { count: blocks },
    }, { timeout: 120000 })
    const error = response.data && (response.data.error || (response.data.result && response.data.result.error))
    if (error) throw new Error('miner rejected generate_blocks: ' + JSON.stringify(error))
}

async function mine (config, rawBlocks) {
    const blocks = Number(rawBlocks)
    if (!Number.isInteger(blocks) || blocks < 1) throw new Error('mine requires a positive block count')
    await Promise.all(MINERS.map((miner, index) => postMiner(config, miner, blocks, index + 1)))
    return { blocks }
}

async function blockHashes (config, indexerId, rawHeight) {
    const indexer = INDEXERS.find((row) => row.id === indexerId)
    const height = Number(rawHeight)
    if (!indexer) throw new Error('unknown two-hub failover indexer ' + indexerId)
    if (!Number.isInteger(height) || height < 0) throw new Error('block-hashes requires a block height')
    const sql = `SELECT b.block_index,t1.hash,t2.hash,t3.hash,t4.hash FROM blocks b
        LEFT JOIN index_transactions t1 ON t1.id=b.ledger_hash_id
        LEFT JOIN index_transactions t2 ON t2.id=b.actions_hash_id
        LEFT JOIN index_transactions t3 ON t3.id=b.contract_hash_id
        LEFT JOIN index_transactions t4 ON t4.id=b.state_hash_id
        WHERE b.block_index=${height} LIMIT 1`
    const rows = await dbRows(config, indexer.database, sql)
    if (rows.length !== 1) throw new Error(indexerId + ' has no block ' + height)
    return {
        block_index: Number(rows[0][0]), ledger_hash: rows[0][1], actions_hash: rows[0][2],
        contract_hash: rows[0][3], state_hash: rows[0][4],
    }
}

async function dispatch (config, operation, args) {
    if (operation === 'observe') return observe(config)
    if (operation === 'stop-hub') {
        if (!HUBS[args[0]]) throw new Error('unknown two-hub failover hub ' + args[0])
        await compose(config, ['stop', args[0]])
        return { stopped: args[0] }
    }
    if (operation === 'start-hub') {
        if (!HUBS[args[0]]) throw new Error('unknown two-hub failover hub ' + args[0])
        await compose(config, ['start', args[0]])
        return { firstReady: await readReadyFrame(config, args[0]) }
    }
    if (operation === 'queue-report') return queueReport(config)
    if (operation === 'mine') return mine(config, args[0])
    if (operation === 'block-hashes') return blockHashes(config, args[0], args[1])
    throw new Error('unknown operation ' + operation)
}

async function main () {
    const result = await dispatch(createConfig(process.env), process.argv[2], process.argv.slice(3))
    process.stdout.write(JSON.stringify(result) + '\n')
}

module.exports = {
    HUBS, INDEXERS, MINERS, createConfig, followedValue, hubIdFromAddress,
    normalizeIndexer, quoteSql, dispatch,
}

if (require.main === module) {
    main().catch((error) => {
        process.stderr.write(error.message + '\n')
        process.exitCode = 1
    })
}
