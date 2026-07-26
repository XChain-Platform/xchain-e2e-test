// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// . Every waitForX in src/db.js routes through _waitFor, so these pin the
// one place that decides how long a suite waits for a row.
//
// The defect being fixed: a fixed deadline assumes a quiet machine. Under
// concurrent load the indexer falls behind the chain and a row that WILL arrive is
// reported missing because the indexer had not reached its block yet. The
// dispenser suite failed a DIFFERENT case on every full run while each passed in
// isolation, and the action was afterwards found in the database, correct.
//
// The rule these tests hold in place is that extending is conditional on the
// indexer being BEHIND. "The chain is advancing" would be the wrong condition,
// since the regtest miner mines continuously and the wait would never end.

const assert   = require('assert')
const Database = require(process.env.XC701_DB_SRC || '../../src/db.js')

// Real time is used deliberately rather than a fake clock: _waitFor reads
// Date.now() directly, and the budgets here are small enough to keep the file
// fast while still exercising real deadline arithmetic.
const TIMEMAX = 60
const TICK    = 15

function makeDb({ lag, maxExtensions = 3 } = {}) {
    const db = Object.create(Database.prototype)
    db.sleep = () => new Promise(r => setTimeout(r, TICK))
    db._recordPerfPoll = () => {}
    db.lagCalls = 0
    db._indexerLagBlocks = async () => { db.lagCalls++; return typeof lag === 'function' ? lag(db.lagCalls) : lag }
    db.WAIT_MAX_EXTENSIONS = maxExtensions
    db.WAIT_LAG_BLOCKS = 2
    db.WAIT_MIN_FOR_EXTENSION = 0   // these budgets are tiny by design; opt in to extension
    db.WAIT_LAG_PROBE_MS = 500
    return db
}

// Named so _waitFor's perf label (checkFn.name) is exercised too.
function checkThing() { return null }

describe(' adaptive wait deadline', function () {
    this.timeout(10000)

    it('returns the row as soon as the check succeeds', async () => {
        const db = makeDb({ lag: 0 })
        let calls = 0
        const row = await db._waitFor(function checkThing(){ calls++; return calls >= 2 ? { id: 7 } : null }, {}, TIMEMAX)
        assert.deepStrictEqual(row, { id: 7 })
        assert.strictEqual(db.lagCalls, 0, 'a wait that succeeds must never consult the lag signal')
    })

    it('does NOT extend when the indexer has caught up, so a genuinely absent row still fails', async () => {
        const db = makeDb({ lag: 0 })
        const started = Date.now()
        const row = await db._waitFor(checkThing, {}, TIMEMAX)
        const elapsed = Date.now() - started
        assert.strictEqual(row, null)
        assert(db.lagCalls > 0, 'the lag signal should have been consulted at the deadline')
        assert(elapsed < TIMEMAX * 3,
            'caught-up indexer must not extend the wait (elapsed ' + elapsed + 'ms)')
    })

    it('extends while the indexer is behind, and finds a row that arrives late', async () => {
        // Row appears only after the ORIGINAL deadline would have expired.
        const db = makeDb({ lag: 25 })
        const started = Date.now()
        const row = await db._waitFor(
            function checkThing(){ return Date.now() - started > TIMEMAX * 1.5 ? { id: 1 } : null },
            {}, TIMEMAX)
        assert.deepStrictEqual(row, { id: 1 },
            'a lagging indexer must buy the row more time instead of failing the case')
    })

    it('caps extensions so a wedged stack fails instead of hanging the suite', async () => {
        const db = makeDb({ lag: 999, maxExtensions: 2 })
        const row = await db._waitFor(checkThing, {}, TIMEMAX)
        assert.strictEqual(row, null, 'a permanently lagging stack must still terminate')
        // One lag probe per expiry: the original deadline plus each granted extension.
        assert(db.lagCalls <= 3,
            'expected at most 3 lag probes for 2 permitted extensions, got ' + db.lagCalls)
    })

    it('does not extend when lag is at or below the threshold', async () => {
        // Ordinary one-block skew between the RPC tip and the indexer is not "behind".
        const db = makeDb({ lag: 2 })
        const started = Date.now()
        const row = await db._waitFor(checkThing, {}, TIMEMAX)
        assert.strictEqual(row, null)
        assert(Date.now() - started < TIMEMAX * 3, 'lag at the threshold must not extend')
    })

    it('does not extend when the lag signal is unavailable', async () => {
        // No signal is not the same as "behind": without one, waiting longer is
        // indistinguishable from hanging, so the fixed deadline stands.
        const db = makeDb({ lag: null })
        const started = Date.now()
        const row = await db._waitFor(checkThing, {}, TIMEMAX)
        assert.strictEqual(row, null)
        assert(Date.now() - started < TIMEMAX * 3, 'null lag must not extend the wait')
    })

    it('keeps polling when the check throws', async () => {
        const db = makeDb({ lag: 0 })
        let calls = 0
        const row = await db._waitFor(function checkThing(){
            calls++
            if (calls < 2) throw new Error('transient DB error')
            return { id: 3 }
        }, {}, TIMEMAX)
        assert.deepStrictEqual(row, { id: 3 }, 'a transient error must not abort the wait')
    })

    it('_indexerLagBlocks returns null when no node connector is wired', async () => {
        const db = Object.create(Database.prototype)
        db.WAIT_LAG_PROBE_MS = 500
        const saved = global.nodeConnector
        delete global.nodeConnector
        try {
            assert.strictEqual(await db._indexerLagBlocks(), null)
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
            assert.strictEqual(await db._indexerLagBlocks(), 30)
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
            assert.strictEqual(await db._indexerLagBlocks(), null,
                'a failing lag probe must degrade to the fixed deadline, not blow up the wait')
        } finally {
            if (saved === undefined) delete global.nodeConnector; else global.nodeConnector = saved
        }
    })
})
