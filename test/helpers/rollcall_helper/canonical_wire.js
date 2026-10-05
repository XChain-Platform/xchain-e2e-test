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
const {
    ROLLCALL_GATES_ARMING_ENV,
    crd,
    eqh,
    frozenVector,
    rga,
} = require('./sibling_resolution')
const { pubkeyForSeed } = require('./federation')

// ── canonical + wire ─────────────────────────────────────────────────────────

// This build's full gate list, as the wire carries it: the sorted, comma-joined
// `<module>.<EXPORT>` keys of consensus_rules_digest.knownGateKeys(). Borrowed
// from the sibling for the same reason every constant here is: a harness that
// spelled its own list would agree with itself and disagree with the hub that
// actually publishes.
function knownGates(){
    return crd().knownGateKeys().join(',')
}

// The gates ACTIVE at a BTC height, which is the comparand the rules-aware
// attestation filter subsets against. A drill that wants a validator DROPPED
// publishes a list missing one of these.
function activeGates(height, network){
    return crd().activeGatesAt(Number(height), String(network))
}

// Whether an epoch publishes ROLLCALL v1, asked of the SHIPPED gate module so
// the harness and the hubs cannot disagree about which form an epoch is. The
// module resolves the regtest height from ROLLCALL_GATES_ARMING_ENV once, at
// require time, exactly as rollcall_activation.js does for its own rail.
function gatesArmed(epochHeight, network){
    return rga().isRollcallGatesActive(Number(epochHeight), String(network))
}

// The GATES field for an epoch: this build's full list on an armed epoch, null
// on a v0 one. Mirrors RollcallRound.gatesFor.
function gatesForEpoch(epochHeight, network){
    return gatesArmed(epochHeight, network) ? knownGates() : null
}

// sha256 of the GATES field EXACTLY as carried, which is what the v1 canonical
// commits to. Spelled here rather than borrowed from
// xchain-indexer/src/actions/rollcall/rollcall_canonical.js on purpose: the point of this harness
// is to be an INDEPENDENT implementation of the bytes the three shipped sites
// build, pinned against the frozen vector, so borrowing the very function under
// test would make the vector check tautological.
function gatesHash(gates){
    return crypto.createHash('sha256').update(String(gates), 'utf8').digest('hex')
}

// The signed preimage. The EQUIV wrapper comes from the SHIPPED indexer module
// (an engine tag and a round id are not this harness's to invent); the content
// is spelled here. Byte-identical to what RollcallRound signs, what
// actions/rollcall/index.js rebuilds from the carried fields, and what the BTC close
// rebuilds from its own ledger_hash.
//
//   v0:  network|epochHeight|ledgerHash
//   v1:  network|epochHeight|ledgerHash|sha256(GATES)
//
// `gates` decides the form, and the DEFAULT is the epoch's own: omit it and an
// armed epoch gets this build's full list while an unarmed one stays v0
// byte-for-byte, so every existing caller keeps working on a venue that arms the
// rail. Pass a STRING to publish a specific list (a drill that needs one
// validator to name a shorter one), or NULL to force v0 - which is what the
// frozen v0 vector check does, since those bytes must stay v0 on any venue.
function canonical(network, epochHeight, ledgerHash, gates){
    const e = eqh()
    const g = (gates === undefined) ? gatesForEpoch(epochHeight, network) : gates
    let content = String(network) + '|' + Number(epochHeight) + '|' + String(ledgerHash).toLowerCase()
    if (g !== null && g !== undefined) content += '|' + gatesHash(g)
    return e.buildEquivCanonical(e.ENGINE_TAGS.ROLLCALL, String(Number(epochHeight)), 0, content)
}

// The two ROLLCALL wire versions. Spelled as literals rather than assembled from
// parts so scripts/count-action-suites.js sees the payloads this harness builds
// and the published ACTION-name figure carries ROLLCALL.
const ROLLCALL_WIRE_V0 = 'ROLLCALL|0'
const ROLLCALL_WIRE_V1 = 'ROLLCALL|1'

