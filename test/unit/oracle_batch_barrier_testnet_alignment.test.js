'use strict';

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
 * The AT5 drill's action alignment (spec row 55), pinned without a chain.
 *
 * WHAT WENT WRONG. The drill compared verdicts by looking origin's action up by
 * THE NODE'S OWN `action_index` and then "checking the coordinate" with
 * `tx_index`. Both are per-node counters, assigned as each node parses from
 * wherever it started, so a chain-only node that begins mid-chain is misaligned
 * from origin by construction. Run 5 (2026-09-09) graded 290 blocks carrying 20
 * actions and reported `verdictsCompared: 0`: every single row came back
 * `coordinateAligned: false`, with nothing in the result saying why.
 *
 * THE FIXTURE IS THAT RUN'S OWN 20 ACTIONS. `REAL_PAIRS` below is the node side
 * as the AT5 node's own database held it, beside the row the public explorer
 * returns for the same transaction, both verbatim (origin's numbers arrive as
 * STRINGS, and they are left as strings here because that is what the code has
 * to cope with). Look at the ORDER at height 67882087: the node calls it
 * `tx_index` 263 and origin calls it 666. All 20 pairs disagree on the counter
 * and all 20 agree on the hash, which is the whole of the defect and the whole
 * of the fix.
 *
 * WHAT THIS FILE REFUSES TO LET HAPPEN. Not just "the predicate returns true":
 * the last block drives the drill's own `observeBlock` and asserts that origin's
 * verdict was fetched with ORIGIN's action index (650, 654, 665) and never with
 * the node's (245, 249, 260). A predicate that is correct but wired to the wrong
 * index would otherwise pass, and cost another four-hour run to find.
 *
 *   npx mocha --no-config test/unit/oracle_batch_barrier_testnet_alignment.test.js
 ********************************************************************/

const { registerFixtureIsTheDefect, registerAlignOnTxHashPredicate, registerNullTxIndex, registerNamedRefusals, registerMultiActionTransaction, registerOriginActionIndexWindow } = require('./oracle_batch_barrier_testnet_alignment.test/alignment_predicate.js');
const { registerObserveBlockAsksOrigin, registerEmptyBlockStopsNothing } = require('./oracle_batch_barrier_testnet_alignment.test/observe_block.js');

describe('AT5 barrier drill: aligning two nodes on the chain\'s own coordinate (row 55)', function () {
    describe('the fixture is the defect', registerFixtureIsTheDefect);
    describe('alignOnTxHash: the predicate', registerAlignOnTxHashPredicate);
    describe('a null tx_index, deliberately', registerNullTxIndex);
    describe('refusals name the cause instead of reporting a bare false', registerNamedRefusals);
    describe('one transaction carrying more than one action', registerMultiActionTransaction);
    describe('buildOriginActionIndex: the window', registerOriginActionIndexWindow);
    describe('observeBlock asks origin for ORIGIN\'s action index', registerObserveBlockAsksOrigin);
    describe('a block with nothing to compare still stops nothing', registerEmptyBlockStopsNothing);
});
