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
 * XChain E2E Performance Collector
 *
 * Global singleton that collects performance metrics during test runs.
 * Used by:
 *   - src/db.js (poll tracking via recordPoll)
 *   - test/initialCheck.test.js (bootstrap phase timing via phase)
 *   - test/reporters/performance-reporter.js (reads collected data)
 *
 ********************************************************************/

const PerfCollector = {
    bootstrapPhases: [],
    pollMetrics: [],

    _runMeta: {
        startedAt: null,
        coin: null,
        network: null,
        nodeVersion: process.version,
        platform: process.platform
    },

    startRun() {
        this._runMeta.startedAt = Date.now()
        this._runMeta.coin = process.env.COIN || null
        this._runMeta.network = process.env.NETWORK || null
    },

    async phase(name, asyncFn) {
        const start = process.hrtime.bigint()
        const startMs = Date.now()
        try {
            return await asyncFn()
        } finally {
            const durationNs = process.hrtime.bigint() - start
            this.bootstrapPhases.push({
                name,
                startMs,
                endMs: Date.now(),
                durationMs: Number(durationNs) / 1e6
            })
        }
    },

    recordPoll({ method, startMs, endMs, polls, resolved }) {
        this.pollMetrics.push({
            method,
            startMs,
            endMs,
            durationMs: endMs - startMs,
            polls,
            resolved
        })
    },

    reset() {
        this.bootstrapPhases = []
        this.pollMetrics = []
        this._runMeta.startedAt = null
    },

    toJSON() {
        return {
            meta: this._runMeta,
            bootstrapPhases: this.bootstrapPhases,
            pollMetrics: this.pollMetrics
        }
    }
}

module.exports = PerfCollector
