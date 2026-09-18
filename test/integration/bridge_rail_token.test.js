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
 *
 * THE TOKEN BRIDGE ACCEPTANCE DRIVE: token AT1 to AT8, over the base drive's venue shape (a harness federation of the seated roster
 * keys, a venue BTC clone, a venue DOGE indexer REPLAYED from genesis under this tree's
 * bridge code). AT9 is the gate run plus the activation parity test and is not a drive.
 *
 * ── ONE SUITE IN TWO PLACES ────────────────────────────────────────────────────────
 * This root holds the venue bring-up, the T0 precondition and the arming case; the legs
 * live in `bridge_rail_token.test/0*.test.js` and share the venue through
 * `./bridge_rail_token.test/support`. ONE mocha run, root first, glob quoted, never
 * `--sort` (bridge_rail_base.test.js says why):
 *
 *   npx mocha test/integration/bridge_rail_token.test.js "test/integration/bridge_rail_token.test/*.test.js"
 *
 * ── HOW TO RUN IT, on the regtest rail host, from this repository root ──────────────
 *
 *   nohup ~/scratch/xc-meta/doge-loop.sh >/dev/null 2>&1 & echo $! > ~/scratch/xc-meta/doge-loop.pid
 *   COIN=bitcoin NETWORK=regtest NODE_PATH=<the chunked module directory> \
 *     BRIDGE_RAIL_REPO_ROOT=<the pinned root the standing containers were built from> \
 *     BRIDGE_RAIL_MINER_PAUSE_FILE=<flag file the BTC loop honours> \
 *     BRIDGE_RAIL_DOGE_MINER_PAUSE_FILE=<flag file the DOGE loop honours> \
 *     npx mocha --timeout 0 --exit --require ./test/initialCheck.test.js \
 *     test/integration/bridge_rail_token.test.js "test/integration/bridge_rail_token.test/*.test.js"
 *   kill $(cat ~/scratch/xc-meta/doge-loop.pid)
 *
 * The federation secret is sourced from the operator's own 0600 store into the
 * environment and passed no other way (`resolveVenueQuorum` is the gate; without it every
 * federated case skips with the reason named). One leg (`--grep "token AT<n>"`) can be
 * run alone only together with the root and the parts that come before it in the order
 * below, because the later legs read rows the earlier ones created.
 *
 * ── THE ORDER IS NOT THE SPEC'S NUMBERING, AND HERE IS WHY ─────────────────────────
 * AT8's retraction claim, "DOGE never gains a root row" (D45: a retracted FIRST in-leg
 * must leave no root row), is only a claim while no in-leg has applied yet. So the
 * retraction leg runs FIRST, right after the engine is armed, on its own tick, and its
 * lock rides back into the chain when mining resumes (the reorg suite's header says why
 * an orphaned lock cannot be kept out): that legitimate second finalization is what
 * creates the BTC root on DOGE, and the leg asserts that creation too. AT1 then proves
 * the child row under an existing root, which is the shape every later token takes.
 * Otherwise the legs run in numbered order, AT8's cap and invariant halves last.
 *
 * ── WHAT THE REGTEST RAIL READS DIFFERENTLY FROM THE SPEC TEXT, MEASURED ──────────
 * `TOKEN_POLICY_INHERITANCE_ACTIVATION` is 0 on regtest (xchain-indexer
 * protocol_changes/shared_rows_5.js), so the policy spec's flag day is ACTIVE on this
 * rail and the token spec's milestone-1 refusals for policy-bound tokens are lifted
 * exactly as that spec's AT1 says ("refused below the flag, applied above it"). AT6
 * reads the indexer's own registry at the case's block and asserts the verdicts the
 * flag state implies: refused with the milestone-1 strings below it, applied above it,
 * with the format 6 controller bind refused either way. Both readings are journaled.
 *
 * ── EVERY DOGE-SIDE READ IS ON THE VENUE LEDGER, ASSERT BY IDENTITY ─────────────────
 * As the base drive: the standing DOGE indexer parsed a different history, and a count
 * over a set this small passes against broken code half the time.
 *
 * Acceptance section 10 of the token bridge drive, decisions D24, D29 and D45; the
 * base drive's section 15 for the venue.
 *
 ********************************************************************/

'use strict';

const {
    assert,
    GAS_TICK,
    state,
    rowsLike,
    pickFreeTick,
    chainHalves,
    needsFederation,
    bridgeRailSuite,
} = require('./bridge_rail_token.test/support');

const T0 = 'token T0: the destination ledger before any token leg';

// ── THE QUIET BEFORE THE FIRST IN LEG ──────────────────────────────────────────
bridgeRailSuite(T0, function () {
    it('token AT1 precondition: no BTC root row on the DOGE ledger in any case, and the native tick is free', async function () {
        this.timeout(0);
        if (needsFederation(this, 'token AT1 precondition')) return;
        const T = state.tokens;
        const btcRows = await rowsLike('DOGE', 'BTC');
        state.evidence.at1_dogeBtcRootBefore = btcRows.map((r) => r.tick);
        assert.deepStrictEqual(btcRows, [],
            'the venue DOGE ledger already holds a root row spelled like BTC: ' + JSON.stringify(btcRows) +
            '. A PREVIOUS run of this drive applied an in leg into this same stable database. Drop the ' +
            'venue DOGE indexer and mirror databases (`..._bridgerailtokendoge_Rpl_Ixr0`, ' +
            '`..._bridgerailtokendoge_Mirror0`) and let it replay from genesis.');
        T.tick = await pickFreeTick(['FUFU', 'FUFB', 'FUFC', 'FUFD']);
        assert.ok(T.tick, 'no free native tick among FUFU..FUFD on the venue BTC ledger');
        T.bridged = 'BTC.' + T.tick;
        state.evidence.tick = T.tick;
        state.evidence.bridgeRoleDoge = await state.venue.roleAddress('DOGE', 'BRIDGE_BTC');
        state.evidence.bridgeRoleBtc = await state.venue.roleAddress('BTC', 'BRIDGE_DOGE');
        assert.ok(state.evidence.bridgeRoleDoge, 'DOGE resolves no BRIDGE_BTC role address');
    });
});

bridgeRailSuite(T0, function () {
    it('arms the venue bridge engine, drains the XCHAIN backlog and takes the XCHAIN baseline (token AT8 control)', async function () {
        this.timeout(0);
        if (needsFederation(this, 'the token baseline')) return;
        // The base drive's note 3: arming re-finalizes every historical XCHAIN lock, and a
        // reading taken while that lands measures two events. The wait is on the
        // destination's settlement rows, not on in_flight.
        const overlay = await state.venue.rewireHubs();
        state.evidence.engineEnv = Object.keys(overlay).sort().join(', ');
        const settled = await state.venue.waitForRailSettled(GAS_TICK, { timeoutMs: 60 * 60 * 1000 });
        assert.ok(settled, 'the XCHAIN backlog never drained: ' + JSON.stringify(state.venue._lastSettlePoll) +
            '\n' + state.venue.indexerTails(40));
        state.evidence.backlogApplied = settled.applied;
        const dupes = await state.venue.duplicateSourceTransfers();
        state.evidence.overFinalizedSourceLegs = dupes;
        assert.deepStrictEqual(dupes, [],
            'the federation finalized ' + dupes.length + ' source leg(s) more than once: ' + JSON.stringify(dupes));
        state.baseline = { xchain: await chainHalves(), invariant: settled.invariant || null };
        state.evidence.xchainBaseline = state.baseline;
    });
});
