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
 * AT4, REORGS. Applied mirror rows are ordinary chain state and move with the
 * chain in both directions. Replacing the applying block makes both nodes bind
 * again at the same height. Replacing the request block removes the request and
 * callback effects while leaving the mirrored row intact and inert.
 *
 * This drill reorgs the shared regtest chain and must run exclusively.
 ********************************************************************/

require('dotenv').config()

const {
    newContext, bringUp, tearDown, proveRequestKept, proveRequestRemoved,
} = require('./at4_reorg.test/steps.test.js')

describe('AT4: a reorg moves the applied response with the chain, in both directions', function () {
    this.timeout(90 * 60 * 1000)
    const ctx = newContext()

    before(async function () { await bringUp(ctx, this) })
    after(async function () { await tearDown(ctx) })

    it('re-binds at the same block on both nodes when the reorg keeps the request', async function () {
        await proveRequestKept(ctx)
    })

    it('rolls the applied rows back on both nodes when the reorg removes the request, and nothing re-binds',
        async function () { await proveRequestRemoved(ctx) })
})
