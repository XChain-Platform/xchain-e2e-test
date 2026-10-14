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
 * ZC2, THE RE-MINE. Serving at zero confirmations means a request can reorg under
 * a round that already ran, and the operator accepted that spend as a cost of
 * business (ruling 2026-09-07). What must NOT happen is paying twice.
 *
 * The spec's own test (zero-confirmation-flip §10 ZC2), on the keep case of
 * `at4-reorg.test.js`: the pre-reorg row re-binds; exactly one `attest_fee` split
 * exists after 25 further blocks; `fetch_count` on every responsible hub reads one
 * more than it did before this request existed.
 *
 * WHAT ACTUALLY PROTECTS THE SECOND FETCH, and it is not the cache (§0 fact 2,
 * D40). The durable `attestation_fetch_cache` is time-windowed at `retryAfterMs`,
 * 123 s at this train's defaults, which is shorter than one live block; on mainnet
 * it is empty long before a reorg is noticed. What refuses the second round is the
 * hub's `finalized` ring (10000 rids, `attestation/consensus.js:495`), which is
 * keyed on the request id, and the request id is content-derived from the
 * transaction hash and is therefore REORG-STABLE (D3). So the re-mined request is
 * the same request, the ring refuses to start a second round for it, and no second
 * fetch happens at all. That is why this drill asserts `fetch_count` and not a
 * cache-hit counter: a cache-hit assertion would pass on regtest for 123 s and be
 * false on every live network.
 *
 * EXCLUSIVE ON THE SHARED REGTEST CHAIN, not merely serialized: it orphans blocks
 * out from under whatever else is on that chain, exactly as AT4 does. Nothing else
 * may be running against this venue or this chain.
 *
 * NO BURIAL BLOCKS, and that is the flip itself. AT4 mines four before the hubs
 * will look at a request; above the zero-conf height the hub serves at tip N, so
 * the round is already finished when the reorg is staged and the reorg stays well
 * inside the standing utxo-tracker's twelve-block undo window with room to spare.
 *
 * WALL-TIME BUDGET: about 45 minutes, most of it the venue's indexers replaying
 * the borrowed chain from genesis plus the 25-block settle.
 ********************************************************************/

const dotenv = require('dotenv')
dotenv.config()

const { newCtx, setupZc2, teardownZc2 } = require('./helpers/zc2_fixture')
const { readBaseline, emitRequest, readResponsibleHubs, awaitApplied } = require('./helpers/zc2_steps')
const { reorgAndRebind, assertOneSplit, assertFetchedOnce } = require('./helpers/zc2_asserts')
const { jsonSafe } = require('./helpers/mirrorDrillWaits')

async function runRemineDrill (ctx) {
    const before          = await readBaseline(ctx)
    const request         = await emitRequest(ctx)
    const responsibleHubs = await readResponsibleHubs(ctx, request.requestId)
    const applied         = await awaitApplied(ctx, request)
    await reorgAndRebind(ctx, request.requestId, applied)
    await assertOneSplit(ctx, applied)
    await assertFetchedOnce(ctx, before, responsibleHubs)

    console.log('ZC2 GREEN: re-bound at ' + applied.appliedBlock + ' on both nodes, one attest_fee split, ' +
        'one fetch on each of hubs ' + jsonSafe(responsibleHubs))
}

describe('ZC2: a re-mined request re-binds once and is paid for once', function () {
    this.timeout(90 * 60 * 1000)

    const ctx = newCtx()

    before(async function () { await setupZc2(ctx, this) })

    after(async function () { await teardownZc2(ctx) })

    it('re-binds the pre-reorg row, splits the escrow once, and never re-fetches', async function () {
        await runRemineDrill(ctx)
    })
})