// v0: ROLLCALL|0|EPOCH_HEIGHT|LEDGER_HASH|PUBLISHER|SIG_COUNT|PUBKEY_1|SIG_1|...
// v1: ROLLCALL|1|EPOCH_HEIGHT|LEDGER_HASH|PUBLISHER|GATES|SIG_COUNT|PUBKEY_1|SIG_1|...
//
// Mirrors RollcallRound.buildWire. Used by the sweeper and self-publish legs,
// which have to land an action the hub engine deliberately would not, and by the
// frozen-vector check that pins this builder against the three implementations.
// `gates` follows the same rule canonical() does - omitted takes the epoch's own
// form, a string publishes that exact list, null forces v0 - so a wire and the
// canonical its pairs were signed over can never disagree about the version.
function buildWire(epochHeight, ledgerHash, publisher, pairs, gates){
    // The wire carries no network, so the default form is resolved against the
    // venue's own (the same global every other read here runs on). A caller that
    // wants a form the venue does not imply passes `gates` explicitly.
    const g = (gates === undefined)
        ? gatesForEpoch(epochHeight, (typeof NETWORK !== 'undefined' && NETWORK) ? NETWORK : 'regtest')
        : gates
    const v1 = (g !== null && g !== undefined)
    const parts = [v1 ? ROLLCALL_WIRE_V1 : ROLLCALL_WIRE_V0, String(Number(epochHeight)),
                   String(ledgerHash).toLowerCase(), String(publisher).toLowerCase()]
    if (v1) parts.push(String(g))
    parts.push(String(pairs.length))
    for (const p of pairs) parts.push(String(p.pubkey).toLowerCase(), String(p.sig).toLowerCase())
    return parts.join('|')
}

// Read a published wire by NAME, never by position. v0 and v1 differ by one
// field (GATES sits between PUBLISHER and SIG_COUNT), so a suite that indexed
// the split payload with v0 offsets read GATES as SIG_COUNT and the count as
// the first pubkey on every gates-armed venue.
function parseWire(payload){
    const p = String(payload).split('|')
    assert.strictEqual(p[0], 'ROLLCALL', 'not a ROLLCALL wire: ' + String(payload).slice(0, 40))
    const version = Number(p[1])
    assert.ok(version === 0 || version === 1, 'unknown ROLLCALL wire version ' + p[1])
    const v1 = version === 1
    const gates = v1 ? p[5] : null
    const countAt = v1 ? 6 : 5
    const sigCount = Number(p[countAt])
    const pairs = []
    for (let i = countAt + 1; i + 1 < p.length; i += 2)
        pairs.push({ pubkey: String(p[i]).toLowerCase(), sig: String(p[i + 1]).toLowerCase() })
    assert.strictEqual(pairs.length, sigCount,
        'ROLLCALL v' + version + ' wire declares SIG_COUNT ' + sigCount + ' but carries ' + pairs.length + ' pair(s)')
    return { version, epochHeight: Number(p[2]), ledgerHash: String(p[3]).toLowerCase(),
             publisher: String(p[4]).toLowerCase(), gates, sigCount, pairs }
}

// Sign the canonical with a raw 32-byte seed. Node's own Ed25519, so this helper
// carries no dependency on xchain-hub being resolvable.
function signCanonical(seedHex, canonicalString){
    const der = Buffer.concat([
        Buffer.from('302e020100300506032b657004220420', 'hex'),
        Buffer.from(String(seedHex), 'hex'),
    ])
    const key = crypto.createPrivateKey({ key: der, format: 'der', type: 'pkcs8' })
    return crypto.sign(null, Buffer.from(canonicalString, 'utf8'), key).toString('hex')
}

