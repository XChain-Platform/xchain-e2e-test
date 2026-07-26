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
// Anti-reseed guard for XCHAIN/USD (, spec §10 step 8).
//
// THE BUG THIS EXISTS TO PREVENT IS THE ORIGINAL ONE.  was a launch blocker
// that survived every green native-fee run because the suites hand-seeded
// XCHAIN/USD = 1.00, a value no producer has ever emitted. The suites were testing
// against data production does not produce, so the missing producer was invisible.
//
// The path of least resistance for a future test author who needs the pair is to
// paste another seed with another convenient number, which silently recreates
// exactly that condition. So: seeding is still allowed (the venue whose hub runs as
// a price-capability oracle validator does not exist yet), but the seeded VALUE must
// be the shared bootstrap constant - the value a real hub publishes today.
//
// When the validator venue lands, this guard tightens from "seed the right value" to
// "do not seed at all".

'use strict'

const assert = require('assert')
const fs     = require('fs')
const path   = require('path')

const { BOOTSTRAP_XCHAIN_USD, hubBootstrapConstant } = require('../helpers/xchainPriceConstants')

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

describe('XCHAIN/USD seed guard ( step 8)', function () {

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

    it('keeps the bootstrap constant byte-equal to the hub that publishes it', function () {
        // Cross-repo pin. If the operator retunes the bootstrap on a flag-day and this
        // repo is not updated, every native-fee assertion here silently prices against
        // a value the federation stopped publishing. Skips when the sibling checkout is
        // absent, matching the convention the vendor-parity guards use.
        const hubValue = hubBootstrapConstant()
        if (hubValue === null) return this.skip()
        assert.strictEqual(BOOTSTRAP_XCHAIN_USD, hubValue,
            'e2e bootstrap constant has drifted from xchain-hub XCHAIN_PRICE_BOOTSTRAP_USD')
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
