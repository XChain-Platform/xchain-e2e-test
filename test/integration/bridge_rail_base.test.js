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
 * THE BRIDGE ACCEPTANCE DRIVE, base legs: AT1, AT2, AT5, AT6, AT7, AT9.
 * (AT3 and AT4 are in bridge_rail_reorg.test.js; AT8 is the gate run and is not
 * a drive at all.)
 *
 * HOW TO RUN IT, on the regtest rail host, from this repository root:
 *
 *   nohup ~/scratch/xc-meta/doge-loop.sh >/dev/null 2>&1 & echo $! > ~/scratch/xc-meta/doge-loop.pid
 *   COIN=bitcoin NETWORK=regtest NODE_PATH=<the chunked module directory> \
 *     npx mocha --timeout 0 --exit --require ./test/initialCheck.test.js \
 *     test/integration/bridge_rail_doge_guards.test.js test/integration/bridge_rail_base.test.js
 *   kill $(cat ~/scratch/xc-meta/doge-loop.pid)
 *
 * The DOGE block loop is not optional: the DOGE miner is mempool-driven, so a DOGE leg
 * that is broadcast and never mined reads exactly like a leg the federation ignored.
 *
 * ── WHAT THIS SUITE CAN AND CANNOT DRIVE TODAY, MEASURED NOT ASSUMED ────────────────
 *
 * Two preconditions of the acceptance set are properties of the ENVIRONMENT rather than
 * of the bridge, both were measured on the regtest rail on 2026-09-12, and both are
 * recorded here rather than worked around, because working around either would produce a
 * green run that proves something other than the AT.
 *
 * 1. THE QUORUM IS DERIVABLE ONLY FROM A SECRET THE DRIVE MUST BE GIVEN (it gates every
 *    AT that needs a federation: AT1, AT2, AT5, AT6's invariant legs, AT7). dq 1 was
 *    ruled option (a), a venue mesh on "the four derivable seeded keys". All four BTC
 *    regtest capability sets (cross_chain, price, oracle_publish, attestation) hold the
 *    same five keys at block 597: the four roster keys at 50000 each and the standing
 *    hub's lost key at 10000. The four were staked on 2026-09-08 by
 *    `test/tools/reseedAttestationRoster.test.js` and are idle GENERATIONS 0 to 3 of the
 *    venue's seeding mnemonic. `mirrorDrillFixture._knownSignerSeeds()` sweeps those
 *    generations only when `XC_ROLLCALL_FEDERATION_MNEMONIC` is in the environment: with
 *    the variable absent it holds four keys, none of them seated, the venue hubs hold 0
 *    of 210000 staked units, and every round times out at `0 commits`, which reads at
 *    the drive as "the bridge does not work". With it, the harness adopts 4 of 5 and
 *    holds 200000 of 210000.
 *
 *    So a drive sources that secret from the operator's own 0600 store into its
 *    environment and passes it no other way. It is never named, quoted or defaulted in
 *    this tree, never echoed and never put on a command line. The gate is
 *    `resolveVenueQuorum`, evaluated ONCE in the root hook; a drive that was not given
 *    the secret skips every federated case below with that reason named rather than
 *    failing thirty minutes later on a round that was never going to close.
 *
 * 2. THE DOGE LEDGER ALREADY HOLDS AN XCHAIN ROW (blocks AT1's stated precondition).
 *    Measured on the standing DOGE regtest indexer database: tick XCHAIN, supply 613400,
 *    max_supply 100000000, decimals 0, mint_start_block 0, one `issues` row at
 *    action_index 326. It is the pre-bridge `gasHelper.mintGas` self-seed: a broadcast
 *    `ISSUE XCHAIN` on DOGE, which the OLD issue.js exempted on regtest and which D62
 *    now refuses unconditionally.
 *
 *    That has a consequence worth stating plainly, because it is a property of the
 *    CLONE and not of the chain: a venue indexer seeded by copying the standing DOGE
 *    database inherits a token row the bridge code's own rules forbid, so it cannot
 *    assert AT1's precondition and its first in-leg would find the row already there
 *    and inject nothing. A venue indexer that REPLAYS DOGE regtest from genesis under
 *    bridge code refuses that historical ISSUE and holds no XCHAIN row, which is the
 *    ledger AT1 describes. AT1's precondition case therefore ASSERTS the absence and
 *    fails with that instruction rather than adapting to the row, because a drive that
 *    adapted would be measuring the mint into an existing row and calling it AT1.
 *
 *    RULED dq 5, option (a), 2026-09-12: the venue DOGE indexer replays. Selecting it is
 *    `dogeReplayChain` on the venue, which is `replayChain` on the DOGE
 *    `AttestMirrorVenue` underneath, and it is NOT `freshIndexers`: that option asks for
 *    a fresh DATABASE and then seeds it from the standing node all the same, so the
 *    ledger it yields is the cloned one either way and AT1 would still find the row.
 *    The cost the ruling accepts is that every DOGE regtest action downstream of that
 *    XCHAIN supply re-grades under today's rules, and it is confined to this venue's own
 *    disposable database; no standing container and no standing database is touched.
 *
 * 3. THE RAIL CARRIES 35 XCHAIN OF ESCROW FROM EARLIER DRIVE ATTEMPTS AND CANNOT BE MADE
 *    VIRGIN AGAIN. A v0 lock credits `ADDRESS.BRIDGE_DOGE` on BTC the moment it is parsed,
 *    with no federation in the loop, so every attempt that got as far as broadcasting a
 *    lock left units there for good; `cryptoHelper` generates a fresh mnemonic per PROCESS,
 *    so the DOGE keys those units were locked to no longer exist and they can never be
 *    burned back. On top of that `getpendingbridgetransfers` answers every valid XBRIDGE
 *    leg the chain has carried that the indexer's own mirror holds no transfer for (every
 *    leg on a venue whose mirror was just dropped), so a venue federation on a new hub
 *    database re-finalizes the whole backlog the instant its engine has indexer URLs; and
 *    since that read gained its settled filter (indexer d93294d8) the pending list empties
 *    the moment the federation has signed, minutes before the destination applies, so the
 *    drain wait reads the hubs' own rows as well (drive 18 took its baseline in that gap).
 *
 *    So this drive ARMS THE ENGINE ITSELF. The venue starts with `deferBridgeWiring`, which
 *    leaves the bridge engine without indexer URLs and therefore idle; the two readings
 *    that must be taken before any in leg lands (AT1's precondition and AT9's before-half)
 *    are taken in that quiet, then `rewireHubs()` arms the engine, the backlog drains, and
 *    the BASELINE every later assertion is a delta from is taken after it. The absolute
 *    readings section 15 writes for AT1 and AT2 ("the DOGE XCHAIN supply is 5", "the escrow
 *    address is 3") describe the virgin rail and are driven as exact deltas of the same
 *    size; every other assertion is unchanged.
 *
 * ── ASSERT BY IDENTITY, NEVER BY COUNT ─────────────────────────────────────────────
 * Every assertion below names the address, the tick, the amount or the transfer id it
 * is about. Over a set this small a count or an ordering assertion passes against
 * broken code about half the time, which is worse than no assertion because it is
 * reported as evidence.
 *
 * ── EVERY DOGE-SIDE READ IS ON THE VENUE LEDGER ─────────────────────────────────────
 * The harness's `*Helper.send*` functions wait on the global `indexerDatabase`, which is
 * the STANDING indexer's database for whichever rail is current. On the BTC side that is
 * the same chain parsed by the same code and the two agree. On the DOGE side it is a
 * DIFFERENT LEDGER (this venue replays under bridge code; the standing node kept its own
 * history), so the waiting helpers are used for BTC legs only and every DOGE leg here is
 * broadcast raw and graded through `venue.verdict`. AT7's airdrop died on exactly that
 * confusion on drive 7: it waited for a `status=valid` row on a ledger that had never been
 * credited.
 *
 * ── MOCHA RUNS A SUITE'S OWN TESTS BEFORE ITS CHILD SUITES ──────────────────────────
 * Which is why every acceptance test below sits in its own `describe` and this file has no
 * bare `it` at the top level. On drive 7 AT5, AT7 and AT9 were bare `it`s and therefore ran
 * FIRST, before the AT1 lock they each depend on: AT5 died on `evidence.at1` being
 * undefined and AT7 broadcast a lock into a rail whose ledger held nothing.
 *
 * Spec: the base bridge spec, section 15; dq 1.
 *
 ********************************************************************/

'use strict';

const {
    assert,
    chainRail,
    cryptoHelper,
    transactionHelper,
    escrowOf,
    driveVerdictWitness,
    GAS_TICK,
    state,
    assertBacked,
    needsFederation,
    bridgeRailSuite,
} = require('./bridge_rail_base.test/support');

// ── THE QUIET BEFORE THE FIRST IN LEG ──────────────────────────────────────────
// Two readings are only true while no XCHAIN has ever landed on the destination
// ledger, and the venue's bridge engine is deliberately unarmed for exactly as long as
// they take. Arming it is the last case here.
bridgeRailSuite('the destination ledger before any in leg (AT1 precondition, AT9 witness)', function () {

    it('AT1 precondition: finds no XCHAIN row on the destination ledger before the first in leg', async function () {
        this.timeout(0);
        if (needsFederation(this, 'AT1 precondition')) return;
        const present = await state.venue.hasTokenRow('DOGE', GAS_TICK);
        state.evidence.at1_dogeXchainRowBefore = present;
        assert.strictEqual(present, false,
            'AT1 requires a DOGE ledger with no XCHAIN row, and this venue indexer holds one. ' +
            'Either it was SEEDED BY CLONING the standing DOGE database rather than by replaying ' +
            'the chain under bridge code (the row would then be the pre-D62 broadcast ISSUE at ' +
            'action_index 326, supply 613400, which the landed issue.js refuses unconditionally ' +
            'off BTC), or a PREVIOUS run of this drive already applied an in leg into this same ' +
            'stable database. Drop the venue DOGE indexer and mirror databases and let it replay ' +
            'from genesis: they are named `..._bridgeraildoge_Rpl_Ixr0` and `..._bridgeraildoge_Mirror0`.');
    });
});

bridgeRailSuite('the destination ledger before any in leg (AT1 precondition, AT9 witness)', function () {
    it('AT9 witness: the controller-guarded SEND, ORDER and DISPENSER verdicts on this ledger, before XCHAIN exists', async function () {
        this.timeout(0);
        if (needsFederation(this, 'AT9 before-half')) return;
        state.witnessBefore = await chainRail.withRail(state.dogeRail, () => driveVerdictWitness(
            { cryptoHelper, transactionHelper, network: NETWORK, gasTick: GAS_TICK },
            state.venue.dogeVenue, 'AT9.BEFORE'));
        state.evidence.at9_before = state.witnessBefore;
        for (const action of ['SEND', 'ORDER', 'DISPENSER']) {
            assert.ok(state.witnessBefore[action],
                'the ' + action + ' from ' + state.witnessBefore.source + ' (tx ' +
                state.witnessBefore.txids[action] + ') was never indexed, so AT9 has no witness for it');
            assert.match(state.witnessBefore[action], /^(valid|invalid: )/,
                action + ' carried the unrecognised verdict ' + state.witnessBefore[action]);
        }
        // The witness is only a witness if the row still did not exist while it was
        // taken; asserting it AFTER is what makes the before-half honest.
        assert.strictEqual(await state.venue.hasTokenRow('DOGE', GAS_TICK), false,
            'an XCHAIN row appeared on the DOGE ledger while the AT9 before-witness was being ' +
            'taken, so the witness is not a reading of a chain without XCHAIN. The venue engine ' +
            'was armed too early.');
    });
});

bridgeRailSuite('the destination ledger before any in leg (AT1 precondition, AT9 witness)', function () {
    it('arms the venue bridge engine, drains the rail backlog and takes the baseline', async function () {
        this.timeout(0);
        if (needsFederation(this, 'the rail baseline')) return;
        // This is the moment the federation starts work. See note 3 in the header for
        // why the backlog exists and why it cannot be cleared off the rail instead.
        const overlay = await state.venue.rewireHubs();
        state.evidence.engineEnv = Object.keys(overlay).sort().join(', ');

        const settled = await state.venue.waitForRailSettled(GAS_TICK, { timeoutMs: 60 * 60 * 1000 });
        assert.ok(settled, 'the rail backlog never drained: every XBRIDGE leg on the chain must ' +
            'reach a finalized hub row and a destination bridge_settlements row before a baseline ' +
            'means anything. Outstanding at timeout: ' +
            JSON.stringify(state.venue._lastSettlePoll) + '\n' + state.venue.indexerTails(40));
        state.evidence.backlogApplied = settled.applied;

        state.baseline = {
            escrow: escrowOf(await state.venue.bridgeBalances('BTC', GAS_TICK), 'DOGE'),
            dogeSupply: (await state.venue.bridgeBalances('DOGE', GAS_TICK)).supply,
            invariant: settled.invariant ? settled.invariant[GAS_TICK] : null,
        };
        state.evidence.baseline = state.baseline;
        // WHAT REACHED THE ESCROW WITHOUT BEING A BRIDGE LEG, measured off the venue's own
        // BTC ledger. The escrow is a plain address and a stray SEND to it mints nothing
        // (D65), so those units sit in the escrow balance for good with nothing on the
        // destination to match them. Recorded before any assertion below uses it, because
        // it is the term that makes the two chain halves comparable at all.
        state.baseline.nonBridgeEscrow = await state.venue.escrowNonBridgeCredits('BTC', 'BRIDGE_DOGE', GAS_TICK);
        state.evidence.baselineNonBridgeEscrow = state.baseline.nonBridgeEscrow;
        // ASKED BEFORE THE ARITHMETIC, because one lock finalizing twice makes every
        // number below disagree and a number cannot say which side invented value.
        // Drive 11 measured BTC lock 99 (5 XCHAIN) finalized three times and lock 95
        // (30 XCHAIN) twice, so 80 XCHAIN locked read as 120 XCHAIN minted; see
        // `overFinalizedSourceLegs` for the hub path that allows it.
        const dupes = await state.venue.duplicateSourceTransfers();
        state.evidence.overFinalizedSourceLegs = dupes;
        assert.deepStrictEqual(dupes, [],
            'the federation finalized ' + dupes.length + ' source leg(s) more than once, so the ' +
            'destination minted value no lock paid for and every reading below is arithmetic on ' +
            'an inflated supply: ' + JSON.stringify(dupes));
        // The two chain halves must agree at the baseline: that is the invariant's real
        // claim, and it is asserted here on the numbers rather than on the hub's `delta`,
        // whose in_flight term is broken on a rail with history (AT6 records that).
        //
        // LESS THE NON-BRIDGE CREDITS, because a bare equality is unsatisfiable on this
        // rail and says nothing when it fails. Measured 2026-09-13: the escrow read 118
        // against a destination supply of 115, and the whole difference is three plain
        // SENDs of 1 XCHAIN into the escrow address (BTC actions 107, 113 and 119) left by
        // three earlier attempts at AT6's D65 case. A SEND to the escrow mints nothing and
        // the escrow key is nobody's, so those units are there for good and every later
        // drive adds one more. See `chainHalves`.
        assertBacked({ escrow: state.baseline.escrow, supply: state.baseline.dogeSupply,
                       nonBridge: state.baseline.nonBridgeEscrow,
                       backed: Number(state.baseline.escrow) - Number(state.baseline.nonBridgeEscrow.net) },
                     'the drained baseline');
    });
});
