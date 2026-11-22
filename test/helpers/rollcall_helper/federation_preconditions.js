/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 ********************************************************************/

'use strict'

const assert = require('assert')
const {
    ROLLCALL_REGTEST_ARMING_ENV,
    closeHeightOf,
    rca,
} = require('./sibling_resolution')
const {
    IDLE_SEED_INDEX,
    federationRoster,
} = require('./federation')

// ── named preconditions ──────────────────────────────────────────────────────
//
// Each returns the fact it measured so a suite can log it, and throws a sentence
// naming the gap when it cannot. None of them skip: by the time a suite calls
// these it has already decided it is meant to run (see requireRollcallVenue).

// The opt-in gate. Unlike everything below it, this one SKIPS, because the
// ROLLCALL suites live under test/actions/** and would otherwise join every
// default `npm test` run against a venue that was never provisioned for them.
// The skip carries its reason so it can never read as a pass.
function requireRollcallVenue(ctx){
    const on = process.env.E2E_REQUIRE_FEDERATION
    if (on === '1' || on === 'true') return true
    console.log('[skip] ROLLCALL acceptance drives BOTH regtest stacks (BTC epochs + DOGE publishes) ' +
                'against a seeded four-source federation. Set E2E_REQUIRE_FEDERATION=1 to run it.')
    ctx.skip()
    return false
}

// The close, the capability predicate and the stake rows are BTC-only
// (rollcall_close.js returns 0 immediately on any other coin), so a run
// bootstrapped on another chain would drive an inert rail and pass by doing
// nothing.
function assertBtcRail(){
    assert.strictEqual(typeof COIN_CODE !== 'undefined' ? COIN_CODE : null, 'BTC',
        'ROLLCALL acceptance must be bootstrapped on the BITCOIN stack (COIN=bitcoin): the epoch close, ' +
        'the capability predicate and the stake rows are BTC-only, and rollcall_close.js returns 0 on any ' +
        'other coin, so this run would drive nothing. Got COIN_CODE=' +
        (typeof COIN_CODE !== 'undefined' ? COIN_CODE : '(unset)') + '.')
}

// The consensus constants this whole harness's arithmetic assumes. Read from the
// sibling, asserted against the values the acceptance list was written for, so a
// stale sibling checkout says so here instead of producing a run whose epoch
// heights are quietly wrong.
function assertRegtestConstants(network){
    const r = rca()

    // Checked BEFORE the numeric sweep below, because Number(null) is 0: an INERT
    // regtest would otherwise sail through the ROLLCALL_ACTIVATION row and every
    // verdict in this file would be read from a rail that never ran.
    assert.notStrictEqual(r.ROLLCALL_ACTIVATION[network], null,
        'ROLLCALL is INERT on ' + network + ': ROLLCALL_ACTIVATION.' + network + ' is null, so no epoch ' +
        'exists and nothing below would close. This harness sets ' + ROLLCALL_REGTEST_ARMING_ENV + '=armed ' +
        'for itself, so seeing null here means the variable was explicitly set to an off value in this shell.')

    // ROLLCALL_ACTIVATION is deliberately NOT pinned to a number here. It is the
    // one value a regtest venue owns, so a venue whose epochs start
    // above an indexed prefix is armed at some other height on purpose, and
    // pinning 0 would report that as "constant drift" and send the reader to the
    // wrong place. The check above is the one that matters: armed, or not. The
    // CADENCE constants are what this harness's epoch arithmetic assumes, and
    // those still must not drift.
    const want = {
        ROLLCALL_INTERVAL_BLOCKS:      30,
        ROLLCALL_ACCEPT_WINDOW_BLOCKS: 12,
        ROLLCALL_PROOF_DELAY_BLOCKS:   2,
        ROLLCALL_DOGE_MATURITY:        2,
    }
    for (const k of Object.keys(want)){
        assert.strictEqual(Number(r[k][network]), want[k],
            'ROLLCALL constant drift: ' + k + '.' + network + ' is ' + JSON.stringify(r[k][network]) +
            ', the acceptance harness was written against ' + want[k] + '. Update the harness deliberately ' +
            'or refresh the xchain-indexer sibling checkout; do not let the two disagree silently.')
    }
    assert.strictEqual(Number(r.ROLLCALL_EVICT_MISSES), 2,
        'ROLLCALL_EVICT_MISSES is ' + r.ROLLCALL_EVICT_MISSES + '; every K-streak assertion here assumes K=2')
    assert.strictEqual(Number(r.ROLLCALL_STREAK_LOOKBACK), 4,
        'ROLLCALL_STREAK_LOOKBACK is ' + r.ROLLCALL_STREAK_LOOKBACK + '; the harness assumes 2K=4')
    assert.strictEqual(String(r.ROLLCALL_REWARD_AMOUNT), '10.00000000',
        'ROLLCALL_REWARD_AMOUNT is ' + r.ROLLCALL_REWARD_AMOUNT + '; AT10 asserts the frozen 10.00000000')

    const e = r.ROLLCALL_INTERVAL_BLOCKS[network]
    assert.strictEqual(closeHeightOf(e, network), e + 14,
        'an epoch must close at E + 14 on ' + network + ' (window 12 + proof delay 2)')
    return want
}

