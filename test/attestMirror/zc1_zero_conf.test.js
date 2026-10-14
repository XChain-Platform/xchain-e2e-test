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
 * ZC1, THE ZERO-CONFIRMATION FLIP. A request mined at block N is served at tip N,
 * and its callback binds at N+1.
 *
 * The spec's own test (zero-confirmation-flip §10 ZC1), driven here with the poll
 * default the fleet will run: an `http_get` request mined at N starts its round at
 * tip N on every responsible hub (`AttestationRound: starting <rid16>... tip=N
 * conf=0 widen=1`, D77), its mirror row is readable within 15 s of the block, and
 * the callback binds at N+1. Records mined-to-mirrored seconds.
 *
 * EXCLUSIVE ON THE SHARED REGTEST CHAIN, not merely serialized. This drill PAUSES
 * THE SHARED MINER for the whole of the driven case and mines two blocks by hand,
 * because "binds at N+1" is not a claim a drill can make on a chain something else
 * is advancing. Nothing else may run against this chain while it does.
 *
 * WHY THE MINER HAS TO BE PAUSED, stated so nobody removes it as fussiness. The
 * applier binds a response at the FIRST block whose protocol time is past the
 * signed `effective_time`, and `effective_time` is stamped `now + forwardS` by the
 * leader. On mainnet blocks are ten minutes apart and forwardS is 120 s, so the
 * next block is always past it and N+1 is the answer by construction. On regtest
 * the miner produces blocks every few seconds, so N+1 lands BEFORE the stamp, does
 * not satisfy it, and the response binds at N+2 or N+3 for a reason that has
 * nothing to do with what ZC1 is about. Pausing the miner and mining N+1 once the
 * stamp has passed reproduces the mainnet geometry rather than papering over it.
 *
 * WHAT THE POLL SETTING MEANS HERE, since the venue pins its own. `attestationPollMs`
 * is passed EXPLICITLY at 3000 (D8): the venue's resting default is 2000, and ZC1
 * measures the value the hub fleet will actually carry after this train
 * (`AttestationRound.DEFAULT_POLL_MS`, §3.3). A drill that inherited the venue's
 * faster poll would report a discovery latency no operator will ever see. The
 * option does reach a spawned hub: `xchain-hub/src/api.js:403` reads
 * ATTESTATION_POLL_MS into p2pConfig (D83).
 *
 * WALL-TIME BUDGET: about 30 minutes, nearly all of it the venue's two indexers
 * replaying the borrowed chain from genesis. The driven part is under two minutes.
 ********************************************************************/

const assert = require('assert')
const dotenv = require('dotenv')
const UNIT_ONLY = process.env.ZC1_UNIT_ONLY === '1'
if (!UNIT_ONLY) dotenv.config()

const { newCtx, setupVenue, teardownVenue, waitForLocalRequestAtBlock } = require('./helpers/zc1_fixture')
const { zeroConfFlipCase } = require('./helpers/zc1_steps')

function registerBarrierWaitsForCommit () {
    it('waits for the venue commit before reading the request row', async function () {
        const venue = { label: 'unit' }
        const request = { requestId: 'abc123', blockIndex: 157 }
        let committed = false
        let evidence = null
        const local = await waitForLocalRequestAtBlock(venue, 0, request, {
            waitForHeight: async (gotVenue, gotIndex, gotHeight) => {
                assert.strictEqual(gotVenue, venue)
                assert.strictEqual(gotIndex, 0)
                assert.strictEqual(gotHeight, 157)
                await Promise.resolve()
                committed = true
                return { at: gotHeight }
            },
            readRow: async (gotVenue, gotIndex, gotRequestId) => {
                assert.ok(committed, 'the request row read ran before the venue committed its block')
                assert.strictEqual(gotVenue, venue)
                assert.strictEqual(gotIndex, 0)
                assert.strictEqual(gotRequestId, 'abc123')
                return { block_index: 157 }
            },
            log: (line) => { evidence = line },
        })
        assert.strictEqual(local.block_index, 157)
        assert.strictEqual(evidence,
            'ZC1 BARRIER: request abc123 mined at 157, venue indexer 0 committed 157')
    })
}

function registerBarrierRefusesWrongBlock () {
    it('refuses a row assigned to a different block', async function () {
        await assert.rejects(() => waitForLocalRequestAtBlock({}, 0,
            { requestId: 'abc123', blockIndex: 157 }, {
                waitForHeight: async () => {},
                readRow: async () => ({ block_index: 158 }),
                log: () => {},
            }), /venue request row landed at block 158 but the standing indexer placed it at 157/)
    })
}

function registerBarrierRefusesNoHeight () {
    it('refuses to wait without a usable request height', async function () {
        await assert.rejects(() => waitForLocalRequestAtBlock({}, 0,
            { requestId: 'abc123', blockIndex: null }),
        /standing indexer returned no usable block height/)
    })
}

function registerUnitBarrier () {
    describe('ZC1 request-block barrier', function () {
        registerBarrierWaitsForCommit()
        registerBarrierRefusesWrongBlock()
        registerBarrierRefusesNoHeight()
    })
}

function registerDriven () {
    describe('ZC1: a request mined at N is served at tip N and binds at N+1', function () {
        // Five hub processes, two indexers replaying from genesis, then one round.
        this.timeout(60 * 60 * 1000)

        const ctx = newCtx()

        before(async function () {
            await setupVenue(ctx, this)
        })

        after(async function () {
            await teardownVenue(ctx)
        })

        it('starts the round at tip N with conf=0 widen=1, mirrors within 15 s, and binds at N+1',
            async function () {
                await zeroConfFlipCase(ctx)
            })
    })
}

if (UNIT_ONLY) registerUnitBarrier()
else registerDriven()
