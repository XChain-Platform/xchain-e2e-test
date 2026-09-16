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
 * The fixture the barrier-family legs share: bf1 to bf6 and bf8 (the family
 * spec's section 7) and the parent's ab1 to ab5. It is the ONE place the legs
 * agree on what "armed", "admitted at B", "the family in loop order", "a stall
 * snapshot" and "the evidence of which bytes ran" mean, so five legs written by
 * three lanes do not carry five spellings of each.
 *
 * WHAT IT DOES NOT DO. It starts nothing and reaches no rail. The venue is
 * `AttestMirrorVenue`; the drill prologue (identities, contract, wedge clearing)
 * is `mirrorDrillFixture.js`; both are reused, never rebuilt. Everything here is
 * either pure (a function of its arguments, drivable in the unit tier) or a thin
 * composition over the venue that pins the two things every leg must get right:
 *
 *   - the venue is built from the ISOLATED build root, passed explicitly and
 *     recorded in the evidence beside the SHA it resolves to (B4, B11), never
 *     defaulted from whatever tree this file happens to live in;
 *   - the arming lever is the indexer's own regtest resolver, read from the
 *     indexer's registry rather than spelled here, so a renamed env key reddens
 *     the fixture instead of silently leaving every "armed" indexer inert.
 *
 * VENUE TRAPS, encoded once (family frontier, "Venue traps the legs must encode"):
 * the oracle quote lives QUOTE_LIFETIME_S and a leg that outlives it misreads a
 * stale fixture as a consensus refusal (reseed through `reseedQuoteBefore`);
 * `setmocktime` is never trusted, the mined block's stamp is read back; the
 * federation is held quiet for any full-hold assertion.
 ********************************************************************/

const assert = require('assert')
const fs     = require('fs')
const path   = require('path')
const { execFileSync } = require('child_process')

const venueModule = require('../../helpers/attestMirrorVenue')
const { AttestMirrorVenue, resolveRepoRoot, mirrorBarrierReasons, coinCode } = venueModule

// The indexer's own admission gate, resolved through the tree this file lives in,
// which in a lane is the isolated build root (B12: cross-package requires land in
// the ROOT). Read for the arming key, the margins and the height windows only.
const gate = require('../../../../xchain-indexer/src/consensus/gates/mirror_admission_gate.js')

// ---------------------------------------------------------------------------
// Constants the legs share
// ---------------------------------------------------------------------------

// The arming lever: the env key the indexer's regtest resolver reads and the value
// that arms it at height 0 (so a drill block sits above the armed node's threshold
// and below the inert node's null). A node with NO key is inert, which is today's
// behaviour byte for byte; the fixture never spells an "inert" value.
const ARM_ENV   = gate.MIRROR_ADMISSION_REGTEST_ENV
const ARM_VALUE = 'armed'

// The nine watermark-keyed reasons in BLOCK-LOOP order, which is the order BF1's
// enumeration must observe as each member's grace is raised in turn. `/status` is
// the only source of the order at run time; this is the expected sequence, and the
// unit tier pins its SET equal to the family derived from the indexer's source.
const FAMILY_REASONS_LOOP_ORDER = Object.freeze([
    'price_sync_barrier',
    'oracle_sync_barrier',
    'match_sync_barrier',
    'call_sync_barrier',
    'bridge_sync_barrier',
    'policy_sync_barrier',
    'anchor_attest_barrier',
    'attest_response_sync_barrier',
    'snapshot_sync_barrier',
])

// The venue oracle's quote lifetime and the margin a long leg reseeds inside.
const QUOTE_LIFETIME_S  = 1800
const RESEED_MARGIN_S   = 300

// The indexer's barrier hold ceiling (HUB_SYNC_BARRIER_HOLD_CEILING_S) and its
// timed-out line cadence, the two numbers BF1 and BF3 size their waits from.
const HOLD_CEILING_S    = 900
const BARRIER_CYCLE_S   = 60

// The mirror tables that carry a per-chain admission map, with the one BTC-only
// rail and the one publishing-chain rail named as such, so a leg picking a table
// for BF3 or BF4 asks the fixture which column that table binds on.
const ADMISSION_TABLES = Object.freeze({
    cross_chain_matches:   'mapped',
    cross_chain_calls:     'mapped',
    bridge_transfers:      'mapped',
    policy_snapshots:      'mapped',
    price_snapshots:       'mapped',
    attestation_responses: 'btc_only',
    oracle_prices:         'publishing_chain',
})

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * The per-index env overlay that arms the named indexers and leaves the rest inert.
 * `{ armed: [0] }` gives `{ 0: { [ARM_ENV]: 'armed' } }` and nothing for indexer 1,
 * which is BF5's whole lever: one venue, two rules.
 *
 * @param {{armed?: number[]}} spec
 * @returns {object} an `opts.indexerEnv` value
 */
function armingOverlay (spec) {
    const armed = (spec && Array.isArray(spec.armed)) ? spec.armed : []
    const out = {}
    for (const i of armed) {
        if (!Number.isInteger(i) || i < 0) throw new Error('barrierFamilyFixture: bad indexer index ' + i)
        out[i] = { [ARM_ENV]: ARM_VALUE }
    }
    return out
}

/**
 * The admission column a mirrored row binds on for chain `chain` in table `table`:
 * `admit_block_<c>` on the mapped rails, `admit_block_btc` on the BTC-only rail
 * whatever chain asks, `admit_block` on the publishing-chain rail.
 */
function admissionColumn (table, chain) {
    const kind = ADMISSION_TABLES[table]
    if (!kind) throw new Error('barrierFamilyFixture: ' + table + ' carries no admission column')
    if (kind === 'btc_only') return 'admit_block_btc'
    if (kind === 'publishing_chain') return 'admit_block'
    return 'admit_block_' + String(chain).toLowerCase()
}

/**
 * Whether one mirrored row is readable at block B on `chain`, by the binding rule
 * of family section 5.5: a row with an admission height for this chain binds when
 * that height is <= B; a LEGACY row (NULL, or a map that never named this chain)
 * binds by `effective_time <= t(B)` at every height. Written out here rather than
 * imported from the indexer so BF2's expected set is an INDEPENDENT computation;
 * the unit tier pins it equal to the indexer's own `isRowReadableAt`.
 */
function rowAdmittedAt (row, column, blockHeight, blockTime) {
    const h = row[column]
    if (h === null || h === undefined) {
        const et = Number(row.effective_time)
        return Number.isFinite(et) && Number.isFinite(Number(blockTime)) && et <= Number(blockTime)
    }
    const height = Number(h)
    return Number.isSafeInteger(height) && height >= 0 && Number.isSafeInteger(Number(blockHeight)) && height <= Number(blockHeight)
}

/**
 * BF2's expected APPLIED ROW SET: the keys of every hub row readable at B on
 * `chain`, computed from the hub's own rows and never from an indexer's hash.
 *
 * @param {object[]} rows          the hub's rows for `table`
 * @param {string}   table
 * @param {string}   chain         upper-case chain code of the reading indexer
 * @param {number}   blockHeight   B
 * @param {number}   blockTime     t(B), for the legacy rule
 * @param {function} [keyOf]       row -> string key (default: the row id)
 * @returns {string[]}             sorted keys
 */
function admittedRowSet (rows, table, chain, blockHeight, blockTime, keyOf) {
    const column = admissionColumn(table, chain)
    const key = keyOf || ((r) => String(r.id))
    return rows.filter((r) => rowAdmittedAt(r, column, blockHeight, blockTime)).map(key).sort()
}

/**
 * The height BF3 pins one indexer's `heights[table][chain]` at: one below the
 * member's own satisfaction line `B - ADMIT_MARGIN_BLOCKS[table]`, using that
 * member's own margin (4 for a mapped rail, 1 for attest responses and oracle
 * prices, 144 for anchor-reward attestations). Never negative.
 */
function pinnedHeightFor (table, blockHeight) {
    const B = Number(blockHeight)
    if (!Number.isSafeInteger(B) || B < 0) throw new Error('barrierFamilyFixture: bad block height ' + blockHeight)
    return Math.max(0, B - gate.admitMarginBlocks(table) - 1)
}

/**
 * The stall facts a leg asserts on, lifted off an indexer `/status` body with the
 * absent-key case made explicit (an absent field is `undefined`, never a default),
 * so a leg cannot read a missing `stallClearsAt` as the null BF3 expects.
 */
function stallSnapshot (statusBody) {
    const b = statusBody || {}
    return {
        stallClass:        b.stallClass,
        stallReason:       b.stallReason,
        stallClearsAt:     b.stallClearsAt,
        atProcessableTip:  b.atProcessableTip,
        degraded:          b.degraded,
        heights:           b.hubMirror && b.hubMirror.heights ? b.hubMirror.heights : undefined,
    }
}

/**
 * The mocha timeout for a leg that asserts a hold of `holdS` seconds: the hold,
 * three timed-out barrier cycles to observe the identical line, the venue boot,
 * and slack. Legs pass this to `this.timeout` rather than guessing.
 */
function legTimeoutMs (holdS, opts) {
    const o = opts || {}
    const bootS  = o.bootS  === undefined ? 300 : o.bootS
    const slackS = o.slackS === undefined ? 600 : o.slackS
    return (Number(holdS) + (3 * BARRIER_CYCLE_S) + bootS + slackS) * 1000
}

/**
 * Whether a leg that started at `startedAtMs` must reseed the oracle quote before
 * running for another `nextS` seconds, on the QUOTE_LIFETIME_S trap.
 */
function reseedQuoteBefore (startedAtMs, nowMs, nextS) {
    const elapsedS = (Number(nowMs) - Number(startedAtMs)) / 1000
    return (elapsedS + Number(nextS || 0)) >= (QUOTE_LIFETIME_S - RESEED_MARGIN_S)
}

// ---------------------------------------------------------------------------
// The build root and its evidence
// ---------------------------------------------------------------------------

/** The commit a checkout (worktree or main) is at, read-only. */
function headShaOf (repoDir) {
    return execFileSync('git', ['-C', repoDir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
}

/**
 * The evidence record every leg writes beside its assertions: the root each
 * child ran from and the SHA that root resolves to, per repo. A hub with its own
 * root (BF6's mixed-version pair) is listed per index. Nothing here is a claim a
 * leg makes about itself; it is what the venue was built from, read back.
 */
function evidenceRecord (venue, extra) {
    const repos = ['xchain-hub', 'xchain-indexer', 'xchain-e2e-test']
    const shas = {}
    for (const r of repos) {
        const dir = path.join(venue.repoRoot, r)
        shas[r] = fs.existsSync(dir) ? headShaOf(dir) : null
    }
    const hubRoots = venue.hubRepoRoots.map((root, i) => ({
        index: i, root, sha: fs.existsSync(path.join(root, 'xchain-hub')) ? headShaOf(path.join(root, 'xchain-hub')) : null,
    }))
    return Object.assign({ repoRoot: venue.repoRoot, shas, hubRoots, coin: venue.coin, network: venue.network,
                           armEnv: ARM_ENV, indexerEnv: venue.indexerEnv }, extra || {})
}

/**
 * Merge an `opts.indexerEnv`-shaped overlay into a base of the same shape KEY BY
 * KEY, so a per-index entry in `base` (a leg's own `indexerExtraEnv`-style key)
 * survives when `overlay` also arms that same index; a plain `Object.assign` at
 * the top level would replace index N's whole env object instead of merging it.
 */
function mergeIndexerEnv (base, overlay) {
    const out = Object.assign({}, base)
    for (const idx of Object.keys(overlay)) {
        out[idx] = Object.assign({}, out[idx] || {}, overlay[idx])
    }
    return out
}

/**
 * Build (not start) the family venue from an EXPLICIT build root. `opts.repoRoot` is
 * required: a leg that lets the venue default its root gets whatever tree this file
 * lives in, which is the shared-tree defect B4 measured. `opts.armed` is the list of
 * indexer indexes to arm; `opts.hubRepoRoots` passes through to the venue for BF6.
 *
 * @returns {{venue: AttestMirrorVenue, evidence: object}}
 */
function buildFamilyVenue (opts) {
    const o = opts || {}
    assert.ok(o.repoRoot, 'barrierFamilyFixture: repoRoot is required and must be the isolated build root')
    const root = resolveRepoRoot(o.repoRoot, {})
    const venueOpts = Object.assign({}, o.venue || {}, {
        label:      o.label || 'bf',
        repoRoot:   root,
        indexerEnv: mergeIndexerEnv((o.venue && o.venue.indexerEnv) || {}, armingOverlay({ armed: o.armed || [] })),
    })
    if (o.hubRepoRoots) venueOpts.hubRepoRoots = o.hubRepoRoots
    const venue = new AttestMirrorVenue(venueOpts)
    return { venue, evidence: evidenceRecord(venue, { armed: o.armed || [], coinCode: coinCode(venue.coin) }) }
}

module.exports = {
    ARM_ENV,
    ARM_VALUE,
    FAMILY_REASONS_LOOP_ORDER,
    QUOTE_LIFETIME_S,
    RESEED_MARGIN_S,
    HOLD_CEILING_S,
    BARRIER_CYCLE_S,
    ADMISSION_TABLES,
    armingOverlay,
    admissionColumn,
    rowAdmittedAt,
    admittedRowSet,
    pinnedHeightFor,
    stallSnapshot,
    legTimeoutMs,
    reseedQuoteBefore,
    headShaOf,
    evidenceRecord,
    buildFamilyVenue,
    // Re-exported so a leg reads the family from one module.
    mirrorBarrierReasons,
}
