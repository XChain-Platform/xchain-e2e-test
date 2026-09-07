'use strict'

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// The responsible-set venue guard decides whether a selection-dependent
// attestation case runs, skips, or fails. Every one of those three outcomes is
// invisible in a live run: a skip prints a line nobody reads, and a guard that
// answered "run" on a venue that never elected this suite's validator produces a
// 60-second timeout attributed to the code under test. So the decision is pinned
// here against synthetic request rows, with no DB, no chain and no venue.
//
// The load-bearing distinction is null-vs-false: a row with NO pinned set is
// UNKNOWN and must run (the case's own assertions rule), while a row with a set
// this validator is absent from is a decided non-election and must not.

const assert = require('assert')
const {
    pinnedResponsibleSet, isResponsibleFor, requireResponsibleValidator
} = require('../../helpers/federationGuards')

const MINE  = 'B80F49788E23658BC58A594D37639F45A44ADAD636E4B042ACF2FE130A671768'
const THEIRS = 'a20a4fa165f293a887b8294cf3cf16a4d5aef6e65434feb7438d0168e29dd250'

// A mocha context stub that records whether the case was marked pending.
function fakeCtx() {
    return { skipped: false, skip() { this.skipped = true } }
}

// Run `fn` with E2E_REQUIRE_FEDERATION set to `value` (undefined = unset), then
// restore whatever the ambient environment had.
function withRequireFederation(value, fn) {
    const had = Object.prototype.hasOwnProperty.call(process.env, 'E2E_REQUIRE_FEDERATION')
    const prev = process.env.E2E_REQUIRE_FEDERATION
    if (value === undefined) delete process.env.E2E_REQUIRE_FEDERATION
    else process.env.E2E_REQUIRE_FEDERATION = value
    try { return fn() } finally {
        if (had) process.env.E2E_REQUIRE_FEDERATION = prev
        else delete process.env.E2E_REQUIRE_FEDERATION
    }
}