// getcapabilityvalidators and getrollcallsigners are FEDERATION_READ_METHODS on
// the indexer: with INDEXER_API_KEY set and no matching x-api-key they answer
// 401, and with no key set they answer 401 unless the venue runs with
// INDEXER_ALLOW_UNAUTHENTICATED=true. Probing once up front turns that into a
// sentence rather than an unexplained failure at the first assertion.
async function assertGatedReadsReachable(conn, blockIndex, label){
    let res
    try {
        res = await conn.call('getcapabilityvalidators', { capability: 'oracle_publish', block_index: Number(blockIndex) })
    } catch (e) {
        throw new Error(
            'ROLLCALL precondition: the ' + label + ' indexer refused the federation-gated read ' +
            'getcapabilityvalidators (' + (e && e.message) + '). Set INDEXER_API_KEY in the e2e environment to the ' +
            'indexer\'s own key, or run the venue with INDEXER_ALLOW_UNAUTHENTICATED=true.')
    }
    assert.ok(res && !res.error,
        'ROLLCALL precondition: ' + label + ' getcapabilityvalidators returned an in-band error: ' +
        JSON.stringify(res && res.error))
    return res
}

// AT1 needs three signing sources plus one idle fourth. Counted by SOURCE, not
// by key: absence, the K-streak and eviction are all pinned per staking SOURCE
// (rollcall_close.js step 6), and one source may hold several keys, so a
// four-key one-source federation is a one-member federation as far as the
// eviction rule is concerned. getstakeweightsbycapability is the read that
// reports both, and it is the same source-keyed shape the close resolves R(E)
// with (getStakeWeightsByCapability).
// `requireExactRoster` is for the suites that assert WHICH hub the election
// picked; see the outsider block below for why every other suite takes a
// warning instead.
async function assertOraclePublishFederation(conn, blockIndex, needSources, requireExactRoster){
    const res = await conn.call('getstakeweightsbycapability', {
        capability: 'oracle_publish', block_index: Number(blockIndex),
    })
    assert.ok(res && !res.error,
        'ROLLCALL precondition: getstakeweightsbycapability failed: ' + JSON.stringify(res && res.error))
    assert.strictEqual(res.truncated, false,
        'ROLLCALL precondition: the oracle_publish read at block ' + blockIndex + ' came back TRUNCATED. ' +
        'The close treats a truncated set as UNKNOWN and writes the epoch UNROLLED, so no acceptance test ' +
        'below can reach a verdict.')

    const sources = new Set((res.validators || []).map(v => String(v.source)))
    const roster  = federationRoster()
    if (sources.size < needSources){
        throw new Error(
            'ROLLCALL precondition FAILED: needs ' + needSources + ' staked oracle_publish SOURCES at block ' +
            blockIndex + ', found ' + sources.size + ' (' + res.count + ' key(s)); seed the federation first.\n' +
            'Stake these exact signing pubkeys, each from its OWN source address, above the oracle_publish ' +
            'MIN_STAKE:\n' +
            roster.map(r => '    [' + r.index + '] ' + r.pubkey + '   ' + r.role).join('\n') + '\n' +
            'Sources currently present: ' + (sources.size ? Array.from(sources).join(', ') : '(none)'))
    }

    // The roster must be the staked set, not merely the same size: the harness
    // signs with these seeds, and a federation of four unrelated keys would
    // produce a run where every hub's signature is discarded as an outsider and
    // all four sources look absent.
    const byPubkey = new Map((res.validators || []).map(v => [String(v.pubkey).toLowerCase(), String(v.source)]))
    const missing  = roster.filter(r => !byPubkey.has(r.pubkey))
    assert.strictEqual(missing.length, 0,
        'ROLLCALL precondition FAILED: the venue has ' + sources.size + ' oracle_publish source(s), but ' +
        missing.length + ' of the harness roster key(s) are not among them:\n' +
        missing.map(r => '    [' + r.index + '] ' + r.pubkey + '   ' + r.role).join('\n') + '\n' +
        'This harness signs with fixed seeds so the operator can stake them ahead of the run; a signature ' +
        'from a key outside R(E) is discarded and reads as an absence.')

    const idle = roster[IDLE_SEED_INDEX]
    const bySource = new Map()
    for (const v of (res.validators || [])) bySource.set(String(v.source), String(v.pubkey).toLowerCase())
    const idleSource = byPubkey.get(idle.pubkey)
    assert.ok(idleSource,
        'ROLLCALL precondition: the idle fourth staker ' + idle.pubkey.slice(0, 16) + '... resolves to no source')

    // Distinct sources per roster key, or an eviction of the idle source would
    // take a signing hub's stake down with it and AT1 would measure the wrong
    // thing.
    const rosterSources = roster.map(r => byPubkey.get(r.pubkey))
    assert.strictEqual(new Set(rosterSources).size, roster.length,
        'ROLLCALL precondition FAILED: the four roster keys must each be staked from a DISTINCT source ' +
        'address (absence and eviction are pinned per SOURCE). Got sources: ' + JSON.stringify(rosterSources))

    // THE FEDERATION MUST BE EXACTLY THE ROSTER, not merely contain it.
    //
    // This check exists because its absence cost a whole session. A venue with
    // one extra staked oracle_publish member produced `epoch 330: the elected
    // leader must be one of the two hubs that are up, got index -1`, four runs
    // running, and no hint anywhere that the venue rather than the protocol was
    // the problem. Two independent things break, and neither says so:
    //
    //   ELECTION. RollcallRound.electionOrder is hashOrder over the WHOLE
    //   oracle_publish key set, so any staked key the harness does not run can
    //   win rank 0. It then never publishes (nobody is holding it), and AT6a/AT6b
    //   read the -1 above. With n outsiders among the eight keys the roster wins
    //   only 4/(4+n) of the time, so re-running is not a remedy, it is a coin
    //   flip that the failure text invites the reader to keep taking.
    //
    //   QUORUM. An outsider never signs, but its weight still counts in the
    //   TOTAL that stake_weighted_quorum.js measures presence against, so every
    //   epoch closes UNROLLED unless the roster's own weight clears two thirds of
    //   roster + outsider weight. The outage legs need more than that again.
    //
    // Hard-failing here rather than warning: a venue that cannot roll an epoch
    // has no verdict to give, and the quiet forms of this are a twenty-minute
    // drive that ends in a sentence about the wrong subsystem.
    const rosterSourceSet = new Set(rosterSources.map(String))
    const foreign = (res.validators || [])
        .filter(v => !rosterSourceSet.has(String(v.source)))
    let outsiders = null
    if (foreign.length > 0){
        const foreignBySource = new Map()
        for (const v of foreign)
            if (!foreignBySource.has(String(v.source))) foreignBySource.set(String(v.source), Number(v.weight))
        const foreignWeight = Array.from(foreignBySource.values()).reduce((a, b) => a + b, 0)
        const weightOf = (s) => Number((res.validators || []).find(v => String(v.source) === String(s)).weight)
        const rosterWeight  = rosterSources.map(weightOf).reduce((a, b) => a + b, 0)
        // The SIGNING sources only: the idle fourth never signs, so it is
        // never part of a present side.
        const signingSources = rosterSources.filter((s, i) => i !== IDLE_SEED_INDEX)
        const signingWeight  = signingSources.map(weightOf).reduce((a, b) => a + b, 0)
        // AT2 silences the SMALLEST signing source, so the outage leg's present
        // side is the signing weight less that one.
        const smallestSigning = Math.min.apply(null, signingSources.map(weightOf))
        const total = rosterWeight + foreignWeight
        const rollsAllPresent = 3 * signingWeight > 2 * total
        const rollsUnderOutage = 3 * (signingWeight - smallestSigning) > 2 * total

        // THE TWO COSTS OF AN OUTSIDER ARE NOT THE SAME COST, and conflating
        // them into one hard failure made this precondition refuse venues that
        // could have answered the question being asked. Separated 2026-09-03
        // after measuring that the only regtest chain with a clean ROLLCALL
        // history also carried four fixture stakes whose source keys nobody
        // holds (the e2e fixture path derives each source from a mnemonic
        // generated per run, so an un-torn-down fixture stake is unremovable),
        // which left "rebuild the venue" as the sole remedy for tests that did
        // not need it.
        //
        //   QUORUM is a hard, arithmetic blocker for EVERY suite. An outsider
        //   never signs, but its weight counts in the TOTAL that presence is
        //   measured against, so past a certain outsider weight no epoch can
        //   roll and no suite has a verdict to give. It is also fixable without
        //   touching the venue: re-seed the roster heavier. So it is checked
        //   here with the real numbers and it still fails the run.
        //
        //   ELECTION only breaks the suites that assert WHO the leader is.
        //   RollcallRound.electionOrder is hashOrder over the whole
        //   oracle_publish key set, so an outsider can win rank 0 and then never
        //   publish (nobody holds it). That is fatal to AT6a/AT6b, which read
        //   `leader index -1`, and it makes AT10's leader-reward leg
        //   undecidable. It is NOT fatal to AT1/AT2/AT3: the rank ladder unlocks
        //   the remaining ranks as BTC height climbs and each live hub publishes
        //   its own signature as a sweeper, which is how epoch 420 rolled on
        //   2026-09-01 with the elected leader silent. Those suites therefore
        //   run with a named warning instead of a refusal.
        //
        // Suites that do assert leader identity pass requireExactRoster and get
        // the old hard failure.
        const detail =
            'the venue\'s oracle_publish set contains ' + foreignBySource.size +
            ' source(s) OUTSIDE the acceptance roster:\n' +
            Array.from(foreignBySource.entries())
                .map(([s, w]) => '    ' + s + '   weight ' + w + '   (not run by this harness)').join('\n') + '\n' +
            'Outsider weight ' + foreignWeight + ' against roster weight ' + rosterWeight +
            ' (signing ' + signingWeight + ', smallest signing ' + smallestSigning + ').\n' +
            '  QUORUM, all three hubs present: 3 * ' + signingWeight + ' vs 2 * ' + total + ' -> ' +
            (rollsAllPresent ? 'ROLLS' : 'UNROLLED, counts for nobody') + '.\n' +
            '  QUORUM, AT2 outage of the smallest signing hub: 3 * ' + (signingWeight - smallestSigning) +
            ' vs 2 * ' + total + ' -> ' + (rollsUnderOutage ? 'ROLLS' : 'UNROLLED, so AT2 passes vacuously') + '.\n' +
            '  ELECTION: hashOrder runs over all ' + (res.validators || []).length + ' key(s), so the roster ' +
            'wins rank 0 only ' + roster.length + ' times in ' + (res.validators || []).length + '.'

        if (!rollsAllPresent || !rollsUnderOutage){
            assert.fail(
                'ROLLCALL precondition FAILED on QUORUM: ' + detail + '\n' +
                'Remedy, in preference order:\n' +
                '  a. Re-seed the roster heavier. The seeding tool\'s weights need 2 * (small signing weight) ' +
                'to exceed the idle weight plus twice the outsider weight for an ordinary epoch, and the ' +
                'large signing weight to exceed twice the small one plus the outsider weight for AT2. This ' +
                'fixes the quorum half on the venue as it stands.\n' +
                '  b. Unstake the outsider source(s) above. Needs the key each was staked from, which the ' +
                'harness does not hold when the stake came from a fixture run.\n' +
                '  c. Drive on a venue whose oracle_publish set was empty before rollcallSeedFederation ran. ' +
                'This is the only remedy that also fixes the election half.')
        }
        if (requireExactRoster){
            assert.fail(
                'ROLLCALL precondition FAILED on ELECTION: ' + detail + '\n' +
                'This suite asserts WHICH hub the election picked, so an outsider winning rank 0 reports ' +
                '`leader index -1` and re-running is a coin flip rather than a remedy. Drive it on a venue ' +
                'whose oracle_publish set was empty before rollcallSeedFederation ran.')
        }
        console.warn(
            '\n    [rollcall] VENUE CARRIES OUTSIDERS, and this run continues on purpose: ' + detail + '\n' +
            '    Quorum clears in both cases above, so epochs roll and the eviction/outage verdicts are real. ' +
            'What is NOT decidable here is leader identity: a leader on an outsider key never publishes, so ' +
            'coverage comes from the rank ladder unlocking each live hub as a sweeper. Suites asserting the ' +
            'elected leader (AT6a/AT6b, AT10\'s leader-reward leg) must run on a venue seeded from empty.\n')
        outsiders = {
            sources: Array.from(foreignBySource.keys()),
            weight:  foreignWeight,
            rollsAllPresent, rollsUnderOutage,
        }
    }

    return { sources, idleSource, byPubkey, weights: res.validators, sourceCount: res.source_count, outsiders }
}

