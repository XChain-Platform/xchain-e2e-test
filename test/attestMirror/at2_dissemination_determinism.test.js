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
 * AT2, DISSEMINATION AND DETERMINISM. An indexer following a hub that never ran
 * the round must reach byte-identical applied state.
 *
 * With redundancy three on five hubs, the drill makes fresh requests until an
 * indexer follows a hub outside the row's actual signer set. It then proves that
 * hub serves the gossiped row and both indexers produce identical applied rows,
 * callback state, rewards, and block state hashes.
 *
 * The delayed-delivery clause is driven separately by at2b, where grace asymmetry
 * makes the named barrier observable without taxing this request-selection loop.
 * SERIALIZED, not parallel: the drill stakes into the shared regtest roster.
 ********************************************************************/

require('dotenv').config()

const assert = require('assert')
const { newContext, bringUp, tearDown, proveDissemination } =
    require('./at2_dissemination_determinism.test/steps.test.js')

describe('AT2: a hub outside the responsible set disseminates the response, identically', function () {
    this.timeout(90 * 60 * 1000)
    const ctx = newContext()

    before(async function () { await bringUp(ctx, this) })
    after(async function () { await tearDown(ctx) })

    it('applies a gossiped response identically on an indexer whose hub never ran the round', async function () {
        await proveDissemination(ctx, this)
    })

    // DRIVEN in at2b: "waits on the named barrier and still binds at the same block on both nodes"
    it.skip('holds the barrier when delivery is delayed past the forward margin (DRIVEN in at2b, see comment)',
        async function () {
            assert.fail('unreachable: this clause is driven in at2b_forward_margin.test.js')
        })
})
