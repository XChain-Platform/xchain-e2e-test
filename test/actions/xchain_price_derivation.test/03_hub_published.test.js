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
// XCHAIN price derivation, hub-published pair (live validator venue): the
// validator stake is restored when a reset lost it, and a published round
// supersedes the carry-forward with the exact volume-weighted value.

const assert = require('assert')
const cryptoHelper = require('../../helpers/core/cryptoHelper')
const gasHelper = require('../../helpers/gasHelper')
const stakeHelper = require('../../helpers/stakeHelper')
const venue = require('./helpers/venue.test')
const steps = require('./helpers/supersession.test')

const { COIN_CODE } = venue

// Venue probe, not a failure: a stack whose hub is not a
// price-capability validator has no XCHAIN/USD snapshots and cannot
// run this half of the proof.
async function hubPublishesXchainUsd() {
    try {
        const rows = await venue.hubPriceSnapshots()
        return venue.pairRows(rows, 'XCHAIN/USD').length > 0
    } catch (e) {
        return false
    }
}

async function probeHubVenue(suite) {
    if (COIN_CODE !== 'BTC') { suite.skip(); return }
    if (await hubPublishesXchainUsd()) return
    console.log('xchainPriceDerivation: hub is not publishing XCHAIN/USD on this venue; skipping hub-published legs')
    suite.skip()
}

// A destructive regtest reset wipes the chain but not the hub's
// signing identity, so the stake that qualifies the price capability
// must be re-created on the new chain. Pubkey comes from the operator
// env because it is venue state, not repo state.
async function restoreValidatorStake(suite) {
    const pubkey = process.env.XCHAIN_VALIDATOR_PUBKEY
    if (!pubkey) suite.skip()

    // give-up-ok: an existence probe - empty means the stake is gone and
    // this venue op has work to do, which is the branch below.
    const existing = await indexerDatabase.waitForStake({
        signingPubkey: pubkey, status: 'valid'
    }, 5000).catch(() => null)
    if (existing) {
        console.log('validator stake already on-chain; nothing to restore')
        return
    }

    const staker = await cryptoHelper.getNewFundedAddress(
        'XCPRICE.VALSTAKE', COIN, NETWORK, null, 'legacy', 0, 1)
    // MAX_MINT caps a single MINT at 100000; mint once at the cap and
    // stake well above the price capability MIN_STAKE.
    await gasHelper.ensureGasBalance(staker, '100000')
    const res = await stakeHelper.sendStakeV1(staker, '50000', pubkey)
    assert(res.stake, 'validator stake should be re-created on the fresh chain')
}

async function proveSupersession(ctx) {
    const db = venue.queryAdapter(indexerDatabase)
    await steps.buryOldFills(ctx, db)
    const { cf, cfRound } = await steps.awaitCarryForward()
    console.log('carry-forward stabilized at ' + cf + ' (round ' + cfRound + ')')

    const { rate1Btc, rate2Btc } = await steps.priceDrillRates(ctx, cf)
    const dispRow = await steps.drillDispenseLeg(ctx, rate1Btc)
    const match = await steps.drillDexLeg(ctx, db, rate2Btc)

    const fills = await steps.frozenWindowFills(ctx, db, {
        dispenseActionIndex: dispRow.action_index, matchActionIndex: match.action_index
    })
    const matched = await steps.matchFreshRound(ctx, fills, cf, cfRound)
    console.log('supersession proven at round ' + matched.round + ': ' + cf + ' -> '
        + matched.published + ' == reproduction ' + matched.expected + ' (clamped=0)')
    assert.notStrictEqual(matched.published, cf,
        'supersession must move the pair off the carry-forward')
}

function registerHubPublished(ctx) {
    describe('hub-published pair (live validator venue)', function () {
        before(async function () { await probeHubVenue(this) })

        it('restores the validator stake when the chain has lost it (env-gated venue op)', async function () {
            this.timeout(300000)
            await restoreValidatorStake(this)
        })

        // Budgeted for the burial, not for the assertions. Ageing a fill out of
        // a 1000-block window means mining ~1000 blocks AND waiting for the
        // indexer to parse them, and this venue parses at a couple of seconds a
        // block, so the burial alone can run past half an hour on a chain that
        // has not been buried before. A rerun on an already-buried venue skips
        // it entirely and the whole leg costs a few minutes.
        it('supersedes the carry-forward with the exact volume-weighted value', async function () {
            this.timeout(3600000)
            await proveSupersession(ctx)
        })
    })
}

module.exports = { registerHubPublished }
