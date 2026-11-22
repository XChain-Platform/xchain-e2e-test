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
// XCHAIN price derivation, live proof (spec §10 step 7).
//
// Every other suite that touches native-coin fees seeds XCHAIN/USD by hand
// (nativeFeeHelper.seedGlobalPrices), which is exactly why the missing-pair bug
// survived to launch-blocker status: every green run tested against data
// production does not produce. This file does the opposite. It MAKES real XCHAIN
// trades on the chain and then asserts the production selection + formula price
// them, so a regression in either is caught by data rather than by a fixture.
//
// It deliberately does NOT seed the pair. The venue legs live in the
// xchain_price_derivation.test/ parts, registered below in file order.

const assert = require('assert')
const fs = require('fs')
const path = require('path')
const venue = require('./xchain_price_derivation.test/helpers/venue.test')
const { registerDispenserVenue } = require('./xchain_price_derivation.test/01_dispenser_venue.test')
const { registerDexVenue } = require('./xchain_price_derivation.test/02_dex_venue.test')
const { registerHubPublished } = require('./xchain_price_derivation.test/03_hub_published.test')
const { registerSelectionExclusions } = require('./xchain_price_derivation.test/04_selection_exclusions.test')
const { registerNativeFee } = require('./xchain_price_derivation.test/05_native_fee.test')

const PARTS_DIR = path.join(__dirname, 'xchain_price_derivation.test')

// Shared across the parts; filled by the root `before` below.
const ctx = { derivation: null, bcmath: null }

function loadDerivation(suite) {
    if (!venue.QUERY_PATH || !venue.PRICE_PATH) {
        console.log('xchainPriceDerivation: sibling xchain-indexer not checked out; skipping')
        suite.skip()
        return
    }
    ctx.bcmath = venue.loadBcmath()
    if (!ctx.bcmath) {
        console.log('xchainPriceDerivation: sibling xchain-hub bcmath not found; skipping')
        suite.skip()
        return
    }
    ctx.derivation = {
        query: require(venue.QUERY_PATH),
        price: require(venue.PRICE_PATH)
    }
}

// This file and every part under the parts directory, so the guard keeps
// covering the code that moved out of this file.
function guardedSources() {
    const parts = []
    for (const dir of [PARTS_DIR, path.join(PARTS_DIR, 'helpers')]) {
        for (const name of fs.readdirSync(dir)) {
            if (name.endsWith('.js')) parts.push(path.join(dir, name))
        }
    }
    return [__filename].concat(parts)
}

// The path of least resistance for a future author who sees this suite go
// red is to seed the pair and move on, which silently resurrects the
// original bug: a green run that proves nothing about production. Keep the
// guard next to the temptation.
// Match CALL syntax (`helper.seedSnapshot(`), not the bare names: a
// scan for the names alone matches this very line and fails the guard
// on itself, which is the same self-match trap a source-scanning
// assertion always sets for its author.
function seedCallLines() {
    const seeds = []
    for (const file of guardedSources()) {
        const lines = fs.readFileSync(file, 'utf8').split('\n')
        seeds.push(...lines.filter(line =>
            /\.(seedSnapshot|seedGlobalPrices)\s*\(/.test(line) && !/^\s*\/\//.test(line)))
    }
    return seeds
}

function registerAntiReseedGuard() {
    describe('the anti-reseed guard (spec step 8)', function () {
        it('does not seed XCHAIN/USD anywhere in this file', function () {
            assert.deepStrictEqual(seedCallLines(), [],
                'this proof must derive XCHAIN/USD from real fills, never seed it')
        })
    })
}

describe('XCHAIN price derivation from real fills (spec step 7)', function () {
    before(function () { loadDerivation(this) })

    registerDispenserVenue(ctx)
    registerDexVenue(ctx)
    registerHubPublished(ctx)
    registerSelectionExclusions(ctx)
    registerNativeFee(ctx)
    registerAntiReseedGuard()
})
