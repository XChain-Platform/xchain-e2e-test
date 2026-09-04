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
 * VENUE TOOL, not an acceptance test: seed the four-source ROLLCALL
 * federation the acceptance suites assert against.
 *
 * It lives under test/tools/ rather than test/actions/ deliberately. The
 * default `npm test` glob is test/actions/**, so a seeding run that mints,
 * stakes and mutates the venue can never join an ordinary suite run by
 * accident. Run it explicitly:
 *
 *   XC_ROLLCALL_FEDERATION_MNEMONIC="<twelve words>" \
 *     npx mocha --timeout 0 --exit --require ./test/initialCheck.test.js \
 *     test/tools/rollcallSeedFederation.test.js
 *
 * WHY A MOCHA FILE AND NOT A PLAIN SCRIPT. Every helper this needs
 * (cryptoHelper's funded-address path, gasHelper's faucet MINT,
 * stakeHelper's two-phase P2SH STAKE) reads the globals that
 * test/initialCheck.test.js installs. Re-deriving that bootstrap in a
 * standalone script would give the venue a second, subtly different client
 * of the same chain, which is exactly the divergence
 * claude/scripts/regtest-gas-bootstrap.js's header warns about.
 *
 * WHAT IT SEEDS, and why these numbers.
 *
 * The roster is rollcallHelper's four Ed25519 keys: hubs 0-2 sign from FIXED
 * seeds (they are the frozen vector's own signers), and the fourth is the
 * IDLE staker AT1 watches the protocol evict. That fourth key is PER-VENUE,
 * derived from this mnemonic and XC_ROLLCALL_IDLE_GENERATION, because an
 * eviction retires a signing key permanently and a fixed one would
 * let a venue run AT1 exactly once. Each is staked from a DISTINCT source
 * address, because absence, the K-streak and eviction are all pinned per
 * staking SOURCE.
 *
 * TO RE-RUN AT1 ON AN ALREADY-EVICTED VENUE: bump XC_ROLLCALL_IDLE_GENERATION
 * and run this tool again. It stakes a fresh idle key from a fresh source
 * address (both move with the generation) and leaves the three signing sources
 * untouched, because it has no choice: STAKE v1 refuses a pubkey that has ever
 * been staked, from any source, so a frozen signing key's address is fixed for
 * the life of the chain. A signing source carrying a stale absence is cleared by
 * driving 2K rolled epochs with that hub present, or by a fresh chain; a signing
 * key that was EVICTED leaves only the fresh chain.
 *
 * The weights are 40/40/10/10 rather than equal, and that is load-bearing
 * rather than cosmetic. Quorum is `3 * present > 2 * total` by source
 * weight. On an equal-weight federation, AT2's one-hub outage leaves the
 * present side at exactly 50%, the epoch closes UNROLLED, it counts for
 * nobody, and "absent then present, and never evicted" is satisfied
 * vacuously instead of demonstrated. At 40/40/10/10 the same outage leaves
 * 80 of 100 present and the epoch rolls, which is the only way that test
 * measures anything. AT6's below-threshold leg needs the mirror property
 * and gets it: silencing both 40s leaves 10 of 100.
 *
 * The addresses are derived from a mnemonic the caller supplies, at address
 * index i for roster entry i (the idle entry at 3 + XC_ROLLCALL_IDLE_GENERATION),
 * matching what rollcallHelper's
 * XC_ROLLCALL_FEDERATION_MNEMONIC branch derives. Hand the same mnemonic to
 * the acceptance run and it holds the sources' keys, which is what lets AT10
 * drive a real COLLECT rather than only asserting the arithmetic behind one.
 * The mnemonic is a spending credential for this venue: it is never printed
 * here, only the addresses it derives.
 *
 * RE-RUNNING IS SAFE. Every leg checks the chain first: an address that
 * already holds enough XCHAIN is not re-minted, and a source whose roster
 * key is already staked and effective is left alone. That matters because a
 * partial seed is the normal failure mode (a funding tx that never
 * confirmed, a mint that raced the utxo tracker) and the fix must be to run
 * it again, not to unpick what landed.
 ********************************************************************/

const assert = require('assert')

const cryptoHelper = require('../cryptoHelper')
const gasHelper    = require('../helpers/gasHelper')
const stakeHelper  = require('../helpers/stakeHelper')
const rc           = require('../helpers/rollcallHelper')

