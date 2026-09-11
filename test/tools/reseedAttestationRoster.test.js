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

/********************************************************************
 * SEED THE ATTESTATION ROSTER ON A FRESHLY RESET REGTEST CHAIN.
 *
 * A venue seeder, not a drill, and it lives beside
 * `rollcallSeedFederation.test.js` for the same reason: it exists to LEAVE
 * stake behind, which is the opposite of what every suite under `test/`
 * does. Run it once after a chain reset; every attestation drill assumes it
 * already has.
 *
 * WHY THIS EXISTS. `mirrorDrillFixture.provisionDrillIdentities` adopts the
 * seated roster and stakes nothing, so on an empty set there is nothing to
 * adopt and it refuses at the provider floor rather than the orphan check.
 * The seeding has to come from somewhere. Before fc52bcc it came from a
 * per-run prologue that staked five FRESH identities, and that prologue was
 * removed on a ruling that still holds:
 *
 *   the responsible set is drawn from EVERY staked validator carrying the
 *   attestation capability and ranked by hash, with stake acting only as a
 *   pre-filter, so a new stake never buys selection priority and only
 *   dilutes the pool with keys whose hubs are not in this mesh.
 *
 * This is NOT that prologue restored, and the difference is the guard below.
 * Staking into a roster that already exists is the diluting move fc52bcc
 * banned. Staking onto an EMPTY one is the only way a roster comes to exist
 * at all, and drawing the identities from `_knownSignerSeeds()` makes the
 * result adoptable by construction, because the seeding source and the
 * adoption check are then the same function.
 *
 * WHY THE KEYS COME FROM `_knownSignerSeeds()`. The failure this tool was
 * written for was a roster seeded with `ValidatorIdentity.generate()` keys:
 * random ed25519, never persisted, gone the moment the test process exited.
 * Five of those sat in the shared BTC regtest attestation set and could be
 * neither signed for nor unstaked, because no staker mnemonic had been
 * recorded for them either, so the only way out was a chain reset. Seeding
 * from seeds the harness can derive, and recording every staker key BEFORE
 * broadcast, is what stops that recurring.
 *
 * TEARDOWN MUST BE OFF, and this file refuses to run otherwise. Under the
 * default policy the root afterAll releases every stake a run created, so a
 * seeder without the hatch silently undoes itself: it stakes five keys, the
 * suite reports a failure or a pass, and the venue is empty again. That is
 * not hypothetical, it is what the first version of this file did. The hatch
 * is documented in
 * xchain-documentation/components/e2e-test/staking-venue-policy.md.
 *
 * SEEDING BESIDE A NAMED KEY, `RESEED_ALLOW_SEATED`, and why the empty-set rule
 * did not simply get relaxed. The BTC regtest chain re-genesised on 2026-09-08
 * came back seating exactly one attestation key, which is the STANDING hub's own
 * identity: its seed lives in that hub's container, so nothing here can derive
 * it, and a venue hub running the same key beside the live one would equivocate
 * and get the real validator slashed. So it can be neither adopted nor unstaked
 * by this lane, and a tool that refuses any non-empty set refuses that chain
 * forever. What the hatch does NOT do is relax the rule: every seated key must
 * still be accounted for, either as one `_knownSignerSeeds()` derives or as one
 * the operator NAMED, and any other seated key refuses exactly as before. Naming
 * it is the point: an unnamed stranger in the set is still the dilution fc52bcc
 * banned, and a blanket "allow whatever is there" would readmit it.
 *
 * USAGE, on a venue whose attestation capability is EMPTY:
 *
 *   E2E_STAKE_TEARDOWN=off npx mocha --timeout 0 --exit \
 *     --require ./test/initialCheck.test.js \
 *     test/tools/reseedAttestationRoster.test.js
 *
 * Env: RESEED_COUNT (default 5), RESEED_STAKE_XCHAIN (default 50000, which
 * clears both ProviderRegistry floors: http_get 10000, llm 25000),
 * RESEED_GAS_XCHAIN (default 60000, which must exceed the stake plus its fee),
 * RESEED_ALLOW_SEATED (comma-separated pubkey hex prefixes, at least 16 hex
 * characters each, naming seated keys this run may seed beside).
 ********************************************************************/

const assert = require('assert')

