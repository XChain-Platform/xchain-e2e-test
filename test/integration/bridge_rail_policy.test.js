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
 * THE POLICY INHERITANCE ACCEPTANCE DRIVE: policy AT1 to AT10 of
 * claude/specs/xchain-token-bridge-policy.md section 11, on the token drive's venue shape
 * (a harness federation of the seated roster keys, one venue BTC indexer per hub, a venue
 * DOGE indexer REPLAYED from genesis under this tree's code).
 *
 * ── ONE SUITE IN TWO PLACES ────────────────────────────────────────────────────────
 * This root holds the venue bring-up, the T0 precondition and the arming case; the legs
 * live in `bridge_rail_policy.test/*.test.js` and share the venue through
 * `./bridge_rail_policy.test/support`, which is the token drive's support factory under the
 * policy drive's own label. ONE mocha run, root first, glob quoted, never `--sort`:
 *
 *   npx mocha test/integration/bridge_rail_policy.test.js "test/integration/bridge_rail_policy.test/*.test.js"
 *
 * ── HOW TO RUN IT, on the regtest rail host, from this repository root ──────────────
 *
 *   COIN=bitcoin NETWORK=regtest NODE_PATH=<the chunked module directory> \
 *     BRIDGE_RAIL_REPO_ROOT=<the pinned root the venue spawns from> \
 *     BRIDGE_RAIL_MINER_PAUSE_FILE=<flag file the BTC loop honours> \
 *     BRIDGE_RAIL_DOGE_MINER_PAUSE_FILE=<flag file the DOGE loop honours> \
 *     npx mocha --timeout 0 --exit --require ./test/initialCheck.test.js \
 *     test/integration/bridge_rail_policy.test.js "test/integration/bridge_rail_policy.test/*.test.js"
 *
 * The federation secret is sourced from the operator's own 0600 store into the environment
 * and passed no other way (`resolveVenueQuorum` is the gate; without it every federated case
 * skips naming the reason). A leg run alone (`--grep "policy AT<n>"`) needs the root and
 * every part before it, because later legs read the tokens earlier ones bridged.
 *
 * ── THE ORDER IS NOT THE SPEC'S NUMBERING, AND HERE IS WHY ─────────────────────────
 * AT9 runs before AT8: AT8 reorgs the DOGE chain under the copies, and AT9's refusals are
 * claims about the ledger AT1 to AT7 left, not about a reorged one. AT8's invariant is read
 * FIRST inside AT8, before its own cap and reorg legs move anything. AT10 is a gate run and
 * is registered last, skipped, with the reason.
 *
 * ── WHAT THE REGTEST RAIL READS DIFFERENTLY FROM THE SPEC TEXT ────────────────────
 * `TOKEN_POLICY_INHERITANCE_ACTIVATION` is 0 on regtest, so every case runs ABOVE the flag.
 * The "below the flag" halves (AT1's refusal, AT7's list_items_invalid) cannot exist on this
 * chain and are skipped with the spec sentence quoted; each opt-in still journals the flag
 * state it was graded under.
 *
 * Spec: claude/specs/xchain-token-bridge-policy.md sections 3 to 11; the token spec's
 * section 10 and the base spec's section 15 for the venue.
 *
 ********************************************************************/

'use strict';

const {
    assert,
    GAS_TICK,
    state,
    rowsLike,
    chainHalves,
    needsFederation,
    bridgeRailSuite,
} = require('./bridge_rail_policy.test/support');

const T0 = 'policy T0: the destination ledger before any policy leg';

bridgeRailSuite(T0, function () {
    it('policy AT1 precondition: the venue DOGE ledger has applied no policy snapshot and resolves a BRIDGE_BTC role address', async function () {
        this.timeout(0);
        if (needsFederation(this, 'policy AT1 precondition')) return;
        const applied = await state.venue.queryIndexerDb('DOGE',
            "SELECT transfer_id, tick FROM bridge_settlements WHERE kind = 'policy'", []);
        state.evidence.policySettlementsBefore = applied.length;
        assert.deepStrictEqual(applied.map((r) => String(r.tick)), [],
            'the venue DOGE ledger already applied policy snapshots: a PREVIOUS run of this drive left them in ' +
            'this stable database. Drop `..._bridgerailpolicydoge_Rpl_Ixr0` and `..._bridgerailpolicydoge_Mirror0` ' +
            'and let the DOGE indexer replay from genesis.');
        state.evidence.bridgeRoleDoge = await state.venue.roleAddress('DOGE', 'BRIDGE_BTC');
        assert.ok(state.evidence.bridgeRoleDoge, 'DOGE resolves no BRIDGE_BTC role address');
        state.evidence.btcRootOnDogeBefore = (await rowsLike('DOGE', 'BTC')).map((r) => r.tick);
    });
});

bridgeRailSuite(T0, function () {
    it('arms the venue bridge engine, drains the XCHAIN backlog and takes the XCHAIN baseline (policy AT8 control)', async function () {
        this.timeout(0);
        if (needsFederation(this, 'the policy baseline')) return;
        // Arming re-finalizes every historical lock on the rail, token locks included, and a
        // reading taken while that lands measures two events (token drive, the same case).
        const overlay = await state.venue.rewireHubs();
        state.evidence.engineEnv = Object.keys(overlay).sort().join(', ');
        state.evidence.btcIndexersPerHub = state.venue.btcVenue.indexers.map((ix) => ix.index + '->hub' + ix.followsHub);
        const settled = await state.venue.waitForRailSettled(GAS_TICK, { timeoutMs: 60 * 60 * 1000 });
        assert.ok(settled, 'the XCHAIN backlog never drained: ' + JSON.stringify(state.venue._lastSettlePoll) +
            '\n' + state.venue.indexerTails(40));
        const dupes = await state.venue.duplicateSourceTransfers();
        assert.deepStrictEqual(dupes, [],
            'the federation finalized ' + dupes.length + ' source leg(s) more than once: ' + JSON.stringify(dupes));
        state.baseline = { xchain: await chainHalves(), invariant: settled.invariant || null };
        state.evidence.xchainBaseline = state.baseline;
    });
});
