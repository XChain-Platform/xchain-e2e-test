// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.
//
// Anti-reseed guard for XCHAIN/USD (spec §10 step 8).
//
// THE BUG THIS EXISTS TO PREVENT IS THE ORIGINAL ONE: a launch blocker
// that survived every green native-fee run because the suites hand-seeded
// XCHAIN/USD = 1.00, a value no producer has ever emitted. The suites were testing
// against data production does not produce, so the missing producer was invisible.
//
// The path of least resistance for a future test author who needs the pair is to
// paste another seed with another convenient number, which silently recreates
// exactly that condition. So, two rules, layered as the venues allow:
//
//   1. Where seeding is allowed (a venue whose hub does NOT publish the pair),
//      the seeded VALUE must be the shared bootstrap constant - the value a real
//      hub publishes.
//   2. TIGHTENED 2026-07-27, now that the validator venue exists (a BTC
//      regtest venue, live since 2026-07-26): every seed site must be SUPPRESSIBLE via
//      XCHAIN_E2E_NO_PRICE_SEED, because on a publishing venue one unsuppressed
//      seed outranks every derived round (getLatestPrice takes the highest
//      round_number and seeds use synthetic rounds in the 990000+ space) - the
//      run stays green while testing a fixture, the original bug's exact shape.
//      Fixture-priced suites skip under the flag; the sdk venue setups, whose fee
//      arithmetic comes FROM the fixture, refuse loudly (refuseSeedIfSuppressed).

'use strict'

const assert = require('assert')
const fs     = require('fs')
const path   = require('path')

const { BOOTSTRAP_XCHAIN_USD, hubBootstrapConstant,
        HUB_BOOTSTRAP_SATS, HUB_CONSTANT_MISSING } = require('../helpers/xchainPriceConstants')

const TEST_ROOT = path.join(__dirname, '..')

// This file is itself full of the strings it hunts for. Excluding it by name is the
// simple fix for the self-match trap that has now bitten two guards in this repo
// (the vendor-parity prose check, and the step-7 guard which matched the line holding
// its own regex literal).
const SELF = path.basename(__filename)

function walk(dir, out = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) { walk(full, out); continue }
        if (entry.isFile() && entry.name.endsWith('.js') && entry.name !== SELF) out.push(full)
    }
    return out
}

// Relative modules a file requires, resolved to absolute .js paths that exist.
// A seed site is allowed to delegate the seeding itself to a shared helper, and the
// suppression then lives in the helper rather than at the call site; following one
// level of require is what lets the guard see it there.
function localRequires(file, body) {
    const out = []
    const rx = /require\(\s*'(\.[^']+)'\s*\)/g
    let m
    while ((m = rx.exec(body)) !== null) {
        let target = path.resolve(path.dirname(file), m[1])
        if (!target.endsWith('.js')) target += '.js'
        if (fs.existsSync(target)) out.push(target)
    }
    return out
}