const cryptoHelper  = require('../cryptoHelper')
const stakeHelper   = require('../helpers/stakeHelper')
const gasHelper     = require('../helpers/gasHelper')
const stakeTeardown = require('../helpers/stakeTeardown')
const { loadHubModule } = require('../helpers/multiValidatorHubHelper')
const fixture       = require('../attestMirror/mirrorDrillFixture')

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
module.exports = { classifySeatedForReseed, ALLOW_PREFIX_MIN_HEX }

describe('seed the attestation roster on a reset chain', function () {
    this.timeout(0)

    it('stakes a roster the harness can sign for, onto an empty set', async () => {
        // ── THE HATCH MUST BE OPEN ───────────────────────────────────────────
        //
        // Checked through the policy resolver rather than by reading the env
        // here, so this agrees with the teardown by construction instead of by
        // a second reading of the same variable.
        const pol = stakeTeardown.policy(process.env)
        assert.strictEqual(pol.release, false,
            'reseedAttestationRoster: stake teardown is ACTIVE (' + pol.reason + '), so every stake ' +
            'this tool creates would be released by the root afterAll and the venue would end up ' +
            'exactly as empty as it started, with a log full of successful stakes. Re-run with ' +
            'E2E_STAKE_TEARDOWN=off, which is the dedicated-staking-venue hatch documented in ' +
            'xchain-documentation/components/e2e-test/staking-venue-policy.md.')

        const known = fixture._knownSignerSeeds()
        assert.ok(known.size >= RESEED_SKIP + RESEED_COUNT,
            'reseedAttestationRoster: the harness can derive ' + known.size + ' signing key(s), but ' +
            RESEED_COUNT + ' were asked for after skipping ' + RESEED_SKIP + '. Seeding a key this ' +
            'harness cannot derive recreates the exact orphan the reset was for. Set ' +
            'XC_ROLLCALL_FEDERATION_MNEMONIC to widen the pool (it contributes the idle generations, ' +
            'which are most of it), lower RESEED_COUNT, or lower RESEED_SKIP.')

        // ── REFUSE ON AN UNACCOUNTED SEATED KEY ──────────────────────────────
        const before = await readSeatedOrEmpty()
        const split  = classifySeatedForReseed(before.set.pubkeys, known, RESEED_ALLOW_SEATED)
        assert.deepStrictEqual(split.blocking, [],
            'reseedAttestationRoster: the attestation set at buried block ' + before.buriedBlock +
            ' seats ' + split.blocking.length + ' validator(s) this run cannot account for: ' +
            split.blocking.map((p) => p.slice(0, 16)).join(', ') + '.\n' +
            'This tool seeds beside keys it can DERIVE or that the operator NAMED, and nothing else. ' +
            'Staking beside an unaccounted key is the dilution fc52bcc removed the old prologue for: ' +
            'the responsible set is drawn from every staked validator and ranked by hash, so these ' +
            'stakes would not displace what is there, they would be drawn alongside it and every draw ' +
            'containing it would stall to timeout.\n' +
            'Reset the chain, have the owning lane unstake it, or, if it is a validator this venue ' +
            'must run BESIDE rather than impersonate, name it in RESEED_ALLOW_SEATED (at least ' +
            ALLOW_PREFIX_MIN_HEX + ' hex characters) and scope the drills to providers whose stake ' +
            'floor it misses.')
        if (split.derivable.length || split.allowed.length) {
            console.log('reseedAttestationRoster: seeding BESIDE ' +
                split.derivable.length + ' derivable seated key(s) [' +
                split.derivable.map((p) => p.slice(0, 16)).join(', ') + '] and ' +
                split.allowed.length + ' operator-named key(s) [' +
                split.allowed.map((p) => p.slice(0, 16)).join(', ') +
                ']. A named key is one nothing here can sign for, so it counts as a set member on ' +
                'every draw and every batch window while signing none of them.')
        }

        // ── NEVER SPEND A ROLL-CALL ROSTER KEY ───────────────────────────────
        //
        // `_knownSignerSeeds()` and `rollcallHelper.federationRoster()` draw from
        // the SAME pool: the three fixed federation signing seeds and the idle
        // generations. But the roll-call roster is FOUR FIXED ENTRIES with no
        // alternatives, while this tool can use any derivable key at all. So a
        // collision costs the roll-call venue everything and costs this tool
        // nothing, because a signing key retires permanently (see RESEED_SKIP).
        //
        // That is not a hypothetical trade-off. A swept seeding run on this
        // chain spent all four roll-call roster keys before this guard existed,
        // and `npm run venue:seed-rollcall` can never succeed there again: not
        // for ZC7, and not for the AT1-AT5 acceptance suites that venue exists
        // for. Excluding them here is the difference between one tool failing
        // and a whole venue becoming unbuildable.
        const rollcall = require('../helpers/rollcallHelper')
        const reserved = new Set()
        try {
            for (const entry of rollcall.federationRoster())
                reserved.add(String(entry.pubkey).toLowerCase())
        } catch (err) {
            // A venue with no federation configured has no roster to protect.
            console.log('reseedAttestationRoster: no roll-call roster to reserve (' + err.message + ')')
        }

        // AND NEVER RE-SPEND A KEY THIS CHAIN ALREADY SEATS. `stake.js` admits a v1
        // STAKE only when `getActiveStakeByPubkey(pk, null)` finds no valid row at
        // any height, so a derivable key that is already in the set is refused
        // outright, and the run dies on `invalid: SIGNING_PUBKEY (already in use)`
        // partway through with some stakes placed and some not. It could not happen
        // while this tool refused every non-empty set; seeding BESIDE a set is
        // exactly when it can.
        const alreadySeated = new Set(split.derivable)
        const candidates = [...known.entries()]
            .filter(([pk]) => !reserved.has(pk.toLowerCase()) && !alreadySeated.has(pk.toLowerCase()))
        const excluded = known.size - candidates.length
        if (excluded > 0)
            console.log('reseedAttestationRoster: set aside ' + excluded + ' derivable key(s): the ' +
                'roll-call roster (fixed four entries with no alternatives, while this tool can use ' +
                'any derivable key) and any key this chain already seats')

        assert.ok(candidates.length >= RESEED_SKIP + RESEED_COUNT,
            'reseedAttestationRoster: only ' + candidates.length + ' derivable key(s) remain after ' +
            'reserving the roll-call roster and the keys already seated, but ' + RESEED_COUNT +
            ' were asked for after skipping ' + RESEED_SKIP + '.')

        const picked = candidates.slice(RESEED_SKIP, RESEED_SKIP + RESEED_COUNT)
        const staked = []

        if (RESEED_SKIP > 0) {
            console.log('reseedAttestationRoster: skipping ' + RESEED_SKIP + ' derivable key(s) as ' +
                'already spent on this chain: ' +
                candidates.slice(0, RESEED_SKIP)
                    .map(([pk, hit]) => pk.slice(0, 16) + ' (' + hit.origin + ')').join(', '))
        }
        console.log('reseedAttestationRoster: seeding with ' +
            picked.map(([pk, hit]) => pk.slice(0, 16) + ' (' + hit.origin + ')').join(', '))

        for (let i = 0; i < picked.length; i++) {
            const [pubkeyHex, hit] = picked[i]
            const stakerLabel = 'reseed-staker-' + i

            // A SEPARATE SOURCE ADDRESS PER STAKE. Stake weight is per source,
            // so one address staking five times is not the same roster as five
            // addresses staking once, and the provider floor is applied per
            // member against that per-source weight.
            //
            // Wrapped for the roll-call wedge because the funding call seeds gas
            // INTERNALLY, so the mint that dies is one level below the explicit
            // one after it. Retry is safe: the wallet is cached by label, so a
            // second attempt funds the SAME address rather than minting a new
            // identity.
            const addr = await fixture.withWedgeClear('funding and gas seed for ' + stakerLabel,
                () => cryptoHelper.getNewFundedAddress(
                    stakerLabel, COIN, NETWORK, null, 'legacy', 0, 0.02))

            // Recorded BEFORE the stake is broadcast, never after. A key
            // recorded after a successful stake is exactly the key you do not
            // have when the stake succeeded and the process then died, which is
            // how the unrecoverable keys on the old chain came to exist.
            const wallet = await cryptoHelper.getWallet(stakerLabel)
            fixture.recordStakerKey('reseed', {
                staker: stakerLabel,
                address: addr.address,
                signingPubkey: pubkeyHex,
                mnemonic: wallet && wallet.mnemonic,
                stakedAt: new Date().toISOString(),
            })

            await fixture.settleStack()
            await fixture.withWedgeClear('gas mint for ' + stakerLabel,
                () => gasHelper.ensureGasBalance(addr, RESEED_GAS_XCHAIN))
            await fixture.settleStack()

            // CLEARED BEFORE, NOT WRAPPED AROUND: sendStakeV1 broadcasts and
            // then waits, so a retry would double-stake this identity.
            await fixture.clearWedgeBefore('stake ' + i + ' for reseed')
            const result = await stakeHelper.sendStakeV1(addr, RESEED_STAKE_XCHAIN, pubkeyHex)
            assert.strictEqual(result.stake.status, 'valid',
                'reseedAttestationRoster: stake ' + i + ' came back ' + result.stake.status +
                ' rather than valid; a venue built on it would have a short responsible set')

            staked.push({ pubkeyHex: pubkeyHex, origin: hit.origin, address: addr.address })
            console.log('reseedAttestationRoster: staked ' + pubkeyHex.slice(0, 16) + ' (' +
                hit.origin + ') from ' + addr.address + ' for ' + RESEED_STAKE_XCHAIN + ' XCHAIN')
        }

        // ── mine until the WHOLE set is visible at the buried height ─────────
        //
        // Waiting on the condition itself rather than on a block count. Each
        // stake becomes effective a fixed distance from ITS OWN block and the
        // read is taken a reorg buffer below the tip, so the number of blocks
        // this needs depends on how far apart the stakes landed, which depends
        // on how long the funding and minting took. That is not knowable up
        // front, and guessing it is what made the first run report a set of two.
        // EVERY STAKED KEY VISIBLE, and the keys that were already there still
        // there. Written as a containment rather than an equality because the set
        // is no longer required to be exactly what this run staked: the accounted
        // keys from before the run stay seated by design, and an equality would
        // fail on precisely the case the hatch exists for.
        const want = new Set(staked.map((s) => s.pubkeyHex.toLowerCase()))
        let after = null
        for (let round = 0; round < VISIBILITY_ROUNDS; round++) {
            await regtestMinerConnector.generateBlocks(
                Number(stakeHelper.ATTESTATION_STAKE_VISIBLE_BLOCKS))
            await fixture.settleStack()
            after = await readSeatedOrEmpty()
            const seatedNow = new Set(after.set.pubkeys.map((p) => p.toLowerCase()))
            if ([...want].every((p) => seatedNow.has(p))) break
            console.log('reseedAttestationRoster: round ' + (round + 1) + '/' + VISIBILITY_ROUNDS +
                ': ' + [...want].filter((p) => seatedNow.has(p)).length + '/' + want.size +
                ' visible at buried block ' + after.buriedBlock + ', mining on')
        }

        const seated  = new Set(after.set.pubkeys.map((p) => p.toLowerCase()))
        const missing = [...want].filter((p) => !seated.has(p))
        assert.deepStrictEqual(missing, [],
            'reseedAttestationRoster: after ' + VISIBILITY_ROUNDS + ' rounds ' + missing.length +
            ' staked key(s) are still not visible at buried block ' + after.buriedBlock + ': ' +
            missing.map((p) => p.slice(0, 16)).join(', ') + '. Seated: ' +
            [...seated].map((p) => p.slice(0, 16)).join(', ') + '. A stake that never becomes visible ' +
            'is a chain or indexer problem, not a timing one.')

        // NOTHING UNACCOUNTED ARRIVED WHILE THIS RAN, judged by the same rule the
        // opening guard used. The roster activates on a delay, so a stake made
        // before this run can seat DURING it, and a key that lands here unnoticed
        // is the orphan every drill would then refuse on.
        const closing = classifySeatedForReseed(after.set.pubkeys, fixture._knownSignerSeeds(),
            RESEED_ALLOW_SEATED)
        assert.deepStrictEqual(closing.blocking, [],
            'reseedAttestationRoster: the set now seats ' + closing.blocking.length + ' key(s) this ' +
            'run cannot account for: ' + closing.blocking.map((p) => p.slice(0, 16)).join(', ') +
            '. Either one seated while this ran, or a key this tool staked is not derivable, and ' +
            'either way every draw containing it stalls its round to timeout.')

        console.log('reseedAttestationRoster: seated ' + after.set.pubkeys.length + ' validator(s) ' +
            'at buried block ' + after.buriedBlock + ' (tip ' + after.tipBlock + '): ' +
            closing.derivable.length + ' adoptable [' +
            staked.map((s) => s.pubkeyHex.slice(0, 16) + ' via ' + s.origin).join('; ') + '] and ' +
            closing.allowed.length + ' operator-named [' +
            closing.allowed.map((p) => p.slice(0, 16)).join(', ') + ']')
    })
})
