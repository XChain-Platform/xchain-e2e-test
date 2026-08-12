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

// SEED_SENTINEL_ROUNDS is what clearSeedSentinels deletes, so a
// seed site whose round is missing from it is not merely undocumented: the
// flagged run prints "cleared N leftover rows", the operator reads that as the
// venue being clean, and the missing round goes on outranking every derived round
// for its pair forever. That is not hypothetical. After the LTC venue was cleared
// on 2026-07-28 the BTC regtest indexer still held 999000001-999000006 (dispenser
// FIAT) at a flat 50000.00 above the hub's own BTC/EUR, BTC/GBP, BTC/JPY, BTC/CHF
// and BTC/CAD rounds, because those six were never in the list.
//
// The old guard was a comment in nativeFeeHelper asking editors to keep the two
// in lockstep. Comments do not fail a build. This walks the seed sites and makes
// the list answer for them.

const assert = require('assert')
const fs     = require('fs')
const path   = require('path')

const { SEED_SENTINEL_ROUNDS } = require('../../helpers/xchainPriceConstants')

// Same floor xchainPriceDerivation uses to tell a fixture from a derived round: a
// hub's counter is a small monotonic integer that needs decades at a ten-minute
// cadence to reach six digits. The ceiling keeps unix timestamps (~1.78e9), which
// share the digit count, out of the scan.
const SEED_ROUND_FLOOR = 990000
const ROUND_CEILING    = 1e9

const TEST_ROOT = path.join(__dirname, '..', '..')

function jsFilesUnder(dir, out = []){
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })){
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()){
            if (entry.name !== 'node_modules') jsFilesUnder(full, out)
        } else if (entry.name.endsWith('.js')) out.push(full)
    }
    return out
}

// Turn the token a seed site passes as its round into the numbers it can be.
// Three forms cover every site in the tree: an inline literal, a file-local
// numeric const (nativeFeeHelper's XCHAIN_ROUND and friends), and the seed-table
// destructure the DOGE setups use, `for (const [pair, price, round] of [[...]])`.
function resolveRoundToken(src, token){
    if (/^\d+$/.test(token)) return [Number(token)]

    const declared = src.match(new RegExp('(?:const|let|var)\\s+' + token + '\\s*=\\s*(\\d+)\\b'))
    if (declared) return [Number(declared[1])]

    const fromTable = []
    for (const line of src.split('\n')){
        if (!new RegExp('\\[[^\\]]*\\b' + token + '\\b[^\\]]*\\]\\s*of\\s*\\[').test(line)) continue
        for (const m of line.matchAll(/\b(\d{6,10})\b/g)){
            const n = Number(m[1])
            if (n >= SEED_ROUND_FLOOR && n < ROUND_CEILING) fromTable.push(n)
        }
    }
    return fromTable
}

// Every round number a file hands to price_snapshots. Two syntactic shapes: the
// helper's `roundNumber:` property, and the local `seedPrice(pair, price, block,
// round)` wrappers in nativeFeeLive / nativeFeeDispenser that write the INSERT
// themselves rather than going through priceSnapshotHelper.
function seededRounds(file){
    const src    = fs.readFileSync(file, 'utf8')
    const tokens = []
    for (const m of src.matchAll(/roundNumber\s*:\s*([A-Za-z0-9_$]+)/g))            tokens.push(m[1])
    for (const m of src.matchAll(/seedPrice\(\s*[^()]*?,\s*([A-Za-z0-9_$]+)\s*\)/g)) tokens.push(m[1])

    const rounds = new Set()
    for (const token of tokens)
        for (const n of resolveRoundToken(src, token))
            if (n >= SEED_ROUND_FLOOR && n < ROUND_CEILING) rounds.add(n)
    return rounds
}

// The unit tree is excluded because it asserts ABOUT these values rather than
// writing them, so its literals are not seed sites.
function seedSites(){
    return jsFilesUnder(TEST_ROOT)
        .filter(f => !f.includes(path.sep + 'unit' + path.sep))
        .map(f => ({ file: path.relative(TEST_ROOT, f), rounds: seededRounds(f) }))
        .filter(s => s.rounds.size)
}

describe('seed-sentinel coverage', () => {

    it('every synthetic round the suite seeds is one clearSeedSentinels deletes', () => {
        const known   = new Set(SEED_SENTINEL_ROUNDS)
        const missing = []
        for (const site of seedSites())
            for (const round of site.rounds)
                if (!known.has(round)) missing.push(site.file + ' seeds round ' + round)

        assert.deepStrictEqual(missing, [],
            'these seed sites write rounds SEED_SENTINEL_ROUNDS cannot retract, so a ' +
            'flagged run would report success while they keep shadowing their pair:\n  ' +
            missing.join('\n  '))
    })

    it('finds the seed sites at all, so a silent zero-match cannot pass it', () => {
        // A regex guard that matches nothing is a green test that proves nothing.
        // Pin the shape of the corpus rather than its exact size, which churns.
        const sites = seedSites()
        assert.ok(sites.length >= 6, 'expected the known seed sites, found ' + sites.length)
        const files = sites.map(s => s.file)
        for (const expected of ['helpers/nativeFeeHelper.js', 'actions/dispenser.test.js',
                                'actions/nativeFeeLive.test.js'])
            assert.ok(files.some(f => f === expected),
                expected + ' seeds price_snapshots but the scan missed it')
    })

    it('the six dispenser FIAT rounds found live on BTC regtest are covered', () => {
        // Regression pin for the exact rows measured on the
        // venue. Named individually because the general assertion above would go
        // green again if someone deleted the dispenser cases rather than the rows.
        for (const round of [999000001, 999000002, 999000003, 999000004, 999000005, 999000006])
            assert.ok(SEED_SENTINEL_ROUNDS.includes(round), 'round ' + round + ' must be retractable')
    })

    it('no sentinel sits low enough to collide with a derived round', () => {
        for (const round of SEED_SENTINEL_ROUNDS)
            assert.ok(round >= SEED_ROUND_FLOOR && round < ROUND_CEILING,
                'sentinel ' + round + ' is outside the fixture band (' + SEED_ROUND_FLOOR +
                ' .. ' + ROUND_CEILING + '), so the clear could delete a hub round')
    })

    it('holds no duplicate rounds', () => {
        assert.strictEqual(new Set(SEED_SENTINEL_ROUNDS).size, SEED_SENTINEL_ROUNDS.length)
    })
})
