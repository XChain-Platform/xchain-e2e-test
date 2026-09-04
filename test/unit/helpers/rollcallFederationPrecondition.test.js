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
//
// assertOraclePublishFederation is the precondition that decides
// whether a venue can give the ROLLCALL acceptance suites (AT1-AT10) a verdict
// at all. It runs before a twenty-minute drive, so what it says when it refuses
// is as load-bearing as whether it refuses: the session that hit the
// outside-the-roster case without this check spent four runs reading
// `elected leader ... got index -1` and blaming the protocol.
//
// Unit-level on purpose. Every fact here is arithmetic over one JSON-RPC
// response, so it does not need a chain, and the acceptance suites themselves
// cannot cover it: they skip on exactly the venues where it matters.

const assert = require('assert')
const rc     = require('../../helpers/rollcallHelper')

// A stand-in for the indexer connector: one canned getstakeweightsbycapability.
function connectorReturning(validators, extra){
    return {
        call: async () => Object.assign({
            capability: 'oracle_publish',
            block_index: 1000,
            count: validators.length,
            source_count: new Set(validators.map(v => v.source)).size,
            truncated: false,
            validators,
        }, extra || {}),
    }
}

// The roster, staked one key per source, at the seeding tool's own 40/40/10/10.
function rosterValidators(weights){
    const w = weights || [40000, 40000, 10000, 10000]
    return rc.federationRoster().map((r, i) => ({
        pubkey: r.pubkey,
        source: 'mRosterSource' + i,
        weight: String(w[i]) + '.00000000',
    }))
}

const OUTSIDER = { pubkey: 'f'.repeat(64), source: 'mOutsiderSource0', weight: '15000.00000000' }