describe('XCHAIN/USD seed guard', function () {

    const files = walk(TEST_ROOT)

    it('finds test files to scan at all, so a broken walk cannot pass vacuously', function () {
        // A guard that scans nothing passes forever. This is the tripwire for that.
        assert.ok(files.length > 50, 'expected to scan the e2e test tree, found ' + files.length + ' files')
    })

    it('seeds no XCHAIN/USD price other than the shared bootstrap constant', function () {
        // Matches a decimal literal appearing on a line that also names the pair: the
        // shape of every hand-seed in this repo. Deliberately line-scoped rather than
        // AST-aware; the point is to catch a pasted literal, not to be a parser.
        const offenders = []
        for (const file of files) {
            const lines = fs.readFileSync(file, 'utf8').split('\n')
            lines.forEach((line, i) => {
                if (!line.includes('XCHAIN/USD')) return
                const literals = line.match(/'[0-9]+\.[0-9]+'/g)
                if (!literals) return
                for (const lit of literals) {
                    if (lit !== "'" + BOOTSTRAP_XCHAIN_USD + "'") {
                        offenders.push(path.relative(TEST_ROOT, file) + ':' + (i + 1) + '  ' + line.trim())
                    }
                }
            })
        }
        assert.deepStrictEqual(offenders, [],
            'XCHAIN/USD must be seeded at the bootstrap constant (' + BOOTSTRAP_XCHAIN_USD +
            '), which is what a real hub publishes. Import BOOTSTRAP_XCHAIN_USD from ' +
            'test/helpers/xchainPriceConstants instead of pasting a literal:\n  ' +
            offenders.join('\n  '))
    })

    it('keeps every XCHAIN/USD seed site suppressible on a publishing venue', function () {
        // A seed site is a file that either pairs 'XCHAIN/USD' with a decimal
        // literal or the bootstrap constant on one line, or names both the pair and
        // the constant anywhere (the oracle-live suite splits them across lines).
        // Such a file must reference the suppression - the NO_PRICE_SEED flag or
        // the refuseSeedIfSuppressed helper - so that a validator-venue run can
        // turn every seed off. A seed that cannot be turned off shadows every
        // derived round there and the run stays green against a fixture.
        const offenders = []
        for (const file of files) {
            const body = fs.readFileSync(file, 'utf8')
            const lines = body.split('\n')
            const lineHit = lines.some(l => l.includes('XCHAIN/USD') &&
                (l.includes('BOOTSTRAP_XCHAIN_USD') || /'[0-9]+\.[0-9]+'/.test(l)))
            const fileHit = body.includes('XCHAIN/USD') && body.includes('BOOTSTRAP_XCHAIN_USD')
            if (!lineHit && !fileHit) continue
            const suppressible = (text) =>
                text.includes('NO_PRICE_SEED') || text.includes('refuseSeedIfSuppressed')
            if (suppressible(body)) continue
            // Or the helper it hands the seed to refuses on its behalf.
            if (localRequires(file, body).some(dep => suppressible(fs.readFileSync(dep, 'utf8')))) continue
            offenders.push(path.relative(TEST_ROOT, file))
        }
        assert.deepStrictEqual(offenders, [],
            'these files seed XCHAIN/USD but cannot be suppressed on a venue whose hub ' +
            'publishes the pair; gate them on NO_PRICE_SEED (skip) or ' +
            'refuseSeedIfSuppressed (setup refusal), both from test/helpers/xchainPriceConstants:\n  ' +
            offenders.join('\n  '))
    })

    it('keeps the bootstrap constant byte-equal to the hub that publishes it', function () {
        // Cross-repo pin. If the operator retunes the bootstrap on a flag-day and this
        // repo is not updated, every native-fee assertion here silently prices against
        // a value the federation stopped publishing. Skips when the sibling checkout is
        // absent, matching the convention the vendor-parity guards use.
        const hubValue = hubBootstrapConstant()
        if (hubValue === null) return this.skip()

        // A present-but-unfindable constant is a FAILURE, never a skip. The previous
        // form of this guard collapsed 'sibling absent' and 'constant renamed' into the
        // same null and skipped both, so the 2026-08-03 rename of
        // XCHAIN_PRICE_BOOTSTRAP_USD -> _SATS sailed past it silently. A pin that
        // cannot tell those apart is not a pin.
        assert.notStrictEqual(hubValue, HUB_CONSTANT_MISSING,
            'xchain-hub/src/constants.js exists but declares no XCHAIN_PRICE_BOOTSTRAP_SATS; ' +
            'it was renamed or removed, and this pin must be repointed rather than skipped')

        assert.strictEqual(HUB_BOOTSTRAP_SATS, hubValue,
            'e2e bootstrap pin has drifted from xchain-hub XCHAIN_PRICE_BOOTSTRAP_SATS')
    })

    it('keeps the derivation proof carrying its own inline no-seed guard', function () {
        // xchainPriceDerivation.test.js proves the pair FROM real on-chain fills, and it
        // already guards itself against being "fixed" with a seed. Deliberately asserted
        // as PRESENCE rather than re-scanning that file here: a second scan would match
        // the very lines of the first guard and fail on them, which is the self-match
        // trap that has already bitten two guards in this repo. Keep one scanner per
        // file, and check from outside that it still exists.
        const proof = path.join(TEST_ROOT, 'actions', 'xchainPriceDerivation.test.js')
        if (!fs.existsSync(proof)) return this.skip()
        const body = fs.readFileSync(proof, 'utf8')
        assert.ok(body.includes('the anti-reseed guard (spec step 8)'),
            'the derivation proof has lost its inline anti-reseed guard; without it a future ' +
            'author can seed the pair the proof is supposed to derive and the run stays green')
    })
})
