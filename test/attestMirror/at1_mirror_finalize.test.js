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
 * AT1: a response finalizes over P2P and reaches the chain's readers without a
 * transaction of its own.
 *
 * An `http_get` and an `llm` request finalize over P2P, the encoder records zero
 * transactions for either response, the callback fires on both indexers, contract
 * state carries the payload, and the synthetic v1 action has a null `tx_index`.
 * The synthetic hash is not persisted, so determinism is asserted through equal
 * action indexes, block indexes, response hashes, and payloads on both nodes.
 *
 * The standing indexer establishes that no ATTEST v1 reached the chain. The venue
 * indexers establish that the mirrored response was nevertheless applied. Both
 * directions are required to distinguish tx-less settlement from doing nothing.
 *
 * SERIALIZED, not parallel. The drill adopts the standing regtest roster and gives
 * each seated key to one venue hub. Concurrent venues would equivocate for the
 * same identities.
 ********************************************************************/

require('dotenv').config()

const {
    newContext, bringUp, tearDown, settleHttpGet, settleLlm,
} = require('./at1_mirror_finalize.test/steps.test.js')

describe('AT1: an ATTEST response finalizes over P2P with no transaction of its own', function () {
    this.timeout(45 * 60 * 1000)
    const ctx = newContext()

    before(async function () { await bringUp(ctx, this) })
    after(async function () { await tearDown(ctx) })

    it('settles an http_get request with no transaction, on both indexers', async function () {
        await settleHttpGet(ctx)
    })

    it('settles an llm request with no transaction, on both indexers', async function () {
        await settleLlm(ctx, this)
    })
})
