'use strict'

const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { EventEmitter } = require('events')
const {
    createConfig,
    hubIdFromAddress,
    normalizeIndexer,
    prepare,
    quoteSql,
    readReadyFrame,
    reportsForHub,
} = require('../../../scripts/hub-failover-stack-driver')

describe('two-hub failover stack driver', function () {
    it('is the non-skipping default for the failover drill', function () {
        const entry = fs.readFileSync(path.resolve(__dirname, '../hubFailover.drill.js'), 'utf8')
        assert.match(entry, /hub-failover-stack-driver\.js/)
        assert.doesNotMatch(entry, /\.skip\s*\(/)
    })

    it('targets the sibling two-hub compose stack by default', function () {
        const config = createConfig({})
        assert.match(config.composeFile, /xchain-node[/]\.github[/]hub-failover[/]compose\.yml$/)
        assert.match(config.stateFile, /xchain-e2e-test[/]tmp[/]hub-failover-driver-state\.json$/)
        assert.strictEqual(config.project, 'hub-failover')
    })

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
})
