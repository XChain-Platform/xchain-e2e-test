'use strict'

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
 * AT0, THE ANTI-WEDGE TEST. The mirror barrier must park a BTC indexer whose hub
 * is gone, resume it with no divergence when the hub returns, and never arm at
 * all off BTC.
 *
 * WHY THIS IS THE FIRST DRILL. The barrier has no chain-only escape hatch by
 * design: with the mirror unreachable it is satisfied by nothing, so a hub outage
 * parks the indexer indefinitely rather than letting it guess. That is deliberate,
 * because a missed mirror row is not lag but a permanent fork: the node would
 * commit the block with the callback un-fired while its peers commit it fired, and
 * nothing later re-binds. A design that parks forever has to be proven to UNPARK,
 * and to park for the stated reason rather than for some other stall, which is
 * what the three cases below separate.
 *
 * WHAT MAKES THE PARK ATTRIBUTABLE. One indexer's hub is stopped and the other's
 * is left running. Both follow the same chain, so if the stopped-hub indexer holds
 * while the live-hub indexer advances past it, the hold is the mirror barrier and
 * not the chain, the decoder, or the venue being slow. Asserting a stall reason
 * alone would not establish that: an indexer can carry a stale reason from an
 * earlier barrier it has since cleared.
 *
 * THE OFF-BTC HALF reads the standing LTC and DOGE indexers rather than venue
 * children, because that is where the claim actually has to hold: those two run
 * the same build with the barrier compiled in, gated on COIN === 'BTC'. A venue
 * child pointed at LTC would prove the gate only for a process this test
 * configured, which is the weaker claim.
 ********************************************************************/

require('dotenv').config()

const assert = require('assert')
const {
    BARRIER_REASON, PARKED_CLASSES, newContext, bringUp, tearDown,
    parkHublessIndexer, resumeWithoutDivergence, assertBarrierAbsentOffBtc,
} = require('./at0_anti_wedge.test/steps.test.js')

describe('AT0 anti-wedge: the mirror barrier parks a hubless BTC indexer and never arms off BTC', function () {
    this.timeout(45 * 60 * 1000)
    const ctx = newContext()

    before(async function () { await bringUp(ctx, this) })
    after(async function () { await tearDown(ctx) })

    it('parks the BTC indexer behind the mirror when its hub is gone, while its peer advances', async function () {
        await parkHublessIndexer(ctx)
    })

    // DRIVEN in at0b: "parks the starved indexer on attest_response_sync_barrier while every other barrier stays clear"
    it.skip('names attest_response_sync_barrier specifically (DRIVEN in at0b, see comment)', async function () {
        const status = await ctx.statusOf(0)
        assert.strictEqual(status.reason, BARRIER_REASON)
        assert.ok(PARKED_CLASSES.includes(status.klass))
    })

    it('resumes with no divergence when the hub returns', async function () {
        await resumeWithoutDivergence(ctx)
    })

    it('never arms the barrier on LTC or DOGE', async function () {
        await assertBarrierAbsentOffBtc()
    })
})
