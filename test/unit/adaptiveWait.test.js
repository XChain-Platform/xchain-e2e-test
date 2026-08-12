// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// Every waitForX in src/db.js routes through _waitFor, so these pin the
// one place that decides how long a suite waits for a row.
//
// The defect being fixed: a fixed deadline assumes a quiet machine. Under
// concurrent load the indexer falls behind the chain and a row that WILL arrive is
// reported missing because the indexer had not reached its block yet. The
// dispenser suite failed a DIFFERENT case on every full run while each passed in
// isolation, and the action was afterwards found in the database, correct.
//
// The rule these tests hold in place is that extending is conditional on evidence
// the row may still be coming: the indexer is BEHIND the chain, or it is still
// writing action rows. "The chain is advancing" would be the wrong condition,
// since the regtest miner mines continuously and the wait would never end; empty
// blocks write no actions, which is what keeps the write signal honest.

const assert   = require('assert')
const Database = require(process.env.XC701_DB_SRC || '../../src/db.js')

// Real time is used deliberately rather than a fake clock: _waitFor reads
// Date.now() directly, and the budgets here are small enough to keep the file
// fast while still exercising real deadline arithmetic.
const TIMEMAX = 60
const TICK    = 15

function makeDb({ lag = null, writes = null, maxExtensions = 3, probeEvery } = {}) {
    const db = Object.create(Database.prototype)
    db.sleep = () => new Promise(r => setTimeout(r, TICK))
    db._recordPerfPoll = () => {}
    db.lagCalls = 0
    db._pipelineProgress = async () => {
        db.lagCalls++
        return {
            lag:    typeof lag    === 'function' ? lag(db.lagCalls)    : lag,
            writes: typeof writes === 'function' ? writes(db.lagCalls) : writes
        }
    }
    db.WAIT_MAX_EXTENSIONS = maxExtensions
    db.WAIT_LAG_BLOCKS = 2
    db.WAIT_MIN_FOR_EXTENSION = 0   // these budgets are tiny by design; opt in to extension
    db.WAIT_LAG_PROBE_MS = 500
    // Sampling floor. Left above these tiny budgets unless a test asks for
    // mid-wait samples, so a lag-only case probes at its deadline and nowhere else.
    db.WAIT_PROBE_MIN_MS = probeEvery || 10000
    db.WAIT_PROBE_INTERVAL_MS = probeEvery || 10000
    db.WAIT_WRITE_IDLE_MS = probeEvery ? probeEvery * 4 : 20000
    return db
}

// Named so _waitFor's perf label (checkFn.name) is exercised too.
function checkThing() { return null }

