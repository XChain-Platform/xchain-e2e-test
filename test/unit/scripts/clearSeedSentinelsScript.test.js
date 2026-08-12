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

// The script deletes rows on a live venue, so its two guards are the
// whole point and both were learned from a venue rather than a review:
//
//  - the flag gate, because on a NON-publishing venue the sentinel rows are the
//    only price the fee lane has (DOGE regtest measured 2026-07-28: four rows in
//    price_snapshots, all four sentinels), so an unguarded clear turns a working
//    lane into an unpriced one;
//  - the topology mapping, because readParams() needs HUB_DB_HOST *and*
//    HUB_DB_NAME and the regtest envs set only the first, which is what made the
//    standalone invocation die with "Cannot read properties of null" twice.

const assert = require('assert')
const script = require('../../../scripts/clear-seed-sentinels')

describe('clear-seed-sentinels script guards', () => {

    describe('publishing-venue gate', () => {
        it('refuses without the venue declaration', () => {
            assert.throws(() => script.assertPublishingVenue({}), /XCHAIN_E2E_NO_PRICE_SEED=1/)
        })

        it('refuses on a merely truthy value, not just an unset one', () => {
            // '0'/'true'/'yes' must not authorise a delete: the rest of the tree
            // tests this flag with === '1', and a looser reading here would let a
            // non-publishing venue through the one gate that protects it.
            for (const value of ['0', 'true', 'yes', ' 1'])
                assert.throws(() => script.assertPublishingVenue({ XCHAIN_E2E_NO_PRICE_SEED: value }),
                    /refusing to clear/, 'value ' + JSON.stringify(value) + ' must not authorise')
        })

        it('allows exactly the declared publishing venue', () => {
            assert.doesNotThrow(() => script.assertPublishingVenue({ XCHAIN_E2E_NO_PRICE_SEED: '1' }))
        })
    })

    describe('topology mapping', () => {
        it('fills HUB_DB_* from the indexer coordinates the venue env carries', () => {
            const env = { INDEXER_DB_HOST: '127.0.0.1', INDEXER_DB_PORT: '13306',
                          INDEXER_DB_NAME: 'XChain_BTC_Regtest_Indexer',
                          INDEXER_DB_USER: 'idx', INDEXER_DB_PASS: 'pw' }
            const filled = script.applyTopology(env)

            assert.deepStrictEqual(filled,
                ['HUB_DB_HOST', 'HUB_DB_PORT', 'HUB_DB_NAME', 'HUB_DB_USER', 'HUB_DB_PASS'])
            assert.strictEqual(env.HUB_DB_NAME, 'XChain_BTC_Regtest_Indexer')
            assert.strictEqual(env.HUB_DB_PORT, '13306')
        })

        it('falls back to DATABASE_URL/PORT, which is what the venue envs actually set', () => {
            const env = { DATABASE_URL: '127.0.0.1', DATABASE_PORT: '13306',
                          INDEXER_DB_NAME: 'XChain_LTC_Regtest_Indexer', INDEXER_DB_USER: 'idx' }
            script.applyTopology(env)
            assert.strictEqual(env.HUB_DB_HOST, '127.0.0.1')
            assert.strictEqual(env.HUB_DB_PORT, '13306')
        })

        it('never overwrites a HUB_DB_* the operator pinned by hand', () => {
            // The live venue password can differ from the .env copy, so an operator
            // exporting the working credential must win over the file.
            const env = { HUB_DB_PASS: 'live', INDEXER_DB_PASS: 'stale',
                          INDEXER_DB_NAME: 'db', DATABASE_URL: 'h' }
            script.applyTopology(env, new Set(['HUB_DB_PASS']))
            assert.strictEqual(env.HUB_DB_PASS, 'live')
        })

        it('replaces a half-filled HUB_DB_* the env FILE left behind', () => {
            // Measured on the venue: the BTC .env names the hub's account but no
            // HUB_DB_NAME, and keeping that user while resolving the indexer's
            // database is "Access denied for user 'xchain_hub'". An incomplete
            // HUB_DB_* set is not a topology to preserve.
            const env = { HUB_DB_USER: 'xchain_hub', INDEXER_DB_USER: 'xchain_indexer_bitcoin_regtest',
                          INDEXER_DB_NAME: 'XChain_BTC_Regtest_Indexer', DATABASE_URL: '127.0.0.1' }
            script.applyTopology(env, new Set())
            assert.strictEqual(env.HUB_DB_USER, 'xchain_indexer_bitcoin_regtest')
        })

        it('is a no-op once the pair readParams needs is already present', () => {
            const env = { HUB_DB_HOST: 'h', HUB_DB_NAME: 'n', INDEXER_DB_NAME: 'other' }
            assert.deepStrictEqual(script.applyTopology(env), [])
            assert.strictEqual(env.HUB_DB_NAME, 'n')
        })

        it('leaves HUB_DB_NAME unset when the env names no database, rather than half-filling it', () => {
            // readParams() checks HOST *and* NAME; filling only the host would send
            // it down the localParams() path with a host that does not belong to it.
            const env = { DATABASE_URL: '127.0.0.1' }
            script.applyTopology(env)
            assert.strictEqual(env.HUB_DB_NAME, undefined)
        })
    })

    describe('argument parsing', () => {
        it('reads the env file and pair', () => {
            assert.deepStrictEqual(script.parseArgs(['--env', '.env.ltc', '--pair', 'XCHAIN/USD']),
                { envFile: '.env.ltc', pair: 'XCHAIN/USD' })
        })

        it('defaults to the whole sentinel set, unscoped', () => {
            assert.deepStrictEqual(script.parseArgs([]), { envFile: null, pair: null })
        })

        it('rejects an unrecognised flag instead of silently ignoring it', () => {
            // A typo'd --pair would otherwise widen the delete from one pair to all.
            assert.throws(() => script.parseArgs(['--pairs', 'XCHAIN/USD']), /unrecognised argument/)
        })
    })

    it('prints no credential', () => {
        // The script logs the target and the round list; the only env names it may
        // emit are the KEYS it filled, never a value.
        const src = require('fs').readFileSync(require.resolve('../../../scripts/clear-seed-sentinels'), 'utf8')
        const logged = [...src.matchAll(/console\.(?:log|error)\(([^\n]*)\)/g)].map(m => m[1])
        for (const line of logged)
            assert.ok(!/PASS|password/i.test(line), 'log line may not reference a password: ' + line)
    })
})
