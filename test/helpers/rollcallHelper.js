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
 **********************************************************************
 * E2E helper: the ROLLCALL validator-liveness rail (two chains, one process).
 *
 * The rail spans both regtest stacks: hubs sign a canonical bound to a BITCOIN
 * epoch block's ledger_hash, an elected leader lands the signatures on DOGECOIN
 * as a ROLLCALL action, and the BITCOIN indexer closes the epoch by proving that
 * DOGE action, re-verifying every signature against its OWN ledger_hash and
 * evicting a source absent for K consecutive rolled epochs.
 *
 * WHY THIS FILE EXISTS AT ALL, rather than the suites doing it inline:
 *
 *   1. CONSENSUS CONSTANTS ARE NEVER RE-DERIVED HERE. Every epoch height, close
 *      height and K value comes from the shipped xchain-indexer
 *      src/rollcall_activation.js, and the canonical comes from the shipped
 *      src/equivocation_header.js. A test that recomputed either would agree
 *      with itself while disagreeing with the chain, which is the exact failure
 *      the frozen vector exists to catch. assertFrozenCanonicalVector() pins
 *      that borrowed builder against
 *      xchain-documentation/protocol/test-vectors/rollcall_canonical.json.
 *
 *   2. THE PRECONDITIONS ARE THE POINT. This venue has several ways to be
 *      almost ready, and each of them makes the epoch close DEFER rather than
 *      fail: an unconfigured DOGE peer, a peer whose action-manifest hash it
 *      cannot report, a federation with too few staking sources. A deferred
 *      close is an indexer that silently stops advancing, which surfaces in a
 *      naive harness as a timeout with no cause attached. Every named assert
 *      below converts one of those into a sentence saying what is missing and
 *      what to do about it.
 *
 *   3. MultiValidatorHub has no roll-call broadcast hook. RollcallRound is
 *      constructed inside XChainHub.startAttestation(), so a rollcall run needs
 *      startAttestation:true, and the hook has to be wired per hub through
 *      hub.getRollcallRound(). setRollcallBroadcastHook() below is that wiring,
 *      kept here rather than added to multiValidatorHubHelper so no existing
 *      suite changes shape.
 *
 * NOTHING HERE SEEDS THE VENUE. Staking the federation is an operator decision
 * (test/tools/rollcallSeedFederation.test.js is the tool that does it). The
 * asserts report what is missing, with the exact pubkeys to stake, and stop.
 *
 * THREE of the four roster keys are fixed; the IDLE one is per-venue. AT1 evicts
 * the idle staker, and an evicted key can never be staked again, so a
 * fixed idle seed would make AT1 one-shot per venue. See idleSeed() below.
 ********************************************************************/

'use strict'

const assert = require('assert')
const crypto = require('crypto')
const fs     = require('fs')
const os     = require('os')
const path   = require('path')

const chainRail = require('./chainRail')

// ── sibling module resolution ────────────────────────────────────────────────
//
// Same candidate ladder multiValidatorHubHelper uses for xchain-hub: monorepo
// sibling, e2e image bundle, or an explicit override. Resolved lazily so a
// suite that only reads its own preconditions does not die at require() time in
// a checkout without the sibling.
function _resolveSibling(pkg, rel){
    const candidates = [
        process.env['XCHAIN_' + pkg.replace('xchain-', '').toUpperCase() + '_PATH'] &&
            path.join(process.env['XCHAIN_' + pkg.replace('xchain-', '').toUpperCase() + '_PATH'], rel),
        path.resolve(__dirname, '../../', pkg, rel),
        path.resolve(__dirname, '../../../', pkg, rel),
        path.resolve(__dirname, '../../../../', pkg, rel),
        path.resolve(__dirname, '../../../../../modules/', pkg, rel),
    ].filter(Boolean)
    for (const p of candidates) if (fs.existsSync(p)) return p
    throw new Error(
        'ROLLCALL harness: cannot resolve ' + pkg + '/' + rel + '. The suite reads its consensus ' +
        'constants and its canonical builder from the shipped module rather than re-deriving them. ' +
        'Place ' + pkg + ' adjacent to xchain-e2e-test. Tried: ' + candidates.join(', ')
    )
}

// The same ladder, answering "is it there" instead of throwing. Used where a
// missing sibling is a legitimate skip and a broken one must still be loud.
function _resolveSiblingIfPresent(pkg, rel){
    try { return _resolveSibling(pkg, rel) }
    catch (e) { return null }
}

let _rca = null, _eqh = null
function rca(){ if (!_rca) _rca = require(_resolveSibling('xchain-indexer', 'src/rollcall_activation.js')); return _rca }
function eqh(){ if (!_eqh) _eqh = require(_resolveSibling('xchain-indexer', 'src/equivocation_header.js')); return _eqh }

// The frozen cross-implementation vector. Authoritative in xchain-documentation;
// read, never forked.
function frozenVector(){
    return require(_resolveSibling('xchain-documentation', 'protocol/test-vectors/rollcall_canonical.json'))
}

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
// Measured here - after the eviction at epoch 420, re-staking a fresh key from
// the same address would have been evicted again at the very next rolled epoch.
// A new generation therefore gets a new address as well as a new key.
function idleAddressIndex(){
    return IDLE_SEED_INDEX + Number(process.env.XC_ROLLCALL_IDLE_GENERATION || '0')
}

function federationRoster(){
    return federationSeeds().map((seed, i) => ({
        index:   i,
        seed:    seed,
        pubkey:  pubkeyForSeed(seed).toLowerCase(),
        // The address the stake is made FROM. Signing sources are stable; the
        // idle one moves with the generation (see idleAddressIndex above).
        addressIndex: i === IDLE_SEED_INDEX ? idleAddressIndex() : i,
        role:    i === IDLE_SEED_INDEX ? 'idle (never signs; AT1 evicts this one)' : 'signing hub ' + i,
    }))
}

// ── canonical + wire ─────────────────────────────────────────────────────────

// The signed preimage, built by the SHIPPED indexer module. Byte-identical to
// what RollcallRound signs, what actions/rollcall.js rebuilds from the carried
// fields, and what the BTC close rebuilds from its own ledger_hash.
function canonical(network, epochHeight, ledgerHash){
    const e = eqh()
    const content = String(network) + '|' + Number(epochHeight) + '|' + String(ledgerHash).toLowerCase()
    return e.buildEquivCanonical(e.ENGINE_TAGS.ROLLCALL, String(Number(epochHeight)), 0, content)
}

// The only ROLLCALL wire version. Spelled as one literal rather than assembled
// from parts so scripts/count-action-suites.js sees the payload this harness
// builds and the published ACTION-name figure carries ROLLCALL.
const ROLLCALL_WIRE_V0 = 'ROLLCALL|0'