describe('rollcallHelper: the oracle_publish federation precondition', function () {

    it('accepts a venue whose oracle_publish set is exactly the roster', async function () {
        const fed = await rc.assertOraclePublishFederation(connectorReturning(rosterValidators()), 1000, 4)
        assert.strictEqual(fed.sourceCount, 4)
        assert.strictEqual(fed.weights.length, 4)
        // The idle fourth is the one AT1 watches the protocol evict, so the
        // precondition has to hand its source back or nothing downstream can
        // name it.
        assert.strictEqual(fed.idleSource, 'mRosterSource3')
    })

    // AN OUTSIDER COSTS TWO DIFFERENT THINGS, and the precondition has to price
    // them separately. Quorum is arithmetic and fatal to every suite; election
    // is fatal only to the suites that assert WHICH hub was elected. Conflating
    // them refused venues that could have answered AT1/AT2, on a shared regtest
    // chain where the outsiders are orphan fixture stakes nobody holds the keys
    // to.
    it('lets a suite that does not assert leader identity run past a light outsider', async function () {
        // Roster 40/40/10/10 against one outsider at 15000: signing weight
        // 90000 of a total 115000, so 3 * 90000 > 2 * 115000 for an ordinary
        // epoch and 3 * 80000 > 2 * 115000 for AT2's outage. Both roll.
        const conn = connectorReturning(rosterValidators().concat([OUTSIDER]))
        const fed = await rc.assertOraclePublishFederation(conn, 1000, 4, false)
        assert.ok(fed.outsiders, 'the outsider must be reported back, not swallowed')
        assert.deepStrictEqual(fed.outsiders.sources, ['mOutsiderSource0'])
        assert.strictEqual(fed.outsiders.weight, 15000)
        assert.strictEqual(fed.outsiders.rollsAllPresent, true)
        assert.strictEqual(fed.outsiders.rollsUnderOutage, true)
    })

    it('REFUSES the same venue for a suite that asserts which hub was elected', async function () {
        const conn = connectorReturning(rosterValidators().concat([OUTSIDER]))
        await assert.rejects(
            () => rc.assertOraclePublishFederation(conn, 1000, 4, true),
            (e) => /FAILED on ELECTION/.test(e.message) && /leader index -1/.test(e.message))
    })

    it('names the outsider, its weight, and the election win-rate over the whole key set', async function () {
        const conn = connectorReturning(rosterValidators().concat([
            OUTSIDER,
            Object.assign({}, OUTSIDER, { pubkey: 'e'.repeat(64), source: 'mOutsiderSource1', weight: '1000.00000000' }),
        ]))
        let msg = null
        try { await rc.assertOraclePublishFederation(conn, 1000, 4, true) } catch (e) { msg = e.message }
        assert.ok(msg, 'the precondition must throw for a leader-identity suite')
        // The operator has to be able to go and look at the thing named.
        assert.ok(msg.includes('mOutsiderSource0'), 'names the outsider source: ' + msg)
        assert.ok(msg.includes('15000'), 'names the outsider weight: ' + msg)
        assert.ok(/2 source\(s\) OUTSIDE/.test(msg), 'counts the outsiders: ' + msg)
        assert.ok(/4 times in 6/.test(msg), 'states the election win-rate over the full key set: ' + msg)
        assert.ok(/oracle_publish set was empty/.test(msg), 'names the clean-venue remedy: ' + msg)
    })

    // The quorum arithmetic is the half an operator might reasonably hope to
    // escape by staking the roster heavier, so the message must report which
    // side of the bar THIS venue is on rather than asserting a general rule.
    // Both legs are checked, because the outage leg fails FIRST as outsider
    // weight grows and it is the one AT2 needs.
    it('refuses on quorum when the outage leg cannot roll, even without leader assertions', async function () {
        // Roster 40/40/10/10 against 30000 of outsiders: an ordinary epoch still
        // rolls (270000 > 260000) but AT2's outage does not (240000 < 260000),
        // so AT2 would pass vacuously and prove nothing.
        const conn = connectorReturning(rosterValidators().concat([
            OUTSIDER,
            Object.assign({}, OUTSIDER, { pubkey: 'e'.repeat(64), source: 'mOutsiderSource1' }),
        ]))
        let msg = null
        try { await rc.assertOraclePublishFederation(conn, 1000, 4, false) } catch (e) { msg = e.message }
        assert.ok(msg, 'an outage leg that cannot roll must refuse the run')
        assert.ok(/FAILED on QUORUM/.test(msg), msg)
        assert.ok(/all three hubs present: 3 \* 90000 vs 2 \* 130000 -> ROLLS/.test(msg),
            'reports the all-present leg as rolling: ' + msg)
        assert.ok(/AT2 passes vacuously/.test(msg), 'names what the outage leg would prove: ' + msg)
    })

    it('refuses on quorum when no epoch can roll at all', async function () {
        const heavy = Object.assign({}, OUTSIDER, { weight: '70000.00000000' })
        let msg = null
        try { await rc.assertOraclePublishFederation(connectorReturning(rosterValidators().concat([heavy])), 1000, 4, false) }
        catch (e) { msg = e.message }
        assert.ok(msg, 'a heavy outsider must be reported as fatal')
        assert.ok(/FAILED on QUORUM/.test(msg), msg)
        assert.ok(/UNROLLED, counts for nobody/.test(msg), msg)
        // The remedy that works on the venue as it stands comes first, because
        // the other two need keys nobody has or a chain nobody has built.
        assert.ok(/Re-seed the roster heavier/.test(msg), msg)
    })

    // The seeding tool's own distribution has to survive the venue it is aimed
    // at, so the numbers it ships are asserted against the outsider weight
    // measured there rather than left to a comment.
    it('accepts the seeding tool\'s shipped weights against the measured outsider weight', async function () {
        const outsiders = [0, 1, 2].map(i => Object.assign({}, OUTSIDER, {
            pubkey: String(i).repeat(64).slice(0, 64), source: 'mOutsiderSource' + i, weight: '15000.00000000',
        })).concat([Object.assign({}, OUTSIDER, {
            pubkey: 'a'.repeat(64), source: 'mOutsiderSource3', weight: '25000.00000000',
        })])
        const conn = connectorReturning(
            rosterValidators([300000, 300000, 25000, 25000]).concat(outsiders))
        const fed = await rc.assertOraclePublishFederation(conn, 1000, 4, false)
        assert.strictEqual(fed.outsiders.weight, 70000)
        assert.strictEqual(fed.outsiders.rollsAllPresent, true)
        assert.strictEqual(fed.outsiders.rollsUnderOutage, true)
    })

    // The pre-existing preconditions still have to fire; the outsider check runs
    // last so a venue that is merely unseeded gets the seeding message, not a
    // confusing complaint about outsiders.
    it('still asks for a seed when the roster is absent entirely', async function () {
        const conn = connectorReturning([OUTSIDER])
        await assert.rejects(
            () => rc.assertOraclePublishFederation(conn, 1000, 4),
            (e) => /seed the federation first/.test(e.message))
    })

    it('still catches a roster staked from one shared source', async function () {
        const shared = rosterValidators().map(v => Object.assign({}, v, { source: 'mOneSourceForAll' }))
        const conn = connectorReturning(shared, { source_count: 1 })
        await assert.rejects(
            () => rc.assertOraclePublishFederation(conn, 1000, 1),
            (e) => /DISTINCT source/.test(e.message))
    })

    it('still refuses a TRUNCATED read, which the close treats as unknown', async function () {
        const conn = connectorReturning(rosterValidators(), { truncated: true })
        await assert.rejects(
            () => rc.assertOraclePublishFederation(conn, 1000, 4),
            (e) => /TRUNCATED/.test(e.message))
    })

    // A GENERATION BUMP MOVES THE IDLE ENTRY AND NOTHING ELSE, and that is a
    // constraint of the chain rather than a preference. STAKE v1 admission asks
    // getActiveStakeByPubkey(pubkey, null), whose null blockIndex drops the
    // activation/deactivation clause, so the rule reads "any valid stake row for
    // this pubkey, EVER" and carries no source term. Once a frozen signing key
    // has been staked from address i on a chain it can never be staked again
    // from anywhere, so moving the signing sources with the generation - the fix
    // proposed on 2026-09-01 after AT2's outage evicted hub 2 - would produce a
    // roster the chain refuses to seed. Pinned here so it is not proposed again.
    describe('generation rotation', function () {
        const saved = process.env.XC_ROLLCALL_IDLE_GENERATION
        afterEach(function () {
            if (saved === undefined) delete process.env.XC_ROLLCALL_IDLE_GENERATION
            else process.env.XC_ROLLCALL_IDLE_GENERATION = saved
        })

        it('moves the idle source one index per generation', function () {
            delete process.env.XC_ROLLCALL_IDLE_GENERATION
            assert.deepStrictEqual(rc.federationRoster().map(r => r.addressIndex), [0, 1, 2, 3])

            process.env.XC_ROLLCALL_IDLE_GENERATION = '1'
            assert.deepStrictEqual(rc.federationRoster().map(r => r.addressIndex), [0, 1, 2, 4])

            process.env.XC_ROLLCALL_IDLE_GENERATION = '2'
            assert.deepStrictEqual(rc.federationRoster().map(r => r.addressIndex), [0, 1, 2, 5])
        })

        it('never reuses an idle address index across generations', function () {
            const seen = new Set()
            for (const g of ['0', '1', '2', '3', '4']){
                process.env.XC_ROLLCALL_IDLE_GENERATION = g
                const idle = rc.federationRoster()[rc.IDLE_SEED_INDEX]
                assert.ok(!seen.has(idle.addressIndex),
                    'generation ' + g + ' reuses idle address index ' + idle.addressIndex + ', so the ' +
                    're-entrant inherits the previous generation\'s absence streak')
                seen.add(idle.addressIndex)
            }
        })

        it('holds the three SIGNING sources still, because the chain will not restake their keys', function () {
            process.env.XC_ROLLCALL_IDLE_GENERATION = '0'
            const a = rc.federationRoster()
            process.env.XC_ROLLCALL_IDLE_GENERATION = '5'
            const b = rc.federationRoster()
            for (let i = 0; i < rc.SIGNING_SEEDS.length; i++){
                assert.strictEqual(a[i].seed, b[i].seed,
                    'signing seed ' + i + ' moved; it is one of the frozen vector\'s and may never be rotated')
                assert.strictEqual(a[i].addressIndex, b[i].addressIndex,
                    'signing source ' + i + ' moved with the generation. STAKE v1 refuses a pubkey that has ' +
                    'ever been staked, from any source, so the seeding tool could never place that stake.')
            }
            // The idle entry is the one that must move, or a re-seed re-enters
            // at an address carrying its own eviction.
            assert.notStrictEqual(a[rc.IDLE_SEED_INDEX].addressIndex, b[rc.IDLE_SEED_INDEX].addressIndex)
        })

        // The idle KEY moves with the generation as well as its address, but
        // only on a venue configured with a mnemonic: without one the helper
        // falls back to the fixed legacy seed and warns that the venue gets one
        // AT1 run ever. Both branches are worth pinning, because the fallback is
        // the one that silently makes a second run unseedable.
        it('mints a fresh idle KEY per generation when a mnemonic is configured', function () {
            const savedMnemonic = process.env.XC_ROLLCALL_FEDERATION_MNEMONIC
            process.env.XC_ROLLCALL_FEDERATION_MNEMONIC = 'unit test mnemonic, never used to sign anything'
            try {
                process.env.XC_ROLLCALL_IDLE_GENERATION = '0'
                const g0 = rc.federationRoster()[rc.IDLE_SEED_INDEX].seed
                process.env.XC_ROLLCALL_IDLE_GENERATION = '1'
                const g1 = rc.federationRoster()[rc.IDLE_SEED_INDEX].seed
                assert.notStrictEqual(g0, g1, 'the idle key must differ per generation, or the re-seed is ' +
                    'refused with invalid: SIGNING_PUBKEY (already in use)')
                assert.ok(/^[0-9a-f]{64}$/.test(g0) && /^[0-9a-f]{64}$/.test(g1))
            } finally {
                if (savedMnemonic === undefined) delete process.env.XC_ROLLCALL_FEDERATION_MNEMONIC
                else process.env.XC_ROLLCALL_FEDERATION_MNEMONIC = savedMnemonic
            }
        })
    })
})
