/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * Adaptive row wait: _waitFor and the pipeline progress probes
 *
 ********************************************************************/

const { logger, insideWaitPoll } = require('./shared')

class WaitMethods {
    // ─── Generic waitFor wrapper ───────────────────────────────────────
    // Default 60s (was 30s). Under full-suite load (especially the OWNERSHIP
    // suite right after ORDER's 7-test pile of MINTs/SENDs/ORDERs) the indexer
    // sometimes needs >30s to write an ORDER row (match-scan + balance/token
    // updates fan out per insert). 60s absorbs that without masking real
    // assertion failures, which surface as null on a row that was never written.
    // Every waitForX in this file routes through here, so this is the one
    // place that decides how long a suite is willing to wait for a row.
    //
    // A fixed deadline silently assumes a quiet machine. Under concurrent load the
    // indexer falls behind the chain and a row that WILL arrive gets reported
    // missing purely because the indexer had not reached its block yet. That is
    // what made the dispenser suite fail a DIFFERENT case on every full run while
    // each one passed in isolation, and it reads like a product defect rather than
    // a slow venue: the action is later found in the database, correct.
    //
    // The tempting signal, "the chain is still advancing", is WRONG here: the
    // regtest miner mines continuously, so it is always true and the wait would
    // never end. Two signals ARE safe, because each one goes quiet exactly when
    // waiting longer stops being useful:
    //
    //   1. indexer LAG. The indexer has not reached the block our row would be in,
    //      so the row cannot exist yet. Falls to zero when the indexer catches up.
    //   2. action-row WRITES. MAX(action_index) is still climbing, so the indexer
    //      is chewing through real work and our row may be in the queue behind it.
    //      This is the signal lag cannot see, and the one the observed failures
    //      needed: every one of them was a wait for a ROW while the indexer kept
    //      pace with blocks, so lag read zero and bought no time. Crucially this is
    //      NOT the rejected "chain is advancing" signal: the miner's empty regtest
    //      blocks carry no actions, so an idle stack does not move this mark and a
    //      genuinely absent row still fails on the original deadline.
    //
    // Neither signal can be sampled once at the deadline: "still writing" is a
    // comparison, so the wait samples progress periodically while it runs and asks
    // at the deadline whether rows landed recently.
    //
    // Considered and rejected as a third signal: a non-empty mempool (the
    // confirmation-latency case). A single stuck transaction would hold it true
    // forever and inflate every genuine failure to the full extension budget, and
    // unlike the other two it never goes quiet on its own.
    //
    // Extensions are capped so a wedged stack still fails a suite instead of
    // hanging it forever, and each one is logged so a slow run stays diagnosable
    // after the fact.
    async ['_waitFor'](checkFn, params, timeMax = 60000){
        const wait = this['_newWaitState'](checkFn, timeMax)
        while (Date.now() < wait.deadline){
            wait.polls++
            const row = await this['_pollOnce'](checkFn, params, wait)
            if (row){
                this['_recordPerfPoll'](wait.label, wait.startMs, wait.polls, true)
                return row
            }
            await this.sleep(1000)
            await this['_maybeExtend'](wait)
        }
        this['_recordPerfPoll'](wait.label, wait.startMs, wait.polls, false)
        this['_logGaveUp'](wait)
        this['_failIfNeverAnswered'](wait)
        return null
    }

    // Everything one wait tracks between polls. Only waits that were meant to be
    // long can be extended: short waits are callers polling for something that
    // should be immediate, and probing on their behalf costs more than it can
    // ever save.
    ['_newWaitState'](checkFn, timeMax){
        const startMs = Date.now()
        // Sample often enough that even a short eligible wait gets two samples to
        // compare, since one sample carries no write signal at all.
        const probeEvery = Math.max(this.WAIT_PROBE_MIN_MS,
                                    Math.min(this.WAIT_PROBE_INTERVAL_MS, Math.floor(timeMax / 3)))
        return {
            startMs, timeMax, probeEvery,
            label:       checkFn.name || 'unknown',
            deadline:    startMs + timeMax,
            eligible:    timeMax >= this.WAIT_MIN_FOR_EXTENSION,
            writeIdleMs: Math.max(this.WAIT_WRITE_IDLE_MS, probeEvery * 2),
            nextProbeAt: startMs + probeEvery,
            extensions: 0, polls: 0,
            // Retained for the give-up report: the last answers the probe gave
            // (null means it could not answer) and whether it was ever consulted.
            lastLag: null, lagReason: null, probes: 0,
            writeMark: null,   // highest action_index the indexer has written
            lastWrites: null, writeReason: null,
            writeMoved: null,  // when that mark last advanced
            // Polls whose check answered (row or no row) versus threw, kept so a
            // wait whose database never answered cannot give up as if the row
            // were absent.
            answered: 0, errored: 0, lastErr: null
        }
    }