describe('adaptive wait deadline', function () {
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

    // Signal change. Every observed failure was a wait for a ROW while the
    // indexer kept pace with blocks, so lag read zero, no extension was granted and
    // the case failed on a row that turned up in the database moments later. Lag
    // alone cannot see a stack that is busy but not behind; action-row writes can.
    describe('row-write signal', () => {
        // 6-7 polls per budget, samples every other poll: enough history for the
        // deadline to ask whether rows landed recently.
        const SLOW = TICK * 7
        const EVERY = TICK * 2

        it('extends when the indexer is NOT behind but is still writing action rows', async () => {
            let mark = 1000
            const db = makeDb({ lag: 0, writes: () => ++mark, probeEvery: EVERY })
            const started = Date.now()
            const row = await db._waitFor(
                function checkThing(){ return Date.now() - started > SLOW * 1.4 ? { id: 9 } : null },
                {}, SLOW)
            assert.deepStrictEqual(row, { id: 9 },
                'a busy-but-caught-up indexer must buy the row more time; this is the case '
                + 'the lag-only signal could not see')
        })

        it('does not extend when action writes have stopped, so an absent row still fails', async () => {
            // An idle regtest stack still mines, but empty blocks write no actions,
            // so the mark stands still and the original deadline holds.
            const db = makeDb({ lag: 0, writes: 4242, probeEvery: EVERY })
            const started = Date.now()
            const row = await db._waitFor(checkThing, {}, SLOW)
            assert.strictEqual(row, null)
            assert(Date.now() - started < SLOW * 2,
                'a stalled write mark must not extend the wait (elapsed ' + (Date.now() - started) + 'ms)')
        })

        it('stops extending once writes go quiet, rather than riding an old advance', async () => {
            // Rows land early in the wait and then stop. The wait must not treat a
            // long-past advance as evidence the row is still coming.
            let calls = 0
            const db = makeDb({ lag: 0, writes: () => (++calls <= 2 ? 1000 + calls : 1002), probeEvery: EVERY })
            db.WAIT_WRITE_IDLE_MS = EVERY   // "recent" means within one sample here
            const started = Date.now()
            const row = await db._waitFor(checkThing, {}, SLOW)
            assert.strictEqual(row, null)
            assert(Date.now() - started < SLOW * 3,
                'a stale advance must not keep buying extensions (elapsed ' + (Date.now() - started) + 'ms)')
        })

        it('caps extensions even while writes keep advancing', async () => {
            let mark = 0
            const db = makeDb({ lag: 0, writes: () => ++mark, maxExtensions: 2, probeEvery: EVERY })
            const started = Date.now()
            const row = await db._waitFor(checkThing, {}, SLOW)
            assert.strictEqual(row, null, 'a permanently busy stack must still terminate')
            assert(Date.now() - started < SLOW * 5,
                'the extension cap must bound a busy stack too (elapsed ' + (Date.now() - started) + 'ms)')
        })

        it('ignores the write signal on waits too short to qualify for an extension', async () => {
            let mark = 0
            const db = makeDb({ lag: 0, writes: () => ++mark, probeEvery: EVERY })
            db.WAIT_MIN_FOR_EXTENSION = 10000   // far above SLOW
            const started = Date.now()
            const row = await db._waitFor(checkThing, {}, SLOW)
            assert.strictEqual(row, null)
            assert.strictEqual(db.lagCalls, 0, 'an ineligible wait must not probe at all')
            assert(Date.now() - started < SLOW * 2, 'an ineligible wait must not be extended')
        })
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

    describe('_pipelineProgress', () => {
        function withConnector(connector, fn){
            const saved = global.nodeConnector
            if (connector === undefined) delete global.nodeConnector; else global.nodeConnector = connector
            return Promise.resolve(fn()).finally(() => {
                if (saved === undefined) delete global.nodeConnector; else global.nodeConnector = saved
            })
        }

        function dbWithRows(rows){
            const db = Object.create(Database.prototype)
            db.WAIT_LAG_PROBE_MS = 500
            db.queries = []
            db.pool = { getConnection: async () => ({
                query:   async (sql) => { db.queries.push(sql); return rows },
                release: async () => {}
            }) }
            return db
        }

        it('reports lag and the action-write mark from one round trip', async () => {
            const db = dbWithRows([{ tip: 4970, writes: 88123 }])
            await withConnector({ getBlockCount: async () => 5000 }, async () => {
                assert.deepStrictEqual(await db._pipelineProgress(), { lag: 30, writes: 88123 })
            })
            assert.strictEqual(db.queries.length, 1,
                'sampling twice as often must not cost twice as many round trips')
        })

        it('still reports writes when the chain tip is not observable', async () => {
            // No node connector means no lag signal, but the write signal does not
            // need the chain: it is exactly the case lag cannot cover.
            const db = dbWithRows([{ tip: 4970, writes: 5 }])
            await withConnector(undefined, async () => {
                assert.deepStrictEqual(await db._pipelineProgress(), { lag: null, writes: 5 })
            })
        })

        it('reports nulls, not NaN, on an empty database', async () => {
            const db = dbWithRows([{ tip: null, writes: null }])
            await withConnector({ getBlockCount: async () => 5000 }, async () => {
                assert.deepStrictEqual(await db._pipelineProgress(), { lag: null, writes: null })
            })
        })

        it('degrades to nulls rather than throwing when the probe fails', async () => {
            const db = Object.create(Database.prototype)
            db.WAIT_LAG_PROBE_MS = 500
            db.pool = { getConnection: async () => { throw new Error('pool exhausted') } }
            await withConnector({ getBlockCount: async () => 5000 }, async () => {
                assert.deepStrictEqual(await db._pipelineProgress(), { lag: null, writes: null })
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
                    await db._pipelineProgress()
                    await db._pipelineProgress()
                    await db._pipelineProgress()
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
                assert.deepStrictEqual(await db._pipelineProgress(), { lag: null, writes: null })
                assert(Date.now() - started < 1000, 'the probe must be time-capped')
            })
        })
    })

    // Diagnosability. Extensions were logged only when GRANTED, so a wait
    // that gave up without one emitted nothing, and the guidance
    // ("if this recurs with extensions=0, change the SIGNAL, not the budget") could
    // not be evaluated from a run's output: zero lines is what a never-eligible
    // wait, a zero-lag wait and a dead probe all look like. These pin the three
    // apart by name, so the next failing run says which case it was.
    describe('give-up diagnostics', () => {
        function captureLog(fn){
            const lines = []
            const orig = console.log
            console.log = (...a) => lines.push(a.join(' '))
            return Promise.resolve(fn()).finally(() => { console.log = orig }).then(() => lines)
        }

        it('reports zero lag distinctly, which is the case the current signal cannot see', async () => {
            const db = makeDb({ lag: 0 })
            const lines = await captureLog(() => db._waitFor(checkThing, {}, TIMEMAX))
            const gaveUp = lines.find(l => l.includes('GAVE UP'))
            assert(gaveUp, 'a timed-out wait must report why it gave up')
            assert(/checkThing/.test(gaveUp), 'the report names the wait')
            assert(/0\/3 extensions/.test(gaveUp), 'the report carries the extension count')
            assert(/last indexer lag 0 blocks/.test(gaveUp),
                'zero lag must be stated, not implied by silence: ' + gaveUp)
        })

        it('reports whether action rows were still landing when it gave up', async () => {
            // Separates "the stack was busy and we ran out of budget" from "the stack
            // was idle and the row is genuinely absent", which read identically before.
            const db = makeDb({ lag: 0, writes: 7777 })
            const lines = await captureLog(() => db._waitFor(checkThing, {}, TIMEMAX))
            const gaveUp = lines.find(l => l.includes('GAVE UP'))
            assert(/action writes idle at index 7777/.test(gaveUp),
                'a stalled write mark must be named in the give-up report: ' + gaveUp)
        })

        it('names the extension it granted for writes, not for lag', async () => {
            let mark = 500
            const db = makeDb({ lag: 0, writes: () => ++mark, maxExtensions: 1, probeEvery: TICK * 2 })
            const lines = await captureLog(() => db._waitFor(checkThing, {}, TICK * 7))
            const granted = lines.find(l => l.includes('extending the wait'))
            assert(granted, 'a write-driven extension must be logged like a lag-driven one')
            assert(/still writing action rows/.test(granted),
                'the log must say which signal bought the time: ' + granted)
        })

        it('distinguishes a probe that could not answer from a zero-lag probe', async () => {
            const db = makeDb({ lag: null })
            const lines = await captureLog(() => db._waitFor(checkThing, {}, TIMEMAX))
            const gaveUp = lines.find(l => l.includes('GAVE UP'))
            assert(/probe failed/.test(gaveUp), 'an unanswerable probe must say so: ' + gaveUp)
        })

        it('says when the wait was too short to ever qualify for an extension', async () => {
            const db = makeDb({ lag: 0 })
            db.WAIT_MIN_FOR_EXTENSION = 10000   // far above TIMEMAX
            const lines = await captureLog(() => db._waitFor(checkThing, {}, TIMEMAX))
            const gaveUp = lines.find(l => l.includes('GAVE UP'))
            assert(/not eligible for extension/.test(gaveUp),
                'an ineligible wait must not be reported as a zero-lag one: ' + gaveUp)
        })

        it('stays silent on the success path, so the log only grows when something went wrong', async () => {
            const db = makeDb({ lag: 0 })
            const lines = await captureLog(() =>
                db._waitFor(function checkThing(){ return { id: 1 } }, {}, TIMEMAX))
            assert.strictEqual(lines.filter(l => l.includes('GAVE UP')).length, 0)
        })
    })
})