// ROLLCALL|0|EPOCH_HEIGHT|LEDGER_HASH|PUBLISHER|SIG_COUNT|PUBKEY_1|SIG_1|...
// Mirrors RollcallRound._buildWire. Used by the sweeper and self-publish legs,
// which have to land an action the hub engine deliberately would not, and by the
// frozen-vector check that pins this builder against the three implementations.
function buildWire(epochHeight, ledgerHash, publisher, pairs){
    const parts = [ROLLCALL_WIRE_V0, String(Number(epochHeight)),
                   String(ledgerHash).toLowerCase(), String(publisher).toLowerCase(),
                   String(pairs.length)]
    for (const p of pairs) parts.push(String(p.pubkey).toLowerCase(), String(p.sig).toLowerCase())
    return parts.join('|')
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
    const got = canonical(v.canonical.network, v.canonical.epoch_height, v.canonical.ledger_hash)
    assert.strictEqual(got, v.canonical.expected,
        'ROLLCALL canonical drift: this harness builds\n  ' + got + '\nbut the frozen vector ' +
        '(xchain-documentation/protocol/test-vectors/rollcall_canonical.json) says\n  ' + v.canonical.expected +
        '\nThe harness borrows xchain-indexer/src/equivocation_header.js, so a drift here means the ' +
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
    const bySeed = new Map(v.signers.map(s => [s.pubkey.toLowerCase(), s.sig.toLowerCase()]))
    for (const w of v.wire){
        const pairs = Array.from(bySeed, ([pubkey, sig]) => ({ pubkey, sig })).slice(0, w.sig_count)
        // The one-signature case names its lone signer as publisher, so take the
        // pairs the vector's own expected payload carries rather than the first N.
        const wanted = String(w.expected).split('|').slice(6)
        const exact  = []
        for (let i = 0; i < wanted.length; i += 2) exact.push({ pubkey: wanted[i], sig: wanted[i + 1] })
        const got2 = buildWire(v.canonical.epoch_height, v.canonical.ledger_hash, w.publisher,
                               exact.length === w.sig_count ? exact : pairs)
        assert.strictEqual(got2, w.expected, 'ROLLCALL wire drift on frozen case "' + w.name + '"')
    }
}

// ── epoch arithmetic, borrowed ───────────────────────────────────────────────

function closeHeightOf(epochHeight, network){
    const h = rca().rollcallCloseHeight(epochHeight, network)
    assert.notStrictEqual(h, null,
        'rollcallCloseHeight(' + epochHeight + ', ' + network + ') is null: unknown network or unparseable height')
    return h
}

// Every epoch boundary strictly after `afterHeight`, in ascending order. The
// suites call this to pick the epochs a run will drive rather than hard-coding
// heights, which would break the moment the venue chain moves.
function epochsAfter(afterHeight, network, count){
    const r = rca()
    const interval = r.ROLLCALL_INTERVAL_BLOCKS[network]
    assert.ok(Number.isFinite(interval) && interval > 0,
        'no ROLLCALL_INTERVAL_BLOCKS for network ' + JSON.stringify(network))
    const out = []
    let e = Math.floor(Number(afterHeight) / interval) * interval
    while (out.length < count){
        e += interval
        if (r.isRollcallEpoch(e, network) && r.isRollcallActive(e, network)) out.push(e)
    }
    return out
}

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
    if (on !== '1' && on !== 'true') {
        console.log('[skip] ROLLCALL acceptance drives BOTH regtest stacks (BTC epochs + DOGE publishes) ' +
                    'against a seeded four-source federation. Set E2E_REQUIRE_FEDERATION=1 to run it.')
        ctx.skip()
        return false
    }
    // Opted IN, but the rail may be inert on this network. Say so in those terms
    // rather than letting assertRegtestConstants report it as "constant drift",
    // which reads as a stale sibling checkout and sends the reader to the wrong
    // place entirely.
    const network = NETWORK
    if (rca().ROLLCALL_ACTIVATION[network] === null) {
        console.log('[skip] ROLLCALL is INERT on ' + network + ' (ROLLCALL_ACTIVATION.' + network + ' is null), ' +
                    'so no epoch exists for this suite to drive and the close would return 0 at every height. ' +
                    'Regtest was made inert on 2026-08-31: arming a network commits every BTC indexer on it to ' +
                    'a wired DOGE peer, and a single-coin BTC regtest venue has none. This suite needs an armed ' +
                    'height, and there is deliberately no env override (the activation file forbids reading one). ' +
                    'Arming it is an operator decision, not a venue setting.')
        ctx.skip()
        return false
    }
    return true
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
    // ROLLCALL_ACTIVATION is deliberately NOT pinned here. It went null (inert) on
    // regtest on 2026-08-31, and requireRollcallVenue already refuses the run in
    // those terms, so any venue that reaches this line has had it armed to some
    // height on purpose. Pinning a value would fight that arming; pinning null
    // would be unreachable. The CADENCE constants below are what this harness's
    // epoch arithmetic actually assumes, and those still must not drift.
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
async function assertOraclePublishFederation(conn, blockIndex, needSources){
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

    return { sources, idleSource, byPubkey, weights: res.validators, sourceCount: res.source_count }
}

// The DOGE peer's own report of its vendored action-manifest hash. This is the
// fifth and least obvious `unknown` condition in RollcallProofClient: a peer that
// cannot name its manifest can never match ours, so EVERY close defers forever,
// with no signal anywhere except a stalled indexer.
//
// Measured on the venue 2026-08-30: the DOGE regtest indexer answers
// manifest_hash null, because xchain-indexer's Dockerfile copies only src/,
// data/genesis and the package files, so test/fixtures/action-manifest.json is
// absent from the running image on BOTH sides.
async function assertDogePeerManifest(dogeConn, network){
    const res = await dogeConn.call('getrollcallsigners', {
        network: network, epoch_height: 0, max_block_time: 0, pubkeys: [], publishers: [],
    })
    assert.ok(res && !res.error,
        'ROLLCALL precondition: the DOGE indexer refused getrollcallsigners: ' + JSON.stringify(res && res.error) +
        '. That read is a FEDERATION_READ_METHOD; set DOGE_INDEXER_API_KEY / INDEXER_API_KEY or run the DOGE ' +
        'venue with INDEXER_ALLOW_UNAUTHENTICATED=true.')

    assert.ok(/^[0-9a-f]{64}$/.test(String(res.manifest_hash || '')),
        'ROLLCALL precondition FAILED: the DOGE indexer reports manifest_hash=' + JSON.stringify(res.manifest_hash) +
        ' rather than a sha256. RollcallProofClient condition (5) compares that value against the BTC ' +
        'indexer\'s own vendored test/fixtures/action-manifest.json and DEFERS on any difference, and a null ' +
        'can never match, so every epoch close would stall forever with no other symptom.\n' +
        'Cause on a containerized venue: xchain-indexer/Dockerfile copies src/, data/genesis and the package ' +
        'files only, so test/fixtures/action-manifest.json is not in the image. Ship that fixture into both ' +
        'indexer images (or bind-mount it) before driving any close.')

    // The BTC side's copy is not readable over any RPC, so this is the closest
    // check available: the local sibling checkout's fixture, which is what a
    // correctly built image carries. A difference is reported rather than
    // asserted, because a legitimately newer venue may lead the checkout.
    //
    // ABSENCE is detected, never caught. Wrapping the read in try/catch would
    // also swallow a sibling that is present but unreadable, and the suite would
    // go green having compared nothing - the false-green shape the repo's own
    // vmFalseGreen guard exists to refuse.
    let localHash = null
    const localManifest = _resolveSiblingIfPresent('xchain-indexer', 'test/fixtures/action-manifest.json')
    if (localManifest){
        localHash = crypto.createHash('sha256').update(fs.readFileSync(localManifest)).digest('hex')
    }
    if (localHash && localHash !== String(res.manifest_hash)){
        console.warn('    [rollcall] DOGE peer manifest_hash ' + String(res.manifest_hash).slice(0, 16) +
                     '... differs from this checkout\'s ' + localHash.slice(0, 16) + '...; the BTC indexer must ' +
                     'carry the SAME fixture as the DOGE indexer or every close defers on condition (5).')
    }
    return { manifestHash: String(res.manifest_hash), hcut: res.hcut, tip: res.tip_block_index }
}

// The BTC indexer must be wired to a DOGE indexer (DOGE_INDEXER_API_URL), or the
// proof client's condition (1) makes every close throw
// RollcallProofUnavailableError and the block is retried forever.
//
// Nothing on the indexer's RPC surface reports its own env, so this measures the
// two observable consequences instead:
//   (a) a stalled tip: the indexer sitting below the node with its next block
//       being an epoch close is the exact signature of a deferring close;
//   (b) a silent close: every close height already at or below the indexed tip
//       must have written a `rollcalls` row, because the close writes one on
//       every path it can reach, including the unrolled ones.
// Measured on the venue 2026-08-30: `printenv | grep '^DOGE'` on the BTC indexer
// container returned nothing.
async function assertBtcProofWiring(nodeConn, idxConn, idxQuery, network){
    const tipRes = await idxConn.call('getblockhashes', {})
    const idxTip = Number(tipRes.block_index)
    const nodeTip = Number(await nodeConn.getBlockCount())

    const r = rca()
    const nextClose = (() => {
        for (let h = idxTip + 1; h <= idxTip + 1 + r.ROLLCALL_INTERVAL_BLOCKS[network]; h++)
            if (r.rollcallEpochClosingAt(h, network) !== null) return h
        return null
    })()

    if (nodeTip > idxTip && nextClose === idxTip + 1){
        throw new Error(
            'ROLLCALL precondition FAILED: the BTC indexer is stalled at ' + idxTip + ' while the node is at ' +
            nodeTip + ', and its next block ' + (idxTip + 1) + ' is the close of epoch ' +
            r.rollcallEpochClosingAt(idxTip + 1, network) + '. That is the signature of a DEFERRING epoch close: ' +
            'RollcallProofClient has no DOGE peer to ask, so it returns unknown and the block is retried forever. ' +
            'Set DOGE_INDEXER_API_URL (and DOGE_INDEXER_API_KEY if the DOGE indexer is keyed) on the BTC indexer ' +
            'and restart it.')
    }

    // Every close at or below the indexed tip wrote a row, or the close is not
    // running on this indexer at all.
    const due = []
    for (let h = 0; h <= idxTip; h++) if (r.rollcallEpochClosingAt(h, network) !== null) due.push(h)
    if (due.length > 0){
        let rows
        try {
            rows = await idxQuery('SELECT close_block FROM rollcalls WHERE close_block <= ?', [idxTip])
        } catch (e) {
            throw new Error(
                'ROLLCALL precondition FAILED: the BTC indexer DB has no readable `rollcalls` table (' +
                (e && e.message) + '). Apply src/sql/migrations/2026-08-30-rollcall-tables.sql to the indexer ' +
                'database before driving any close.')
        }
        const have = new Set(rows.map(x => Number(x.close_block)))
        const gaps = due.filter(h => !have.has(h))
        assert.strictEqual(gaps.length, 0,
            'ROLLCALL precondition FAILED: the BTC indexer has indexed past close block(s) ' +
            gaps.join(', ') + ' but wrote no `rollcalls` row for them. Either this indexer predates ' +
            'src/rollcall_close.js, or those blocks were indexed before ROLLCALL activated. Deploy the ' +
            'rollcall-aware indexer and reindex from below block ' + gaps[0] + ' before driving the acceptance ' +
            'tests, or every verdict below is read from a rail that never ran.')
    }
    return { idxTip, nodeTip, nextClose }
}

// getrollcalls / getrollcallabsences are the two PLAIN PUBLIC reads the AT list
// quotes. Their DB half (db.js getRollcalls / getRollcallAbsencesBySource) is
// landed; the RPC half was still in flight when this harness was written, and
// is absent from the BTC regtest indexer as measured 2026-08-30. A suite that
// asserted on them without checking would fail with "Method not found" halfway
// through a twenty-minute drive.
async function probePublicRollcallReads(conn){
    const out = {}
    for (const m of ['getrollcalls', 'getrollcallabsences']){
        try {
            const params = m === 'getrollcalls' ? { limit: 1 } : { source: 'rollcall-probe-unknown-source', limit: 1 }
            const res = await conn.call(m, params)
            out[m] = (res && res.error) ? { present: true, error: res.error } : { present: true, sample: res }
        } catch (e) {
            out[m] = { present: false, why: String((e && e.message) || e) }
        }
    }
    return out
}

function assertPublicRollcallRead(probe, method){
    assert.ok(probe[method] && probe[method].present,
        'ROLLCALL precondition FAILED: the BTC indexer does not serve `' + method + '` (' +
        (probe[method] && probe[method].why) + '). Its DB half is landed (xchain-indexer src/db.js ' +
        (method === 'getrollcalls' ? 'getRollcalls' : 'getRollcallAbsencesBySource') + ') but the JSON-RPC ' +
        'method is not deployed on this indexer. Deploy the public-read push, or run with ' +
        'XC_ROLLCALL_SKIP_PUBLIC_READS=1 to assert the same facts from the indexer DB only.')
}

// AT1 asserts the idle source is NOT evicted after its first driven epoch,
// which is only true if that epoch is its FIRST rolled absence. The K-streak
// walks the last 2K ROLLED epochs and skips unrolled ones (D39), so a venue that
// has ever rolled an epoch with this source absent carries a head start that no
// amount of driving can undo.
//
// Measured on the venue: epoch 240 rolled with the idle source absent, epochs
// 270-390 all closed unrolled and were skipped, and the very first epoch this
// suite drove completed K=2 and evicted immediately. The protocol was right; the
// suite was reading a venue with history as if it were clean, and reported a
// correct eviction as a failure.
//
// A FRESH idle key has no history by construction, which is the same rotation
// the ledger item forces after an eviction anyway - so the remedy for both is one step.
async function assertIdleStreakClean(ctx){
    const idle = ctx.roster[IDLE_SEED_INDEX]
    const source = ctx.fed.byPubkey.get(idle.pubkey)
    let res
    try {
        res = await indexerConnector.call('getrollcallabsences', { source: String(source), limit: 50 })
    } catch (e) {
        return null   // the public read is probed separately; do not fail twice on it
    }
    if (!res || res.error) return null
    const rolled = (res.absences || []).filter(a => Number(a.epoch_height) >= 0)
    if (rolled.length === 0) return { priorAbsences: 0 }

    const evicted = rolled.some(a => Number(a.evicted) === 1)
    assert.fail(
        'ROLLCALL precondition FAILED: the idle source ' + source + ' already carries ' + rolled.length +
        ' recorded absence(s) at epoch(s) ' + rolled.map(a => a.epoch_height).join(', ') +
        (evicted ? ' and has ALREADY BEEN EVICTED' : '') + '. The K-streak counts ROLLED epochs and skips ' +
        'unrolled ones, so this source starts with a head start and the first epoch this suite drives may ' +
        'complete K=2 and evict immediately - which AT1 reads as "evicted on a streak of 1" and reports as a ' +
        'protocol failure when the protocol was right.\n' +
        'Remedy: seed a FRESH idle key, which has no history by construction. Bump ' +
        'XC_ROLLCALL_IDLE_GENERATION (removing any XC_ROLLCALL_IDLE_SEED pin) and re-run ' +
        'test/tools/rollcallSeedFederation.test.js. That is required after an eviction anyway, because an ' +
        'evicted signing key can never be staked again.')
}

// ── the DOGE rail ────────────────────────────────────────────────────────────

// The second stack, through the repo's own multi-chain rail rather than a
// bespoke set of connectors: withRail(rail, fn) swaps the globals so every
// existing helper (transactionHelper, cryptoHelper, gasHelper) works verbatim
// on DOGE, which is what lets the sweeper leg broadcast a real ROLLCALL action.
async function openDogeRail(network){
    let rail
    try {
        rail = await chainRail.createRail('dogecoin', network)
    } catch (e) {
        throw new Error(
            'ROLLCALL precondition FAILED: cannot build the DOGE rail (' + (e && e.message) + '). ' +
            'Roll calls land on DOGECOIN, so the acceptance venue needs BOTH regtest stacks up and both ' +
            'registered with the hub. Bring up the dogecoin-regtest stack (node, utxo-tracker, encoder, ' +
            'decoder, indexer, regtest-miner) before running.')
    }
    const failures = await chainRail.railFailures(rail)
    assert.strictEqual(failures.length, 0,
        'ROLLCALL precondition FAILED: the DOGE rail is not usable: ' + failures.join('; ') +
        '. Every ROLLCALL action is published on DOGE, so none of the acceptance tests can drive without it.')
    return rail
}

// ── hub engine wiring ────────────────────────────────────────────────────────

// RollcallRound instances, in hub index order. Constructed inside
// XChainHub.startAttestation(), so a MultiValidatorHub built without
// startAttestation:true has none and the whole run would sign nothing.
function rollcallRounds(mvh){
    const rounds = mvh.hubs.map(h => (h.getRollcallRound && h.getRollcallRound()) || null)
    const missing = rounds.map((r, i) => r ? null : i).filter(i => i !== null)
    assert.strictEqual(missing.length, 0,
        'ROLLCALL harness: hub(s) ' + missing.join(', ') + ' have no RollcallRound. The engine is constructed ' +
        'in XChainHub.startAttestation(), so MultiValidatorHub must be built with startAttestation:true - but ' +
        'the likelier cause is a STALE xchain-hub checkout, because MultiValidatorHub resolves the sibling by ' +
        'a path ladder and a monorepo checkout shared with other sessions can sit behind origin without saying ' +
        'so. Measured 2026-08-30: the sibling was 12 commits behind origin/develop and simply had no ' +
        'RollcallRound.js, and this assertion was the only symptom. Check ' +
        JSON.stringify(process.env.XCHAIN_HUB_PATH || '(XCHAIN_HUB_PATH unset; resolved by the sibling ladder)') +
        ' and point XCHAIN_HUB_PATH at a checkout that carries src/RollcallRound.js.')
    return rounds
}

// Wire one DOGE publish hook into every hub's RollcallRound. Only the ranks the
// election has unlocked actually call it, so a single funded publisher address
// is safe. `fn(wirePayload)` must return `{ txid }`.
function setRollcallBroadcastHook(mvh, fn){
    for (const eng of rollcallRounds(mvh)) eng.setBroadcastHook(fn)
}

// Drive every engine one tick, in hub order. The suites set ROLLCALL_POLL_MS
// high and tick manually so a round advances on the test's schedule rather than
// on a wall clock the mining loop races.
//
// `skip` is how an outage is expressed, and it is NOT optional decoration.
// RollcallRound.stop() only stops the engine's OWN timer; calling _tick()
// afterwards drives it anyway, so a "stopped" hub kept signing and gossiping
// and a sweeper then landed its signature on chain, exactly as union semantics
// says it should. AT2 measured that as "the silenced hub was present", which
// reads as a protocol failure when it is the harness driving a hub it had just
// declared down. An outage means nobody ticks it.
async function tickAll(mvh, skip){
    const skipSet = new Set((skip || []).map(Number))
    const rounds  = rollcallRounds(mvh)
    for (let i = 0; i < rounds.length; i++){
        if (skipSet.has(i)) continue
        await rounds[i]._tick()
    }
}

// Gossip needs a moment to cross the in-process mesh between the tick that signs
// and the tick that publishes. Poll the engines' own collected counts rather
// than sleeping a fixed span.
async function waitForGossip(mvh, epoch, wantSigners, timeoutMs, skip){
    const deadline = Date.now() + (timeoutMs || 60000)
    const skipSet  = new Set((skip || []).map(Number))
    let best = 0
    while (Date.now() < deadline){
        await tickAll(mvh, skip)
        // Count only the hubs that are up. A silenced engine's own view is not
        // evidence about the mesh, and reading it would let an outage satisfy
        // its own gossip target.
        best = Math.max(...rollcallRounds(mvh).map((e, i) => {
            if (skipSet.has(i)) return 0
            const s = e.getStatus()
            return (s && s.epoch === epoch) ? Number(s.gossiped_count || 0) : 0
        }))
        if (best >= wantSigners) return best
        await new Promise(r => setTimeout(r, 1000))
    }
    return best
}

// ── shared venue bring-up ────────────────────────────────────────────────────
//
// All three ROLLCALL suites need the same thing standing before they can assert
// anything: both stacks reachable, every precondition named and checked, three
// in-process hubs with their DOGE publish rail wired, and a funded DOGE
// publisher. It lives here rather than being copied into each suite so a venue
// gap is reported in one voice, and so a fix to one precondition reaches all
// three at once.
//
// Returns a context object the suites drive through. Throws, never skips: by the
// time this runs the suite has already opted in.
async function bringUpVenue(opts){
    const o = opts || {}
    const ctx = {}

    assertBtcRail()
    assertFrozenCanonicalVector()

    ctx.network = NETWORK
    assertRegtestConstants(ctx.network)

    ctx.btcRail = chainRail.captureCurrentRail()
    ctx.idxQuery = async (sql, args) => {
        const conn = await indexerDatabase.getConnection()
        try { return await conn.query(sql, args) }
        finally { await conn.release() }
    }
    ctx.btcTip = async () => Number((await indexerConnector.call('getblockhashes', {})).block_index)

    const tip = await ctx.btcTip()
    await assertGatedReadsReachable(indexerConnector, tip, 'BTC')
    ctx.wiring = await assertBtcProofWiring(nodeConnector, indexerConnector, ctx.idxQuery, ctx.network)

    ctx.dogeRail = await openDogeRail(ctx.network)
    ctx.peer = await assertDogePeerManifest(ctx.dogeRail.globals.indexerConnector, ctx.network)

    ctx.roster = federationRoster()
    ctx.fed    = await assertOraclePublishFederation(indexerConnector, tip, o.needSources || 4)
    ctx.idleSource = ctx.fed.idleSource
    ctx.sourceOf   = (hubIndex) => ctx.fed.byPubkey.get(ctx.roster[hubIndex].pubkey)

    ctx.weightBySource = new Map()
    for (const v of ctx.fed.weights)
        if (!ctx.weightBySource.has(String(v.source))) ctx.weightBySource.set(String(v.source), Number(v.weight))
    ctx.totalWeight = Array.from(ctx.weightBySource.values()).reduce((a, b) => a + b, 0)

    ctx.publicReads = await probePublicRollcallReads(indexerConnector)
    await assertIdleStreakClean(ctx)

    // Optional deterministic source addresses. When the operator seeded the
    // federation from this mnemonic, the harness holds the sources' keys, which
    // is what lets AT10 drive a real COLLECT rather than only asserting the
    // ledger arithmetic behind one.
    ctx.federationMnemonic = process.env.XC_ROLLCALL_FEDERATION_MNEMONIC || null
    ctx.sourceAddressInfo  = new Map()
    if (ctx.federationMnemonic){
        const cryptoHelper = require('../cryptoHelper')
        for (const r of ctx.roster){
            const info = await cryptoHelper.getNewAddress(
                'rollcall-source-' + r.addressIndex, COIN, NETWORK, ctx.federationMnemonic, 'legacy', r.addressIndex)
            ctx.sourceAddressInfo.set(String(info.address), info)
        }
        const staked = new Set(ctx.fed.sources)
        const derived = Array.from(ctx.sourceAddressInfo.keys())
        const unmatched = derived.filter(a => !staked.has(a))
        assert.strictEqual(unmatched.length, 0,
            'XC_ROLLCALL_FEDERATION_MNEMONIC is set, but the addresses it derives are not the staked sources: ' +
            JSON.stringify(unmatched) + ' are not among ' + JSON.stringify(Array.from(staked)) + '. Seed the ' +
            'federation from this mnemonic (address index i for roster entry i), or unset the variable and let ' +
            'the COLLECT leg skip.')
    }

    // In-process hubs. The DOGE indexer URL is for THESE hubs' RollcallRound
    // engines only; it does nothing for the separately deployed BTC indexer,
    // whose own DOGE_INDEXER_API_URL is a container-side deployment condition
    // that assertBtcProofWiring above is the only check on.
    process.env.DOGE_INDEXER_API_URL = 'http://' + ctx.dogeRail.host + ':' + ctx.dogeRail.ports.indexer + '/'
    process.env.ROLLCALL_POLL_MS     = '600000'   // manual ticks only
    // Per-run spend and signature logs. RollcallRound deliberately re-emits a
    // STORED signature for an epoch it has already signed, so a shared default
    // path would make a second run replay the first run's bytes against a
    // different ledger_hash and read as a federation-wide absence.
    const logDir = path.join(os.tmpdir(), 'xchain-rollcall-' + process.pid)
    process.env.ROLLCALL_SIGN_LOG_PATH  = path.join(logDir, 'signatures.jsonl')
    process.env.ROLLCALL_SPEND_LOG_PATH = path.join(logDir, 'publish.spend.jsonl')

    // The three hubs each want their own database, and the platform's own
    // `xchain_hub` user deliberately lacks CREATE DATABASE (disposableHubDb's
    // header makes the argument: granting it would be a privileged platform
    // grant that every consensus test then depends on). Measured on the venue:
    // MultiValidatorHub.start() dies on ER_ACCESS_DENIED_ERROR against
    // xchain_hub@127.0.0.1:13306, and "retrying will not fix a credentials
    // error". So self-provision, exactly as the multiHub* integration suites
    // do. forceDocker is load-bearing rather than belt-and-braces: this venue
    // ALWAYS has HUB_DB_USER/HUB_DB_PASS in its .env, so the helper's reuse
    // path would hand back the very credentials that cannot create a database,
    // and it answers a liveness probe happily while doing it.
    const { startDisposableHubDb } = require('./disposableHubDb')
    ctx.hubDb = await startDisposableHubDb({
        forceDocker: true,
        // STABLE name, not pid-suffixed. The helper's first act is
        // `docker rm -f <name>`, so a stable name makes a crashed run's
        // container self-healing; a per-pid name plus a fixed port does the
        // opposite and guarantees the NEXT run dies on "port already
        // allocated" (measured: a run that threw after bring-up left
        // xchain-rollcall-testdb-2716751 holding 13308 and the following run
        // could not start at all). Two concurrent ROLLCALL runs would collide
        // on this name, but they would collide on the single regtest chain
        // first, so serialising them is a precondition either way.
        name: 'xchain-rollcall-testdb',
        // 13307 is the multiHub integration suites' default and a leftover
        // container may still hold it; a per-rail port keeps a stale one from
        // silently becoming this run's database.
        port: process.env.XC_ROLLCALL_HUB_DB_PORT || 13308,
    })
    assert.ok(ctx.hubDb,
        'ROLLCALL precondition FAILED: no hub database available. The three in-process hubs each create their ' +
        'own database and the platform user cannot, so this run needs Docker on the box to spin a throwaway ' +
        'MariaDB. Install Docker or export a HUB_DB_USER with CREATE DATABASE and re-run.')

    const { MultiValidatorHub } = require('./multiValidatorHubHelper')
    ctx.mvh = new MultiValidatorHub({
        count: o.hubCount || 3,
        identities: federationRoster().slice(0, o.hubCount || 3).map(r => ({ pubkeyHex: r.pubkey, privkeyHex: r.seed })),
        // RollcallRound is constructed inside XChainHub.startAttestation(), so
        // this is load-bearing rather than incidental.
        startAttestation: true,
        dbNamePrefix: (o.dbNamePrefix || 'XChain_BTC_Regtest_ROLLCALL_') + process.pid + '_',
    })
    await ctx.mvh.start()
    ctx.rounds = rollcallRounds(ctx.mvh)

    // The DOGE publish rail. Every ROLLCALL is a two-phase P2SH action and
    // transactionHelper drives exactly that pipeline, plus the native DOGE fee
    // output the chain requires. The only thing the wrapper adds is the regtest
    // block production a live chain supplies on its own.
    const cryptoHelper      = require('../cryptoHelper')
    const transactionHelper = require('../transactionHelper')
    ctx.dogePublisher = await chainRail.withRail(ctx.dogeRail, async () => {
        // seedGas=false, and it is load-bearing on DOGE. The default seeds the
        // new address with an XCHAIN gas MINT, but ROLLCALL carries NO protocol
        // fee (D33, the ANCHOR precedent) - a publish pays a native DOGE fee
        // output and nothing else, which is exactly why the venue's own anchor
        // publisher wallet holds only DOGE. Meanwhile a regtest DOGE chain need
        // not have XCHAIN issued at all, and when it does not the seeding MINT
        // comes back `invalid: TICK (unknown)` while waitForMint polls forever:
        // measured on the venue, the bring-up hung there with no error, which is
        // the worst shape a missing precondition can take.
        const addr = await cryptoHelper.getNewFundedAddress('rollcall-publisher', COIN, NETWORK, null, 'legacy', 0, 5.0, false)
        await regtestMinerConnector.generateBlocks(2)
        await utxoTrackerConnector.quiesce({ timeoutMs: 60000, pollMs: 250, regtestMiner: regtestMinerConnector })
        return addr
    })
    ctx.publishedWires = []
    setRollcallBroadcastHook(ctx.mvh, async (payload) => {
        return await chainRail.withRail(ctx.dogeRail, async () => {
            const txid = await transactionHelper.createAndSendTransaction(ctx.dogePublisher, payload)
            ctx.publishedWires.push({ payload, txid })
            await regtestMinerConnector.generateBlocks(1)
            await utxoTrackerConnector.quiesce({ timeoutMs: 60000, pollMs: 250, regtestMiner: regtestMinerConnector })
            return { txid }
        })
    })
    for (let i = 0; i < ctx.rounds.length; i++)
        assert.strictEqual(ctx.rounds[i].broadcastCapable(), true,
            'hub ' + i + ' must be broadcast-capable for this run; a hub that can only sign and gossip cannot ' +
            'publish, and the acceptance drives need a leader that lands its roll call')

    return ctx
}

async function tearDownVenue(ctx){
    if (ctx && ctx.mvh){ await ctx.mvh.stop(); await ctx.mvh.dropDatabases() }
    // After the hubs, never before: dropDatabases still needs the server, and
    // stop() also restores the HUB_DB_* env it overwrote, so leaving it out
    // poisons the next suite's resolution path with a dead port.
    if (ctx && ctx.hubDb){ await ctx.hubDb.stop() }
    delete process.env.DOGE_INDEXER_API_URL
    delete process.env.ROLLCALL_POLL_MS
    delete process.env.ROLLCALL_SIGN_LOG_PATH
    delete process.env.ROLLCALL_SPEND_LOG_PATH
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

// ── the drive ────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

// Mine BTC to `height` and wait for the indexer to reach it. A close block that
// DEFERS never arrives, so the timeout says that rather than reporting an
// anonymous stall: this is the single most likely way an unseeded or
// half-configured venue fails, and it must never look like a mystery.
async function mineBtcTo(ctx, height, label){
    let tip = await ctx.btcTip()
    while (tip < height){
        const need = Math.min(height - tip, 25)
        await regtestMinerConnector.generateBlocks(need)
        await utxoTrackerConnector.quiesce({ timeoutMs: 60000, pollMs: 250, regtestMiner: regtestMinerConnector })
        const deadline = Date.now() + 180000
        let seen = tip
        let nudged = 0
        while (Date.now() < deadline){
            seen = await ctx.btcTip()
            if (seen >= Math.min(height, tip + need)) break
            // A stalled tip whose NEXT block is a close is usually not a
            // misconfiguration, it is a one-second cadence race: the close needs
            // doge.tip_block_time > btc.block_time(E + W), and on regtest both
            // stamps are wall clock, so mining BTC past the window end in the
            // same instant as the last DOGE block leaves the DOGE side short by
            // as little as ONE SECOND (measured on the venue: doge tip 1788142312
            // against a window end of 1788142313). It is also how a FAILED drive
            // wedges the venue for every later run - the epoch's BTC side is
            // mined and its DOGE follow-up never happens, so the next run stalls
            // on someone else's half-driven epoch.
            //
            // Mining DOGE distinguishes the two cases instead of guessing: the
            // race clears, while a missing DOGE_INDEXER_API_URL or an unreadable
            // manifest still stalls and still fails below with its real message.
            if (rca().rollcallEpochClosingAt(seen + 1, ctx.network) !== null && nudged < 6){
                nudged++
                await mineDoge(ctx, 2)
            }
            await sleep(1500)
        }
        assert.ok(seen > tip,
            'the BTC indexer stopped advancing at ' + seen + ' while mining toward ' + height + ' (' + label + '). ' +
            'A ROLLCALL close that cannot prove its DOGE evidence throws RollcallProofUnavailableError and the ' +
            'block is retried forever. Check whether block ' + (seen + 1) + ' is a close height, whether the BTC ' +
            'indexer has DOGE_INDEXER_API_URL set, and whether the DOGE indexer reports a real manifest_hash.')
        tip = seen
    }
    return tip
}

async function mineDoge(ctx, n){
    return await chainRail.withRail(ctx.dogeRail, async () => {
        await regtestMinerConnector.generateBlocks(n)
        await utxoTrackerConnector.quiesce({ timeoutMs: 60000, pollMs: 250, regtestMiner: regtestMinerConnector })
        return Number((await indexerConnector.call('getblockhashes', {})).block_index)
    })
}

// ── BTC-side reads, straight against the real tables ─────────────────────────
//
// There is no JSON-RPC read for stakes, unstakes, delegations or validator
// rewards on origin/develop, so these go to the indexer database the suite is
// already connected to. That is also the stronger choice: a mocked database
// cannot fail on a wrong column name, and two such bugs shipped green this week.

async function rollcallRow(ctx, epoch){
    const rows = await ctx.idxQuery(
        'SELECT epoch_height, snapshot_block, close_block, rolled, responsible_set_json FROM rollcalls WHERE epoch_height = ?',
        [epoch])
    return rows.length ? rows[0] : null
}

async function absenceRows(ctx, epoch){
    return await ctx.idxQuery(
        `SELECT ra.epoch_height, ia.address AS source, ra.close_block, ra.evicted
           FROM rollcall_absences ra
           JOIN index_addresses ia ON ia.id = ra.source_id
          WHERE ra.epoch_height = ?
          ORDER BY ia.address ASC`, [epoch])
}

// The synthetic UNSTAKE rows an eviction mints: one per (source, signing key)
// with a sweepable balance, marked by action_format = 3.
async function evictionUnstakes(ctx, source){
    return await ctx.idxQuery(
        `SELECT u.action_index, u.cooldown_end_block, u.amount, u.block_index,
                p.pubkey  AS signing_pubkey, a.address AS source, st.status AS status
           FROM unstakes u
           JOIN actions       act ON act.action_index = u.action_index
           JOIN index_pubkeys    p ON p.id  = u.signing_pubkey_id
           JOIN index_addresses  a ON a.id  = u.source_id
           JOIN index_statuses  st ON st.id = u.status_id
          WHERE act.action_format = 3 AND a.address = ?
          ORDER BY u.action_index ASC`, [source])
}

async function stakeDeactivations(ctx, source){
    return await ctx.idxQuery(
        `SELECT p.pubkey AS signing_pubkey, s.deactivation_block AS deactivation_block, st.status AS status
           FROM stakes s
           JOIN index_addresses a ON a.id  = s.source_id
           JOIN index_pubkeys   p ON p.id  = s.signing_pubkey_id
           JOIN index_statuses st ON st.id = s.status_id
          WHERE a.address = ?
          ORDER BY s.action_index ASC`, [source])
}

async function delegationDeactivations(ctx, source){
    return await ctx.idxQuery(
        `SELECT d.action_index, d.deactivation_block AS deactivation_block
           FROM delegations d
           JOIN index_addresses a ON a.id = d.source_id
          WHERE a.address = ? ORDER BY d.action_index ASC`, [source])
}

async function rollcallRewards(ctx, epoch){
    return await ctx.idxQuery(
        `SELECT vr.amount, vr.block_index, vr.derive_block_index, vr.round_reference, vr.round_qualifier,
                ia.address AS source, ip.pubkey AS signing_pubkey
           FROM validator_rewards vr
           JOIN index_addresses ia ON ia.id = vr.source_id
           JOIN index_pubkeys   ip ON ip.id = vr.signing_pubkey_id
          WHERE vr.reward_type = 'rollcall_publish' AND vr.round_reference = ?`, [epoch])
}

// The exact arithmetic the COLLECT handler gates on (db.js getUnclaimedRewardTotal):
// everything minted for the source, less every VALID claim against it.
async function unclaimedRewardTotal(ctx, source, blockIndex){
    const rows = await ctx.idxQuery(
        `SELECT
            (SELECT COALESCE(SUM(CAST(vr.amount AS DECIMAL(65,18))), 0)
               FROM validator_rewards vr
               JOIN index_addresses a ON a.id = vr.source_id
              WHERE a.address = ? AND vr.block_index <= ?) AS minted,
            (SELECT COALESCE(SUM(CAST(rc.amount AS DECIMAL(65,18))), 0)
               FROM reward_claims rc
               JOIN index_addresses a2 ON a2.id = rc.source_id
               JOIN index_statuses  s  ON s.id  = rc.status_id
              WHERE a2.address = ? AND s.status = 'valid' AND rc.block_index <= ?) AS claimed`,
        [source, blockIndex, source, blockIndex])
    return Number(rows[0].minted) - Number(rows[0].claimed)
}

// The DOGE-side record of who was counted for an epoch: the raw signed material
// the BTC close re-verifies. Read from the DOGE indexer's own database so a
// column-name drift cannot pass.
async function dogeSigners(ctx, epoch){
    return await chainRail.withRail(ctx.dogeRail, async () => {
        const conn = await indexerDatabase.getConnection()
        try {
            return await conn.query(
                'SELECT pubkey, publisher, action_index, block_index, ledger_hash FROM rollcall_signers ' +
                'WHERE epoch_height = ? ORDER BY action_index ASC, pubkey ASC', [epoch])
        } finally { await conn.release() }
    })
}

/**
 * Drive one epoch from its first signable tick through its close.
 *
 * `opts.silentHubs`  hub indexes that must NOT sign this epoch. Their engine is
 *                    stopped before the round is created, so they neither sign
 *                    nor gossip, exactly as a stopped hub would not.
 * `opts.beforePublish` optional hook run after the signing tick and before the
 *                    publishing tick, so a suite can hold a signature back.
 * `opts.expectClose` when false, the epoch's close is NOT mined to and no
 *                    `rollcalls` row is awaited (the proof-barrier suite drives
 *                    the close itself).
 */
// Per-hub round state, printed on demand. Opt-in via XC_ROLLCALL_TRACE=1 so a
// normal run stays readable.
//
// WHY THIS EXISTS: when an epoch closes with fewer present sources than the hubs
// that signed, the log says only that a publish happened with N pairs, and every
// candidate explanation (gossip had not crossed the mesh, the rank ladder had
// not unlocked, the DOGE read was undecidable so a sweeper deferred, the elected
// leader was the hub the test silenced) produces the SAME single line. The
// engines already hold the answer; this prints it rather than making the next
// reader guess between four theories, which is what cost this lane a session.
async function traceRounds(ctx, label){
    if (process.env.XC_ROLLCALL_TRACE !== '1') return
    const tip = await ctx.btcTip()
    const rows = ctx.rounds.map((eng, i) => {
        const s = (eng && eng.getStatus && eng.getStatus()) || {}
        return '      hub ' + i + ' epoch=' + s.epoch + ' signed=' + s.signed +
               ' gossiped=' + s.gossiped_count + ' onchain=' + s.on_chain_count +
               ' rank=' + s.our_rank + ' leader=' + String(s.leader || '').slice(0, 12) +
               ' txids=' + (Array.isArray(s.txids) ? s.txids.length : 0)
    })
    console.log('    [trace] ' + label + ' (btc tip ' + tip + ', since=' + (tip - Number(ctx._traceEpoch || 0)) + ')')
    for (const r of rows) console.log(r)
}

// The rank ladder climbs with BTC HEIGHT, so a publish phase that ticks at a
// fixed height cannot exercise it.
//
// Measured on the venue: with hub 2 silenced, the elected LEADER was hub 2
// (rank 0, never publishes), the hub holding BOTH signatures was rank 3, and the
// only unlocked hub held just its own. _rankUnlocked allows rank <= floor(since /
// ELECTION_TOLERANCE), so at since = 6 with a regtest tolerance of 3 only ranks
// 0..2 can ever publish - and every tick happened at since = 6. One signature
// reached the chain, the epoch closed UNROLLED at present 1/4, and it read as a
// protocol failure when it was the harness holding the chain still.
//
// So mine FORWARD through the publish phase, which is also what a real venue
// does, and stop as soon as the DOGE side actually holds every signature we
// expect rather than after a fixed number of ticks.
function electionTolerance(network){
    const mod = require(_resolveSibling('xchain-hub', 'src/RollcallRound.js'))
    const t = mod.ELECTION_TOLERANCE_DEFAULTS && mod.ELECTION_TOLERANCE_DEFAULTS[network]
    assert.ok(Number.isFinite(Number(t)) && Number(t) > 0,
        'cannot read ELECTION_TOLERANCE_DEFAULTS.' + network + ' from the shipped RollcallRound; the ladder ' +
        'arithmetic here must come from the engine rather than be re-derived')
    return Number(t)
}

// Which pubkeys the DOGE side already carries for this epoch.
async function onChainSigners(ctx, epoch, pubkeys){
    const res = await ctx.dogeRail.globals.indexerConnector.call('getrollcallsigners', {
        network: ctx.network, epoch_height: epoch, max_block_time: 9999999999,
        pubkeys: pubkeys, publishers: [],
    })
    if (!res || res.error) return new Set()
    // The read echoes EVERY pubkey it was asked about and puts null against the
    // ones it has no signature for, so Object.keys() counts absences as
    // presences. Measured: a bounded ask for three keys with one on chain comes
    // back as three keys, two of them null - and taking the key list made this
    // helper report full coverage after a single publish, which ended the ladder
    // climb before it began.
    return new Set(Object.entries(res.signers || {})
        .filter(([, v]) => v && v.sig)
        .map(([k]) => String(k).toLowerCase()))
}

async function driveEpoch(ctx, epoch, opts){
    const o = opts || {}
    const silentHubs = o.silentHubs || []
    const network    = ctx.network
    const closeBlock = closeHeightOf(epoch, network)
    const windowEnd  = rca().rollcallWindowEndHeight(epoch, network)
    console.log('    epoch ' + epoch + ': window end ' + windowEnd + ', close ' + closeBlock +
                (silentHubs.length ? ', silent hub(s) ' + silentHubs.join(',') : ''))

    for (const i of silentHubs) await ctx.rounds[i].stop()

    // A round exists only once the epoch block is buried by
    // CANONICAL_REORG_BUFFER (RollcallRound.newestSignableEpoch), so mine past
    // it before the first tick or every engine skips the epoch entirely.
    await mineBtcTo(ctx, epoch + 6, 'burying epoch ' + epoch)

    const want = ctx.rounds.length - silentHubs.length
    ctx._traceEpoch = epoch
    const gossiped = await waitForGossip(ctx.mvh, epoch, want, 120000, silentHubs)
    await traceRounds(ctx, 'after gossip')
    assert.ok(gossiped >= want,
        'epoch ' + epoch + ': expected ' + want + ' gossiped signature(s) across the mesh, saw ' + gossiped +
        '. Every hub signs regardless of whether it can publish, so a short count is a signing or gossip ' +
        'failure, not a publish failure.')

    if (typeof o.beforePublish === 'function') await o.beforePublish()

    // Climb the rank ladder instead of ticking in place. Each round: tick (any
    // newly unlocked rank publishes), let DOGE bury it, tick again so the
    // engines see it on chain, then advance BTC by one tolerance step so the
    // next rank unlocks. Stops as soon as every expected signature is on chain.
    const tolerance = electionTolerance(ctx.network)
    const wantKeys  = ctx.roster.slice(0, ctx.rounds.length)
        .filter((_, i) => !silentHubs.map(Number).includes(i))
        .map(r => r.pubkey)
    for (let round = 0; ; round++){
        await tickAll(ctx.mvh, silentHubs)
        await mineDoge(ctx, 3)
        await tickAll(ctx.mvh, silentHubs)
        await traceRounds(ctx, 'publish round ' + round)

        const on = await onChainSigners(ctx, epoch, wantKeys)
        const missing = wantKeys.filter(k => !on.has(k))
        if (missing.length === 0){
            console.log('    epoch ' + epoch + ': all ' + wantKeys.length + ' expected signature(s) on chain')
            break
        }
        const tip = await ctx.btcTip()
        if (tip + tolerance > windowEnd){
            console.log('    epoch ' + epoch + ': window end reached with ' + missing.length +
                        ' signature(s) still off chain (' + missing.map(k => k.slice(0, 12)).join(', ') + ')')
            break
        }
        await mineBtcTo(ctx, tip + tolerance, 'unlocking the next rank for epoch ' + epoch)
    }

    if (typeof o.afterPublish === 'function') await o.afterPublish()

    // The window-end block_time is the cut basis and must exist as a STORED
    // header stamp before the close reads it.
    await mineBtcTo(ctx, windowEnd, 'window end for epoch ' + epoch)

    if (o.expectClose === false) return { closeBlock, windowEnd }

    // The DOGE side must then pass that stamp and bury the cut by
    // ROLLCALL_DOGE_MATURITY. DOGE is mined AFTER the BTC window end so its
    // header stamps are strictly later than the cut basis.
    await mineDoge(ctx, 2 + Number(rca().ROLLCALL_DOGE_MATURITY[network]) + 2)
    await mineBtcTo(ctx, closeBlock, 'close of epoch ' + epoch)

    const deadline = Date.now() + 180000
    let row = null
    while (Date.now() < deadline){
        row = await rollcallRow(ctx, epoch)
        if (row) break
        await sleep(2000)
    }
    assert.ok(row,
        'epoch ' + epoch + ' wrote no `rollcalls` row even though the BTC indexer reached its close block ' +
        closeBlock + '. The close writes a row on every path it can reach, including the unrolled ones, so no ' +
        'row means the close never ran on this indexer.')

    for (const i of silentHubs) await ctx.rounds[i].start()
    return row
}

module.exports = {
    SIGNING_SEEDS,
    federationSeeds,
    IDLE_SEED_INDEX,
    sleep,
    mineBtcTo,
    mineDoge,
    driveEpoch,
    rollcallRow,
    absenceRows,
    evictionUnstakes,
    stakeDeactivations,
    delegationDeactivations,
    rollcallRewards,
    unclaimedRewardTotal,
    dogeSigners,
    bringUpVenue,
    tearDownVenue,
    assertOutageStillRolls,
    assertOutageFallsBelowThreshold,
    federationRoster,
    pubkeyForSeed,
    signCanonical,
    canonical,
    buildWire,
    assertFrozenCanonicalVector,
    rca,
    eqh,
    frozenVector,
    closeHeightOf,
    epochsAfter,
    requireRollcallVenue,
    assertBtcRail,
    assertRegtestConstants,
    assertGatedReadsReachable,
    assertOraclePublishFederation,
    assertDogePeerManifest,
    assertBtcProofWiring,
    probePublicRollcallReads,
    assertPublicRollcallRead,
    openDogeRail,
    rollcallRounds,
    setRollcallBroadcastHook,
    tickAll,
    waitForGossip,
}
