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


const assert = require('assert')

const cryptoHelper  = require('../../../cryptoHelper')
const stakeHelper   = require('../../../helpers/stakeHelper')
const gasHelper     = require('../../../helpers/gasHelper')
const stakeTeardown = require('../../../helpers/stakeTeardown')
const { loadHubModule } = require('../../../helpers/multiValidatorHubHelper')
const fixture       = require('../../../attestMirror/mirrorDrillFixture')

const RESEED_COUNT        = Number(process.env.RESEED_COUNT || 5)
const RESEED_STAKE_XCHAIN = String(process.env.RESEED_STAKE_XCHAIN || '50000.00000000')
const RESEED_GAS_XCHAIN   = String(process.env.RESEED_GAS_XCHAIN || '60000')
const RESEED_ALLOW_SEATED = String(process.env.RESEED_ALLOW_SEATED || '')

// The shortest prefix `RESEED_ALLOW_SEATED` will accept.
//
// SIXTEEN HEX CHARACTERS, which is 64 bits, and the bound is the whole safety of
// the hatch. Every log line and every refusal in this tree prints a pubkey
// truncated to 16 characters, so an operator copying an identifier out of one of
// them lands exactly on the bound rather than under it. Shorter than that and a
// typo stops naming ONE key and starts naming a class: an 8-character prefix has
// a real chance of matching some future seated stranger, and the guard would then
// wave through the dilution it exists to catch, silently and only once it
// mattered.
const ALLOW_PREFIX_MIN_HEX = 16

// How many derivable keys to pass over before picking.
//
// A SIGNING KEY RETIRES PERMANENTLY, and this is the whole reason this knob
// exists. `stake.js` admits a v1 STAKE only when `getActiveStakeByPubkey(pk,
// null)` finds NO valid stake row at any height, so a key that was ever staked
// is refused for the life of the chain even after a full UNSTAKE: the row it
// is judged against is still there. A seeding run that gets swept by the
// teardown therefore does not merely undo itself, it BURNS every key it used.
// That is not hypothetical either; it is how the first seeding attempt on this
// chain spent the three federation signing seeds and two idle generations.
//
// There is no read that exposes this. `getstakesourcebypubkey` answers about
// ACTIVE stake at a height, so a retired key looks identical to a fresh one,
// and the fixture's `queryVenueDb` needs a started venue that a seeder does not
// have. So the skip is explicit rather than detected, and the cost of guessing
// it wrong is one minute and a loud `invalid: SIGNING_PUBKEY (already in use)`
// in the indexer log, not a silent bad roster. The closing asserts still prove
// the outcome whatever this is set to.
const RESEED_SKIP = Number(process.env.RESEED_SKIP || 0)

// How many rounds of "mine a little, look again" to allow before giving up.
// A BOUNDED WAIT ON THE REAL CONDITION, not a fixed block count, and the
// distinction is what the first version got wrong. ATTESTATION_STAKE_VISIBLE_BLOCKS
// (6 activation + 6 burial + 2 margin) is measured from ONE stake's own block,
// but a seeding loop spreads its stakes across however many blocks the funding,
// minting and confirming take. Mining that constant once at the END covers the
// last stake only if nothing drifted, and when it does not, the set comes back
// short and the failure reads like a staking bug rather than a timing one.
const VISIBILITY_ROUNDS = 12

/**
 * The seated attestation set, TOLERATING AN EMPTY ONE.
 *
 * `mirrorDrillFixture.readSeatedAttestationSet` asserts the set is non-empty,
 * because for a drill an empty capability means every request is refused at
 * admission and there is nothing more to say. That makes it the wrong
 * instrument here: this tool runs precisely when the set IS empty, so calling
 * it to prove emptiness fails on the state it is checking for. Same height
 * maths and the same capability read, without the verdict.
 */
