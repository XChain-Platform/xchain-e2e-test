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
 * E2E acceptance: the rules-aware attestation set (ZC7).
 *
 * The operator ask this drives: route an attestation request only to validators
 * running the CONSENSUS RULES that govern it, keyed on the rules and never on a
 * release version. The rail that answers it spans both chains and four
 * components, and this suite is the only place all four are driven together:
 *
 *   ZC7a  every hub publishes ROLLCALL v1 naming the gate list its build knows,
 *         the epoch ROLLS, and the BTC close writes one `rollcall_gates` row per
 *         verified signer carrying exactly that list.
 *   ZC7b  a second epoch in which one or more validators publish their OWN roll
 *         call over a list MISSING a gate that is active at the request block.
 *         Their rows are recorded with the short list, which is a true statement
 *         about what those builds accepted.
 *   ZC7c  at a request block judged against that epoch, the short-list validator
 *         is ABSENT from the `attestation` capability set and still PRESENT in
 *         the `price` set: the filter is scoped to the one capability whose
 *         responsible set is derived from consensus rules (spec §7.4, D16).
 *   ZC7d  with fewer sources surviving the filter than the request's REDUNDANCY,
 *         the emitting EXECUTE REVERTS carrying the rules-aware admission
 *         literal, which is a different sentence from the ordinary "the set was
 *         always this small" refusal (D61).
 *
 * WHY THIS IS ON THE LIVENESS FEDERATION VENUE AND NOT THE MIRROR ONE (D63): the
 * ROLLCALL rail is inert unless XC_ROLLCALL_REGTEST_ACTIVATION is set, and the
 * attestMirror venue has never produced a rolled epoch. Gate rows exist only as
 * an artifact of a rolled epoch's close, so the whole filter is unreachable
 * without a federation that rolls.
 *
 * BOTH RAILS ARMED, AND THE SECOND ONE IS THE VENUE'S OPT-IN. The harness arms
 * the ROLLCALL rail for itself; it deliberately does NOT arm the gates rail
 * (rollcallHelper's note at ROLLCALL_GATES_ARMING_ENV says why). Set
 * XC_ROLLCALL_GATES_REGTEST_ACTIVATION=armed in the shell that runs this suite
 * AND in the environment of BOTH indexer containers - the DOGE parser refuses a
 * v1 action for an epoch its own build reads as v0, and the BTC close refuses a
 * v0 row for an epoch it reads as v1, so a half-armed venue produces a
 * federation-wide absence rather than an error. Unarmed, this suite SKIPS.
 *
 * EXCLUSIVE ON THE VENUE. It drives two whole epochs on the shared regtest
 * chain, silences hubs, and lands hand-built ROLLCALL actions on DOGE; another
 * ROLLCALL suite running against the same chain would drive the same epochs.
 * Run it alone, or serialised behind the other rollcall suites.
 *
 * BLOCK BUDGET: about 2 x 30 (two epochs) + 12 (accept window) + 2 (proof delay)
 * BTC blocks, plus the 6-block burial before each epoch's first signable tick
 * and a handful past the second close for the capability reads and the request:
 * roughly 90 BTC blocks, with DOGE mined throughout for the publishes and the
 * close's evidence.
 *
 * WALL TIME: about 35 to 50 minutes on the regtest venue, dominated
 * by the two rank-ladder climbs and the two closes. The suite timeout is 60
 * minutes so a slow close reports its own precondition rather than a timeout.
 *
 * SIDE EFFECT WORTH KNOWING BEFORE A STANDALONE RUN: two rolled epochs with the
 * idle fourth staker absent complete its K-streak and the protocol EVICTS it,
 * exactly as rollcallEviction (AT1) does, and an evicted key can never be staked
 * again. Driven after that suite in one `npm run test:rollcall` pass there is
 * nothing left to evict; driven standalone twice on one venue, bump
 * XC_ROLLCALL_IDLE_GENERATION and re-seed between runs.
 *
 * VENUE: bootstrapped on the BITCOIN regtest stack (COIN=bitcoin) with the
 * DOGECOIN regtest stack up and a seeded four-source federation. See
 * test/helpers/rollcallHelper.js bringUpVenue for the full precondition list;
 * E2E_REQUIRE_FEDERATION=1 opts in (npm run test:rollcall sets it).
 *
 ********************************************************************/


'use strict'

const rc     = require('../helpers/rollcallHelper')
const shared = require('./rollcall_gates.test/support/shared')
const zc7a   = require('./rollcall_gates.test/01_zc7a_gate_rows.test')
const zc7b   = require('./rollcall_gates.test/02_zc7b_short_gate_list.test')
const zc7c   = require('./rollcall_gates.test/03_zc7c_filter_scope.test')
const zc7d   = require('./rollcall_gates.test/04_zc7d_rules_aware_revert.test')

async function setUp(suite, st){
    if (!shared.venueReady(suite)) return
    await shared.bringUp(st)
    await shared.loadProvider(st)
    await shared.planEpochs(st)
}

describe('ROLLCALL acceptance: the rules-aware attestation set (ZC7)', function () {
    this.timeout(60 * 60 * 1000)

    // The parts share what each one measured through this record and run in the
    // order registered below.
    const st = shared.newState()

    before(async function () { await setUp(this, st) })

    after(async function () { await rc.tearDownVenue(st.ctx) })

    zc7a.register(st)
    zc7b.register(st)
    zc7c.register(st)
    zc7d.register(st)
})
