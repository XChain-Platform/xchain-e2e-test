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
 * ZC5, THE FLAG DAY. Below the height nothing changes; above it a rollback across
 * a bound response restores the ledger.
 *
 * The spec's own test (zero-confirmation-flip §10 ZC5) has two halves and they are
 * driven in two different places, for a measured reason.
 *
 * THE BELOW-HEIGHT HALF IS A UNIT-TIER ASSERTION AND CANNOT BE ANYTHING ELSE
 * (gaps 12). `ATTEST_ZERO_CONF_ACTIVATION.regtest` is 0 and every resolver reads
 * the map directly: no environment variable, no config key, no injected seam. So
 * on this venue there is no block index below the height and no request that can
 * exist below it, exactly as AT6's own skipped case measures for the mirror
 * activation. The below-height behaviour is therefore asserted at a SYNTHETIC
 * height on `testnet`, which is the one network where the widening map is armed
 * (150780), the mirror map is armed (151324) and the zero-conf map arms at 151800:
 * the only interval that reaches the old branches with the mirror-era gate satisfied.
 * The fixture pins that activation and keeps every synthetic height below it, so a
 * later registry change fails before these cases can assert the wrong era.
 *
 * THE ABOVE-HEIGHT HALF IS ON THE VENUE, on the at6 shape (D79): a request served
 * at zero confirmations, bound, then rolled back and re-applied, with the signed
 * roots compared on both nodes either side. at6 itself is untouched.
 *
 * WHAT "RESTORES state_hash" CAN AND CANNOT MEAN HERE, stated so nobody tightens
 * this into an assertion that must fail. A reorg replaces the block at height B
 * with a DIFFERENT block: it has to, or the node would not switch to the competing
 * chain, and an identical block is one the node has already marked invalid. Its
 * coinbase pays a different address, so `block_merkle_root` at B is expected to
 * differ and comparing it across the reorg would be comparing the block rather
 * than the ledger. What must be restored is the LEDGER: `state_root`,
 * `balances_root` and `stakes_root` at B, which carry the applied response, the
 * callback's writes and the settle. Those three are compared across the reorg, all
 * four are compared BETWEEN the two nodes (a fork is a disagreement between
 * nodes), and the block below the reorg point is compared both ways as the control
 * that says the rollback did not reach further than it should have.
 *
 * EXCLUSIVE ON THE SHARED REGTEST CHAIN for the venue half: it orphans blocks out
 * from under whatever else is on that chain. WALL-TIME BUDGET: the unit half is
 * milliseconds and needs no venue at all; the venue half is about 45 minutes,
 * nearly all of it the indexers replaying from genesis.
 ********************************************************************/

const dotenv = require('dotenv')
dotenv.config()

const {
    loadBelowModules, assertFixtureAssumption, assertConfirmationsFor,
    assertWidenSlots, assertSelectorCandidates,
} = require('./helpers/zc5_below_steps')
const { bootZc5, teardownZc5, rollbackRestoresLedger } = require('./helpers/zc5_above_steps')

// ---------------------------------------------------------------------------
// The below-height half: synthetic heights on testnet, no venue.
// ---------------------------------------------------------------------------

describe('ZC5 below the height: the flag day leaves every rule where it was', function () {
    this.timeout(60 * 1000)

    const ctx = { zc: null, wid: null, Utility: null }

    before(function () {
        loadBelowModules(ctx)
    })

    it('holds the fixture assumption: the synthetic request stays below testnet zero-conf activation',
        function () {
            return assertFixtureAssumption(ctx)
        })

    it('confirmationsFor returns the constructor value below the height and 0 above it', function () {
        return assertConfirmationsFor()
    })

    it('widenSlots runs the stage-1 ladder below the height and the V2 headroom above it', function () {
        return assertWidenSlots(ctx)
    })

    it('the selector carries no candidate list below the height and one above it', function () {
        return assertSelectorCandidates(ctx)
    })
})

// ---------------------------------------------------------------------------
// The above-height half: a rollback across a bound zero-conf response.
// ---------------------------------------------------------------------------

describe('ZC5 above the height: a rollback across a bound response restores the ledger', function () {
    this.timeout(90 * 60 * 1000)

    const ctx = { venue: null, up: false, testServer: null, testUrl: null, contract: null, minerAddr: null }

    before(async function () {
        await bootZc5(ctx, this)
    })

    after(async function () {
        await teardownZc5(ctx)
    })

    it('re-applies at the same block with the ledger roots restored and no fork', function () {
        return rollbackRestoresLedger(ctx)
    })
})