// Stake per roster index, in whole XCHAIN. See the header for why they are
// not equal. Kept here rather than in rollcallHelper because the harness
// asserts on the DISTRIBUTION it finds on chain, never on the numbers a
// seeding run happened to choose; a venue seeded 400/400/100/100 satisfies
// the same suites.
// The ratio is 12:1 rather than the original 4:1, and the absolute numbers are
// large, because a SHARED regtest venue is never empty. Quorum is measured
// against the weight of every staked oracle_publish source, including fixture
// stakes from other lanes' runs that were never torn down, and whose source
// keys nobody holds (the fixture path derives each source from a mnemonic
// generated per run, so an orphan cannot be unstaked). Measured on the venue
// 2026-09-03: four such sources holding 70000 between them.
//
// Two inequalities have to hold, with F for the outsider weight, A for a large
// signing source and B for the small signing source and the idle one:
//   an ordinary all-present epoch rolls when  2A > B + 2F
//   AT2's outage of the small signing hub rolls when  A > 2B + F
// At 300000/300000/25000/25000 the second one, which is the tighter, tolerates
// F up to 250000 - about fifteen more orphan fixture stakes at the 15000 the
// fixture path uses. At the original 40000/40000/10000/10000 it tolerated
// F = 60000, which the venue already exceeded.
const WEIGHTS = [300000, 300000, 25000, 25000]

// Headroom over the stake for the protocol fees the STAKE itself pays, plus
// slack for a re-run.
const GAS_HEADROOM = 5000

// XCHAIN is an open faucet on regtest, but MINT is capped per TRANSACTION
// (MAX_MINT, 100000 on this venue), so a stake larger than the cap is funded by
// several mints rather than one. Read from the chain rather than hardcoded: a
// venue whose token was issued with a different cap would otherwise fail with a
// MINT rejection that names the amount and not the cap.
const MINT_CAP_FALLBACK = 100000

// Enough BTC for a two-phase P2SH action plus its change. Every ROLLCALL-era
// action exceeds the 76-byte OP_RETURN cap, so the P2SH lane is the only one,
// and it funds a second leg out of the first.
const FUND_BTC = 0.5

// The gas token's per-transaction MINT cap, read from the venue once. Falls
// back to the documented regtest value if the row cannot be read, so a seeding
// run is never blocked by a diagnostic query.
let _mintCap = null
async function mintCap(){
    if (_mintCap !== null) return _mintCap
    _mintCap = MINT_CAP_FALLBACK
    try {
        const conn = await indexerDatabase.getConnection()
        try {
            const rows = await conn.query(
                'SELECT max_mint FROM tokens WHERE tick = ? ORDER BY tick_id DESC LIMIT 1', ['XCHAIN'])
            const v = rows && rows[0] && Number(rows[0].max_mint)
            if (Number.isFinite(v) && v > 0) _mintCap = v
        } finally { await conn.release() }
    } catch (e) {
        console.log('    mint cap       : falling back to ' + MINT_CAP_FALLBACK + ' (' + (e && e.message) + ')')
    }
    return _mintCap
}

