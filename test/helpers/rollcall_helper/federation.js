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
const crypto = require('crypto')

// ── the acceptance federation ────────────────────────────────────────────────
//
// The three SIGNING seeds are fixed, the multiHubNodeProof convention: the
// operator must stake these exact pubkeys before the run, so they cannot be
// random per run. They are also the frozen vector's own signer seeds, so a
// harness that can sign for this federation is a harness that agrees with the
// vector - which is why they may never be made configurable.
const SIGNING_SEEDS = [
    '11'.repeat(32),   // hub 0
    '22'.repeat(32),   // hub 1
    '33'.repeat(32),   // hub 2
]
const IDLE_SEED_INDEX = 3

// The legacy idle seed, kept so an unconfigured venue keeps its previous
// behaviour and says so.
const LEGACY_IDLE_SEED = '44'.repeat(32)

// THE IDLE SEED IS PER-VENUE, AND THAT IS A CORRECTNESS REQUIREMENT RATHER THAN
// A CONVENIENCE.
//
// AT1's whole point is that the protocol EVICTS this source, and an eviction
// stamps deactivation_block through setStakeDeactivationBySourceAndPubkey
// (xchain-indexer rollcall_close.js) exactly as an UNSTAKE does. The STAKE v1
// admission rule then refuses that pubkey FOREVER: it asks
// getActiveStakeByPubkey(pubkey, null), and a null blockIndex drops the whole
// activation/deactivation clause, so the rule reads "any valid stake row for
// this pubkey, ever" - and it is keyed on the pubkey alone, so re-staking from a
// different source address does not rescue it either.
//
// So a FIXED idle seed makes AT1 a ONE-SHOT test: the first successful run burns
// the key, and every later run on that venue fails to seed with
// `invalid: SIGNING_PUBKEY (already in use)`. Measured on the the regtest host regtest
// venue 2026-08-30 (recorded in the platform ledger).
//
// Resolution order, most explicit first:
//   1. XC_ROLLCALL_IDLE_SEED         - an exact 32-byte hex seed.
//   2. the federation mnemonic + XC_ROLLCALL_IDLE_GENERATION - derived, so a
//      venue seeded from one mnemonic gets a stable idle key across the two
//      epochs of a run (it must be stable WITHIN a run: the same source has to
//      be absent twice for the K-streak to form), and rotating the generation
//      mints a fresh one without re-seeding the three signing sources.
//   3. the legacy 44... seed, with a warning, so an unconfigured venue still
//      runs but nobody is surprised when its second run cannot seed.
function idleSeed(){
    const explicit = process.env.XC_ROLLCALL_IDLE_SEED
    if (explicit){
        assert.ok(/^[0-9a-fA-F]{64}$/.test(String(explicit)),
            'XC_ROLLCALL_IDLE_SEED must be exactly 64 hex characters (a 32-byte Ed25519 seed); got ' +
            String(explicit).length + ' character(s). A typo here silently stakes a different key than the ' +
            'acceptance run signs for, which reads as a federation-wide absence.')
        return String(explicit).toLowerCase()
    }

    const mnemonic = process.env.XC_ROLLCALL_FEDERATION_MNEMONIC
    if (mnemonic){
        const generation = String(process.env.XC_ROLLCALL_IDLE_GENERATION || '0')
        // Domain-separated so this can never collide with any other key derived
        // from the same mnemonic (the four SOURCE addresses come from its BIP39
        // seed through a different path entirely).
        return crypto.createHash('sha256')
            .update('xchain-rollcall-idle|' + generation + '|' + mnemonic, 'utf8')
            .digest('hex')
    }

    console.warn(
        '    [rollcall] neither XC_ROLLCALL_IDLE_SEED nor XC_ROLLCALL_FEDERATION_MNEMONIC is set, so the idle ' +
        'staker falls back to the legacy fixed seed. AT1 EVICTS this key and an evicted key can never be staked ' +
        'again, so this venue gets exactly ONE AT1 run. Set the mnemonic (or bump ' +
        'XC_ROLLCALL_IDLE_GENERATION) before re-seeding.')
    return LEGACY_IDLE_SEED
}

// Kept as a getter rather than a constant: the idle entry depends on env, and a
// module-load-time array would freeze whatever was set when the first require
// happened.
function federationSeeds(){
    return SIGNING_SEEDS.concat([idleSeed()])
}

// The legacy AT4 re-entry seed, kept so an unconfigured venue behaves as before.
const LEGACY_REENTRY_SEED = '55'.repeat(32)

