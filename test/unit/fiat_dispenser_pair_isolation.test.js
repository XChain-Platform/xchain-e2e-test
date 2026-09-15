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

// `price_snapshots` is global fixture state keyed only by coin_pair, and
// every writer of a pair CLEARS it first. nativeFeeHelper.seedGlobalPrices() is
// the one that bites: it clears {COIN}/USD + XCHAIN/USD from getNativeFeeOutput(),
// which every ACTION tx passes through, throttled to once per SEED_REFRESH_MS. A
// FIAT dispenser case that seeds {COIN}/USD and then sends an action tx before its
// payment could therefore have its snapshot deleted and replaced at a present-day
// timestamp and a different price, mid-case.
//
// That is what made the back-dated Mode 2 cases flake: they seed 20-25h in the
// past, and reverseOraclePriceMatch reads the validator price as of the QUOTE's
// effective_at, so a reseed dated "now" is outside the window entirely and the
// dispense settles `invalid: no matching oracle price` -- indistinguishable from a
// consensus bug. Only the throttle kept it intermittent: in isolation the reseed
// fires before the case and stays suppressed through it.
//
// The fix is that the FIAT cases price in their own fiats. These are source pins
// (the established style here, cf. the indexer's price-barrier suites) because the
// property is about which pairs two FILES agree to keep apart, which no runtime
// assertion in either file can observe.

const assert = require('assert')
const fs     = require('fs')
const path   = require('path')

// Overridable so the pins can be run against an older checkout of either file to
// prove they fail against it, which is the only way a source pin earns its place.
const DISPENSER_SUITE = process.env.XC693_SUITE_SRC
    || path.join(__dirname, '..', 'actions', 'dispenser.test.js')
const NATIVE_FEE_HELPER = process.env.XC693_HELPER_SRC
    || path.join(__dirname, '..', 'helpers', 'nativeFeeHelper.js')

// The suite may be split into a `<basename>.test/NN_*.test.js` container, an
// oversized-file convention this repo uses elsewhere: the entry keeps only a
// leading run of cases, so a pin that reads the entry alone would miss
// whatever moved to a part. Concatenating entry + parts in file order keeps
// this pin reading the same logical suite the split declares equivalent.
function readSuiteSource(suiteFile){
    const own = fs.readFileSync(suiteFile, 'utf8')
    const partsDir = suiteFile.replace(/\.js$/, '')
    if (!fs.existsSync(partsDir) || !fs.statSync(partsDir).isDirectory()) return own
    const parts = fs.readdirSync(partsDir)
        .filter(f => f.endsWith('.test.js'))
        .sort((a, b) => a.localeCompare(b, 'en'))
        .map(f => fs.readFileSync(path.join(partsDir, f), 'utf8'))
    return [own, ...parts].join('\n')
}

let suiteSrc, helperSrc

function loadSources(){
    if (suiteSrc !== undefined && helperSrc !== undefined) return
    const nextSuiteSrc  = readSuiteSource(DISPENSER_SUITE)
    const nextHelperSrc = fs.readFileSync(NATIVE_FEE_HELPER, 'utf8')
    suiteSrc  = nextSuiteSrc
    helperSrc = nextHelperSrc
}

// Parses `const FIAT_X = 'EUR'` out of the suite rather than importing it:
// requiring dispenser.test.js would register its live e2e cases with mocha.
function declaredFiats(){
    const out = {}
    const re = /const\s+(FIAT_[A-Z0-9_]+)\s*=\s*'([A-Z]{3})'/g
    let m
    while ((m = re.exec(suiteSrc)) !== null) out[m[1]] = m[2]
    return out
}

describe('FIAT dispenser price_snapshots pair isolation', () => {
    before(loadSources)

    it('declares a fiat constant for every FIAT dispenser case', () => {
        const fiats = declaredFiats()
        // One per case: Mode 1, Mode 2, oracle fee, window distance, update
        // delay, retracted quote, per-token pricing.
        assert.strictEqual(Object.keys(fiats).length, 7,
            'expected 7 FIAT_* constants, found ' + JSON.stringify(fiats))
    })

    it('gives every case a DISTINCT fiat, so no two cases share a coin_pair', () => {
        const fiats  = declaredFiats()
        const values = Object.values(fiats)
        assert.strictEqual(new Set(values).size, values.length,
            'two FIAT dispenser cases share a fiat, so one clearPair wipes the other: '
            + JSON.stringify(fiats))
    })

    it('keeps every case OFF the USD pair nativeFeeHelper clears', () => {
        const fiats = declaredFiats()
        for (const [name, code] of Object.entries(fiats)){
            assert.notStrictEqual(code, 'USD',
                name + " is back on USD, the pair nativeFeeHelper.seedGlobalPrices() "
                + 'deletes from every action tx. That is the known flake.')
        }
    })

    it('uses only fiats the indexer accepts in FIAT_CODE', () => {
        // xchain-indexer/src/config.js FIATS. A code outside this list is
        // rejected at dispenser create with `invalid: FIAT_CODE (unsupported FIAT)`.
        const SUPPORTED = ['USD', 'CAD', 'AUD', 'MXN', 'GBP', 'JPY', 'CNY', 'CHF', 'BRL', 'INR', 'EUR', 'KRW']
        for (const [name, code] of Object.entries(declaredFiats())){
            assert(SUPPORTED.includes(code),
                name + " = '" + code + "' is not in the indexer's FIATS allow-list")
        }
    })
})

describe('FIAT dispenser price_snapshots pair isolation', () => {
    before(loadSources)

    it('no FIAT dispenser case seeds or clears a USD pair directly', () => {
        // Catches a case that hardcodes the pair instead of using its constant.
        const offenders = suiteSrc.split('\n')
            .map((line, i) => ({ line, n: i + 1 }))
            .filter(({ line }) => /clearPair\(|coinPair:|fiat:\s*'/.test(line))
            .filter(({ line }) => /['"]USD['"]|\/USD/.test(line))
        assert.deepStrictEqual(offenders.map(o => o.n), [],
            'these lines pin the shared USD pair again: '
            + JSON.stringify(offenders.map(o => o.n + ': ' + o.line.trim())))
    })

    it('nativeFeeHelper still clears ONLY the USD pairs this isolation assumes', () => {
        // The whole fix rests on nativeFeeHelper's blast radius being {COIN}/USD +
        // XCHAIN/USD. If it gains another pair, the FIAT cases must move again.
        const cleared = [...helperSrc.matchAll(/clearPair\(([^)]*)\)/g)].map(m => m[1].trim())
        assert.deepStrictEqual(cleared, ["'XCHAIN/USD'", "global.COIN_CODE + '/USD'"],
            'nativeFeeHelper.clearPair call set changed; re-check pair isolation. Found: '
            + JSON.stringify(cleared))
    })
})