// AT2's outage must leave its epoch ROLLED, or the epoch counts for nobody and
// no K-streak forms. Strict 2/3 by SOURCE weight (stake_weighted_quorum.js), so
// an equal-weight four-source federation can never satisfy this.
function assertOutageStillRolls(ctx, silentSources){
    let present = ctx.totalWeight
    for (const s of silentSources) present -= (ctx.weightBySource.get(s) || 0)
    assert.ok(3 * present > 2 * ctx.totalWeight,
        'ROLLCALL precondition FAILED: the stake DISTRIBUTION cannot show this case. With ' +
        JSON.stringify(silentSources) + ' silent, present weight is ' + present + ' of ' + ctx.totalWeight +
        ', which does not clear the strict 2/3 bar (3 * present > 2 * total) in stake_weighted_quorum.js. ' +
        'That epoch would close UNROLLED and count for nobody. Re-seed the federation so the publishing hubs ' +
        'alone exceed two thirds (for example 40/40/10/10 across the four sources).')
    return present
}

// The mirror of the above: a set of silent sources that must push the epoch
// BELOW the bar, which is what AT6's unrolled leg needs.
function assertOutageFallsBelowThreshold(ctx, silentSources){
    let present = ctx.totalWeight
    for (const s of silentSources) present -= (ctx.weightBySource.get(s) || 0)
    assert.ok(3 * present <= 2 * ctx.totalWeight,
        'ROLLCALL precondition FAILED: with ' + JSON.stringify(silentSources) + ' silent, present weight is ' +
        present + ' of ' + ctx.totalWeight + ', which still CLEARS the strict 2/3 bar, so the epoch would roll ' +
        'and the below-threshold leg would assert nothing. Re-seed the federation so this outage falls short.')
    return present
}

module.exports = {
    requireRollcallVenue,
    assertBtcRail,
    assertRegtestConstants,
    assertGatedReadsReachable,
    assertOraclePublishFederation,
    assertOutageStillRolls,
    assertOutageFallsBelowThreshold,
}
