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

/**
 * Performance: live-stack service latency budgets.
 *
 * Drives the running regtest stack through the same global connectors the rest
 * of the e2e suite uses, and asserts that each service's request/response path
 * stays inside a budget. These are read-only probes (ping / sync-status / health
 * / a trivial DB round-trip). They are deliberately NOT the block-confirmation path,
 * whose wall-clock is bounded by miner cadence, not service performance.
 *
 * The budgets are GENEROUS regression ceilings, not SLOs: a warm stack answers
 * these in tens of milliseconds, so the ceilings (hundreds of ms to a couple of
 * seconds) only trip when a service has become pathologically slow (a wedged
 * pool, a missing index, an O(n) config scan). Each case asserts on the MEDIAN of
 * N samples (robust to GC/scheduler outliers) after a short warm-up; p95 and max
 * are logged for visibility but not gated. Correctness is checked first so a fast
 * failure (connection refused -> instant `false`) can't sneak under a latency bar.
 *
 * Complements test/perf/perfCollector.js + the performance-reporter, which
 * measure whole-suite timing as a wrapper; this file is the only place that
 * asserts per-service latency contracts directly.
 */

const SAMPLES = 15
const WARMUP = 3

// Generous regression ceilings (ms), median over SAMPLES.
const PING_BUDGET_MS        = 1000   // lightweight JSON-RPC reachability probe
const QUERY_BUDGET_MS       = 1500   // a real read (config tree / health report)
const DB_BUDGET_MS          = 1000   // pooled connection + SELECT round-trip
const CONCURRENCY           = 20     // simultaneous in-flight probes
const CONCURRENT_BUDGET_MS  = 5000   // all CONCURRENCY probes resolved

function percentile(sortedAsc, p) {
    if (sortedAsc.length === 0) return NaN
    const idx = Math.min(sortedAsc.length - 1, Math.ceil((p / 100) * sortedAsc.length) - 1)
    return sortedAsc[Math.max(0, idx)]
}

// Run `fn` WARMUP times (discarded), then SAMPLES times under timing.
// `validate(result)` must return truthy for every sample or the test fails.
// This guarantees we are timing real work, not a fast error path.
async function measure(label, fn, validate) {
    for (let i = 0; i < WARMUP; i++) {
        try { await fn() } catch (_) { /* warm-up errors ignored */ }
    }
    const samples = []
    for (let i = 0; i < SAMPLES; i++) {
        const start = process.hrtime.bigint()
        const result = await fn()
        const ms = Number(process.hrtime.bigint() - start) / 1e6
        assert.ok(validate(result), `${label}: sample ${i} returned an invalid/failed result (${JSON.stringify(result)})`)
        samples.push(ms)
    }
    samples.sort((a, b) => a - b)
    const stat = {
        median: percentile(samples, 50),
        p95: percentile(samples, 95),
        min: samples[0],
        max: samples[samples.length - 1]
    }
    console.log(`      [perf] ${label}: median=${stat.median.toFixed(1)}ms p95=${stat.p95.toFixed(1)}ms max=${stat.max.toFixed(1)}ms (n=${SAMPLES})`)
    return stat
}

const isTrue = (r) => r === true
const isObject = (r) => r !== null && typeof r === 'object'

describe('Performance: live-stack service latency (regression budgets, not SLOs)', function () {
    this.timeout(120000)

    it('utxo-tracker ping stays within the latency budget', async function () {
        assert.strictEqual(await utxoTrackerConnector.ping(), true, 'utxo-tracker unreachable')
        const s = await measure('utxo-tracker ping', () => utxoTrackerConnector.ping(), isTrue)
        assert.ok(s.median < PING_BUDGET_MS, `median ${s.median.toFixed(1)}ms exceeds ${PING_BUDGET_MS}ms`)
    })

    it('encoder ping stays within the latency budget', async function () {
        assert.strictEqual(await encoderConnector.ping(), true, 'encoder unreachable')
        const s = await measure('encoder ping', () => encoderConnector.ping(), isTrue)
        assert.ok(s.median < PING_BUDGET_MS, `median ${s.median.toFixed(1)}ms exceeds ${PING_BUDGET_MS}ms`)
    })

    it('indexer ping stays within the latency budget', async function () {
        assert.strictEqual(await indexerConnector.ping(), true, 'indexer unreachable')
        const s = await measure('indexer ping', () => indexerConnector.ping(), isTrue)
        assert.ok(s.median < PING_BUDGET_MS, `median ${s.median.toFixed(1)}ms exceeds ${PING_BUDGET_MS}ms`)
    })

    it('explorer ping stays within the latency budget', async function () {
        assert.strictEqual(await explorerConnector.ping(), true, 'explorer unreachable')
        const s = await measure('explorer ping', () => explorerConnector.ping(), isTrue)
        assert.ok(s.median < PING_BUDGET_MS, `median ${s.median.toFixed(1)}ms exceeds ${PING_BUDGET_MS}ms`)
    })

    it('indexer health report stays within the read budget', async function () {
        assert.ok(isObject(await indexerConnector.health()), 'indexer health unavailable')
        const s = await measure('indexer health', () => indexerConnector.health(), isObject)
        assert.ok(s.median < QUERY_BUDGET_MS, `median ${s.median.toFixed(1)}ms exceeds ${QUERY_BUDGET_MS}ms`)
    })

    it('utxo-tracker sync-status read stays within the read budget', async function () {
        // getSyncStatus() returns the tracker's indexed-height/tip payload (or null
        // on RPC error). It is a heavier read than ping, exercising the status handler.
        assert.ok(isObject(await utxoTrackerConnector.getSyncStatus()), 'utxo-tracker sync status unavailable')
        const s = await measure('utxo-tracker getSyncStatus', () => utxoTrackerConnector.getSyncStatus(), isObject)
        assert.ok(s.median < QUERY_BUDGET_MS, `median ${s.median.toFixed(1)}ms exceeds ${QUERY_BUDGET_MS}ms`)
    })

    it('indexer DB round-trip (pooled SELECT) stays within budget', async function () {
        assert.strictEqual(await indexerDatabase.ping(), true, 'indexer DB unreachable')
        const s = await measure('indexer DB ping', () => indexerDatabase.ping(), isTrue)
        assert.ok(s.median < DB_BUDGET_MS, `median ${s.median.toFixed(1)}ms exceeds ${DB_BUDGET_MS}ms`)
    })

    it(`stack absorbs ${CONCURRENCY} concurrent pings within budget`, async function () {
        // Throughput/contention probe: fire CONCURRENCY pings at once and require
        // every one to succeed inside a single wall-clock budget. A service that
        // serializes requests (or a saturated pool) blows the ceiling even though
        // a single sequential ping would pass.
        const start = process.hrtime.bigint()
        const results = await Promise.all(
            Array.from({ length: CONCURRENCY }, () => indexerConnector.ping())
        )
        const elapsed = Number(process.hrtime.bigint() - start) / 1e6
        console.log(`      [perf] ${CONCURRENCY} concurrent indexer pings: ${elapsed.toFixed(1)}ms`)
        assert.ok(results.every(isTrue), 'one or more concurrent pings failed')
        assert.ok(elapsed < CONCURRENT_BUDGET_MS, `${elapsed.toFixed(1)}ms exceeds ${CONCURRENT_BUDGET_MS}ms`)
    })
})
