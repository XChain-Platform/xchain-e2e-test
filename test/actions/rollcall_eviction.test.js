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
 * E2E acceptance: ROLLCALL eviction (validator liveness), AT1 - AT4.
 *
 * Drives the whole two-chain rail: three in-process hubs sign a canonical bound
 * to a BITCOIN epoch block's ledger_hash, the elected leader lands the
 * signatures on DOGECOIN as a ROLLCALL action, and the BITCOIN indexer closes
 * each epoch at C = E + 14, re-verifies every signature against its OWN
 * ledger_hash, and after K = 2 consecutive rolled absences evicts the idle
 * fourth staking source with a synthetic UNSTAKE at action_format = 3.
 *
 *   AT1  the idle fourth source is evicted by the protocol after K rolled
 *        epochs, and getcapabilityvalidators at C + 7 returns three rows.
 *   AT2  a hub stopped across K - 1 epoch closes is absent then present, and is
 *        never evicted.
 *   AT3  rolling back the evicting close restores the hashes at C - 1, the
 *        re-parse of C reproduces them byte-identically, and deactivation_block
 *        returns to NULL on `stakes` AND `delegations`.
 *   AT4  after COOLDOWN_BLOCKS the evicted source is credited its swept amount
 *        and a fresh STAKE v1 re-enters.
 *
 * AT1 AND AT2 SHARE ONE DRIVE, deliberately: AT2's hub is down for exactly the
 * first of the two epochs AT1 needs, so one pair of epochs shows both the
 * one-epoch absence that must NOT evict and the two-epoch streak that must. The
 * two tests are one `it` because they are one measurement.
 *
 * The suite SEEDS NOTHING. Staking the federation is an operator decision, so
 * every condition the drive depends on is a named precondition in
 * test/helpers/rollcallHelper.js (bringUpVenue) that fails with the gap spelled
 * out. Two of those conditions were measured absent on the regtest venue on
 * 2026-08-30: the BTC indexer had no DOGE_INDEXER_API_URL, and the DOGE indexer
 * reported manifest_hash null. Either one makes every close DEFER forever, which
 * is why they are checked before a single block is mined.
 *
 * VENUE: bootstrapped on the BITCOIN regtest stack (COIN=bitcoin), with the
 * DOGECOIN regtest stack up and registered with the hub. Needs HUB_DB_USER /
 * HUB_DB_PASS for the in-process hubs and E2E_REQUIRE_FEDERATION=1 to opt in.
 *
 ********************************************************************/

'use strict'

const rc   = require('../helpers/rollcallHelper')
const { requireFederationEnv } = require('../helpers/federationGuards')
const at12 = require('./rollcall_eviction.test/01_at1_at2_eviction.test')
const at3  = require('./rollcall_eviction.test/02_at3_rollback.test')
const at4  = require('./rollcall_eviction.test/03_at4_cooldown_reentry.test')

// Brings the venue up and derives the two epochs the drive uses. Returns early
// (skipping the suite) when the venue or federation is not opted in.
async function setUp(suite, st){
    if (!rc.requireRollcallVenue(suite)) return
    if (!requireFederationEnv(suite)) return

    const ctx = st.ctx = await rc.bringUpVenue({ hubCount: 3, needSources: 4 })
    st.idleSource   = ctx.idleSource
    st.silentSource = ctx.sourceOf(at12.AT2_SILENT_HUB)
    console.log('    federation: ' + ctx.fed.sourceCount + ' source(s); idle ' + st.idleSource +
                ', AT2 silent ' + st.silentSource)

    // AT2's outage must leave its epoch ROLLED, or the epoch counts for
    // nobody and AT1's K-streak never forms.
    rc.assertOutageStillRolls(ctx, [st.silentSource, st.idleSource])

    const tip = await ctx.btcTip()
    const epochs = rc.epochsAfter(tip + 6, ctx.network, 2)
    st.E1 = epochs[0]; st.E2 = epochs[1]
    st.C1 = rc.closeHeightOf(st.E1, ctx.network)
    st.C2 = rc.closeHeightOf(st.E2, ctx.network)
    console.log('    driving epochs ' + st.E1 + ' (close ' + st.C1 + ') and ' + st.E2 + ' (close ' + st.C2 + ')')
}

describe('ROLLCALL acceptance: eviction of an idle staking source (AT1-AT4)', function () {
    // Two epochs of 30 BTC blocks with their 14-block closes, a reorg, and a
    // cooldown, all with DOGE publishes interleaved.
    this.timeout(45 * 60 * 1000)

    // The parts share what each one measured through this record and run in the
    // order registered below. evictionRows are the synthetic UNSTAKE rows AT1
    // observed, and both delays are DERIVED from those rows, never assumed from
    // a config this cannot read.
    const st = {
        ctx: null, idleSource: null, silentSource: null,
        E1: null, E2: null, C1: null, C2: null,
        row2: null, evictionRows: null, cooldownBlocks: null, activationDelay: null,
    }

    before(async function () { await setUp(this, st) })

    after(async function () { await rc.tearDownVenue(st.ctx) })

    at12.register(st)
    at3.register(st)
    at4.register(st)
})
