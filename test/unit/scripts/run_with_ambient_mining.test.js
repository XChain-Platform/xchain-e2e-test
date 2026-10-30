'use strict'

/*********************************************************************
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 ********************************************************************/

const assert = require('assert')
const fs = require('fs')
const http = require('http')
const os = require('os')
const path = require('path')
const { spawn } = require('child_process')

const SCRIPT = path.resolve(__dirname, '..', '..', '..', 'bin', 'run-with-ambient-mining.sh')

// Start a stub miner that records each request's x-api-key and answers with the given status and body.
function stubMiner (status, body) {
    const keys = []
    const server = http.createServer((req, res) => {
        req.resume()
        req.on('end', () => {
            keys.push(req.headers['x-api-key'] || null)
            res.writeHead(status, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify(body))
        })
    })
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, keys, port: server.address().port })))
}

// Run the script around a short sleep and resolve with its exit code and stderr.
function runScript (btc, doge, env) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ambient-mining-'))
    const child = spawn('bash', [SCRIPT, 'sleep', '1'], {
        env: {
            PATH: process.env.PATH,
            REGTEST_MINER_API_PORT: String(btc.port),
            DOGE_REGTEST_MINER_API_PORT: String(doge.port),
            BRIDGE_RAIL_MINER_PAUSE_FILE: path.join(root, 'btc.pause'),
            BRIDGE_RAIL_DOGE_MINER_PAUSE_FILE: path.join(root, 'doge.pause'),
            AMBIENT_MINING_INTERVAL_S: '0.2',
            ...env,
        },
    })
    let stderr = ''
    child.stderr.on('data', (chunk) => { stderr += chunk })
    return new Promise((resolve) => child.on('exit', (code) => setTimeout(() => resolve({ code, stderr }), 300)))
}

const MINED = { jsonrpc: '2.0', id: 1, result: { count: 1, hashes: ['00'] } }

describe('run-with-ambient-mining', function () {
    this.timeout(15000)
    const servers = []
    afterEach(() => { while (servers.length) servers.pop().server.close() })

    it('sends each chain its own miner key, falling back to the shared one', async function () {
        const btc = await stubMiner(200, MINED)
        const doge = await stubMiner(200, MINED)
        servers.push(btc, doge)
        const result = await runScript(btc, doge, { MINER_API_KEY: 'shared-key', DOGE_MINER_API_KEY: 'doge-key' })
        assert.strictEqual(result.code, 0, result.stderr)
        assert.ok(btc.keys.length > 0 && doge.keys.length > 0, 'both loops must mine')
        assert.ok(btc.keys.every((k) => k === 'shared-key'), JSON.stringify(btc.keys))
        assert.ok(doge.keys.every((k) => k === 'doge-key'), JSON.stringify(doge.keys))
        assert.doesNotMatch(result.stderr, /mine (refused|failed)/)
    })

    it('sends no key header to an unkeyed miner', async function () {
        const btc = await stubMiner(200, MINED)
        const doge = await stubMiner(200, MINED)
        servers.push(btc, doge)
        const result = await runScript(btc, doge, {})
        assert.strictEqual(result.code, 0, result.stderr)
        assert.ok(btc.keys.length > 0 && btc.keys.every((k) => k === null), JSON.stringify(btc.keys))
    })

    it('logs a 401 and an error inside a 200 body as refused mines, never the key', async function () {
        const btc = await stubMiner(401, { error: 'Unauthorized: missing or invalid X-API-Key' })
        const doge = await stubMiner(200, { jsonrpc: '2.0', id: 1, result: { error: 'mining is disabled while fill_mempool is running' } })
        servers.push(btc, doge)
        const result = await runScript(btc, doge, { MINER_API_KEY: 'wrong-key' })
        assert.strictEqual(result.code, 0, result.stderr)
        assert.match(result.stderr, /BTC mine refused \(http 401\)/)
        assert.match(result.stderr, /DOGE mine refused: .*mining is disabled while fill_mempool is running/)
        assert.doesNotMatch(result.stderr, /wrong-key/)
    })

    it('logs a miner it cannot reach as a failed mine and still returns the command exit code', async function () {
        const btc = await stubMiner(200, MINED)
        const gone = await stubMiner(200, MINED)
        await new Promise((resolve) => gone.server.close(resolve))
        servers.push(btc)
        const result = await runScript(btc, gone, {})
        assert.strictEqual(result.code, 0, result.stderr)
        assert.match(result.stderr, /DOGE mine failed: curl exit \d+/)
    })
})
