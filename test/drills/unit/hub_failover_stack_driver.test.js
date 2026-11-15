// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

'use strict'

const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { EventEmitter } = require('events')
const {
    createConfig,
    hubIdFromAddress,
    mine,
    normalizeIndexer,
    prepare,
    quoteSql,
    readReadyFrame,
    reportsForHub,
} = require('../../../bin/hub-failover-stack-driver')

function registerDefaultTargetTests () {
    it('is the non-skipping default for the failover drill', function () {
        const entry = fs.readFileSync(path.resolve(__dirname, '../hub_failover.test.js'), 'utf8')
        assert.match(entry, /hub-failover-stack-driver\.js/)
        assert.doesNotMatch(entry, /\.skip\s*\(/)
    })

    it('targets the sibling two-hub compose stack by default', function () {
        const config = createConfig({})
        assert.match(config.composeFile, /xchain-node[/]\.github[/]hub-failover[/]compose\.yml$/)
        assert.match(config.stateFile, /xchain-e2e-test[/]tmp[/]hub-failover-driver-state\.json$/)
        assert.strictEqual(config.project, 'hub-failover')
    })
}

function registerIndexerStatusTests () {
    it('normalizes the followed hub and move evidence from indexer status', function () {
        const definition = { id: 'btc-indexer', coin: 'BTC', role: 'failover' }
        const normalized = normalizeIndexer(definition, {
            indexerBlock: 101,
            stallReason: null,
            hubMirror: {
                connected: true,
                bootstrapped: true,
                moveCount: 2,
                followedAddress: 'http://hub-b:10000',
            },
        })
        assert.deepStrictEqual(normalized, {
            id: 'btc-indexer', coin: 'BTC', role: 'failover', followedHub: 'hub-b',
            indexerBlock: 101, stallReason: null,
            hubMirror: { connected: true, bootstrapped: true, moveCount: 2 },
        })
    })
}

function registerPrepareTests () {
    it('restarts seed-driven indexers until each follows hub-a ready, with a 15 restart bound', async function () {
        const restarts = []
        const reads = new Map()
        const status = (address) => ({
            hubMirror: { followedAddress: address, connected: true, bootstrapped: true },
        })
        const result = await prepare(createConfig({}), {
            indexerStatus: async (config, indexer) => {
                const count = (reads.get(indexer.id) || 0) + 1
                reads.set(indexer.id, count)
                return status(count === 1 ? 'http://hub-b:10000' : 'http://hub-a:10000')
            },
            restartIndexer: async (indexer) => { restarts.push(indexer.id) },
        })
        assert.deepStrictEqual(restarts, ['btc-indexer', 'ltc-indexer', 'doge-indexer'])
        assert.deepStrictEqual(result, { followedAddress: 'http://hub-a:10000' })

        let restartCount = 0
        await assert.rejects(prepare(createConfig({}), {
            indexerStatus: async () => status('http://hub-b:10000'),
            restartIndexer: async () => { restartCount++ },
        }), /after 15 restarts/)
        assert.strictEqual(restartCount, 15)
    })

    it('removes stale driver state before checking the prepared indexers', async function () {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-failover-prepare-'))
        const stateFile = path.join(directory, 'driver-state.json')
        fs.writeFileSync(stateFile, '{"stale":true}\n')
        try {
            await prepare(createConfig({ XCHAIN_HUB_FAILOVER_STATE_FILE: stateFile }), {
                indexerStatus: async () => {
                    assert.strictEqual(fs.existsSync(stateFile), false)
                    return {
                        hubMirror: {
                            followedAddress: 'http://hub-a:10000',
                            connected: true,
                            bootstrapped: true,
                        },
                    }
                },
            })
            assert.strictEqual(fs.existsSync(stateFile), false)
        } finally {
            fs.rmSync(directory, { recursive: true, force: true })
        }
    })
}

function registerReadyFrameTests () {
    it('retries ready-frame connection errors and keeps the first ready frame', async function () {
        let connections = 0
        class FakeWebSocket extends EventEmitter {
            constructor () {
                super()
                connections++
                if (connections === 1) process.nextTick(() => this.emit('error', new Error('refused')))
                else process.nextTick(() => {
                    this.emit('message', Buffer.from(JSON.stringify({ type: 'ready', caught_up: false })))
                    this.emit('message', Buffer.from(JSON.stringify({ type: 'ready', caught_up: true })))
                })
            }

            close () {}
        }
        const config = createConfig({ XCHAIN_HUB_FAILOVER_READY_TIMEOUT_MS: '1000' })
        const frame = await readReadyFrame(config, 'hub-a', { WebSocketImpl: FakeWebSocket })
        assert.deepStrictEqual(frame, { type: 'ready', caught_up: false })
        assert.strictEqual(connections, 2)
    })
}

function registerValidationAndMappingTests () {
    it('refuses status that cannot prove a followed hub or move count', function () {
        const definition = { id: 'btc-indexer', coin: 'BTC', role: 'failover' }
        assert.throws(() => normalizeIndexer(definition, {
            indexerBlock: 1,
            hubMirror: { connected: true, bootstrapped: true, moveCount: 0 },
        }), /recognized followed hub/)
        assert.throws(() => normalizeIndexer(definition, {
            indexerBlock: 1,
            hubMirror: { connected: true, bootstrapped: true, followed: 'http:\/\/hub-a:10000' },
        }), /moveCount/)
    })

    it('maps internal and published hub addresses without accepting strangers', function () {
        assert.strictEqual(hubIdFromAddress('http://hub-a:10000'), 'hub-a')
        assert.strictEqual(hubIdFromAddress('http://127.0.0.1:64232'), 'hub-b')
        assert.strictEqual(hubIdFromAddress('http://example.invalid:10000'), null)
    })

    it('quotes fixture report values for the MariaDB command', function () {
        assert.strictEqual(quoteSql("a'b\\c"), "'a''b\\\\c'")
    })

    it('credits report delivery only when the report row exists in that hub', function () {
        const state = { reportId: 'push:7' }
        assert.deepStrictEqual(reportsForHub(state, false), [])
        assert.deepStrictEqual(reportsForHub(state, true), ['push:7'])
    })
}

function registerMineTests () {
    const confirming = (calls) => async (url, method, params, opts) => {
        calls.push({ url, method, params, opts })
        return { count: params.count, hashes: [] }
    }

    it('mines every chain through the shared miner client and keeps the requested count', async function () {
        const calls = []
        const result = await mine(createConfig({}), 2, { minerRpc: confirming(calls) })
        assert.deepStrictEqual(result, { blocks: 2 })
        assert.deepStrictEqual(calls.map((call) => call.url), [
            'http://127.0.0.1:64206', 'http://127.0.0.1:64215', 'http://127.0.0.1:64225',
        ])
        assert.ok(calls.every((call) => call.method === 'generate_blocks' && call.params.count === 2))
    })

    it('sends the per-chain miner key before the shared one, and none when unset', async function () {
        const calls = []
        await mine(createConfig({ MINER_API_KEY: 'shared', LTC_MINER_API_KEY: 'ltc-only' }), 1,
            { minerRpc: confirming(calls) })
        assert.deepStrictEqual(calls.map((call) => call.opts.apiKey), ['shared', 'ltc-only', 'shared'])
        const bare = []
        await mine(createConfig({}), 1, { minerRpc: confirming(bare) })
        assert.ok(bare.every((call) => call.opts.apiKey === null))
    })

    it('refuses a miner reply that confirms fewer blocks than requested', async function () {
        await assert.rejects(mine(createConfig({}), 2, {
            minerRpc: async (url, method, params) => ({ count: params.count - 1, hashes: [] }),
        }), /confirmed 1 of 2/)
        await assert.rejects(mine(createConfig({}), 2, { minerRpc: async () => ({}) }), /confirmed undefined of 2/)
    })

    it('treats a reply with no result as a refusal when the real client reads it', async function () {
        const axios = require('axios')
        const original = axios.post
        axios.post = async () => ({ data: { jsonrpc: '2.0', id: 1 } })
        try {
            await assert.rejects(mine(createConfig({}), 2), /no result/)
        } finally {
            axios.post = original
        }
    })
}

describe('two-hub failover stack driver', function () {
    registerDefaultTargetTests()
    registerIndexerStatusTests()
    registerPrepareTests()
    registerReadyFrameTests()
    registerValidationAndMappingTests()
    registerMineTests()
})