// PRECONDITION: the borrowed canonical builder reproduces the frozen vector.
// Every suite runs this first. A harness whose canonical has drifted would sign
// bytes no verifier accepts and would report a live federation as absent, which
// is the one failure mode that reads as a protocol bug rather than a test bug.
function assertFrozenCanonicalVector(){
    const v = frozenVector()
    // NULL, not omitted: these bytes are the v0 case and stay v0 whatever the
    // venue arms. Letting the epoch decide the form here would make the check
    // report "canonical drift" on a gates-armed venue, which is the one message
    // that must only ever mean a real disagreement.
    const got = canonical(v.canonical.network, v.canonical.epoch_height, v.canonical.ledger_hash, null)
    assert.strictEqual(got, v.canonical.expected,
        'ROLLCALL canonical drift: this harness builds\n  ' + got + '\nbut the frozen vector ' +
        '(xchain-documentation/protocol/test-vectors/rollcall_canonical.json) says\n  ' + v.canonical.expected +
        '\nThe harness borrows xchain-indexer/src/consensus/equivocation_header.js, so a drift here means the ' +
        'sibling checkout disagrees with the frozen vector, not that the test is wrong.')

    // The vector's signatures are real, so verifying one proves the seed
    // derivation and the signing path agree with the three implementations too.
    for (const s of v.signers){
        assert.strictEqual(pubkeyForSeed(s.seed).toLowerCase(), String(s.pubkey).toLowerCase(),
            'ROLLCALL harness seed derivation disagrees with the frozen vector for seed ' + s.seed.slice(0, 8) + '...')
        assert.strictEqual(signCanonical(s.seed, v.canonical.expected).toLowerCase(), String(s.sig).toLowerCase(),
            'ROLLCALL harness signing disagrees with the frozen vector for pubkey ' + s.pubkey.slice(0, 16) + '...')
    }

    // The wire builder too: AT6 lands a hand-built ROLLCALL, and a wire the DOGE
    // parser rejects would read as "the sweeper never landed" rather than as a
    // malformed payload.
    const byPubkey = new Map(v.signers.map(s => [s.pubkey.toLowerCase(), s.sig.toLowerCase()]))
    for (const w of v.wire){
        const fields = String(w.expected).split('|')
        const pairs  = []
        for (let i = 6; i + 1 < fields.length; i += 2){
            const pubkey = String(fields[i]).toLowerCase()
            const sig    = byPubkey.get(pubkey)
            assert.ok(sig,
                'the frozen v0 wire case "' + w.name + '" names signer ' + pubkey.slice(0, 16) +
                '... which signers does not carry, so its payload cannot be rebuilt from signed material')
            assert.strictEqual(String(fields[i + 1]).toLowerCase(), sig,
                'the frozen v0 wire case "' + w.name + '" carries a signature for ' + pubkey.slice(0, 16) +
                '... that signers does not: the vector disagrees with itself, so one of the two was edited')
            pairs.push({ pubkey, sig })
        }
        assert.strictEqual(pairs.length, Number(w.sig_count),
            'the frozen v0 wire case "' + w.name + '" declares sig_count ' + w.sig_count + ' but its payload ' +
            'carries ' + pairs.length + ' pair(s)')
        const got2 = buildWire(v.canonical.epoch_height, v.canonical.ledger_hash, w.publisher,
                               pairs, null)
        assert.strictEqual(got2, w.expected, 'ROLLCALL wire drift on frozen case "' + w.name + '"')
    }

    // On a GATES-ARMED venue the hubs publish v1, so the v1 half of the vector is
    // load-bearing for the same run and is checked with it. On an unarmed venue
    // nothing here builds a v1 byte, so it is not the run's business.
    if (gatesArmed(v.canonical.epoch_height, v.canonical.network)) assertFrozenGatesVector()
}

