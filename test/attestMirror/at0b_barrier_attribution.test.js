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
 * AT0's LAST CLAUSE: the stall is `attest_response_sync_barrier` BY NAME.
 *
 * The anti-wedge drill stops a whole hub, which starves every barrier at once.
 * This drill instead withholds only `attestation_responses` on one mirror edge
 * and raises only that barrier's grace. The peer keeps flowing, the followed hub
 * remains available, and release forces a fresh snapshot before convergence.
 ********************************************************************/

require('dotenv').config()

const {
    newContext, bringUp, tearDown, parkOnAttributedBarrier, releaseAndConverge,
} = require('./at0b_barrier_attribution.test/steps.test.js')

describe('AT0 last clause: the mirror stall is attest_response_sync_barrier by name', function () {
    this.timeout(45 * 60 * 1000)
    const ctx = newContext()

    before(async function () { await bringUp(ctx, this) })
    after(async function () { await tearDown(ctx) })

    it('parks the starved indexer on attest_response_sync_barrier while every other barrier stays clear',
        async function () { await parkOnAttributedBarrier(ctx) })

    it('resumes and converges on the same state_root once the table is released', async function () {
        await releaseAndConverge(ctx)
    })
})
