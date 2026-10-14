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
 * The AT5 drill's observe-phase gate (spec row 46), pinned without a chain.
 *
 * WHY THIS EXISTS. The drill is a four-hour run against a live public chain, so
 * a defect in WHICH blocks it grades is found, at best, four hours after the
 * launch and, at worst, not at all: run 3 (2026-09-09) returned
 * `status: "completed"` over six blocks that had each been sitting in the
 * decoder for over an hour, scored them with `waitS: 0`, `escape: "none"` and
 * `deferralCount: 0`, and reported that as an AT5 observation. Nothing in the
 * result said the barrier had not been measured; the number that should have
 * said so, `stallsWithinGracePlusConfirm`, read 0 of 6, which is what a broken
 * barrier looks like too.
 *
 * THE NUMBERS BELOW ARE RUN 3'S OWN. The six heights (67879822-67879827) and
 * their ages on arrival (4,303-4,453 s) are the measurements the record
 * records; the block times are reconstructed so that those ages come out
 * exactly, because the ages are what the gate reasons about and the absolute
 * times are not. So this file asks the fixed drill what it would have said
 * about the run that motivated the fix, and the answer must be "nothing was
 * graded", not "six blocks cleared the barrier instantly".
 *
 * EVERY OBSERVATION RECORD HERE IS PRODUCED BY THE DRILL'S OWN `observeBlock`,
 * not hand-written to the shape the summary wants: a gate that is exported and
 * correct but never wired into the record would otherwise pass this file. The
 * database connection is a reader that finds no rows, which is the honest shape
 * for a node whose mirror is empty, and no socket is opened anywhere.
 *
 *   npx mocha --no-config test/unit/oracle_batch_barrier_testnet_observe.test.js
 *
 * The cases live in oracle_batch_barrier_testnet_observe.test/, one part per
 * topic; the fixtures they share are in its helpers/fixtures.js
 ********************************************************************/

const DIR = './oracle_batch_barrier_testnet_observe.test/';

module.exports = {};

require(DIR + '01_freshness_and_catch_up.test.js');
require(DIR + '02_observation_record.test.js');
require(DIR + '03_summarize_and_settings.test.js');