    async ['_pollOnce'](checkFn, params, wait){
        try {
            const row = await insideWaitPoll.run(true, () => checkFn.call(this, params))
            wait.answered++
            return row
        } catch(err) {
            wait.errored++
            wait.lastErr = err
            logger.info(err)
            return null
        }
    }

    // Sample progress when due and, once the deadline passes, extend it if the
    // indexer is behind or still writing.
    async ['_maybeExtend'](wait){
        if (!wait.eligible) return
        const expired = Date.now() >= wait.deadline
        // Budget spent: stop probing and let the loop end, so a wedged stack
        // fails on time instead of paying for advice it can no longer act on.
        if (expired && wait.extensions >= this.WAIT_MAX_EXTENSIONS) return
        if (!expired && Date.now() < wait.nextProbeAt) return

        this['_noteProgress'](wait, await this['_pipelineProgress']())
        if (!expired) return

        const behind  = wait.lastLag !== null && wait.lastLag > this.WAIT_LAG_BLOCKS
        const writing = wait.writeMoved !== null && (Date.now() - wait.writeMoved) <= wait.writeIdleMs
        if (!behind && !writing) return
        wait.extensions++
        wait.deadline = Date.now() + wait.timeMax
        logger.info(wait.label + ': '
            + (behind
                ? 'indexer is ' + wait.lastLag + ' blocks behind the chain tip'
                : 'indexer is still writing action rows (index ' + wait.writeMark + ')')
            + '; extending the wait (' + wait.extensions + '/' + this.WAIT_MAX_EXTENSIONS + ')')
    }

    ['_noteProgress'](wait, progress){
        wait.probes++
        wait.nextProbeAt = Date.now() + wait.probeEvery
        wait.lastLag = progress.lag
        wait.lagReason = progress.lagReason
        wait.lastWrites = progress.writes
        wait.writeReason = progress.writesReason
        if (progress.writes === null) return
        if (wait.writeMark !== null && progress.writes > wait.writeMark) wait.writeMoved = Date.now()
        if (wait.writeMark === null || progress.writes > wait.writeMark) wait.writeMark = progress.writes
    }

    // A timed-out wait must say WHY it gave up, because the diagnosis
    // this feeds turns on a distinction the old code could not express.
    //
    // Extensions were logged only when GRANTED, so the "no extension was
    // granted" case emitted nothing at all, and the ledger's own next step
    // ("if this recurs with extensions=0, change the SIGNAL, not the budget")
    // was unfalsifiable: zero lines is what a never-eligible wait, a
    // zero-lag wait and an unreachable probe all look like. Silence read as
    // evidence when it was the absence of evidence.
    //
    // The states are distinguishable by name:
    //   lag N > 0    the indexer had not reached the row's block
    //   lag 0        the indexer kept pace with the chain, so the write signal
    //                below is the one that decided this wait
    //   lag null     the probe could not answer, so the fixed deadline stood
    //   not eligible timeMax below the extension floor
    // and the write signal says whether rows were still landing at give-up time,
    // which separates "the stack is busy and we ran out of budget" from "the
    // stack was idle and the row is genuinely absent".
    ['_logGaveUp'](wait){
        logger.info(wait.label + ': GAVE UP after ' + (Date.now() - wait.startMs) + 'ms'
            + ' (' + wait.polls + ' polls, ' + wait.extensions + '/' + this.WAIT_MAX_EXTENSIONS + ' extensions, '
            + 'timeMax ' + wait.timeMax + 'ms, '
            + this['_describeProbe'](wait)
            + ', ' + wait.errored + ' of ' + wait.polls + ' polls errored)')
    }

    ['_describeProbe'](wait){
        if (!wait.eligible)
            return 'last indexer lag unavailable (probe was never run because the wait was not eligible for extension)'
                + ', action writes unavailable (probe was never run because the wait was not eligible for extension)'
        if (wait.probes === 0)
            return 'last indexer lag unavailable (probe was never run before give-up)'
                + ', action writes unavailable (probe was never run before give-up)'
        return 'last indexer lag ' + (wait.lastLag === null ? 'unavailable (' + wait.lagReason + ')' : wait.lastLag + ' blocks')
            + ', action writes ' + (wait.lastWrites === null
                ? 'unavailable (' + wait.writeReason + ')'
                : wait.writeMoved === null
                    ? 'idle at index ' + wait.writeMark
                    : 'last advanced ' + (Date.now() - wait.writeMoved) + 'ms ago (index ' + wait.writeMark + ')')
    }

