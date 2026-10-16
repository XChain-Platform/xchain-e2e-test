// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const assert = require('assert')
const { Database, withConnector, dbWithRows, captureLog, makeDb } = require('./support/helpers')

describe('adaptive wait deadline', function () {
    this.timeout(10000)

    registerIndexerLagBlocksTests()

    describe('_pipelineProgress', () => {
        registerPipelineProgressShapeTests()
        registerPipelineProgressFailureTests()
    })
})

function registerIndexerLagBlocksTests() {
    it('_indexerLagBlocks returns null when no node connector is wired', async () => {
        const db = Object.create(Database.prototype)
        db.WAIT_LAG_PROBE_MS = 500
        const saved = global.nodeConnector
        delete global.nodeConnector
        try {
            assert.strictEqual(await db['_indexerLagBlocks'](), null)
        } finally {
            if (saved !== undefined) global.nodeConnector = saved
        }
    })

    it('_indexerLagBlocks reports chain tip minus indexed tip', async () => {
        const db = Object.create(Database.prototype)
        db.WAIT_LAG_PROBE_MS = 500
        const saved = global.nodeConnector
        global.nodeConnector = { getBlockCount: async () => 5000 }
        db.pool = { getConnection: async () => ({
            query:   async () => [{ tip: 4970 }],
            release: async () => {}
        }) }
        try {
            assert.strictEqual(await db['_indexerLagBlocks'](), 30)
        } finally {
            if (saved === undefined) delete global.nodeConnector; else global.nodeConnector = saved
        }
    })

    it('_indexerLagBlocks returns null rather than throwing when the tip query fails', async () => {
        const db = Object.create(Database.prototype)
        db.WAIT_LAG_PROBE_MS = 500
        const saved = global.nodeConnector
        global.nodeConnector = { getBlockCount: async () => 5000 }
        db.pool = { getConnection: async () => { throw new Error('pool exhausted') } }
        try {
            assert.strictEqual(await db['_indexerLagBlocks'](), null,
                'a failing lag probe must degrade to the fixed deadline, not blow up the wait')
        } finally {
            if (saved === undefined) delete global.nodeConnector; else global.nodeConnector = saved
        }
    })
}


function registerPipelineProgressShapeTests() {
    it('names a missing database pool for both unavailable signals', async () => {
        const db = Object.create(Database.prototype)
        assert.deepStrictEqual(await db['_pipelineProgress'](), {
            lag: null, lagReason: 'no database pool wired',
            writes: null, writesReason: 'no database pool wired'
        })
    })

    it('reports lag and the action-write mark from one round trip', async () => {
        const db = dbWithRows([{ tip: 4970, writes: 88123 }])
        await withConnector({ getBlockCount: async () => 5000 }, async () => {
            assert.deepStrictEqual(await db['_pipelineProgress'](), {
                lag: 30, lagReason: null, writes: 88123, writesReason: null
            })
        })
        assert.strictEqual(db.queries.length, 1,
            'sampling twice as often must not cost twice as many round trips')
    })

    it('still reports writes when the chain tip is not observable', async () => {
        // No node connector means no lag signal, but the write signal does not
        // need the chain: it is exactly the case lag cannot cover.
        const db = dbWithRows([{ tip: 4970, writes: 5 }])
        await withConnector(undefined, async () => {
            assert.deepStrictEqual(await db['_pipelineProgress'](), {
                lag: null, lagReason: 'no node connector wired',
                writes: 5, writesReason: null
            })
        })
    })

    it('reports nulls, not NaN, on an empty database', async () => {
        const db = dbWithRows([{ tip: null, writes: null }])
        await withConnector({ getBlockCount: async () => 5000 }, async () => {
            assert.deepStrictEqual(await db['_pipelineProgress'](), {
                lag: null, lagReason: 'blocks table held no rows',
                writes: null, writesReason: 'actions table held no rows'
            })
        })
    })
}

function registerPipelineProgressFailureTests() {
    it('degrades to nulls rather than throwing when the probe fails', async () => {
        const db = Object.create(Database.prototype)
        db.WAIT_LAG_PROBE_MS = 500
        db.pool = { getConnection: async () => { throw new Error('pool exhausted') } }
        await withConnector({ getBlockCount: async () => 5000 }, async () => {
            assert.deepStrictEqual(await db['_pipelineProgress'](), {
                lag: null, lagReason: 'probe failed: pool exhausted',
                writes: null, writesReason: 'probe failed: pool exhausted'
            })
        })
    })

    it('says once why a failing probe went blind, instead of degrading silently', async () => {
        // A probe that can never answer sends every wait back to a fixed deadline
        // and reports nothing, which is how this mechanism stayed unproven.
        const db = Object.create(Database.prototype)
        db.WAIT_LAG_PROBE_MS = 500
        db.pool = { getConnection: async () => { throw new Error("Table 'actions' doesn't exist") } }
        const lines = []
        const orig = console.log
        console.log = (...a) => lines.push(a.join(' '))
        try {
            await withConnector({ getBlockCount: async () => 1 }, async () => {
                await db['_pipelineProgress']()
                await db['_pipelineProgress']()
                await db['_pipelineProgress']()
            })
        } finally { console.log = orig }
        const warnings = lines.filter(l => l.includes('probe unavailable'))
        assert.strictEqual(warnings.length, 1,
            'the cause must be named once, not once per poll: ' + JSON.stringify(lines))
        assert(/actions/.test(warnings[0]), 'the warning must carry the driver error: ' + warnings[0])
    })

    it('gives up on a probe that hangs, so it can never block the wait it advises', async () => {
        const db = Object.create(Database.prototype)
        db.WAIT_LAG_PROBE_MS = 50
        db.pool = { getConnection: () => new Promise(() => {}) }
        await withConnector({ getBlockCount: async () => 5000 }, async () => {
            const started = Date.now()
            assert.deepStrictEqual(await db['_pipelineProgress'](), {
                lag: null, lagReason: 'probe timed out',
                writes: null, writesReason: 'probe timed out'
            })
            assert(Date.now() - started < 1000, 'the probe must be time-capped')
        })
    })
}
