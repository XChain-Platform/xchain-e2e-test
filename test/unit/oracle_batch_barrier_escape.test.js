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
 * THE AT5 DRILL'S ESCAPE ATTRIBUTION (spec row 56), pinned without a chain.
 *
 * WHAT WENT WRONG. Run 5 (2026-09-09) graded 290 blocks and could name the
 * escape for ONE: 289 read `escape: "none"` with `deferralCount: 0`, on blocks
 * that had each waited over 4,400 seconds. TA5's "never BEFORE the barrier
 * permits" half was therefore unmeasured, and the run said nothing about it.
 *
 * TWO CAUSES, both measured and both pinned below.
 *
 *   1. THE EVIDENCE WAS A LOG LINE THE NODE ALMOST NEVER PRINTS.
 *      `hub_db_sync.waitForPriceSyncTime` returns an already-resolved promise
 *      when the barrier is satisfied and resolves a pending waiter silently the
 *      moment it opens, so `Deferring block N (price time-sync)` is reached only
 *      when one attempt runs out its HUB_PRICE_SYNC_TIMEOUT_MS (60 s). At this
 *      node's working point the residual wait per block is shorter than that:
 *      one block of run 5's 290 timed out, three times, and 289 said nothing.
 *      The capture was never at fault; there was nothing to capture.
 *
 *   2. THE ATTRIBUTION REASONED ON THE WRONG CLOCK. The barrier is called with
 *      `decoderDb.getBlockTime()`, which on testnet resolves PROTOCOL time
 *      (median time past over 11 preceding stamps, db.js:2470 via
 *      protocol_time.js), not the chain's raw header stamp the drill read from
 *      the decoder. On run 5's one deferred block the two differ by 206 s, and
 *      the difference is the whole reason its stalls topped out at 4,607 s
 *      against a 4,800 s grace: a run that looked like a barrier opening early
 *      was a drill measuring against a clock the node never used.
 *
 * EVERY NUMBER BELOW IS A READING, NOT A FIXTURE. The block times come from the
 * public explorer's own `/TDOGE/api/block/<height>`; the barrier state samples
 * are the three deferral lines run 5's result file carries verbatim, which are
 * the indexer's own print of `priceSyncMaxTimestamp` and `streamWatermark`; and
 * the grace and the predicate are taken from xchain-indexer itself where it is
 * checked out beside this repo, so a drift in either shows up here as a failure
 * rather than as another four-hour run.
 *
 *   npx mocha --no-config test/unit/oracle_batch_barrier_escape.test.js
 ********************************************************************/

const DIR = './oracle_batch_barrier_escape.test/';

module.exports = {};

require(DIR + '01_predicate_and_clock.test.js');
require(DIR + '02_sampled_attribution.test.js');
require(DIR + '03_ungated_and_state.test.js');
