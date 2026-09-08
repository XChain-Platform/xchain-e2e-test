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
 * USAGE, on a venue whose attestation capability is EMPTY:
 *
 *   E2E_STAKE_TEARDOWN=off npx mocha --timeout 0 --exit \
 *     --require ./test/initialCheck.test.js \
 *     test/tools/reseedAttestationRoster.test.js
 *
 * Env: RESEED_COUNT (default 5), RESEED_STAKE_XCHAIN (default 50000, which
 * clears both ProviderRegistry floors: http_get 10000, llm 25000),
 * RESEED_GAS_XCHAIN (default 60000, which must exceed the stake plus its fee).
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

        // ── REFUSE ON A NON-EMPTY SET ────────────────────────────────────────
        const before = await readSeatedOrEmpty()
        assert.strictEqual(before.set.pubkeys.length, 0,
            'reseedAttestationRoster: the attestation set at buried block ' + before.buriedBlock +
            ' already seats ' + before.set.pubkeys.length + ' validator(s): ' +
            before.set.pubkeys.map((p) => p.slice(0, 16)).join(', ') + '.\n' +
            'This tool seeds an EMPTY set only. Staking into a set that already exists is the ' +
            'dilution fc52bcc removed the old prologue for: the responsible set is drawn from every ' +
            'staked validator and ranked by hash, so these stakes would not displace what is there, ' +
            'they would be drawn alongside it. Reset the chain first, or adopt the roster as it is.')

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

        const candidates = [...known.entries()].filter(([pk]) => !reserved.has(pk.toLowerCase()))
        const excluded = known.size - candidates.length
        if (excluded > 0)
            console.log('reseedAttestationRoster: reserved ' + excluded + ' roll-call roster key(s), ' +
                'which this tool must never spend: those four entries are fixed and have no ' +
                'alternatives, while this tool can use any derivable key')

        assert.ok(candidates.length >= RESEED_SKIP + RESEED_COUNT,
            'reseedAttestationRoster: only ' + candidates.length + ' derivable key(s) remain after ' +
            'reserving the roll-call roster, but ' + RESEED_COUNT + ' were asked for after skipping ' +
            RESEED_SKIP + '.')

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
        const want = new Set(staked.map((s) => s.pubkeyHex.toLowerCase()))
        let after = null
        for (let round = 0; round < VISIBILITY_ROUNDS; round++) {
            await regtestMinerConnector.generateBlocks(
                Number(stakeHelper.ATTESTATION_STAKE_VISIBLE_BLOCKS))
            await fixture.settleStack()
            after = await readSeatedOrEmpty()
            const seatedNow = new Set(after.set.pubkeys.map((p) => p.toLowerCase()))
            if (seatedNow.size === want.size && [...want].every((p) => seatedNow.has(p))) break
            console.log('reseedAttestationRoster: round ' + (round + 1) + '/' + VISIBILITY_ROUNDS +
                ': ' + seatedNow.size + '/' + want.size + ' visible at buried block ' +
                after.buriedBlock + ', mining on')
        }

        const seated = new Set(after.set.pubkeys.map((p) => p.toLowerCase()))
        assert.deepStrictEqual([...seated].sort(), [...want].sort(),
            'reseedAttestationRoster: after ' + VISIBILITY_ROUNDS + ' rounds the seated set at ' +
            'buried block ' + after.buriedBlock + ' is still not the set that was staked. Seated: ' +
            [...seated].map((p) => p.slice(0, 16)).join(', ') + '; staked: ' +
            [...want].map((p) => p.slice(0, 16)).join(', ') + '. A stake that never becomes visible ' +
            'is a chain or indexer problem, not a timing one.')

        // Adoptability is the actual goal, so assert it through the same
        // function the drills use rather than re-deriving the answer here.
        const readopt = fixture._knownSignerSeeds()
        const orphans = after.set.pubkeys.filter((pk) => !readopt.get(pk))
        assert.deepStrictEqual(orphans, [],
            'reseedAttestationRoster: seeded a roster this harness still cannot sign for: ' +
            orphans.map((p) => p.slice(0, 16)).join(', '))

        console.log('reseedAttestationRoster: seated ' + after.set.pubkeys.length + ' validator(s) ' +
            'at buried block ' + after.buriedBlock + ' (tip ' + after.tipBlock + '), every one ' +
            'adoptable: ' + staked.map((s) => s.pubkeyHex.slice(0, 16) + ' via ' + s.origin).join('; '))
    })
})
