#!/usr/bin/env node
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
/*********************************************************************
 *
 * XChain E2E Performance Gate
 *
 * Reads the most recent perf-results JSON file and exits with code 1
 * if any performance threshold is breached. Designed for CI pipelines.
 *
 * Usage:
 *   node scripts/perf-gate.js
 *   node scripts/perf-gate.js --file perf-results/perf-2026-04-06.json
 *   node scripts/perf-gate.js --config scripts/perf-thresholds.json
 *
 ********************************************************************/

const fs = require('fs')
const path = require('path')

const DEFAULT_THRESHOLDS = {
    totalSuiteMaxMs: 600000,        // 10 minutes
    singleTestMaxMs: 120000,        // 2 minutes per test
    peakMemoryRssMb: 512,           // 512 MB RSS
    pollOverheadRatioMax: 0.80,     // poll time / total suite time
    maxUnresolvedPolls: 5           // allow some timeouts
}

function parseArgs(argv) {
    const args = {}
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--file' && argv[i + 1]) args.file = argv[++i]
        else if (argv[i] === '--config' && argv[i + 1]) args.config = argv[++i]
    }
    return args
}

function findLatestResult(dir) {
    if (!fs.existsSync(dir)) return null
    const files = fs.readdirSync(dir)
        .filter(f => f.startsWith('perf-') && f.endsWith('.json'))
        .sort()
    return files.length > 0 ? path.join(dir, files[files.length - 1]) : null
}

function formatMs(ms) {
    if (ms >= 60000) return `${(ms / 60000).toFixed(1)}m`
    if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`
    return `${Math.round(ms)}ms`
}

function formatMb(bytes) {
    return `${(bytes / 1048576).toFixed(1)} MB`
}

function run() {
    const args = parseArgs(process.argv.slice(2))

    // Load thresholds
    let thresholds = { ...DEFAULT_THRESHOLDS }
    if (args.config) {
        try {
            const custom = JSON.parse(fs.readFileSync(args.config, 'utf8'))
            thresholds = { ...thresholds, ...custom }
        } catch (e) {
            console.error('[perf-gate] Error reading config:', e)
            process.exit(2)
        }
    }

    // Find results file
    const resultsDir = path.resolve(__dirname, '..', 'perf-results')
    const filePath = args.file
        ? path.resolve(args.file)
        : findLatestResult(resultsDir)

    if (!filePath || !fs.existsSync(filePath)) {
        console.error('[perf-gate] No performance results found. Run test:perf first.')
        process.exit(2)
    }

    console.log(`[perf-gate] Reading: ${path.basename(filePath)}`)

    let data
    try {
        data = JSON.parse(fs.readFileSync(filePath, 'utf8'))
    } catch (e) {
        console.error('[perf-gate] Error parsing results:', e)
        process.exit(2)
    }

    const breaches = []

    // Check total suite time
    const totalMs = data.mochaStats.duration || 0
    if (totalMs > thresholds.totalSuiteMaxMs) {
        breaches.push({
            metric: 'Total suite time',
            actual: formatMs(totalMs),
            threshold: formatMs(thresholds.totalSuiteMaxMs)
        })
    }

    // Check individual test times
    const slowTests = (data.tests || []).filter(t => t.durationMs > thresholds.singleTestMaxMs)
    for (const t of slowTests) {
        breaches.push({
            metric: `Test "${t.fullTitle}"`,
            actual: formatMs(t.durationMs),
            threshold: formatMs(thresholds.singleTestMaxMs)
        })
    }

    // Check peak memory
    const peakRss = Math.max(0, ...(data.tests || []).map(t => t.memEndRss || 0))
    const peakRssMb = peakRss / 1048576
    if (peakRssMb > thresholds.peakMemoryRssMb) {
        breaches.push({
            metric: 'Peak RSS memory',
            actual: formatMb(peakRss),
            threshold: `${thresholds.peakMemoryRssMb} MB`
        })
    }

    // Check poll overhead ratio
    const totalPollMs = (data.pollMetrics || []).reduce((sum, p) => sum + (p.durationMs || 0), 0)
    const pollRatio = totalMs > 0 ? totalPollMs / totalMs : 0
    if (pollRatio > thresholds.pollOverheadRatioMax) {
        breaches.push({
            metric: 'Poll overhead ratio',
            actual: `${(pollRatio * 100).toFixed(1)}%`,
            threshold: `${(thresholds.pollOverheadRatioMax * 100).toFixed(1)}%`
        })
    }

    // Check unresolved polls
    const unresolvedPolls = (data.pollMetrics || []).filter(p => !p.resolved).length
    if (unresolvedPolls > thresholds.maxUnresolvedPolls) {
        breaches.push({
            metric: 'Unresolved polls (timeouts)',
            actual: `${unresolvedPolls}`,
            threshold: `${thresholds.maxUnresolvedPolls}`
        })
    }

    // Print summary
    console.log('')
    console.log('  Performance Gate Results')
    console.log('  ========================')
    console.log(`  Suite time:       ${formatMs(totalMs)} (limit: ${formatMs(thresholds.totalSuiteMaxMs)})`)
    console.log(`  Peak RSS:         ${formatMb(peakRss)} (limit: ${thresholds.peakMemoryRssMb} MB)`)
    console.log(`  Poll overhead:    ${(pollRatio * 100).toFixed(1)}% (limit: ${(thresholds.pollOverheadRatioMax * 100).toFixed(1)}%)`)
    console.log(`  Unresolved polls: ${unresolvedPolls} (limit: ${thresholds.maxUnresolvedPolls})`)
    console.log(`  Tests:            ${data.mochaStats.passes}/${data.mochaStats.tests} passed`)

    if (slowTests.length > 0) {
        console.log(`  Slow tests:       ${slowTests.length} exceeding ${formatMs(thresholds.singleTestMaxMs)}`)
    }
    console.log('')

    if (breaches.length > 0) {
        console.log('  BREACHES:')
        for (const b of breaches) {
            console.log(`    FAIL  ${b.metric}: ${b.actual} (threshold: ${b.threshold})`)
        }
        console.log('')
        console.log(`[perf-gate] FAILED: ${breaches.length} threshold(s) breached`)
        process.exit(1)
    } else {
        console.log('[perf-gate] PASSED: all thresholds within limits')
        process.exit(0)
    }
}

run()
