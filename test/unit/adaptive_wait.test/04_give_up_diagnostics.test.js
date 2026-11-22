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
const { Database, TIMEMAX, TICK, makeDb, checkThing, captureLog, gaveUpFor } = require('./support/helpers')

describe('adaptive wait deadline', function () {
    this.timeout(10000)

    // Diagnosability. Extensions were logged only when GRANTED, so a wait
    // that gave up without one emitted nothing, and the guidance
    // ("if this recurs with extensions=0, change the SIGNAL, not the budget") could
    // not be evaluated from a run's output: zero lines is what a never-eligible
    // wait, a zero-lag wait and a dead probe all look like. These pin the three
    // apart by name, so the next failing run says which case it was.
    describe('give-up diagnostics', () => {
        registerGiveUpSignalTests()
        registerGiveUpReasonTests()
        registerGiveUpEligibilityTests()
    })
})

function registerGiveUpSignalTests() {
    it('reports zero lag distinctly, which is the case the current signal cannot see', async () => {
        const db = makeDb({ lag: 0 })
        const lines = await captureLog(() => db['_waitFor'](checkThing, {}, TIMEMAX))
        const gaveUp = lines.find(l => l.includes('GAVE UP'))
        assert(gaveUp, 'a timed-out wait must report why it gave up')
        assert(/checkThing/.test(gaveUp), 'the report names the wait')
        assert(/0\/3 extensions/.test(gaveUp), 'the report carries the extension count')
        assert(/last indexer lag 0 blocks/.test(gaveUp),
            'zero lag must be stated, not implied by silence: ' + gaveUp)
    })

    it('preserves polls, extensions and timeMax in their established order', async () => {
        const gaveUp = await gaveUpFor({
            lag: 0, lagReason: null, writes: 0, writesReason: null
        })
        assert(/GAVE UP after \d+ms \(\d+ polls, 0\/3 extensions, timeMax 60ms, /.test(gaveUp),
            'the stable diagnostic fields changed shape or order: ' + gaveUp)
    })

    it('reports whether action rows were still landing when it gave up', async () => {
        // Separates "the stack was busy and we ran out of budget" from "the stack
        // was idle and the row is genuinely absent", which read identically before.
        const db = makeDb({ lag: 0, writes: 7777 })
        const lines = await captureLog(() => db['_waitFor'](checkThing, {}, TIMEMAX))
        const gaveUp = lines.find(l => l.includes('GAVE UP'))
        assert(/action writes idle at index 7777/.test(gaveUp),
            'a stalled write mark must be named in the give-up report: ' + gaveUp)
    })

    it('names the extension it granted for writes, not for lag', async () => {
        let mark = 500
        const db = makeDb({ lag: 0, writes: () => ++mark, maxExtensions: 1, probeEvery: TICK * 2 })
        const lines = await captureLog(() => db['_waitFor'](checkThing, {}, TICK * 7))
        const granted = lines.find(l => l.includes('extending the wait'))
        assert(granted, 'a write-driven extension must be logged like a lag-driven one')
        assert(/still writing action rows/.test(granted),
            'the log must say which signal bought the time: ' + granted)
    })

    it('distinguishes a probe that could not answer from a zero-lag probe', async () => {
        const db = makeDb({ lag: null })
        const lines = await captureLog(() => db['_waitFor'](checkThing, {}, TIMEMAX))
        const gaveUp = lines.find(l => l.includes('GAVE UP'))
        assert(/probe failed: test probe unavailable/.test(gaveUp),
            'an unanswerable probe must say so: ' + gaveUp)
    })
}

function registerGiveUpReasonTests() {
    it('names a missing database pool for each signal', async () => {
        const gaveUp = await gaveUpFor({
            lag: null, lagReason: 'no database pool wired',
            writes: null, writesReason: 'no database pool wired'
        })
        assert(/last indexer lag unavailable \(no database pool wired\)/.test(gaveUp), gaveUp)
        assert(/action writes unavailable \(no database pool wired\)/.test(gaveUp), gaveUp)
    })

    it('names a missing node connector without hiding a readable action mark', async () => {
        const gaveUp = await gaveUpFor({
            lag: null, lagReason: 'no node connector wired',
            writes: 0, writesReason: null
        })
        assert(/last indexer lag unavailable \(no node connector wired\)/.test(gaveUp), gaveUp)
        assert(/action writes idle at index 0/.test(gaveUp), gaveUp)
    })

    it('names each empty table independently', async () => {
        const gaveUp = await gaveUpFor({
            lag: null, lagReason: 'blocks table held no rows',
            writes: null, writesReason: 'actions table held no rows'
        })
        assert(/last indexer lag unavailable \(blocks table held no rows\)/.test(gaveUp), gaveUp)
        assert(/action writes unavailable \(actions table held no rows\)/.test(gaveUp), gaveUp)
    })

    it('names a timed-out probe for each signal', async () => {
        const gaveUp = await gaveUpFor({
            lag: null, lagReason: 'probe timed out',
            writes: null, writesReason: 'probe timed out'
        })
        assert(/last indexer lag unavailable \(probe timed out\)/.test(gaveUp), gaveUp)
        assert(/action writes unavailable \(probe timed out\)/.test(gaveUp), gaveUp)
    })
}

function registerGiveUpEligibilityTests() {
    it('reduces a thrown probe value to its message without logging the object', async () => {
        const db = makeDb()
        db['_pipelineProgress'] = Database.prototype['_pipelineProgress']
        db.pool = { getConnection: async () => {
            throw { message: 'safe probe failure', toString: () => 'connection object with secret' }
        } }
        const saved = global.nodeConnector
        global.nodeConnector = { getBlockCount: async () => 1 }
        let lines
        try {
            lines = await captureLog(() => db['_waitFor'](checkThing, {}, TIMEMAX))
        } finally {
            if (saved === undefined) delete global.nodeConnector; else global.nodeConnector = saved
        }
        const gaveUp = lines.find(l => l.includes('GAVE UP'))
        assert(/probe failed: safe probe failure/.test(gaveUp), gaveUp)
        assert(!lines.join('\n').includes('connection object with secret'),
            'the thrown object reached the log: ' + JSON.stringify(lines))
    })

    it('says when the wait was too short to ever qualify for an extension', async () => {
        const db = makeDb({ lag: 0 })
        db.WAIT_MIN_FOR_EXTENSION = 10000   // far above TIMEMAX
        const lines = await captureLog(() => db['_waitFor'](checkThing, {}, TIMEMAX))
        const gaveUp = lines.find(l => l.includes('GAVE UP'))
        assert(/probe was never run because the wait was not eligible for extension/.test(gaveUp),
            'an ineligible wait must not be reported as a zero-lag one: ' + gaveUp)
    })

    it('says when an eligible wait exhausted its budget before any probe ran', async () => {
        const db = makeDb({ maxExtensions: 0 })
        const lines = await captureLog(() => db['_waitFor'](checkThing, {}, TIMEMAX))
        const gaveUp = lines.find(l => l.includes('GAVE UP'))
        assert(/probe was never run before give-up/.test(gaveUp),
            'an unrun eligible probe needs its own reason: ' + gaveUp)
    })

    it('stays silent on the success path, so the log only grows when something went wrong', async () => {
        const db = makeDb({ lag: 0 })
        const lines = await captureLog(() =>
            db['_waitFor'](function checkThing(){ return { id: 1 } }, {}, TIMEMAX))
        assert.strictEqual(lines.filter(l => l.includes('GAVE UP')).length, 0)
    })
}
