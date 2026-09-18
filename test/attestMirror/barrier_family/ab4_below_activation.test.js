'use strict'

/*********************************************************************
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 **********************************************************************
 * AB4 (parent section 5): below the activation is byte-identical. With the
 * activation INERT (the venue default) the anchor-attest predicate reduces to
 * today's form for every input: the AB2 matrix (bound below, equal to, above
 * `blockTime`; a null bound; the `false` sentinel the decoder returns for a block
 * it cannot serve; B < 144) is driven on the indexer's own method with a stub
 * `this`, and the derive-set identity is driven by spawning the indexer's own
 * derive suite. Identity by construction; the matrix is what turns the argument
 * into a measurement.
 *
 * Pure: no venue, no rail. The OLD-versus-NEW replay over the regtest BTC corpus
 * (byte-identical `validator_rewards` and `state_hash` at every block) is row
 * 11's serial pass with the witness pattern of
 * `bin/verify-genesis-arm-replay-equivalence.js`, for the reason BF4 states: it
 * needs one corpus under one set of mirror inputs, which two venues cannot give.
 ********************************************************************/

const assert = require('assert')
const path = require('path')
const fs = require('fs')
const { spawnSync } = require('child_process')

const BUILD_ROOT = path.resolve(__dirname, '..', '..', '..', '..')
const INDEXER = path.join(BUILD_ROOT, 'xchain-indexer')
const attest = require(path.join(INDEXER, 'src', 'hub', 'hub_db_sync', 'barriers', 'attest.js'))
const watermarks = require(path.join(INDEXER, 'src', 'hub', 'hub_db_sync', 'watermarks.js'))
const XChainIndexer = require(path.join(INDEXER, 'src', 'XChainIndexer.js'))

const T = 1788494058
const GRACE_S = 120
const MARGIN_S = 64800

// The mirror client as the anchor-attest member sees it, inert: no height entry can
// satisfy it and the clock form alone decides.
function inertStub (watermark) {
    return {
        enabled: true, streamWatermark: watermark, anchorAttestWatermarkGraceS: GRACE_S,
        coin: 'BTC', network: 'regtest', heightWatermarks: {}, _heightShortfalls: {},
        admissionChain: () => 'BTC', admissionActiveAt: () => false,
        publishedHeight: watermarks.publishedHeight, heightSatisfied: watermarks.heightSatisfied,
    }
}

// Today's form, written independently: watermark >= blockTime + grace, nothing else.
function legacy (watermark, blockTime) {
    return Number(watermark) >= Number(blockTime) + GRACE_S
}

describe('AB4 unit: below the activation the anchor-attest predicate is today\'s form for every input', function () {

    // The caller's half: inert, the horizon bound is NULL for every height, so the
    // predicate below never sees a number. Driven on the indexer's own method with a stub
    // whose decoder answers a stamp for every block, so only the activation can null it.
    it('resolves NO horizon bound while inert, for every height including B < 144', async function () {
        const stub = { hubDbSync: {}, config: { NETWORK: 'regtest' }, anchorAttestArrivalMarginS: MARGIN_S, decoderDb: { getBlockTime: async (h) => T + Number(h) } }
        for (const height of [812000, 144, 143, 0, 'nope', null]) {
            const bound = await XChainIndexer.prototype.anchorAttestHorizonBound.call(stub, height)
            assert.strictEqual(bound, null, 'inert: height ' + String(height) + ' resolved a horizon bound ' + String(bound))
        }
        // The decoder's false sentinel is rejected by identity even when the caller is armed:
        // Number(false) is 0 and a coercing guard would open the barrier on every decoder gap.
        const sentinel = { hubDbSync: {}, config: { NETWORK: 'regtest' }, anchorAttestArrivalMarginS: MARGIN_S, decoderDb: { getBlockTime: async () => false } }
        assert.strictEqual(await XChainIndexer.prototype.anchorAttestHorizonBound.call(sentinel, 812000), null)
    })

    it('reduces to watermark >= blockTime + grace with a null bound over the watermark matrix, whatever heights say', function () {
        const heights = [{}, { anchor_reward_attestations: { BTC: 812000 } }, { anchor_reward_attestations: { BTC: 0 } }]
        for (const w of [T - 1, T + GRACE_S - 1, T + GRACE_S, T + GRACE_S + 1, T + MARGIN_S + GRACE_S]) {
            for (const height of [812000, 143, 0, null]) {
                for (const hw of heights) {
                    const stub = inertStub(w)
                    stub.heightWatermarks = hw
                    for (const bound of [null, undefined]) {
                        const got = attest.anchorAttestSyncSatisfied.call(stub, T, bound, height)
                        assert.strictEqual(got, legacy(w, T), 'inert: watermark ' + w + ', height ' + String(height) + ', heights ' + JSON.stringify(hw))
                    }
                }
            }
        }
        const armed = inertStub(T + 99999)
        armed.admissionActiveAt = () => true
        assert.strictEqual(attest.anchorAttestSyncSatisfied.call(armed, T + 999999, false, 812000), false,
            'a false horizon bound was coerced to zero and opened the barrier')
    })

    it('above the activation the same matrix is decided by the height half OR the horizon form, never by blockTime alone', function () {
        const armed = inertStub(T)
        armed.admissionActiveAt = () => true
        armed.heightWatermarks = { anchor_reward_attestations: { BTC: 812000 - 144 } }
        assert.strictEqual(attest.anchorAttestSyncSatisfied.call(armed, T + 7200, null, 812000), true, 'the height half satisfies at B - 144')
        armed.heightWatermarks = { anchor_reward_attestations: { BTC: 812000 - 145 } }
        assert.strictEqual(attest.anchorAttestSyncSatisfied.call(armed, T + 7200, null, 812000), false, 'one below the line, no horizon: held')
        assert.strictEqual(attest.anchorAttestSyncSatisfied.call(armed, T + 7200, T - GRACE_S, 812000), true, 'the horizon form opens what the height half holds')
        assert.strictEqual(attest.anchorAttestSyncSatisfied.call(armed, T + 7200, T - GRACE_S + 1, 812000), false, 'one second inside the window: held')
    })
})

describe('AB4 unit: the derive-set identity on a fixture with real matured rows', function () {
    this.timeout(10 * 60 * 1000)

    it('the indexer\'s own derive suite passes with zero pending', function () {
        const mocha = path.join(INDEXER, 'node_modules', '.bin', 'mocha')
        assert.ok(fs.existsSync(mocha), 'no mocha in ' + INDEXER)
        const res = spawnSync(mocha, ['--no-config', '--no-package', '--require', './test/helpers/setup.js', '--timeout', '60000', '--exit',
            '--reporter', 'json', 'test/unit/anchor/anchor_reward_derive.test.js', 'test/unit/anchor/anchor_reward_derive.test/anchor_reward_derive_set_is.test.js'],
        { cwd: INDEXER, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
        let report = null
        try { report = JSON.parse(res.stdout.slice(res.stdout.indexOf('{'))) } catch (_) { report = null }
        assert.ok(report && report.stats, 'no mocha JSON from the derive suite (exit ' + res.status + '):\n' + res.stderr.slice(-2000))
        const failed = (report.failures || []).map((t) => t.fullTitle + ': ' + ((t.err && t.err.message) || ''))
        console.log('AB4 derive suite: ' + JSON.stringify(report.stats))
        assert.deepStrictEqual(failed, [], 'the derive suite has failures')
        assert.strictEqual(report.stats.pending, 0, 'the derive suite skipped ' + report.stats.pending + ' case(s)')
        assert.ok(report.stats.passes > 0, 'the derive suite ran nothing')
    })
})
