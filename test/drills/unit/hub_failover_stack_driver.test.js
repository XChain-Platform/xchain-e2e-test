'use strict'

const assert = require('assert')
const fs = require('fs')
const path = require('path')
const {
    createConfig,
    hubIdFromAddress,
    normalizeIndexer,
    quoteSql,
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
                selector: { followed: 'http://hub-b:10000' },
            },
        })
        assert.deepStrictEqual(normalized, {
            id: 'btc-indexer', coin: 'BTC', role: 'failover', followedHub: 'hub-b',
            indexerBlock: 101, stallReason: null,
            hubMirror: { connected: true, bootstrapped: true, moveCount: 2 },
        })
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

    it('credits report delivery only to the hub with its own delivered record', function () {
        const state = { reportId: 'push:7' }
        const delivered = new Set(['hub-b'])
        assert.deepStrictEqual(reportsForHub(state, delivered, 'hub-a'), [])
        assert.deepStrictEqual(reportsForHub(state, delivered, 'hub-b'), ['push:7'])
    })
})
