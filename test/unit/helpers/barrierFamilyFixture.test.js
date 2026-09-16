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
 * The barrier-family fixture's contract, pinned without a venue, a child, a
 * database or the rail. What the legs share is what is checked here: the arming
 * lever reads the indexer's own key, the loop-order family equals the family the
 * indexer's source derives, the independent admission predicate agrees with the
 * indexer's own `isRowReadableAt` over the boundary matrix, the BF3 pin is one
 * below each member's own margin, and a venue is never built without an explicit
 * build root.
 ********************************************************************/

const assert = require('assert')
const fs     = require('fs')
const os     = require('os')
const path   = require('path')

const F = require('../../attestMirror/helpers/barrierFamilyFixture')
const { resolveRepoRoot } = require('../../helpers/attestMirrorVenue')
const gate = require('../../../../xchain-indexer/src/consensus/gates/mirror_admission_gate.js')

const ROOT = resolveRepoRoot(undefined, {})

describe('barrierFamilyFixture: the arming lever', function () {
    it('reads the arming key from the indexer registry rather than spelling it', () => {
        assert.strictEqual(F.ARM_ENV, gate.MIRROR_ADMISSION_REGTEST_ENV)
        assert.strictEqual(gate.resolveMirrorAdmissionRegtest({ [F.ARM_ENV]: F.ARM_VALUE }),
            gate.MIRROR_ADMISSION_REGTEST_ARMED_HEIGHT, 'the armed value does not arm the resolver')
    })

    it('arms only the named indexers and gives the rest NO key, which is inert', () => {
        assert.deepStrictEqual(F.armingOverlay({ armed: [0] }), { 0: { [F.ARM_ENV]: 'armed' } })
        assert.deepStrictEqual(F.armingOverlay({ armed: [] }), {})
        assert.deepStrictEqual(F.armingOverlay(undefined), {})
        assert.strictEqual(gate.resolveMirrorAdmissionRegtest({}), null, 'no key must read inert')
        assert.throws(() => F.armingOverlay({ armed: [-1] }), /bad indexer index/)
    })
})

describe('barrierFamilyFixture: the family in loop order', function () {
    it('is the nine reasons the indexer source derives, as a set, in the block-loop order', () => {
        assert.strictEqual(F.FAMILY_REASONS_LOOP_ORDER.length, 9)
        assert.deepStrictEqual([...F.FAMILY_REASONS_LOOP_ORDER].sort(), [...F.mirrorBarrierReasons()])
        assert.strictEqual(F.FAMILY_REASONS_LOOP_ORDER[0], 'price_sync_barrier')
        assert.strictEqual(F.FAMILY_REASONS_LOOP_ORDER[8], 'snapshot_sync_barrier')
    })

    it('names the admission column each table binds on', () => {
        assert.strictEqual(F.admissionColumn('cross_chain_matches', 'LTC'), 'admit_block_ltc')
        assert.strictEqual(F.admissionColumn('attestation_responses', 'LTC'), 'admit_block_btc')
        assert.strictEqual(F.admissionColumn('oracle_prices', 'DOGE'), 'admit_block')
        assert.throws(() => F.admissionColumn('state_checkpoints', 'BTC'), /carries no admission column/)
    })
})

