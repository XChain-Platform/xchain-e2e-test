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

const {
    assert, cryptoHelper, stakeHelper, gasHelper, stakeTeardown, fixture,
    RESEED_COUNT, RESEED_STAKE_XCHAIN, RESEED_GAS_XCHAIN, RESEED_ALLOW_SEATED,
    ALLOW_PREFIX_MIN_HEX, RESEED_SKIP, VISIBILITY_ROUNDS, readSeatedOrEmpty,
    classifySeatedForReseed,
} = require('./helpers/reseed_attestation_roster')

async function prepareRoster () {
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

    return { known, split }
}

function chooseRoster ({ known, split }) {
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
    const rollcall = require('../../helpers/rollcallHelper')
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

    if (RESEED_SKIP > 0) {
        console.log('reseedAttestationRoster: skipping ' + RESEED_SKIP + ' derivable key(s) as ' +
            'already spent on this chain: ' +
            candidates.slice(0, RESEED_SKIP)
                .map(([pk, hit]) => pk.slice(0, 16) + ' (' + hit.origin + ')').join(', '))
    }
    console.log('reseedAttestationRoster: seeding with ' +
        picked.map(([pk, hit]) => pk.slice(0, 16) + ' (' + hit.origin + ')').join(', '))
    return { known, split, picked }
}

async function stakeRoster ({ known, split, picked }) {
    const staked = []
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
    return { known, split, picked, staked }
}

async function waitForRoster ({ known, split, picked, staked }) {
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
    return { known, split, picked, staked, after }
}

function verifyClosingRoster ({ staked, after }) {
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
}

async function runReseed () {
    const prepared = await prepareRoster()
    const chosen = chooseRoster(prepared)
    const staked = await stakeRoster(chosen)
    const visible = await waitForRoster(staked)
    verifyClosingRoster(visible)
}

describe('seed the attestation roster on a reset chain', function () {
    this.timeout(0)

    it('stakes a roster the harness can sign for, onto an empty set', async () => {
        await runReseed()
    })
})
