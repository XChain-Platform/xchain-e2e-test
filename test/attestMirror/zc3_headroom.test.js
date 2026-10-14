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
 * ZC3, THE HEADROOM SLOT. One drawn member that cannot sign must not stall the
 * round for a third of the deadline window.
 *
 * The spec's own test (zero-confirmation-flip §10 ZC3): make a request, read the
 * draw through `getattestationresponsibleset`, stop one drawn venue hub; the round
 * finalizes with `redundancy` signatures INSIDE THE FIRST LADDER SEGMENT at the
 * same block on both venue indexers.
 *
 * THE DEFECT THIS MEASURES, measured on the public testnet. A 0.11.0 community validator seated in one
 * of the attestation slots proposes without a signed `effective_time`; every
 * current hub rejects its proposal, so a 3-of-7 draw that includes it stalls at 2
 * of 3. Before this train the ladder admitted a fourth member only after the first
 * THIRD of the serviceable span, which on contract 49's ten-block deadline is six
 * blocks; the live measurement was an hour and three quarters of retries. With the
 * V2 headroom slot the same round finalizes at the request's own block, with no
 * clock at all. A stopped hub is that key: from the federation's side, a member
 * that is drawn and never signs is a member that is drawn and never signs.
 *
 * WHY THE STOPPED MEMBER IS RANK 1 AND NOT THE LAST. The draw is ranked by
 * `sha256(request_id || pubkey)`, so the widened HEADROOM slot is the last entry.
 * Stopping that one leaves an ordinary three-of-three round and proves nothing:
 * the round would finalize with or without §4.1. Stopping a member inside the
 * first `redundancy` slots is what makes the headroom slot load-bearing, because
 * the third signature can then only come from it. Rank 1 rather than rank 0
 * because rank 0 is the leader at escalation step 0 and stopping it would be a
 * test of leader rotation instead. Rank 1 is never a hub a venue indexer follows:
 * that indexer would lose its only mirror stream and never see the row, so such a
 * draw is discarded before anything stops and drawn again.
 *
 * WHY THE POLL IS SLOWED DOWN HERE, and what it is NOT. `attestationPollMs` is
 * raised to open a window between the request becoming visible and the first round
 * starting, so the drill can read the draw and stop a hub inside it: "selects the
 * dead member AFTER the draw" (gaps 8) is a precondition, not a hope. ZC1 owns the
 * claim about the fleet's poll default; this value is a drill knob and says
 * nothing about it. The precondition is then ASSERTED rather than assumed: the
 * stopped hub must have logged no round-start line for this request.
 *
 * SERIALIZED, not chain-exclusive. It adopts the standing roster (so every draw is
 * venue-only) and stops one of its own hub processes; it orphans nothing and does
 * not touch the shared miner, so the chain is left exactly as it was found.
 *
 * WALL-TIME BUDGET: about 35 minutes, nearly all of it the venue's two indexers
 * replaying the borrowed chain from genesis.
 ********************************************************************/

const dotenv = require('dotenv')
dotenv.config()

const { newCtx, setupZc3, teardownZc3 } = require('./helpers/zc3_fixture')
const { constructVictimWindow, assertSignedResult, assertBoundInFirstSegment } = require('./helpers/zc3_asserts')

async function runHeadroomDrill (ctx) {
    const st      = await constructVictimWindow(ctx)
    const signers = await assertSignedResult(ctx, st)
    await assertBoundInFirstSegment(ctx, st, signers)
}

describe('ZC3: a drawn member that cannot sign is covered by the headroom slot', function () {
    this.timeout(75 * 60 * 1000)

    const ctx = newCtx()

    before(async function () { await setupZc3(ctx, this) })

    after(async function () { await teardownZc3(ctx) })

    it('finalizes with exactly redundancy signatures inside the first ladder segment', async function () {
        await runHeadroomDrill(ctx)
    })
})