// AT4's RE-ENTRY key, and it has to rotate for the same reason the idle key does.
// AT4 stakes this pubkey to prove an evicted source can come back on a fresh
// key; STAKE v1 admission then refuses that pubkey forever, so a FIXED seed made
// AT4 one-shot per chain in exactly the way a fixed idle seed made AT1 one-shot.
// Domain-separated from the idle derivation so the two can never collide, and
// bumped by the same XC_ROLLCALL_IDLE_GENERATION, so one env change re-arms the
// whole suite.
function reentrySeed(){
    const explicit = process.env.XC_ROLLCALL_REENTRY_SEED
    if (explicit){
        assert.ok(/^[0-9a-fA-F]{64}$/.test(String(explicit)),
            'XC_ROLLCALL_REENTRY_SEED must be exactly 64 hex characters (a 32-byte Ed25519 seed); got ' +
            String(explicit).length + ' character(s).')
        return String(explicit).toLowerCase()
    }
    const mnemonic = process.env.XC_ROLLCALL_FEDERATION_MNEMONIC
    if (mnemonic){
        const generation = String(process.env.XC_ROLLCALL_IDLE_GENERATION || '0')
        return crypto.createHash('sha256')
            .update('xchain-rollcall-reentry|' + generation + '|' + mnemonic, 'utf8')
            .digest('hex')
    }
    console.warn(
        '    [rollcall] neither XC_ROLLCALL_REENTRY_SEED nor XC_ROLLCALL_FEDERATION_MNEMONIC is set, so AT4 ' +
        'will re-enter on the legacy fixed seed. AT4 STAKES that key and an already-staked key can never be ' +
        'staked again, so this venue gets exactly ONE AT4 run. Set the mnemonic (or bump ' +
        'XC_ROLLCALL_IDLE_GENERATION) before re-running.')
    return LEGACY_REENTRY_SEED
}

// Ed25519 pubkey for a 32-byte seed, derived without the hub package so a
// precondition can print the roster the operator must stake even on a checkout
// where xchain-hub is absent.
function pubkeyForSeed(seedHex){
    const der = Buffer.concat([
        Buffer.from('302e020100300506032b657004220420', 'hex'),
        Buffer.from(String(seedHex), 'hex'),
    ])
    const key = crypto.createPrivateKey({ key: der, format: 'der', type: 'pkcs8' })
    return crypto.createPublicKey(key).export({ format: 'der', type: 'spki' }).subarray(12).toString('hex')
}

// THE IDLE SOURCE ADDRESS ROTATES WITH THE KEY, and that is a second
// requirement, not a tidiness choice. rollcall_absences is keyed on SOURCE_ID
// (D11: weight and eviction are per source, because a delegated key owns no
// stake row), and getRollcallAbsenceEpochsForSource has no term excluding rows
// that predate the source's current stake. So a source that re-enters at the
// same address inherits its old absences: with the window being the last 2K
// ROLLED epochs, one more absence completes K and evicts it immediately.
// Measured 2026-09-01 - after an eviction at epoch 420, re-staking a fresh key
// from the same address would have been evicted again at the very next rolled
// epoch. A new generation therefore gets a new address as well as a new key.
//
// THE SIGNING SOURCES CANNOT ROTATE, AND THE FIX THAT SAID THEY SHOULD IS
// UNIMPLEMENTABLE. It was proposed on 2026-09-01, after AT2's outage let the
// protocol evict hub 2 (a FROZEN vector key, so unrotatable, so permanently
// unstakeable) on a signing source that arrived carrying an earlier run's
// absence. The proposal was to move all four source addresses with the
// generation, i + 4 * generation, so every roster member would get a clean
// streak. It cannot work: STAKE v1 admission asks
// getActiveStakeByPubkey(pubkey, null) (xchain-indexer stake.js:93) and the null
// blockIndex drops the whole activation/deactivation clause, so the rule reads
// "any valid stake row for this pubkey, EVER" and is keyed on the pubkey with no
// source term. Once seed 11's key has been staked from address 0 on a chain, it
// can never be staked again from address 4 or anywhere else. So a signing
// source's address is fixed for the LIFE OF THE CHAIN, and only the idle
// entry - whose key is per-generation and has never been staked - can move.
//
// WHAT TO DO INSTEAD, for a signing source carrying a stale absence:
//   - the absence window is the last 2K ROLLED epochs (getRolledRollcallEpochs),
//     so drive 2K rolled epochs with that hub PRESENT and the old absence ages
//     out of the window on its own; or
//   - drive on a fresh chain, which is the only remedy for a signing key that
//     was actually EVICTED.
// The check that makes either one possible is assertRosterStreaksClean below,
// which refuses the run instead of letting the protocol retire a frozen key.
function idleAddressIndex(){
    return IDLE_SEED_INDEX + Number(process.env.XC_ROLLCALL_IDLE_GENERATION || '0')
}

function federationRoster(){
    return federationSeeds().map((seed, i) => ({
        index:   i,
        seed:    seed,
        pubkey:  pubkeyForSeed(seed).toLowerCase(),
        // The address the stake is made FROM. Signing sources are fixed for the
        // life of the chain (see idleAddressIndex above for why); the idle one
        // moves with the generation.
        addressIndex: i === IDLE_SEED_INDEX ? idleAddressIndex() : i,
        role:    i === IDLE_SEED_INDEX ? 'idle (never signs; AT1 evicts this one)' : 'signing hub ' + i,
    }))
}

module.exports = {
    SIGNING_SEEDS,
    federationSeeds,
    IDLE_SEED_INDEX,
    LEGACY_IDLE_SEED,
    reentrySeed,
    federationRoster,
    pubkeyForSeed,
}
