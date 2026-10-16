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
 * AT3, THE DEADLINE. A row whose first satisfying block is past the deadline
 * never applies and leaves the expired callback standing. A row first satisfied
 * exactly at the deadline applies there. Mining is paused around height-critical
 * sections so automatic regtest blocks cannot move either boundary.
 ********************************************************************/

require('dotenv').config()

const {
    newContext, bringUp, tearDown, provePastDeadline, proveDeadlineBoundary,
} = require('./at3_deadline.test/steps.test.js')

describe('AT3: the deadline decides whether a mirrored response ever binds', function () {
    this.timeout(90 * 60 * 1000)
    const ctx = newContext()

    before(async function () { await bringUp(ctx, this) })
    after(async function () { await tearDown(ctx) })

    it('never applies a row whose first satisfying block would be past the deadline', async function () {
        await provePastDeadline(ctx)
    })

    it('applies a row whose first satisfying block IS the deadline block', async function () {
        await proveDeadlineBoundary(ctx)
    })
})
