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

    it('REFUSES a venue carrying a source outside the roster', async function () {
        const conn = connectorReturning(rosterValidators().concat([OUTSIDER]))
        await assert.rejects(
            () => rc.assertOraclePublishFederation(conn, 1000, 4),
            (e) => /OUTSIDE the acceptance roster/.test(e.message))
    })

    it('names the outsider, its weight, and both things it breaks', async function () {
        const conn = connectorReturning(rosterValidators().concat([OUTSIDER]))
        let msg = null
        try { await rc.assertOraclePublishFederation(conn, 1000, 4) } catch (e) { msg = e.message }
        assert.ok(msg, 'the precondition must throw on an outsider')
        // The operator has to be able to go and look at the thing named.
        assert.ok(msg.includes('mOutsiderSource0'), 'names the outsider source: ' + msg)
        assert.ok(msg.includes('15000'), 'names the outsider weight: ' + msg)
        // Both failure paths, because fixing one alone does not give a verdict.
        assert.ok(/ELECTION/.test(msg), 'names the election half: ' + msg)
        assert.ok(/QUORUM/.test(msg), 'names the quorum half: ' + msg)
        // And the remedy that actually works, ahead of the one that does not.
        assert.ok(/oracle_publish set was empty/.test(msg), 'names the clean-venue remedy: ' + msg)
        assert.ok(/not a remedy for AT6a\/AT6b/.test(msg),
            'says plainly that re-seeding heavier does not fix the election: ' + msg)
    })

    // The quorum arithmetic is the half an operator might reasonably hope to
    // escape by staking the roster heavier, so the message must report which
    // side of the bar THIS venue is on rather than asserting a general rule.
    it('reports the quorum verdict from the venue it actually measured', async function () {
        // Roster 40/40/10/10 against an outsider at 15000: signing weight 90000,
        // total 115000, and 3 * 90000 > 2 * 115000, so an ordinary epoch rolls.
        let light = null
        try { await rc.assertOraclePublishFederation(connectorReturning(rosterValidators().concat([OUTSIDER])), 1000, 4) }
        catch (e) { light = e.message }
        assert.ok(/clears the bar/.test(light), 'a small outsider still lets an epoch roll: ' + light)
        assert.ok(/an ordinary epoch rolls/.test(light), light)

        // The same roster against an outsider heavy enough to hold the total
        // above two thirds: nothing the suites drive can ever roll.
        const heavy = Object.assign({}, OUTSIDER, { weight: '70000.00000000' })
        let msg = null
        try { await rc.assertOraclePublishFederation(connectorReturning(rosterValidators().concat([heavy])), 1000, 4) }
        catch (e) { msg = e.message }
        assert.ok(/does NOT clear the bar/.test(msg), 'a heavy outsider must be reported as fatal: ' + msg)
        assert.ok(/closes UNROLLED and counts for nobody/.test(msg), msg)
    })

    it('counts the roster win-rate over the whole key set, so re-running reads as futile', async function () {
        const conn = connectorReturning(rosterValidators().concat([
            OUTSIDER,
            Object.assign({}, OUTSIDER, { pubkey: 'e'.repeat(64), source: 'mOutsiderSource1' }),
        ]))
        let msg = null
        try { await rc.assertOraclePublishFederation(conn, 1000, 4) } catch (e) { msg = e.message }
        assert.ok(/2 source\(s\) OUTSIDE/.test(msg), 'counts the outsiders: ' + msg)
        assert.ok(/4 times in 6/.test(msg), 'states the election win-rate over the full key set: ' + msg)
        assert.ok(/Re-running does not fix it/.test(msg), msg)
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
})
