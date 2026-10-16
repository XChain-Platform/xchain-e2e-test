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

const Database = require(process.env.XC701_DB_SRC || '../../../../src/db.js')

// Real time is used deliberately rather than a fake clock: _waitFor reads
// Date.now() directly, and the budgets here are small enough to keep the file
// fast while still exercising real deadline arithmetic.
const TIMEMAX = 60
const TICK    = 15

function makeDb({ lag = null, writes = null, lagReason, writesReason,
    maxExtensions = 3, probeEvery } = {}) {
    const db = Object.create(Database.prototype)
    db.sleep = () => new Promise(r => setTimeout(r, TICK))
    db['_recordPerfPoll'] = () => {}
    db.lagCalls = 0
    db['_pipelineProgress'] = async () => {
        db.lagCalls++
        const lagValue = typeof lag === 'function' ? lag(db.lagCalls) : lag
        const writeValue = typeof writes === 'function' ? writes(db.lagCalls) : writes
        return {
            lag: lagValue,
            lagReason: lagValue === null ? (lagReason || 'probe failed: test probe unavailable') : null,
            writes: writeValue,
            writesReason: writeValue === null
                ? (writesReason || 'probe failed: test probe unavailable')
                : null
        }
    }
    db.WAIT_MAX_EXTENSIONS = maxExtensions
    db.WAIT_LAG_BLOCKS = 0          // the shipped default: any unreached block may hold the row
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


function captureLog(fn){
    const lines = []
    const orig = console.log
    console.log = (...a) => lines.push(a.join(' '))
    return Promise.resolve(fn()).finally(() => { console.log = orig }).then(() => lines)
}

async function gaveUpFor(progress, configure){
    const db = makeDb()
    db['_pipelineProgress'] = async () => progress
    if (configure) configure(db)
    const lines = await captureLog(() => db['_waitFor'](checkThing, {}, TIMEMAX))
    return lines.find(l => l.includes('GAVE UP'))
}

module.exports = {
    Database, TIMEMAX, TICK, makeDb, checkThing, withConnector, dbWithRows, captureLog, gaveUpFor
}
