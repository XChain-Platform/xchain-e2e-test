#!/usr/bin/env node
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

// Retract the suite's leftover synthetic price_snapshots rows on a venue
// whose own hub publishes the pair, without running a suite.
//
// WHY A SCRIPT. The durable fix (priceSnapshotHelper.clearSeedSentinels, called
// from nativeFeeHelper's NO_PRICE_SEED branch) only fires when a suite that seeds
// prices actually runs, and the leftovers are worst on a venue nobody is about to
// run that suite against. Both times an operator needed this they hand-wrote a
// throwaway runner in /tmp and rediscovered the same two obstacles: readParams()
// resolves from HUB_DB_* or a mocha-set global.indexerDatabase and the regtest
// envs set HUB_DB_HOST but no HUB_DB_NAME, so a standalone require fails with
// "Cannot read properties of null"; and the venue's live password can have
// drifted from the .env (the four-store credential problem). This is that runner,
// kept, so the third operator does not write it a third time.
//
// WHY THE FLAG IS A HARD GATE. On a venue whose hub does NOT publish XCHAIN/USD
// and COIN/USD, the sentinel rows are not junk, they are the only price the fee
// lane has: measured 2026-07-28, DOGE regtest's entire price_snapshots table was
// four rows and all four were sentinels. Deleting them there takes the lane from
// priced to unpriced, which is the opposite of the repair. XCHAIN_E2E_NO_PRICE_SEED=1
// is exactly the operator's declaration that this venue derives its own prices,
// so it is what authorises the delete.
//
// Credentials are read from the environment and never printed.
//
// Usage:
//   XCHAIN_E2E_NO_PRICE_SEED=1 node scripts/clear-seed-sentinels.js [--env .env.ltc] [--pair XCHAIN/USD]

const path = require('path')

const REPO_ROOT = path.join(__dirname, '..')

// The declaration that this venue's hub publishes the pair. Without it the rows
// being deleted may be the venue's only price source.
function assertPublishingVenue(env){
    if (env.XCHAIN_E2E_NO_PRICE_SEED === '1') return
    throw new Error(
        'refusing to clear: XCHAIN_E2E_NO_PRICE_SEED=1 is not set. That flag is how a venue ' +
        'declares its own hub publishes XCHAIN/USD and COIN/USD. On a venue that does not, the ' +
        'sentinel rows ARE the fee lane\'s price and deleting them makes every native-fee quote ' +
        'unpriced. Set the flag only for a publishing venue (a BTC regtest venue since 2026-07-26).')
}

// hubMirrorTopology.readParams() wants HUB_DB_HOST *and* HUB_DB_NAME together, or
// a global.indexerDatabase that only the mocha harness sets. The venue envs carry
// the indexer's own coordinates under INDEXER_DB_* / DATABASE_*, so map them
// across. Returns the names it filled in, for a log line that names no value.
//
// All-or-nothing on purpose. A venue env that sets some HUB_DB_* but no
// HUB_DB_NAME is not a usable topology, it is a half-filled one, and honouring
// those leftovers mixes identities: one venue's BTC env sets HUB_DB_USER to
// the hub's account, so keeping it while resolving the INDEXER database produced
// "Access denied for user 'xchain_hub'" against the indexer's schema. Only keys
// the operator PINNED (already in the process environment before any env file was
// read) survive, which is how a drifted .env password gets overridden by hand.
function applyTopology(env, pinned = new Set()){
    if (env.HUB_DB_HOST && env.HUB_DB_NAME) return []
    const filled = []
    const put = (key, value) => {
        if (!value || pinned.has(key)) return
        env[key] = value
        filled.push(key)
    }
    put('HUB_DB_HOST', env.INDEXER_DB_HOST || env.DATABASE_URL)
    put('HUB_DB_PORT', env.INDEXER_DB_PORT || env.DATABASE_PORT)
    put('HUB_DB_NAME', env.INDEXER_DB_NAME)
    put('HUB_DB_USER', env.INDEXER_DB_USER)
    put('HUB_DB_PASS', env.INDEXER_DB_PASS)
    return filled
}

function parseArgs(argv){
    const opts = { envFile: null, pair: null }
    for (let i = 0; i < argv.length; i++){
        if (argv[i] === '--env')  opts.envFile = argv[++i]
        else if (argv[i] === '--pair') opts.pair = argv[++i]
        else throw new Error('unrecognised argument: ' + argv[i])
    }
    return opts
}

async function main(argv, env){
    const opts = parseArgs(argv)
    // Snapshot BEFORE the env file lands, so "the operator set this by hand" and
    // "the file happened to contain it" stay distinguishable.
    const pinned = new Set(Object.keys(env).filter(k => k.startsWith('HUB_DB_')))
    if (opts.envFile){
        require(path.join(REPO_ROOT, 'node_modules', 'dotenv'))
            .config({ path: path.resolve(REPO_ROOT, opts.envFile) })
    }
    assertPublishingVenue(env)
    const filled = applyTopology(env, pinned)
    if (filled.length) console.log('topology: filled ' + filled.join(', ') + ' from the venue env')

    const helper = require(path.join(REPO_ROOT, 'test', 'helpers', 'priceSnapshotHelper'))
    const { SEED_SENTINEL_ROUNDS } = require(path.join(REPO_ROOT, 'test', 'helpers', 'xchainPriceConstants'))

    const target = helper.seedTarget()
    if (!target) throw new Error('no database resolved; pass --env or set HUB_DB_HOST + HUB_DB_NAME')
    console.log('target: db=' + target.database + ' host=' + target.host + ':' + target.port)
    console.log('rounds in scope: ' + SEED_SENTINEL_ROUNDS.join(','))
    if (opts.pair) console.log('scoped to pair: ' + opts.pair)

    const removed = await helper.clearSeedSentinels(opts.pair || undefined)
    console.log('cleared ' + removed + ' leftover seed-sentinel price_snapshots row(s)')
    return removed
}

module.exports = { assertPublishingVenue, applyTopology, parseArgs, main }

if (require.main === module){
    main(process.argv.slice(2), process.env)
        .catch(err => { console.error('clear-seed-sentinels: ' + err.message); process.exit(1) })
}