describe('federationGuards: responsible-set venue guard', function () {
    this.timeout(10000)

    describe('pinnedResponsibleSet', () => {
        it('parses the JSON string the indexer stores, lower-cased', () => {
            assert.deepStrictEqual(
                pinnedResponsibleSet({ responsible_set_json: JSON.stringify([MINE]) }),
                [MINE.toLowerCase()])
        })

        it('accepts an already-parsed array (driver-dependent JSON column shape)', () => {
            assert.deepStrictEqual(
                pinnedResponsibleSet({ responsible_set_json: [THEIRS] }), [THEIRS])
        })

        it('preserves the elected ORDER, because element 0 is the broadcaster', () => {
            assert.deepStrictEqual(
                pinnedResponsibleSet({ responsible_set_json: JSON.stringify([THEIRS, MINE]) }),
                [THEIRS, MINE.toLowerCase()])
        })

        it('returns an EMPTY array for an elected-nobody set, not null', () => {
            // [] is a decided election with no members, which is a real state
            // (admission below the flag-day). It must not read as "unknown".
            assert.deepStrictEqual(pinnedResponsibleSet({ responsible_set_json: '[]' }), [])
        })

        it('returns null for a row that pins nothing', () => {
            assert.strictEqual(pinnedResponsibleSet({}), null)
            assert.strictEqual(pinnedResponsibleSet({ responsible_set_json: null }), null)
            assert.strictEqual(pinnedResponsibleSet({ responsible_set_json: '' }), null)
            assert.strictEqual(pinnedResponsibleSet(null), null)
        })

        it('returns null rather than throwing on a malformed or non-array value', () => {
            assert.strictEqual(pinnedResponsibleSet({ responsible_set_json: '{not json' }), null)
            assert.strictEqual(pinnedResponsibleSet({ responsible_set_json: '"a-string"' }), null)
        })
    })

    describe('isResponsibleFor', () => {
        it('matches case-insensitively in both directions', () => {
            const row = { responsible_set_json: JSON.stringify([MINE.toLowerCase()]) }
            assert.strictEqual(isResponsibleFor(row, MINE), true)
            assert.strictEqual(isResponsibleFor(row, MINE.toLowerCase()), true)
        })

        it('is false when the venue elected somebody else', () => {
            assert.strictEqual(
                isResponsibleFor({ responsible_set_json: JSON.stringify([THEIRS]) }, MINE), false)
        })

        it('finds a member past element 0 (REDUNDANCY > 1)', () => {
            assert.strictEqual(
                isResponsibleFor({ responsible_set_json: JSON.stringify([THEIRS, MINE.toLowerCase()]) }, MINE),
                true)
        })

        it('is null (unknown), not false, when nothing is pinned', () => {
            assert.strictEqual(isResponsibleFor({}, MINE), null)
        })
    })

    describe('requireResponsibleValidator', () => {
        it('runs the case when this suite\'s validator was elected', () => {
            const ctx = fakeCtx()
            const proceed = withRequireFederation(undefined, () => requireResponsibleValidator(
                ctx, { responsible_set_json: JSON.stringify([MINE.toLowerCase()]) }, MINE, 'paid request'))
            assert.strictEqual(proceed, true)
            assert.strictEqual(ctx.skipped, false)
        })

        it('marks the case PENDING (never failed) when the venue elected somebody else', () => {
            const ctx = fakeCtx()
            const proceed = withRequireFederation(undefined, () => requireResponsibleValidator(
                ctx, { responsible_set_json: JSON.stringify([THEIRS]) }, MINE, 'paid request'))
            assert.strictEqual(proceed, false)
            assert.strictEqual(ctx.skipped, true)
        })

        it('names the elected pubkey and the case in the skip reason', () => {
            const lines = []
            const log = console.log
            console.log = (m) => lines.push(String(m))
            try {
                withRequireFederation(undefined, () => requireResponsibleValidator(
                    fakeCtx(), { responsible_set_json: JSON.stringify([THEIRS]) }, MINE, 'paid request'))
            } finally { console.log = log }
            const said = lines.join('\n')
            assert.ok(said.includes(THEIRS), 'reason should name the elected pubkey')
            assert.ok(said.includes('paid request'), 'reason should name the case')
            assert.ok(said.includes('venue-dependent'), 'reason should be labelled venue-dependent')
        })

        it('HARD FAILS instead of skipping under E2E_REQUIRE_FEDERATION=1', () => {
            // The escape hatch that keeps a 7/7 claim honest: on a venue the caller
            // reset, a non-election is a broken prerequisite, not a fact of life.
            const ctx = fakeCtx()
            assert.throws(() => withRequireFederation('1', () => requireResponsibleValidator(
                ctx, { responsible_set_json: JSON.stringify([THEIRS]) }, MINE, 'paid request')),
                /E2E_REQUIRE_FEDERATION/)
            assert.strictEqual(ctx.skipped, false, 'a hard failure must not also mark it pending')
        })

        it('does NOT fail under E2E_REQUIRE_FEDERATION=1 when the validator WAS elected', () => {
            const ctx = fakeCtx()
            const proceed = withRequireFederation('1', () => requireResponsibleValidator(
                ctx, { responsible_set_json: JSON.stringify([MINE.toLowerCase()]) }, MINE, 'paid request'))
            assert.strictEqual(proceed, true)
            assert.strictEqual(ctx.skipped, false)
        })

        it('runs the case (never skips) when the row pins no set at all', () => {
            const ctx = fakeCtx()
            const proceed = withRequireFederation('1', () => requireResponsibleValidator(
                ctx, { responsible_set_json: null }, MINE, 'paid request'))
            assert.strictEqual(proceed, true)
            assert.strictEqual(ctx.skipped, false)
        })

        it('treats an elected-nobody set as a non-election, not as unknown', () => {
            const ctx = fakeCtx()
            const proceed = withRequireFederation(undefined, () => requireResponsibleValidator(
                ctx, { responsible_set_json: '[]' }, MINE, 'paid request'))
            assert.strictEqual(proceed, false)
            assert.strictEqual(ctx.skipped, true)
        })
    })
})
