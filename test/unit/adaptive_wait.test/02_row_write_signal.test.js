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

// 6-7 polls per budget, samples every other poll: enough history for the
// deadline to ask whether rows landed recently.
const SLOW = TICK * 7
const EVERY = TICK * 2

describe('adaptive wait deadline', function () {
    this.timeout(10000)

    // Signal change. Every observed failure was a wait for a ROW while the
    // indexer kept pace with blocks, so lag read zero, no extension was granted and
    // the case failed on a row that turned up in the database moments later. Lag
    // alone cannot see a stack that is busy but not behind; action-row writes can.
    describe('row-write signal', registerRowWriteSignalTests)
})

function registerRowWriteSignalTests() {
    it('extends when the indexer is NOT behind but is still writing action rows', async () => {
        let mark = 1000
        const db = makeDb({ lag: 0, writes: () => ++mark, probeEvery: EVERY })
        const started = Date.now()
        const row = await db['_waitFor'](
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
        const row = await db['_waitFor'](checkThing, {}, SLOW)
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
        const row = await db['_waitFor'](checkThing, {}, SLOW)
        assert.strictEqual(row, null)
        assert(Date.now() - started < SLOW * 3,
            'a stale advance must not keep buying extensions (elapsed ' + (Date.now() - started) + 'ms)')
    })

    it('caps extensions even while writes keep advancing', async () => {
        let mark = 0
        const db = makeDb({ lag: 0, writes: () => ++mark, maxExtensions: 2, probeEvery: EVERY })
        const started = Date.now()
        const row = await db['_waitFor'](checkThing, {}, SLOW)
        assert.strictEqual(row, null, 'a permanently busy stack must still terminate')
        assert(Date.now() - started < SLOW * 5,
            'the extension cap must bound a busy stack too (elapsed ' + (Date.now() - started) + 'ms)')
    })

    it('ignores the write signal on waits too short to qualify for an extension', async () => {
        let mark = 0
        const db = makeDb({ lag: 0, writes: () => ++mark, probeEvery: EVERY })
        db.WAIT_MIN_FOR_EXTENSION = 10000   // far above SLOW
        const started = Date.now()
        const row = await db['_waitFor'](checkThing, {}, SLOW)
        assert.strictEqual(row, null)
        assert.strictEqual(db.lagCalls, 0, 'an ineligible wait must not probe at all')
        assert(Date.now() - started < SLOW * 2, 'an ineligible wait must not be extended')
    })
}