describe('barrierFamilyFixture: the independent admission predicate (BF2, BF4)', function () {
    const B = 1000, T = 5_000_000
    const matrix = [
        { admit: null,      et: T - 1, expect: true  },   // legacy row, effective_time in the past
        { admit: null,      et: T,     expect: true  },   // legacy row, at the stamp
        { admit: null,      et: T + 1, expect: false },   // legacy row, future stamp
        { admit: undefined, et: T - 1, expect: true  },   // absent column reads as legacy
        { admit: B - 1,     et: T + 9, expect: true  },   // height rule wins over the clock
        { admit: B,         et: T + 9, expect: true  },   // equal to B binds
        { admit: B + 1,     et: T - 9, expect: false },   // above B does not, whatever the clock
        { admit: '999',     et: T + 9, expect: true  },   // a stringified height (mirror rows are JSON)
        { admit: 'x',       et: T - 9, expect: false },   // an unreadable height never binds
    ]

    it('agrees with the indexer\'s own isRowReadableAt over the boundary matrix', () => {
        for (const c of matrix) {
            const row = { admit_block_btc: c.admit, effective_time: c.et }
            const mine = F.rowAdmittedAt(row, 'admit_block_btc', B, T)
            assert.strictEqual(mine, c.expect, JSON.stringify(c))
            assert.strictEqual(mine, gate.isRowReadableAt(c.admit, B, c.et, T), 'disagrees with the indexer: ' + JSON.stringify(c))
        }
    })

    it('never binds a negative height, which an UNSIGNED mirror column cannot hold anyway', () => {
        // Outside the agreement matrix on purpose: the indexer's _readHeight admits a
        // negative number and the column type is what keeps it unreachable there.
        assert.strictEqual(F.rowAdmittedAt({ admit_block_btc: -1, effective_time: T - 9 }, 'admit_block_btc', B, T), false)
    })

    it('enumerates the admitted row set from the hub rows, sorted by key, per chain column', () => {
        const rows = [
            { id: 3, admit_block_btc: B,     admit_block_ltc: B + 5, effective_time: T + 9 },
            { id: 1, admit_block_btc: null,  admit_block_ltc: null,  effective_time: T - 1 },
            { id: 2, admit_block_btc: B + 1, admit_block_ltc: B - 1, effective_time: T - 1 },
        ]
        assert.deepStrictEqual(F.admittedRowSet(rows, 'cross_chain_matches', 'BTC', B, T), ['1', '3'])
        assert.deepStrictEqual(F.admittedRowSet(rows, 'cross_chain_matches', 'LTC', B, T), ['1', '2'])
        assert.deepStrictEqual(F.admittedRowSet(rows, 'cross_chain_matches', 'BTC', B, T, (r) => 'm' + r.id), ['m1', 'm3'])
    })
})

describe('barrierFamilyFixture: the BF3 pin and the leg sizing', function () {
    it('pins one below each member\'s own satisfaction line, using that member\'s margin', () => {
        assert.strictEqual(F.pinnedHeightFor('cross_chain_matches', 1000), 1000 - gate.admitMarginBlocks('cross_chain_matches') - 1)
        assert.strictEqual(F.pinnedHeightFor('attestation_responses', 1000), 1000 - 1 - 1)
        assert.strictEqual(F.pinnedHeightFor('anchor_reward_attestations', 1000), 1000 - 144 - 1)
        assert.strictEqual(F.pinnedHeightFor('attestation_responses', 1), 0, 'never negative')
        assert.throws(() => F.pinnedHeightFor('cross_chain_matches', -5), /bad block height/)
    })

    it('sizes a full-hold leg past the hold, three barrier cycles, the boot and slack', () => {
        assert.strictEqual(F.legTimeoutMs(7320), (7320 + 180 + 300 + 600) * 1000)
        assert.strictEqual(F.legTimeoutMs(0, { bootS: 0, slackS: 0 }), 180 * 1000)
    })

    it('says to reseed the quote before the 30 minute lifetime, with its margin', () => {
        const t0 = 1_000_000
        assert.strictEqual(F.reseedQuoteBefore(t0, t0 + (10 * 60 * 1000), 60), false)
        assert.strictEqual(F.reseedQuoteBefore(t0, t0 + (24 * 60 * 1000), 59), false)
        assert.strictEqual(F.reseedQuoteBefore(t0, t0 + (24 * 60 * 1000), 60), true, 'the 25 minute line is inclusive')
        assert.strictEqual(F.reseedQuoteBefore(t0, t0 + (26 * 60 * 1000), 0), true)
    })

    it('lifts the stall facts off /status with absence kept as undefined', () => {
        assert.deepStrictEqual(F.stallSnapshot({ stallClass: 'barrier_defer', stallReason: 'match_sync_barrier', stallClearsAt: null }),
            { stallClass: 'barrier_defer', stallReason: 'match_sync_barrier', stallClearsAt: null,
              atProcessableTip: undefined, degraded: undefined, heights: undefined })
        assert.strictEqual(F.stallSnapshot({ hubMirror: { heights: { cross_chain_matches: { BTC: 7 } } } }).heights.cross_chain_matches.BTC, 7)
    })

    it('reads heights off the /status hubMirror block, not a mirror block a real body never carries', () => {
        assert.strictEqual(F.stallSnapshot({ mirror: { heights: { cross_chain_matches: { BTC: 7 } } } }).heights, undefined,
            'a stray top-level mirror block must not be mistaken for hubMirror')
        assert.strictEqual(F.stallSnapshot({ hubMirror: {} }).heights, undefined, 'hubMirror with no heights key stays undefined')
    })
})

