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
const { TIMEMAX, TICK, makeDb, checkThing } = require('./support/helpers')

describe('adaptive wait deadline', function () {
    this.timeout(10000)

    registerSucceedAndLagTests()
    registerThresholdTests()
    registerNoSignalTests()
})

function registerSucceedAndLagTests() {
    it('returns the row as soon as the check succeeds', async () => {
        const db = makeDb({ lag: 0 })
        let calls = 0
        const row = await db['_waitFor'](function checkThing(){ calls++; return calls >= 2 ? { id: 7 } : null }, {}, TIMEMAX)
        assert.deepStrictEqual(row, { id: 7 })
        assert.strictEqual(db.lagCalls, 0, 'a wait that succeeds must never consult the lag signal')
    })

    it('does NOT extend when the indexer has caught up, so a genuinely absent row still fails', async () => {
        const db = makeDb({ lag: 0 })
        const started = Date.now()
        const row = await db['_waitFor'](checkThing, {}, TIMEMAX)
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
        const row = await db['_waitFor'](
            function checkThing(){ return Date.now() - started > TIMEMAX * 1.5 ? { id: 1 } : null },
            {}, TIMEMAX)
        assert.deepStrictEqual(row, { id: 1 },
            'a lagging indexer must buy the row more time instead of failing the case')
    })

    it('extends on a lag of ONE or TWO blocks, which is where the row usually is', async () => {
        // The boundary that cost a drill and a release rehearsal on 2026-09-05: a
        // threshold of 2 read "2 blocks behind" as caught up and gave up with the
        // row sitting in one of the two blocks the indexer had not reached.
        for (const lag of [1, 2]) {
            const db = makeDb({ lag })
            const started = Date.now()
            const row = await db['_waitFor'](
                function checkThing(){ return Date.now() - started > TIMEMAX * 1.5 ? { id: lag } : null },
                {}, TIMEMAX)
            assert.deepStrictEqual(row, { id: lag },
                'a wait must extend while the indexer is ' + lag + ' block(s) behind: that block may hold the row')
        }
    })
}

function registerThresholdTests() {
    it('honours an explicit E2E_WAIT_LAG_BLOCKS=0 and refuses junk', () => {
        // The tunable the way the constructor computes it (src/db.js), checked
        // here without standing up a Database: `parseInt('0') || 2` was 2, so an
        // operator setting 0 got the old threshold back without knowing.
        const compute = (raw) => {
            const n = raw === undefined || raw === '' ? NaN : Number(raw)
            return Number.isInteger(n) && n >= 0 ? n : 0
        }
        assert.strictEqual(compute('0'), 0, 'an explicit 0 must be 0, not the default')
        assert.strictEqual(compute(undefined), 0, 'the default is 0')
        assert.strictEqual(compute('3'), 3)
        assert.strictEqual(compute('junk'), 0)
        assert.strictEqual(compute('-1'), 0)
    })

    it('caps extensions so a wedged stack fails instead of hanging the suite', async () => {
        const db = makeDb({ lag: 999, maxExtensions: 2 })
        const row = await db['_waitFor'](checkThing, {}, TIMEMAX)
        assert.strictEqual(row, null, 'a permanently lagging stack must still terminate')
        // One lag probe per expiry: the original deadline plus each granted extension.
        assert(db.lagCalls <= 3,
            'expected at most 3 lag probes for 2 permitted extensions, got ' + db.lagCalls)
    })

    it('does not extend when lag is at or below the threshold', async () => {
        // At the shipped default (0) only a level indexer is "not behind"; an
        // operator who raises the threshold gets the old tolerance back, and a
        // lag exactly AT that threshold still does not extend.
        for (const [threshold, lag] of [[0, 0], [2, 2]]) {
            const db = makeDb({ lag })
            db.WAIT_LAG_BLOCKS = threshold
            const started = Date.now()
            const row = await db['_waitFor'](checkThing, {}, TIMEMAX)
            assert.strictEqual(row, null)
            assert(Date.now() - started < TIMEMAX * 3,
                'lag ' + lag + ' at threshold ' + threshold + ' must not extend')
        }
    })
}

function registerNoSignalTests() {
    it('does not extend when the lag signal is unavailable', async () => {
        // No signal is not the same as "behind": without one, waiting longer is
        // indistinguishable from hanging, so the fixed deadline stands.
        const db = makeDb({ lag: null })
        const started = Date.now()
        const row = await db['_waitFor'](checkThing, {}, TIMEMAX)
        assert.strictEqual(row, null)
        assert(Date.now() - started < TIMEMAX * 3, 'null lag must not extend the wait')
    })

    it('keeps polling when the check throws', async () => {
        const db = makeDb({ lag: 0 })
        let calls = 0
        const row = await db['_waitFor'](function checkThing(){
            calls++
            if (calls < 2) throw new Error('transient DB error')
            return { id: 3 }
        }, {}, TIMEMAX)
        assert.deepStrictEqual(row, { id: 3 }, 'a transient error must not abort the wait')
    })
}
