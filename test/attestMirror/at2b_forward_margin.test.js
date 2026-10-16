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
 * AT2's SECOND CLAUSE. Delivery delayed past the forward margin must hold the
 * named barrier, not fork the ledger. One indexer receives a delayed response
 * feed and an attest-response-only grace; its peer remains unfiltered. Once the
 * barrier is visible, delivery is released and both nodes must bind at one block.
 ********************************************************************/

require('dotenv').config()

const {
    newContext, bringUp, tearDown, proveForwardMargin, proveBarrierClears,
} = require('./at2b_forward_margin.test/steps.test.js')

describe('AT2 second clause: delivery past the forward margin holds the barrier and forks nothing', function () {
    this.timeout(90 * 60 * 1000)
    const ctx = newContext()

    before(async function () { await bringUp(ctx, this) })
    after(async function () { await tearDown(ctx) })

    it('waits on the named barrier and still binds at the same block on both nodes', async function () {
        await proveForwardMargin(ctx)
    })

    it('clears the barrier once the delay is released', async function () {
        await proveBarrierClears(ctx)
    })
})