async function readSeatedOrEmpty () {
    const buffer = Number(loadHubModule('src/snapshot_reorg_buffer.js').CANONICAL_REORG_BUFFER)
    const tip = await indexerConnector.call('getblockhashes', {})
    assert.ok(tip && tip.block_index !== undefined && tip.block_index !== null,
        'reseedAttestationRoster: the indexer would not report a tip, so the set cannot be read')
    const buried = Number(tip.block_index) - buffer
    assert.ok(Number.isFinite(buried) && buried > 0,
        'reseedAttestationRoster: computed a nonsensical buried height (' + buried + ') from tip ' +
        tip.block_index + ' and reorg buffer ' + buffer + '. On a freshly reset chain that just ' +
        'means the miner has not yet put ' + buffer + ' blocks on it; wait and re-run.')

    const set = await stakeTeardown.readCapabilitySet({
        indexer: indexerConnector, capability: 'attestation', blockIndex: buried,
    })
    // NO VERDICT rather than an empty one, for the reason the fixture gives:
    // an unreadable set says nothing about the roster, and treating it as
    // clean is how a tool talks itself into seeding a roster it never saw.
    assert.ok(set && !set.error,
        'reseedAttestationRoster: could not read the attestation capability at buried block ' +
        buried + (set && set.error ? ' (' + set.error + ')' : '') +
        '. This is an INSTRUMENT failure and NOT evidence that the set is empty.')
    return { set: set, tipBlock: Number(tip.block_index), buriedBlock: buried }
}

/**
 * Split a seated set into what this tool may seed beside and what it must refuse.
 *
 * PURE, AND EXPORTED, so the rule can be driven without a chain. The thing that
 * makes this worth separating is that its failure is invisible: a guard that
 * accidentally admits an unaccounted seated key does not fail here, it fails
 * forty minutes into an acceptance drill as a round that never finalized.
 *
 * THREE OUTCOMES, and only the middle one is new:
 *
 *   - DERIVABLE: `_knownSignerSeeds()` holds its seed, so the harness can run a
 *     hub for it and it was never a problem.
 *   - ALLOWED: the operator NAMED it through RESEED_ALLOW_SEATED. Nothing here
 *     can sign for it; the run is declaring that it knows and accepts that.
 *   - BLOCKING: neither. Refused, exactly as a non-empty set was refused before
 *     the hatch existed.
 *
 * A MALFORMED PREFIX THROWS RATHER THAN MATCHING NOTHING. The quiet failure is
 * the dangerous direction in only one of the two: a prefix that is too SHORT
 * matches too much, so it is refused; a prefix that is simply wrong matches
 * nothing and lands in `blocking`, which already refuses loudly.
 *
 * @param {string[]} seatedPubkeys  the seated attestation pubkeys, hex
 * @param {Map}      known          a `_knownSignerSeeds()` result
 * @param {string}   allowRaw       the raw RESEED_ALLOW_SEATED value
 * @returns {{prefixes: string[], derivable: string[], allowed: string[], blocking: string[]}}
 */
function classifySeatedForReseed (seatedPubkeys, known, allowRaw) {
    const prefixes = String(allowRaw || '').split(',')
        .map((s) => s.trim().toLowerCase())
        .filter((s) => s !== '')
    for (const p of prefixes) {
        assert.ok(new RegExp('^[0-9a-f]{' + ALLOW_PREFIX_MIN_HEX + ',64}$').test(p),
            'reseedAttestationRoster: RESEED_ALLOW_SEATED entry "' + p + '" is not a usable pubkey ' +
            'prefix. Each entry must be ' + ALLOW_PREFIX_MIN_HEX + ' to 64 hexadecimal characters. ' +
            'A shorter one stops naming one key and starts naming a class, which would wave through ' +
            'the next seated stranger instead of refusing on it.')
    }

    const derivable = []
    const allowed   = []
    const blocking  = []
    for (const raw of seatedPubkeys || []) {
        const pk = String(raw).toLowerCase()
        if (known && known.get(pk)) { derivable.push(pk); continue }
        if (prefixes.some((p) => pk.startsWith(p))) { allowed.push(pk); continue }
        blocking.push(pk)
    }
    return { prefixes: prefixes, derivable: derivable, allowed: allowed, blocking: blocking }
}

// Exported for the unit tier. The suite below stakes on a live venue, so a unit
// test must reach this function WITHOUT registering that suite; see
// test/unit/tools/reseedAttestationRoster.test.js for how it does that.
module.exports = {
    assert, cryptoHelper, stakeHelper, gasHelper, stakeTeardown, loadHubModule, fixture,
    RESEED_COUNT, RESEED_STAKE_XCHAIN, RESEED_GAS_XCHAIN, RESEED_ALLOW_SEATED,
    ALLOW_PREFIX_MIN_HEX, RESEED_SKIP, VISIBILITY_ROUNDS, readSeatedOrEmpty,
    classifySeatedForReseed,
}
