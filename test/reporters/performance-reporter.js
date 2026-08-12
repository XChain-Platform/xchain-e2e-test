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
 * XChain E2E Performance Reporter
 *
 * Custom Mocha reporter that captures per-test timing, memory usage,
 * and poll metrics, writing results to a JSON file in perf-results/.
 *
 * Embeds the Spec reporter for human-readable console output.
 *
 * Usage:
 *   mocha --reporter ./test/reporters/performance-reporter.js ...
 *
 ********************************************************************/

'use strict'

const Spec = require('mocha/lib/reporters/spec')
const fs = require('fs')
const path = require('path')
const constants = require('mocha/lib/runner').constants

const {
    EVENT_RUN_BEGIN,
    EVENT_RUN_END,
    EVENT_TEST_BEGIN,
    EVENT_TEST_END
} = constants

function PerformanceReporter(runner, options) {
    // Embed the Spec reporter for normal console output
    Spec.call(this, runner, options)

    const testStartTimes = new Map()
    const testMemStart = new Map()
    const testResults = []

    runner.on(EVENT_RUN_BEGIN, function () {
        try {
            const collector = require('../perf/perfCollector')
            if (!collector._runMeta.startedAt) collector.startRun()
        } catch (e) {}
    })

    runner.on(EVENT_TEST_BEGIN, function (test) {
        testStartTimes.set(test, process.hrtime.bigint())
        testMemStart.set(test, process.memoryUsage())
    })

    runner.on(EVENT_TEST_END, function (test) {
        const startHr = testStartTimes.get(test)
        const memStart = testMemStart.get(test)
        if (!startHr) return

        const durationNs = process.hrtime.bigint() - startHr
        const memEnd = process.memoryUsage()

        testResults.push({
            title: test.title,
            fullTitle: test.fullTitle(),
            file: test.file ? path.basename(test.file) : null,
            filePath: test.file || null,
            durationMs: Number(durationNs) / 1e6,
            mochaDurationMs: test.duration || null,
            state: test.state || 'unknown',
            memStartRss: memStart.rss,
            memEndRss: memEnd.rss,
            memHeapUsed: memEnd.heapUsed,
            memHeapTotal: memEnd.heapTotal,
            memExternal: memEnd.external
        })

        testStartTimes.delete(test)
        testMemStart.delete(test)
    })

    runner.once(EVENT_RUN_END, function () {
        let perfCollector = null
        try { perfCollector = require('../perf/perfCollector') } catch (e) {}

        const outputDir = path.resolve(
            options.reporterOptions && options.reporterOptions.outputDir
                ? options.reporterOptions.outputDir
                : 'perf-results'
        )

        const result = {
            runAt: new Date().toISOString(),
            meta: perfCollector ? perfCollector._runMeta : {},
            mochaStats: {
                suites: runner.stats.suites,
                tests: runner.stats.tests,
                passes: runner.stats.passes,
                failures: runner.stats.failures,
                pending: runner.stats.pending,
                duration: runner.stats.duration
            },
            bootstrapPhases: perfCollector ? perfCollector.bootstrapPhases : [],
            pollMetrics: perfCollector ? perfCollector.pollMetrics : [],
            tests: testResults
        }

        fs.mkdirSync(outputDir, { recursive: true })
        const ts = new Date().toISOString().replace(/[:.]/g, '-')
        const outFile = path.join(outputDir, `perf-${ts}.json`)
        fs.writeFileSync(outFile, JSON.stringify(result, null, 2))
        console.log(`\n[perf] Results written to: ${outFile}`)
    })
}

Object.setPrototypeOf(PerformanceReporter.prototype, Spec.prototype)

module.exports = PerformanceReporter
