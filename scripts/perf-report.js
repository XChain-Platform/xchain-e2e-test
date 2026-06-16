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
 * XChain E2E Performance Report Generator
 *
 * Reads perf-results JSON and outputs a markdown performance report.
 *
 * Usage:
 *   node scripts/perf-report.js
 *   node scripts/perf-report.js --file perf-results/perf-2026-04-06.json
 *   node scripts/perf-report.js > perf-results/report.md
 *
 ********************************************************************/

const fs = require('fs')
const path = require('path')

function parseArgs(argv) {
    const args = {}
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--file' && argv[i + 1]) args.file = argv[++i]
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

function bar(value, max, width) {
    const filled = Math.round((value / max) * width)
    return '\u2588'.repeat(Math.min(filled, width)) + '\u2591'.repeat(Math.max(0, width - filled))
}

function run() {
    const args = parseArgs(process.argv.slice(2))
    const resultsDir = path.resolve(__dirname, '..', 'perf-results')
    const filePath = args.file
        ? path.resolve(args.file)
        : findLatestResult(resultsDir)

    if (!filePath || !fs.existsSync(filePath)) {
        console.error('[perf-report] No performance results found. Run test:perf first.')
        process.exit(1)
    }

    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'))
    const lines = []

    function emit(line) { lines.push(line === undefined ? '' : line) }

    // Header
    const runDate = data.runAt ? data.runAt.replace('T', ' ').replace(/\.\d+Z$/, ' UTC') : 'unknown'
    emit(`# Performance Report — ${runDate}`)
    emit()

    // Run metadata
    emit('## Run Metadata')
    emit()
    emit(`| Field | Value |`)
    emit(`|---|---|`)
    emit(`| Coin | ${data.meta.coin || 'N/A'} |`)
    emit(`| Network | ${data.meta.network || 'N/A'} |`)
    emit(`| Node.js | ${data.meta.nodeVersion || 'N/A'} |`)
    emit(`| Platform | ${data.meta.platform || 'N/A'} |`)
    emit()

    // Suite summary
    const stats = data.mochaStats || {}
    emit('## Suite Summary')
    emit()
    emit(`| Metric | Value |`)
    emit(`|---|---|`)
    emit(`| Total time | ${formatMs(stats.duration || 0)} |`)
    emit(`| Tests | ${stats.tests || 0} |`)
    emit(`| Passed | ${stats.passes || 0} |`)
    emit(`| Failed | ${stats.failures || 0} |`)
    emit(`| Pending | ${stats.pending || 0} |`)
    emit()

    // Bootstrap breakdown
    if (data.bootstrapPhases && data.bootstrapPhases.length > 0) {
        emit('## Bootstrap Phases')
        emit()
        const maxDuration = Math.max(...data.bootstrapPhases.map(p => p.durationMs))
        emit(`| Phase | Duration | |`)
        emit(`|---|---|---|`)
        for (const p of data.bootstrapPhases) {
            emit(`| ${p.name} | ${formatMs(p.durationMs)} | ${bar(p.durationMs, maxDuration, 20)} |`)
        }
        const totalBootstrap = data.bootstrapPhases.reduce((s, p) => s + p.durationMs, 0)
        emit(`| **Total** | **${formatMs(totalBootstrap)}** | |`)
        emit()
    }

    // Top 10 slowest tests
    const tests = data.tests || []
    if (tests.length > 0) {
        const sorted = [...tests].sort((a, b) => b.durationMs - a.durationMs)
        const top = sorted.slice(0, 10)
        emit('## Top 10 Slowest Tests')
        emit()
        emit(`| # | Test | File | Duration | RSS |`)
        emit(`|---|---|---|---|---|`)
        top.forEach((t, i) => {
            emit(`| ${i + 1} | ${t.fullTitle} | ${t.file || '?'} | ${formatMs(t.durationMs)} | ${formatMb(t.memEndRss)} |`)
        })
        emit()

        // Test timing distribution
        const buckets = { '<1s': 0, '1-5s': 0, '5-15s': 0, '15-30s': 0, '30-60s': 0, '>60s': 0 }
        for (const t of tests) {
            const ms = t.durationMs
            if (ms < 1000) buckets['<1s']++
            else if (ms < 5000) buckets['1-5s']++
            else if (ms < 15000) buckets['5-15s']++
            else if (ms < 30000) buckets['15-30s']++
            else if (ms < 60000) buckets['30-60s']++
            else buckets['>60s']++
        }
        emit('## Test Duration Distribution')
        emit()
        emit(`| Bucket | Count |`)
        emit(`|---|---|`)
        for (const [bucket, count] of Object.entries(buckets)) {
            if (count > 0) emit(`| ${bucket} | ${count} |`)
        }
        emit()
    }

    // Poll analysis
    const polls = data.pollMetrics || []
    if (polls.length > 0) {
        emit('## Poll Analysis')
        emit()

        const totalPollMs = polls.reduce((s, p) => s + (p.durationMs || 0), 0)
        const suiteMs = stats.duration || 1
        const resolved = polls.filter(p => p.resolved)
        const unresolved = polls.filter(p => !p.resolved)
        const avgPolls = polls.reduce((s, p) => s + p.polls, 0) / polls.length

        emit(`| Metric | Value |`)
        emit(`|---|---|`)
        emit(`| Total waitFor calls | ${polls.length} |`)
        emit(`| Resolved | ${resolved.length} |`)
        emit(`| Timed out | ${unresolved.length} |`)
        emit(`| Total polling time | ${formatMs(totalPollMs)} |`)
        emit(`| Polling % of suite | ${(totalPollMs / suiteMs * 100).toFixed(1)}% |`)
        emit(`| Avg polls per call | ${avgPolls.toFixed(1)} |`)
        emit()

        // Breakdown by method
        const byMethod = {}
        for (const p of polls) {
            if (!byMethod[p.method]) byMethod[p.method] = { calls: 0, totalMs: 0, totalPolls: 0, resolved: 0 }
            byMethod[p.method].calls++
            byMethod[p.method].totalMs += p.durationMs || 0
            byMethod[p.method].totalPolls += p.polls
            if (p.resolved) byMethod[p.method].resolved++
        }

        const methodEntries = Object.entries(byMethod).sort((a, b) => b[1].totalMs - a[1].totalMs)
        emit('### By Method')
        emit()
        emit(`| Method | Calls | Avg Duration | Avg Polls | Resolved |`)
        emit(`|---|---|---|---|---|`)
        for (const [method, m] of methodEntries) {
            emit(`| ${method} | ${m.calls} | ${formatMs(m.totalMs / m.calls)} | ${(m.totalPolls / m.calls).toFixed(1)} | ${m.resolved}/${m.calls} |`)
        }
        emit()
    }

    // Memory trend
    if (tests.length > 0) {
        emit('## Memory Trend')
        emit()
        const step = Math.max(1, Math.floor(tests.length / 20))
        emit(`| Test # | RSS | Heap Used | Test |`)
        emit(`|---|---|---|---|`)
        for (let i = 0; i < tests.length; i += step) {
            const t = tests[i]
            emit(`| ${i + 1} | ${formatMb(t.memEndRss)} | ${formatMb(t.memHeapUsed)} | ${t.fullTitle.slice(0, 40)} |`)
        }
        // Always include last test
        if (tests.length > 1 && (tests.length - 1) % step !== 0) {
            const t = tests[tests.length - 1]
            emit(`| ${tests.length} | ${formatMb(t.memEndRss)} | ${formatMb(t.memHeapUsed)} | ${t.fullTitle.slice(0, 40)} |`)
        }
        emit()

        // Memory delta
        const firstRss = tests[0].memEndRss
        const lastRss = tests[tests.length - 1].memEndRss
        const peakRss = Math.max(...tests.map(t => t.memEndRss))
        emit(`**RSS delta:** ${formatMb(firstRss)} -> ${formatMb(lastRss)} (peak: ${formatMb(peakRss)})`)
        emit()
    }

    console.log(lines.join('\n'))
}

run()