describe('barrierFamilyFixture: the build root and its evidence (B4, B11)', function () {
    it('refuses to build a venue without an explicit build root', () => {
        assert.throws(() => F.buildFamilyVenue({}), /repoRoot is required/)
        assert.throws(() => F.buildFamilyVenue({ repoRoot: os.tmpdir() }), /has no xchain-hub\/src\/api\.js/)
    })

    it('builds from the given root, arms the named indexers and records the SHAs it resolves to', () => {
        const { venue, evidence } = F.buildFamilyVenue({ repoRoot: ROOT, armed: [0], label: 'bfseam', venue: { hubCount: 2 } })
        assert.strictEqual(venue.repoRoot, ROOT)
        assert.deepStrictEqual(venue.indexerEnv, { 0: { [F.ARM_ENV]: 'armed' } })
        assert.strictEqual(evidence.repoRoot, ROOT)
        assert.deepStrictEqual(evidence.armed, [0])
        assert.strictEqual(evidence.coinCode, 'BTC')
        for (const r of ['xchain-hub', 'xchain-indexer', 'xchain-e2e-test']) {
            assert.ok(/^[0-9a-f]{40}$/.test(evidence.shas[r]), r + ' sha: ' + evidence.shas[r])
            assert.strictEqual(evidence.shas[r], F.headShaOf(path.join(ROOT, r)))
        }
        assert.deepStrictEqual(evidence.hubRoots.map((h) => h.root), [ROOT, ROOT])
        assert.strictEqual(evidence.hubRoots[1].sha, evidence.shas['xchain-hub'])
    })

    it('merges the arming overlay into a per-index key instead of replacing it', () => {
        const { venue } = F.buildFamilyVenue({
            repoRoot: ROOT, armed: [0], label: 'bfseam',
            venue: { hubCount: 2, indexerEnv: { 0: { MARGIN_OVERRIDE: '5' }, 1: { OTHER_KEY: 'x' } } },
        })
        assert.deepStrictEqual(venue.indexerEnv, {
            0: { MARGIN_OVERRIDE: '5', [F.ARM_ENV]: 'armed' },
            1: { OTHER_KEY: 'x' },
        }, 'arming index 0 must not drop its own indexerExtraEnv-style key, and index 1 must survive untouched')
    })

    it('passes a per-hub root through to the venue and records it per index', () => {
        const spelled = path.join(ROOT, 'xchain-hub', '..')
        const { venue, evidence } = F.buildFamilyVenue({ repoRoot: ROOT, label: 'bfseam', hubRepoRoots: { 1: spelled }, venue: { hubCount: 2 } })
        assert.strictEqual(venue.hubRepoRoot(1), ROOT)
        assert.strictEqual(evidence.hubRoots[1].root, ROOT)
        assert.ok(fs.existsSync(path.join(evidence.hubRoots[1].root, 'xchain-hub', 'src', 'api.js')))
    })
})