// PRECONDITION for every leg that drives the GATES rail: the v1 half of the same
// frozen vector.
//
// Separate from the v0 check above, and HARD-FAILING on a vector that carries no
// v1 entry, because the two answer different questions. The v0 check asks whether
// this harness still agrees with the three shipped implementations. This one asks
// whether it agrees about the SECOND form - the one whose whole content is a
// commitment to a list the drill hand-builds - and a drill that signed a v1
// canonical this vector does not recognise would publish actions the DOGE parser
// silently refuses and read the result as a federation-wide absence, which is
// precisely the reading the vector exists to make impossible.
function assertFrozenGatesVector(){
    const v = frozenVector()
    assert.ok(v.canonical_v1 && v.signers_v1 && v.wire_v1,
        'the frozen vector (xchain-documentation/protocol/test-vectors/rollcall_canonical.json) carries no v1 ' +
        'entry (canonical_v1 / signers_v1 / wire_v1), but this venue arms ' + ROLLCALL_GATES_ARMING_ENV +
        ', so every roll call it publishes is ROLLCALL v1. Refresh the xchain-documentation sibling checkout: a ' +
        'v1 byte nothing pins is a byte three implementations can drift on with nothing going red.')

    const c1 = v.canonical_v1
    assert.strictEqual(gatesHash(c1.gates), String(c1.gates_hash).toLowerCase(),
        'ROLLCALL v1 gatesHash drift: this harness hashes the vector\'s GATES field to\n  ' + gatesHash(c1.gates) +
        '\nbut the frozen vector says\n  ' + c1.gates_hash +
        '\nThe canonical commits to THIS hash, so a drift here makes every v1 signature this harness produces ' +
        'unverifiable to the DOGE parser and the BTC close.')

    const got = canonical(c1.network, c1.epoch_height, c1.ledger_hash, c1.gates)
    assert.strictEqual(got, c1.expected,
        'ROLLCALL v1 canonical drift: this harness builds\n  ' + got + '\nbut the frozen vector says\n  ' +
        c1.expected + '\nThe v1 content appends |sha256(GATES) to the v0 content inside the same EQUIV header; ' +
        'a difference here is the harness and the sibling checkout disagreeing, not the test being wrong.')

    // Real signatures over the v1 canonical, from the same fixed seeds: proof that
    // this harness can produce a v1 pair the three implementations accept.
    for (const s of v.signers_v1){
        assert.strictEqual(pubkeyForSeed(s.seed).toLowerCase(), String(s.pubkey).toLowerCase(),
            'ROLLCALL harness seed derivation disagrees with the frozen v1 vector for seed ' + s.seed.slice(0, 8) + '...')
        assert.strictEqual(signCanonical(s.seed, c1.expected).toLowerCase(), String(s.sig).toLowerCase(),
            'ROLLCALL harness v1 signing disagrees with the frozen vector for pubkey ' + s.pubkey.slice(0, 16) + '...')
    }

    // And the v1 wire, field order included: GATES sits between PUBLISHER and
    // SIG_COUNT, and a builder that put it anywhere else would land an action the
    // parser reads as a malformed v0.
    //
    // THE PAIRS COME FROM signers_v1, NOT FROM THE EXPECTED STRING, and that is
    // the difference between a check and a mirror. Reading a case's pairs out of
    // the very payload it is compared against makes the comparison circular: a
    // tampered `expected` feeds its own tampered bytes back into the builder and
    // reproduces itself. Measured on this file 2026-09-07 - the first version of
    // this loop took both halves of each pair from `expected` and went GREEN
    // against a vector whose payload had been edited. Only the pubkey ORDER is
    // read from the case (which signer a case lists first is part of what it
    // pins); the signature bytes are the vector's own, and are asserted to match
    // the ones the case carries before anything is built.
    const bySeed = new Map(v.signers_v1.map(s => [s.pubkey.toLowerCase(), s.sig.toLowerCase()]))
    for (const w of v.wire_v1){
        const fields = String(w.expected).split('|')
        const pairs  = []
        for (let i = 7; i + 1 < fields.length; i += 2){
            const pubkey = String(fields[i]).toLowerCase()
            const sig    = bySeed.get(pubkey)
            assert.ok(sig,
                'the frozen v1 wire case "' + w.name + '" names signer ' + pubkey.slice(0, 16) +
                '... which signers_v1 does not carry, so its payload cannot be rebuilt from signed material')
            assert.strictEqual(String(fields[i + 1]).toLowerCase(), sig,
                'the frozen v1 wire case "' + w.name + '" carries a signature for ' + pubkey.slice(0, 16) +
                '... that signers_v1 does not: the vector disagrees with itself, so one of the two was edited')
            pairs.push({ pubkey, sig })
        }
        assert.strictEqual(pairs.length, Number(w.sig_count),
            'the frozen v1 wire case "' + w.name + '" declares sig_count ' + w.sig_count + ' but its payload ' +
            'carries ' + pairs.length + ' pair(s)')
        const got2 = buildWire(c1.epoch_height, c1.ledger_hash, w.publisher, pairs, w.gates)
        assert.strictEqual(got2, w.expected, 'ROLLCALL v1 wire drift on frozen case "' + w.name + '"')
    }
}

module.exports = {
    signCanonical,
    canonical,
    buildWire,
    parseWire,
    ROLLCALL_WIRE_V0,
    ROLLCALL_WIRE_V1,
    gatesHash,
    knownGates,
    activeGates,
    gatesArmed,
    gatesForEpoch,
    assertFrozenCanonicalVector,
    assertFrozenGatesVector,
}