describe('ROLLCALL: seed the four-source acceptance federation', function () {

    let mnemonic = null
    const seeded = []

    before(async function () {
        assert.strictEqual(COIN_CODE, 'BTC',
            'the ROLLCALL federation is staked on BITCOIN: the capability predicate and the stake rows are ' +
            'BTC-only, so seeding on ' + COIN_CODE + ' would produce rows the epoch close never reads.')

        mnemonic = process.env.XC_ROLLCALL_FEDERATION_MNEMONIC || null
        assert.ok(mnemonic,
            'XC_ROLLCALL_FEDERATION_MNEMONIC is not set. The acceptance run needs the sources\' own keys for ' +
            'AT10\'s COLLECT leg, and a venue seeded from a throwaway mnemonic can never be driven again. ' +
            'Generate twelve words, store them 0600 beside the venue\'s other credentials, and pass them here ' +
            'and to the acceptance run.')

        // A drifted canonical would not break seeding, but it would mean the
        // roster pubkeys this stakes are not the ones the suites sign with,
        // and the whole federation would read as absent. Cheap to check here.
        rc.assertFrozenCanonicalVector()
    })

    it('stakes each roster key from its own source address', async function () {
        const roster = rc.federationRoster()
        assert.strictEqual(roster.length, WEIGHTS.length,
            'the roster is ' + roster.length + ' entries but this tool carries ' + WEIGHTS.length + ' weights')

        // What is already effective, read through the SAME source-keyed view the
        // epoch close resolves R(E) with. There is no getstakes on the indexer's
        // RPC surface, and asking the capability read is the better question
        // anyway: a stake row that exists but does not clear the floor or has not
        // activated is not a member, and re-staking on top of one is the only way
        // to make it one.
        const tip0 = Number((await indexerConnector.call('getblockhashes', {})).block_index)
        const pre  = await indexerConnector.call('getstakeweightsbycapability', {
            capability: 'oracle_publish', block_index: tip0,
        })
        assert.ok(pre && !pre.error, 'getstakeweightsbycapability failed: ' + JSON.stringify(pre && pre.error))
        const already = new Set((pre.validators || []).map(v => String(v.pubkey).toLowerCase()))

        for (const entry of roster) {
            const want = WEIGHTS[entry.index]
            console.log('\n[' + entry.index + '] ' + entry.role + '  ' + entry.pubkey)

            // DERIVE before deciding, FUND only if we are going to stake.
            // getNewFundedAddress sends coin and mints its own seed gas on every
            // call, so checking the skip after it would make a re-run spend on a
            // venue it then declines to touch - which is exactly the state a
            // re-run is for.
            const addr = await cryptoHelper.getNewAddress(
                'rollcall-source-' + entry.addressIndex, COIN, NETWORK, mnemonic, 'legacy', entry.addressIndex)
            console.log('    source address : ' + addr.address)

            // Already effective? Leave it. A second STAKE|1 for the same pubkey
            // from the same source is a top-up, which would move the weight
            // distribution the suites' quorum arithmetic depends on.
            if (already.has(entry.pubkey)) {
                console.log('    already staked : effective in oracle_publish at block ' + tip0 + ', leaving alone')
                seeded.push({ entry, address: addr.address, staked: false })
                continue
            }

            await cryptoHelper.getNewFundedAddress(
                'rollcall-source-' + entry.addressIndex, COIN, NETWORK, mnemonic, 'legacy', entry.addressIndex, FUND_BTC)

            // MINT is capped per TRANSACTION, so a stake above the cap is
            // funded by several mints. Chunked rather than one call because the
            // rejection an oversized MINT earns names the amount, not the cap,
            // and reads as a broken faucet.
            const cap  = await mintCap()
            let owed   = want + GAS_HEADROOM
            let mints  = 0
            while (owed > 0){
                const chunk = Math.min(owed, cap)
                await gasHelper.ensureGasBalance(addr, String(chunk))
                owed -= chunk
                mints++
            }
            console.log('    minted gas     : ' + (want + GAS_HEADROOM) + ' XCHAIN in ' + mints + ' mint(s) ' +
                        '(cap ' + cap + ' per transaction)')

            const res = await stakeHelper.sendStakeV1(addr, want.toFixed(0) + '.00000000', entry.pubkey)
            console.log('    STAKE v1       : ' + want + ' XCHAIN, tx ' + res.txHash)
            seeded.push({ entry, address: addr.address, staked: true })
        }

        // Activation is not instant: the stake rows carry activation_block and
        // the capability predicate only admits them at or past it.
        await regtestMinerConnector.generateBlocks(stakeHelper.ATTESTATION_STAKE_VISIBLE_BLOCKS)
        await utxoTrackerConnector.waitForSync()
    })

    it('reports a federation the acceptance suites can drive', async function () {
        const roster = rc.federationRoster()

        // POLL, do not read once. A stake is admitted only at
        // activation_block = <landed block> + STAKING.ACTIVATION_DELAY_BLOCKS,
        // so the last STAKE of the loop is still invisible when the loop ends
        // even though it is indexed and valid. Measured on the venue: reading
        // once at the tip reported the two 40000 sources present and called the
        // two 10000 sources a seeding failure, which is the most misleading
        // answer available - it points at the amounts, and the amounts were
        // never the problem.
        let tip = 0, res = null, byPubkey = new Map(), missing = roster
        let lastTip = -1, stalls = 0
        const deadline = Date.now() + 10 * 60 * 1000
        while (Date.now() < deadline) {
            tip = Number((await indexerConnector.call('getblockhashes', {})).block_index)
            res = await indexerConnector.call('getstakeweightsbycapability', {
                capability: 'oracle_publish', block_index: tip,
            })
            assert.ok(res && !res.error, 'getstakeweightsbycapability failed: ' + JSON.stringify(res && res.error))
            byPubkey = new Map((res.validators || []).map(v => [String(v.pubkey).toLowerCase(), v]))
            missing  = roster.filter(r => !byPubkey.has(r.pubkey))
            if (!missing.length) break

            // A STALLED TIP ON AN ARMED VENUE IS A DEFERRING CLOSE, and a loop that polls
            // through it for the full ten minutes ends up blaming the seeding
            // instead. This tool mines BTC only, so it can walk the indexer onto a
            // close block whose epoch cannot be decided yet: the close needs the
            // DOGE tip's block_time to pass the BTC window-end stamp, and freshly
            // mined DOGE blocks are stamped at wall clock, so mining DOGE is what
            // clears it. Measured twice on the regtest acceptance venue 2026-09-03, both
            // times parked at a close with the activation poll spinning. Only fired
            // when the tip does NOT move, so a healthy venue never mines DOGE for
            // no reason, and a genuinely broken one still fails with its own
            // message rather than this one.
            if (tip === lastTip){
                stalls++
                if (stalls >= 2){
                    console.log('    tip parked at ' + tip + '; mining DOGE so a deferring epoch close can decide')
                    try {
                        const rail = await require('../helpers/chainRail').createRail('dogecoin', NETWORK)
                        await rail.globals.regtestMinerConnector.generateBlocks(4)
                    } catch (e) {
                        console.log('    could not mine DOGE (' + (e && e.message) + '); the close will stay deferred')
                    }
                    stalls = 0
                }
            } else {
                stalls = 0
            }
            lastTip = tip

            console.log('    waiting for activation: ' + missing.length + ' roster key(s) not yet effective at ' + tip)
            await regtestMinerConnector.generateBlocks(2)
            await new Promise(r => setTimeout(r, 3000))
        }

        console.log('\noracle_publish at block ' + tip + ': ' + (res.validators || []).length + ' key(s), ' +
                    new Set((res.validators || []).map(v => String(v.source))).size + ' source(s)')
        for (const v of (res.validators || []))
            console.log('    ' + String(v.pubkey).slice(0, 16) + '...  weight ' + v.weight + '  source ' + v.source)

        assert.strictEqual(missing.length, 0,
            'seeding did not take: ' + missing.map(r => '[' + r.index + '] ' + r.pubkey).join(', ') +
            ' are not in the oracle_publish set at block ' + tip)

        // Every key from its own source, or an eviction of the idle source
        // would take a signing hub's stake down with it.
        const sources = roster.map(r => String(byPubkey.get(r.pubkey).source))
        assert.strictEqual(new Set(sources).size, roster.length,
            'the four roster keys must resolve to four DISTINCT sources; got ' + JSON.stringify(sources))

        // The distribution check the suites will make, made here so a
        // mis-seeded venue says so now rather than twenty minutes into a drive.
        const weightBySource = new Map()
        for (const v of (res.validators || []))
            if (!weightBySource.has(String(v.source))) weightBySource.set(String(v.source), Number(v.weight))
        const total = Array.from(weightBySource.values()).reduce((a, b) => a + b, 0)

        // PRESENCE IS THE ROSTER'S SIGNING WEIGHT, never "total minus the silent
        // ones". The earlier form subtracted the idle and small-signer weights
        // from the WHOLE set's total, which silently counts every outsider as
        // PRESENT - the exact opposite of what an outsider does. On a venue with
        // 70000 of outsider weight it reported AT2 as satisfiable at
        // 40000/40000/10000/10000, where the real present side is 80000 of
        // 170000 and the epoch closes UNROLLED.
        const idleSource  = String(byPubkey.get(roster[rc.IDLE_SEED_INDEX].pubkey).source)
        const smallSigner = String(byPubkey.get(roster[2].pubkey).source)
        const signingSources = roster
            .filter(r => r.index !== rc.IDLE_SEED_INDEX)
            .map(r => String(byPubkey.get(r.pubkey).source))
        const signingWeight = signingSources
            .map(s => weightBySource.get(s) || 0).reduce((a, b) => a + b, 0)
        const at2Present    = signingWeight - (weightBySource.get(smallSigner) || 0)
        const outsiderWeight = total - signingWeight - (weightBySource.get(idleSource) || 0)

        assert.ok(3 * signingWeight > 2 * total,
            'an ORDINARY epoch cannot roll on this distribution: with all three hubs present the signing ' +
            'weight is ' + signingWeight + ' of ' + total + ' (outsiders hold ' + outsiderWeight + '), which ' +
            'does not clear 3 * present > 2 * total, so every epoch closes UNROLLED and no acceptance test ' +
            'has a verdict. Raise WEIGHTS in this tool, or unstake the outsiders.')

        assert.ok(3 * at2Present > 2 * total,
            'AT2 cannot pass on this distribution: with the idle source and the small signing hub silent, ' +
            'present weight is ' + at2Present + ' of ' + total + ' (outsiders hold ' + outsiderWeight + ', ' +
            'and an outsider counts toward total while never signing), which does not clear ' +
            '3 * present > 2 * total. Raise WEIGHTS in this tool so the large signing weight exceeds twice ' +
            'the small one plus the outsider weight, or unstake the outsiders.')

        console.log('\nfederation ready: total weight ' + total + ' (roster signing ' + signingWeight +
                    ', outsiders ' + outsiderWeight + '), AT2 outage leaves ' + at2Present + ' present')
    })
})