    // Refuse to read "never answered" as "absent": a null here would pass every
    // assertion that the row does not exist, against a query that never ran.
    ['_failIfNeverAnswered'](wait){
        if (wait.answered !== 0 || wait.errored === 0) return
        const err = new Error(wait.label + ': no poll answered in ' + (Date.now() - wait.startMs) + 'ms ('
            + wait.polls + ' polls, all errored); last error: ' + (wait.lastErr && wait.lastErr.message))
        err.code  = 'WAIT_NO_ANSWER'
        err.cause = wait.lastErr
        throw err
    }

    // One sample of how far along the pipeline is, for the two signals _waitFor
    // extends on:
    //   lag    blocks the indexer still has to process before it could see our row
    //   writes the highest action_index it has written, whose movement between
    //          samples is what "the indexer is busy but not behind" looks like
    // Either field is null when it is not observable (no node connector wired, RPC
    // down, empty table, probe timed out), and null deliberately disables that
    // signal so the fixed deadline stands: without progress, waiting longer is
    // indistinguishable from hanging.
    async ['_pipelineProgress'](){
        if (!this.pool) return {
            lag: null, lagReason: 'no database pool wired',
            writes: null, writesReason: 'no database pool wired'
        }
        // The probe is an optimisation, never a reason to block. If it cannot answer
        // promptly the fixed deadline stands, so a probe that hangs costs one timeout
        // rather than stalling the suite. Learned the hard way: the first cut called
        // this.getConnection(), which retries until a connection appears.
        const unavailable = reason => ({
            lag: null, lagReason: reason,
            writes: null, writesReason: reason
        })
        const capped = new Promise(resolve => setTimeout(() =>
            resolve(unavailable('probe timed out')), this.WAIT_LAG_PROBE_MS))
        const measured = this['_probePipeline']().then(progress => ({
            lag: progress.lag,
            lagReason: progress.lag === null
                ? (!global.nodeConnector || typeof global.nodeConnector.getBlockCount !== 'function'
                    ? 'no node connector wired'
                    : 'blocks table held no rows')
                : null,
            writes: progress.writes,
            writesReason: progress.writes === null ? 'actions table held no rows' : null
        })).catch(err => {
            const message = err && typeof err.message === 'string' && err.message
                ? err.message
                : 'no error message'
            this['_warnProbeFailed']({ message })
            return unavailable('probe failed: ' + message)
        })
        return Promise.race([measured, capped])
    }

    // A probe that can never answer degrades every wait back to a fixed deadline
    // and says nothing about it, which is how this item's mechanism went unproven
    // for a week. Say it once per Database, not once per poll: a wait polls every
    // second and the point is a visible cause, not a flooded log.
    ['_warnProbeFailed'](err){
        if (this['_probeWarned']) return
        this['_probeWarned'] = true
        logger.info('_pipelineProgress: probe unavailable (' + (err && err.message ? err.message : err) + '); '
            + 'waits fall back to the fixed deadline')
    }

    async ['_probePipeline'](){
        let chainTip = null
        if (global.nodeConnector && typeof global.nodeConnector.getBlockCount === 'function'){
            const count = Number(await global.nodeConnector.getBlockCount())
            if (Number.isFinite(count)) chainTip = count
        }
        const conn = await this.pool.getConnection()
        try {
            // Both marks in one round trip: each is an index-only MAX, and a wait
            // that samples twice as often must not cost twice as much.
            const rows = await conn.query('SELECT (SELECT MAX(block_index) FROM blocks) AS tip, '
                + '(SELECT MAX(action_index) FROM actions) AS writes')
            const row    = rows && rows.length ? rows[0] : null
            const tip    = this['_finiteOrNull'](row ? row.tip : null)
            const writes = this['_finiteOrNull'](row ? row.writes : null)
            return {
                lag:    (chainTip !== null && tip !== null) ? chainTip - tip : null,
                writes: writes
            }
        } finally {
            await conn.release().catch(() => {})
        }
    }

    ['_finiteOrNull'](value){
        if (value === null || value === undefined) return null
        const n = Number(value)
        return Number.isFinite(n) ? n : null
    }

    // Kept as the named single-signal view: callers and tests that only care how far
    // behind the indexer is should not have to know the probe carries two marks.
    async ['_indexerLagBlocks'](){
        const progress = await this['_pipelineProgress']()
        return progress ? progress.lag : null
    }
}

module.exports = WaitMethods
