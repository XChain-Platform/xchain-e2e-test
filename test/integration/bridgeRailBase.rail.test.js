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
 * (AT3 and AT4 are in bridgeRailReorg.rail.test.js; AT8 is the gate run and is not
 * a drive at all.)
 *
 * HOW TO RUN IT, on the regtest rail host, from this repository root:
 *
 *   nohup ~/scratch/xc-meta/doge-loop.sh >/dev/null 2>&1 & echo $! > ~/scratch/xc-meta/doge-loop.pid
 *   COIN=bitcoin NETWORK=regtest NODE_PATH=<the chunked module directory> \
 *     npx mocha --timeout 0 --exit --require ./test/initialCheck.test.js \
 *     test/integration/bridgeRailBase.rail.test.js
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
 *    leg the chain has ever carried, with no settled filter, so a venue federation on a new
 *    hub database re-finalizes the whole backlog the instant its engine has indexer URLs.
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

const assert = require('assert');

const chainRail         = require('../helpers/chainRail');
const stakeTeardown     = require('../helpers/stakeTeardown');
const cryptoHelper      = require('../cryptoHelper');
const transactionHelper = require('../transactionHelper');
const issueHelper       = require('../helpers/issueHelper');
const mintHelper        = require('../helpers/mintHelper');
const fixture           = require('../attestMirror/mirrorDrillFixture');
const {
    BridgeRailVenue,
    resolveVenueQuorum,
    lockWireV0,
    burnWireV1,
    classifyInvariant,
    escrowOf,
    minimalQuorumSigners,
    driveVerdictWitness,
    journalCase,
} = require('../helpers/bridgeRailVenue');

const GAS_TICK = 'XCHAIN';

// AT1 locks 5, AT2 burns 2 of them, AT7 mints and locks 30. Named rather than inlined
// so the invariant arithmetic at AT6 quotes the same numbers the legs moved.
const AT1_LOCK   = 5;
const AT2_BURN   = 2;
const AT7_MINT   = 30;
const AT7_EACH   = 10;

describe('XBRIDGE acceptance drive on the BTC/DOGE regtest rail (AT1, AT2, AT5, AT6, AT7, AT9)', function () {

    let venue = null;
    let quorum = null;
    let dogeRail = null;
    // AT1's destination address RECORD (address plus its key material), kept so AT2, AT5
    // and AT6 can sign from it. `cryptoHelper.getWallet(label)` answers the WALLET
    // (mnemonic, seed, an addresses array) and NOT one address, so `w.privateKey` is
    // undefined and a burn signed from it dies in ecpair with "Expected Buffer, got
    // undefined" before it is ever a bridge question. Never folded into `evidence`, which
    // is printed.
    let at1Dest = null;
    // The AT9 witness taken on THIS venue's own DOGE ledger, before any in leg. NOT the
    // guards suite's: that one runs against a CLONED ledger which already holds the
    // pre-D62 XCHAIN row, so its verdicts are the ones a chain WITH XCHAIN carries and
    // comparing them to this ledger's measures the clone, not the bridge. Drive 7 failed
    // AT9 exactly there, `insufficient funds` against `TICK (unknown)`.
    let witnessBefore = null;
    // What the rail already held when this drive armed the engine and the backlog drained.
    // Every later assertion is an exact delta from this; see note 3 in the header.
    let baseline = null;
    let blocked = null;      // non-null: the measured reason no federated case can run
    // The venue's DOGE/USD quote and its age as the CURRENT case started, read before the
    // per-case reseed touched it. This is the only reading that can tell a clock refusal from
    // a pricing-code refusal, because after the reseed every row is fresh by construction.
    let priceBeforeCase = null;
    const evidence = {};     // every readout this drive took, printed at the end

    // The DOGE actions this drive broadcasts raw, with the table each one's verdict lives
    // on. Named here so a case cannot quietly read `sends` for an ORDER and find nothing.
    const EXPIRY = () => Math.floor(Date.now() / 1000) + 90 * 24 * 3600;

    /**
     * Broadcast one action on DOGE and read its verdict OFF THE VENUE LEDGER.
     *
     * `wire` is either the raw action string or a function that broadcasts and answers the
     * txid (for the actions a helper already knows how to spell); `table` is the action
     * table the verdict lives on, because a verdict is never on `actions`.
     */
    async function dogeAction(from, wire, table) {
        const tx = await chainRail.withRail(dogeRail, () => (typeof wire === 'function'
            ? wire()
            : transactionHelper.createAndSendTransaction(from, wire)));
        const got = await venue.verdict('DOGE', table, tx);
        assert.ok(got, 'the venue DOGE indexer never graded the ' + table + ' action in tx ' + tx +
            ' within the budget.\n' + venue.indexerTails(40));
        return { tx: tx, status: got.status, actionIndex: got.actionIndex };
    }

    /**
     * The two chain halves of the invariant, plus the term that makes them comparable.
     *
     * The claim section 15 writes as "the invariant reads equal on BTC and DOGE" is that the
     * destination holds exactly what the origin escrow backs. The escrow is a plain address,
     * though, and a SEND to it is applied like any other send and mints nothing (D65): those
     * units sit in the escrow balance with nothing on the destination to match them, and the
     * escrow key is nobody's so they can never leave again. This rail carries three of them,
     * one from each earlier attempt that reached AT6's surplus case, and it will carry one
     * more after every drive that reaches it. So the comparable quantity is the escrow LESS
     * the non-bridge credits, measured off the venue's own ledger at the moment of the read
     * rather than carried as a constant, and `backed` is that number.
     *
     * ONE DEFINITION, used by the baseline, by AT6's invariant and by AT7, because three
     * copies of an arithmetic identity are three chances to correct only two of them.
     */
    async function chainHalves() {
        const escrow = escrowOf(await venue.bridgeBalances('BTC', GAS_TICK), 'DOGE');
        const supply = (await venue.bridgeBalances('DOGE', GAS_TICK)).supply;
        const nonBridge = await venue.escrowNonBridgeCredits('BTC', 'BRIDGE_DOGE', GAS_TICK);
        return { escrow: escrow, supply: supply, nonBridge: nonBridge,
                 backed: Number(escrow) - Number(nonBridge.net) };
    }

    /**
     * Assert the identity the two chain halves must satisfy, naming every term.
     *
     * A bare `escrow === supply` is unsatisfiable on a rail that has ever carried a stray
     * SEND, which is what drive 13's baseline failed on (escrow 118, supply 115).
     */
    function assertBacked(halves, where) {
        assert.strictEqual(halves.backed, Number(halves.supply),
            'at ' + where + ' the BTC escrow holds ' + halves.escrow + ', of which ' +
            halves.nonBridge.net + ' arrived through actions that are not XBRIDGE legs (' +
            JSON.stringify(halves.nonBridge.byAction) + '), leaving ' + halves.backed +
            ' backed by locks, where the DOGE ledger reports a supply of ' + halves.supply +
            '. Those two are the same units counted on two chains, so a difference is a real ' +
            'break and not a timing artefact.');
    }

    before(async function () {
        this.timeout(0);

        // WHICH TREE THIS DRIVE IS ACTUALLY RUNNING, recorded rather than assumed. A drive
        // can pin the code under test to one worktree through BRIDGE_RAIL_REPO_ROOT, and the
        // venue spawns its hubs and indexers out of it, but the TEST process loads indexer
        // modules of its own (the barrier names, and the gas-token parameter set AT1 grades
        // against). On drive 13 those came from the shared checkout while everything else came
        // from the pinned root, and the only reason it did not matter is that the two copies
        // differed by one comment line. So the module cache is read here and quoted in the
        // readouts: a path outside the pinned root is visible in the evidence instead of being
        // something a later reader has to re-derive.
        evidence.repoRoot = process.env.BRIDGE_RAIL_REPO_ROOT || null;
        evidence.indexerModulesLoaded = Object.keys(require.cache)
            .filter((p) => /xchain-indexer[\\/]src[\\/]/.test(String(p))).sort();

        dogeRail = await chainRail.createRail('dogecoin', NETWORK);

        // THE QUORUM GATE, and it is read off the LIVE chain rather than from a fixture:
        // the seated set is what it is at drive time, and a gate on a hard-coded roster
        // would keep passing after the roster changed.
        const tip = await indexerConnector.call('getblockhashes', {});
        const buried = Number(tip.block_index) -
            Number(require('../helpers/hubMirrorTopology').CANONICAL_REORG_BUFFER || 6);
        const set = await stakeTeardown.readCapabilitySet({
            indexer: indexerConnector, capability: 'cross_chain', blockIndex: buried,
        });
        assert.ok(set && !set.error,
            'the cross_chain capability set could not be read at buried block ' + buried +
            '. That is an INSTRUMENT failure and says nothing about the rail.');

        const seated = set.pubkeys.map((pk) => {
            const row = set.byPubkey.get(pk) || {};
            return { pubkey: pk, stake: Number(row.weight || 0) };
        });
        quorum = resolveVenueQuorum(seated, fixture._knownSignerSeeds());
        evidence.seated = seated.map((s) => s.pubkey.slice(0, 16) + '@' + s.stake).join(', ');
        evidence.buriedBlock = buried;
        evidence.btcTip = Number(tip.block_index);

        if (!quorum.ok) {
            blocked = quorum.reason;
            console.log('\nBRIDGE RAIL: no federation can be built here.\n  ' + blocked +
                '\n  seated at block ' + buried + ': ' + evidence.seated + '\n');
            return;
        }

        // THE MINIMUM QUORUM, NOT EVERY KEY THE HARNESS HOLDS. With all four seated keys a
        // round closes on any three and the fourth silently keeps no record; an indexer
        // mirrors exactly one hub, so whether the destination ever sees a transfer becomes a
        // coin toss. See `minimalQuorumSigners` for the measurement.
        const mesh = minimalQuorumSigners(quorum.signers.adopted, quorum.signers.totalStake);
        assert.ok(mesh.length, 'no subset of the adopted keys clears the supermajority, which ' +
            'resolveVenueQuorum should already have refused');
        evidence.meshSize = mesh.length;
        evidence.meshStake = mesh.reduce((n, a) => n + Number(a.stake || 0), 0) +
            ' of ' + quorum.signers.totalStake;

        venue = new BridgeRailVenue({
            label: 'bridgerail',
            identities: mesh.map((a) => ({
                pubkeyHex: a.pubkeyHex,
                // ValidatorIdentity takes the seed; the adopted entry carries it.
                privkeyHex: a.seedHex,
            })),
            dogeRail: dogeRail,
            confirmations: { BTC: 1, DOGE: 1 },
            // dq 5, ruled (a) 2026-09-12. The venue DOGE indexer builds its own ledger by
            // replaying the standing DOGE chain under this tree's bridge code, so the
            // pre-D62 self-seeded XCHAIN ISSUE at action_index 326 is refused and AT1's
            // precondition below asserts a fact rather than a hope.
            dogeReplayChain: true,
            // See note 3 in the header: the engine stays unarmed until this drive has taken
            // the two readings that are only true before an in leg lands.
            deferBridgeWiring: true,
        });
        const up = await venue.start();
        if (!up) {
            blocked = 'the venue could not be built: ' + venue.unavailable;
            console.log('\nBRIDGE RAIL: ' + blocked + '\n');
            return;
        }
        await fixture.waitForVenueIndexersAtTip(venue.btcVenue);
        // FIVE HOURS FOR THE DOGE SIDE, not the fixture's default 150 minutes, because
        // this indexer REPLAYS the chain rather than cloning it (dq 5). DOGE regtest was
        // 10648 blocks on 2026-09-12 and the block loop adds one every 20 seconds while
        // the replay runs, so the first pass is hours and a barrier that gives up in the
        // middle of it reports a venue fault where the real fact is a long catch-up.
        // Later runs resume the same stable database and cost only the new blocks.
        await chainRail.withRail(dogeRail, () => fixture.waitForVenueIndexersAtTip(
            venue.dogeVenue, { timeoutMs: 300 * 60 * 1000 }));
    });

    // EVERY CASE'S VERDICT, WRITTEN AS IT ENDS, and it exists because drive 13's whole
    // result was lost: mocha prints a failure MESSAGE only in its epilogue, so a run that
    // ends any other way than by finishing takes every message with it. Drive 13 was
    // interrupted inside a stalled funding call and the baseline failure that six other reds
    // cascaded off could not be read at all afterwards. A journal line per case survives an
    // interrupt, a crash and a kill.
    afterEach(function () {
        const test = this.currentTest || {};
        const err = test.err || null;
        journalCase({
            suite: 'bridgeRailBase',
            title: String(test.title || ''),
            state: String(test.state || 'unfinished'),
            durationMs: Number(test.duration || 0),
            error: err ? String(err.message).slice(0, 4000) : null,
        });
    });

    after(async function () {
        this.timeout(0);
        if (venue) await venue.stop();
        console.log('\n=== bridge rail drive readouts ===\n' +
            JSON.stringify(evidence, null, 2) + '\n');
        // AND ON DISK, for the same reason as the per-case journal: this block is the drive's
        // only complete readout and an interrupted run never prints it.
        journalCase({ suite: 'bridgeRailBase', title: '=== readouts ===', state: 'evidence',
            evidence: evidence });
    });

    // ── THE FIXTURE'S PRICE CLOCK ──────────────────────────────────────────────────
    // Re-seed the venue hubs' COIN/USD quotes before EVERY case. The venue seeds DOGE/USD
    // and XCHAIN/USD once at bring-up and its oracle publishes nothing afterwards, while a
    // priced action (any ISSUE, and every emission that resolves a fee) refuses against a
    // quote older than 1800 s. This drive is hours long and AT2's out leg alone waits out
    // the BTC relay margin, so AT5's FUFU issue landed on drive 11 with `invalid: no
    // current oracle price for DOGE/USD (stale beyond 1800s)`. A per-case refresh, rather
    // than a call in front of the cases known to be priced today, is what makes that
    // unreachable for a case added later: the seed is a handful of idempotent upserts into
    // each venue hub's `price_snapshots`, so paying it every case costs nothing measurable.
    // It is the FIXTURE's clock being held still, never an assertion adapting to it.
    //
    // AND THE RESEED MUST NOT MASK WHY A CASE WAS REFUSED. A reseed in front of a case makes a
    // refusal caused by the pricing CODE look identical to one caused by the CLOCK, because
    // both disappear. So the quote's real age is MEASURED first and recorded per case: a case
    // that is refused for a stale price while `priceClock` says the row was fresh has found
    // something in the pricing path, and that is a production finding, not a fixture one.
    beforeEach(async function () {
        this.timeout(0);
        if (!venue || blocked) return;
        priceBeforeCase = await venue.readVenuePrice('DOGE/USD');
        if (priceBeforeCase) {
            evidence.priceClock = evidence.priceClock || [];
            evidence.priceClock.push({
                case: this.currentTest ? String(this.currentTest.title).slice(0, 70) : null,
                ageSeconds: priceBeforeCase.ageSeconds, stale: priceBeforeCase.stale,
                rowCount: priceBeforeCase.rowCount, price: priceBeforeCase.price });
        }
        await venue.refreshVenuePrices();
    });

    /**
     * Skip THIS case with the measured blocker, and say which AT is going unproven.
     *
     * A skip that names nothing is indistinguishable from a case nobody wrote, which is
     * the whole reason the frontier could not tell "attempted and blocked" from
     * "skipped" the last time this row was tried.
     */
    function needsFederation(ctx, at) {
        if (!blocked) return false;
        console.log('  ' + at + ' NOT DRIVEN: ' + blocked);
        ctx.skip();
        return true;
    }

    // ── THE QUIET BEFORE THE FIRST IN LEG ──────────────────────────────────────────
    // Two readings are only true while no XCHAIN has ever landed on the destination
    // ledger, and the venue's bridge engine is deliberately unarmed for exactly as long as
    // they take. Arming it is the last case here.
    describe('the destination ledger before any in leg (AT1 precondition, AT9 witness)', function () {

        it('AT1 precondition: finds no XCHAIN row on the destination ledger before the first in leg', async function () {
            this.timeout(0);
            if (needsFederation(this, 'AT1 precondition')) return;
            const present = await venue.hasTokenRow('DOGE', GAS_TICK);
            evidence.at1_dogeXchainRowBefore = present;
            assert.strictEqual(present, false,
                'AT1 requires a DOGE ledger with no XCHAIN row, and this venue indexer holds one. ' +
                'Either it was SEEDED BY CLONING the standing DOGE database rather than by replaying ' +
                'the chain under bridge code (the row would then be the pre-D62 broadcast ISSUE at ' +
                'action_index 326, supply 613400, which the landed issue.js refuses unconditionally ' +
                'off BTC), or a PREVIOUS run of this drive already applied an in leg into this same ' +
                'stable database. Drop the venue DOGE indexer and mirror databases and let it replay ' +
                'from genesis: they are named `..._bridgeraildoge_Rpl_Ixr0` and `..._bridgeraildoge_Mirror0`.');
        });

        it('AT9 witness: the controller-guarded SEND, ORDER and DISPENSER verdicts on this ledger, before XCHAIN exists', async function () {
            this.timeout(0);
            if (needsFederation(this, 'AT9 before-half')) return;
            witnessBefore = await chainRail.withRail(dogeRail, () => driveVerdictWitness(
                { cryptoHelper, transactionHelper, network: NETWORK, gasTick: GAS_TICK },
                venue.dogeVenue, 'AT9.BEFORE'));
            evidence.at9_before = witnessBefore;
            for (const action of ['SEND', 'ORDER', 'DISPENSER']) {
                assert.ok(witnessBefore[action],
                    'the ' + action + ' from ' + witnessBefore.source + ' (tx ' +
                    witnessBefore.txids[action] + ') was never indexed, so AT9 has no witness for it');
                assert.match(witnessBefore[action], /^(valid|invalid: )/,
                    action + ' carried the unrecognised verdict ' + witnessBefore[action]);
            }
            // The witness is only a witness if the row still did not exist while it was
            // taken; asserting it AFTER is what makes the before-half honest.
            assert.strictEqual(await venue.hasTokenRow('DOGE', GAS_TICK), false,
                'an XCHAIN row appeared on the DOGE ledger while the AT9 before-witness was being ' +
                'taken, so the witness is not a reading of a chain without XCHAIN. The venue engine ' +
                'was armed too early.');
        });

        it('arms the venue bridge engine, drains the rail backlog and takes the baseline', async function () {
            this.timeout(0);
            if (needsFederation(this, 'the rail baseline')) return;
            // This is the moment the federation starts work. See note 3 in the header for
            // why the backlog exists and why it cannot be cleared off the rail instead.
            const overlay = await venue.rewireHubs();
            evidence.engineEnv = Object.keys(overlay).sort().join(', ');

            const settled = await venue.waitForRailSettled(GAS_TICK, { timeoutMs: 60 * 60 * 1000 });
            assert.ok(settled, 'the rail backlog never drained: every XBRIDGE leg on the chain must ' +
                'reach a finalized hub row and a destination bridge_settlements row before a baseline ' +
                'means anything. Outstanding at timeout: ' +
                JSON.stringify(venue._lastSettlePoll) + '\n' + venue.indexerTails(40));
            evidence.backlogApplied = settled.applied;

            baseline = {
                escrow: escrowOf(await venue.bridgeBalances('BTC', GAS_TICK), 'DOGE'),
                dogeSupply: (await venue.bridgeBalances('DOGE', GAS_TICK)).supply,
                invariant: settled.invariant ? settled.invariant[GAS_TICK] : null,
            };
            evidence.baseline = baseline;
            // WHAT REACHED THE ESCROW WITHOUT BEING A BRIDGE LEG, measured off the venue's own
            // BTC ledger. The escrow is a plain address and a stray SEND to it mints nothing
            // (D65), so those units sit in the escrow balance for good with nothing on the
            // destination to match them. Recorded before any assertion below uses it, because
            // it is the term that makes the two chain halves comparable at all.
            baseline.nonBridgeEscrow = await venue.escrowNonBridgeCredits('BTC', 'BRIDGE_DOGE', GAS_TICK);
            evidence.baselineNonBridgeEscrow = baseline.nonBridgeEscrow;
            // ASKED BEFORE THE ARITHMETIC, because one lock finalizing twice makes every
            // number below disagree and a number cannot say which side invented value.
            // Drive 11 measured BTC lock 99 (5 XCHAIN) finalized three times and lock 95
            // (30 XCHAIN) twice, so 80 XCHAIN locked read as 120 XCHAIN minted; see
            // `overFinalizedSourceLegs` for the hub path that allows it.
            const dupes = await venue.duplicateSourceTransfers();
            evidence.overFinalizedSourceLegs = dupes;
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
            assertBacked({ escrow: baseline.escrow, supply: baseline.dogeSupply,
                           nonBridge: baseline.nonBridgeEscrow,
                           backed: Number(baseline.escrow) - Number(baseline.nonBridgeEscrow.net) },
                         'the drained baseline');
        });
    });

    // ── AT1 ────────────────────────────────────────────────────────────────────────
    describe('AT1: a v0 lock of ' + AT1_LOCK + ' XCHAIN to a DOGE address', function () {

        it('finalizes at the pinned depth and credits the exact DOGE address, the escrow and the supply', async function () {
            this.timeout(0);
            if (needsFederation(this, 'AT1')) return;

            assert.ok(baseline, 'AT1 asserts deltas from the drained baseline, so the baseline case ' +
                'must have run');
            // FUNDED WITH 5 COIN, NOT 1: this address is the source of four later DOGE legs
            // (AT2's burn, AT5's counter-order, AT6's DESTROY, AT2's second burn) and each
            // one spends a native-coin fee out of the same balance. The funding call sends
            // ONE output whatever the amount, so it buys no extra candidate inputs; what
            // keeps the legs apart is the ORDER they run in. The encoder reserves an
            // address's inputs for five minutes once it has built from them, so every leg
            // here is separated by a barrier that waits minutes on a settlement. Drive 7
            // ran them back to back and got "all 1 candidate input(s) are reserved by a
            // transaction built in the last 5 minutes" twice.
            const dest = await venue.funded('AT1.DEST', () => chainRail.withRail(dogeRail,
                () => cryptoHelper.getNewFundedAddress('AT1.DEST', 'dogecoin', NETWORK, null, 'legacy', 0, 5, false)));
            // KEPT AS THE RECORD, not re-fetched later by label; see the declaration.
            at1Dest = dest;
            const sender = await venue.funded('AT1.SENDER',
                () => cryptoHelper.getNewFundedAddress('AT1.SENDER', 'bitcoin', NETWORK, null, 'legacy', 0, 1, false));
            await mintHelper.sendMintV0(sender, GAS_TICK, AT1_LOCK, sender.address, '');

            const before = {
                senderBtc: await venue.addressBalance('BTC', sender.address, GAS_TICK),
                escrow: escrowOf(await venue.bridgeBalances('BTC', GAS_TICK), 'DOGE'),
                destDoge: await venue.addressBalance('DOGE', dest.address, GAS_TICK),
            };

            const lockTx = await transactionHelper.createAndSendTransaction(
                sender, lockWireV0('DOGE', dest.address, AT1_LOCK, ''));
            evidence.at1_lockTx = lockTx;

            const row = await venue.waitForFinalizedTransfer(
                (r) => String(r.src_chain) === 'BTC' && String(r.dest_chain) === 'DOGE' &&
                       String(r.dest_address) === dest.address && String(r.tick) === GAS_TICK);
            assert.ok(row, 'no bridge_transfers row naming ' + dest.address + ' was finalized by the venue ' +
                'federation within the budget.\n' + venue.hubTails(30));
            evidence.at1_transferId = row.transfer_id;
            evidence.at1_snapshotBlock = String(row.snapshot_block);

            // THE FEDERATION AGREEING IS NOT THE DESTINATION APPLYING. Hold for the DOGE
            // indexer's own settlement record before reading any DOGE state; see
            // `waitForBridgeApplied` for the false red this barrier exists to stop.
            const applied = await venue.waitForBridgeApplied('DOGE', row.transfer_id);
            assert.ok(applied, 'the venue DOGE indexer never recorded a bridge_settlements row for ' +
                row.transfer_id + ', so the in leg was never applied.\n' + venue.indexerTails(40));
            evidence.at1_appliedBlock = String(applied.block_index);

            // BY IDENTITY: the credit is asserted on the address the lock NAMED, not on
            // "some address gained 5".
            const after = {
                senderBtc: await venue.addressBalance('BTC', sender.address, GAS_TICK),
                escrow: escrowOf(await venue.bridgeBalances('BTC', GAS_TICK), 'DOGE'),
                destDoge: await venue.addressBalance('DOGE', dest.address, GAS_TICK),
                dogeSupply: (await venue.bridgeBalances('DOGE', GAS_TICK)).supply,
            };
            evidence.at1 = { before, after, destAddress: dest.address, senderAddress: sender.address };

            assert.strictEqual(Number(after.destDoge) - Number(before.destDoge), AT1_LOCK,
                'the DOGE balance of ' + dest.address + ' did not gain exactly ' + AT1_LOCK);
            assert.strictEqual(Number(after.escrow) - Number(before.escrow || 0), AT1_LOCK,
                'ADDRESS.BRIDGE_DOGE on BTC did not gain exactly ' + AT1_LOCK);
            assert.strictEqual(Number(before.senderBtc) - Number(after.senderBtc), AT1_LOCK,
                'the sender ' + sender.address + ' was not debited exactly ' + AT1_LOCK +
                ' XCHAIN (the native fee is a coin output and never a tick debit)');
            // Section 15 writes this as "the DOGE XCHAIN supply is 5", which is the reading
            // on a rail whose escrow starts empty. This rail's escrow carries
            // `baseline.dogeSupply` units that cannot be returned (header note 3), so the
            // same claim is driven as an exact rise of AT1_LOCK over the drained baseline.
            assert.strictEqual(Number(after.dogeSupply) - Number(baseline.dogeSupply), AT1_LOCK,
                'the DOGE XCHAIN supply moved from ' + baseline.dogeSupply + ' to ' +
                after.dogeSupply + ', which is not a rise of exactly ' + AT1_LOCK);
        });

        it('creates the DOGE token row with the shared gas-token parameter set, and the bridge role owner', async function () {
            this.timeout(0);
            if (needsFederation(this, 'AT1 token row')) return;
            const doge = await venue.tokenParameters('DOGE', GAS_TICK);
            assert.ok(doge, 'the in leg created no XCHAIN row on DOGE');

            // AT1 as first framed compared the DOGE row against the STANDING BTC
            // regtest row byte for byte. That row predates the bridge's shared parameter
            // set (genesis.js gasTokenParams, xchain-bridge.md section 9 and D66): measured
            // on this rail it carries decimals 0, max_mint 100000, description
            // "XChain GAS Token" and mint_start_block 0, a fixture written by a code path
            // from before the shared helper existed
            // (measured by the token-row lane on that date). Asserting
            // DOGE-equals-BTC on that fixture fails no matter what the bridge does, so this
            // case instead asserts the DOGE row against the ONE parameter set the spec
            // requires every XCHAIN row to carry, field by field, and leaves the BTC row
            // uncompared.
            // FROM THE PINNED ROOT when a drive has one. AT1 grades the row the PINNED indexer
            // created, so reading the expected parameter set out of the SHARED checkout would
            // compare one build's output against another build's expectations. Unset keeps the
            // relative path, so a drive that pins nothing behaves exactly as before.
            const genesisPath  = process.env.BRIDGE_RAIL_REPO_ROOT
                ? require('path').join(process.env.BRIDGE_RAIL_REPO_ROOT, 'xchain-indexer', 'src', 'genesis.js')
                : '../../../xchain-indexer/src/genesis.js';
            const Genesis      = require(genesisPath);
            // THE FILE THIS CASE'S EXPECTATIONS CAME FROM, resolved rather than described,
            // because drive 13 read them out of the shared checkout while the row under test
            // was created by the pinned one.
            evidence.at1_genesisModule = require.resolve(genesisPath);
            const genesisUtil  = { isNull: (v) => (v === null || v === undefined || v === '') };
            // A bare Genesis instance built only to read gasTokenParams(): the DB/actions
            // arguments are never exercised by that method, only this.config and this.util.
            const gasParams = new Genesis(
                { processTransaction: async () => {} },
                { getTickerId: async () => null, getTokenInfo: async () => false },
                { COIN: 'DOGE', NETWORK: NETWORK, GAS: GAS_TICK, ADDRESS: { GAS: null } },
                genesisUtil
            ).gasTokenParams(null);
            evidence.at1_tokenParams = { doge: doge.params, dogeOwner: doge.ownerAddress,
                gasTokenParams: gasParams };

            assert.strictEqual(gasParams.tick, GAS_TICK,
                'gasTokenParams() itself does not carry the gas tick, so the parameter source is wrong');
            assert.strictEqual(Number(doge.params.decimals), Number(gasParams.decimals),
                'the DOGE row\'s decimals (' + doge.params.decimals + ') do not match gasTokenParams() (' +
                gasParams.decimals + ')');
            assert.strictEqual(Number(doge.params.max_supply), Number(gasParams.maxSupply),
                'the DOGE row\'s max_supply (' + doge.params.max_supply + ') does not match gasTokenParams() (' +
                gasParams.maxSupply + ')');
            // MAX_MINT is never in gasTokenParams(): the wire carries it empty, which the
            // uncapped sentinel this row must land on, is 0.
            assert.strictEqual(Number(doge.params.max_mint || 0), 0,
                'the DOGE row\'s max_mint (' + doge.params.max_mint + ') is not the uncapped sentinel ' +
                'an empty MAX_MINT field on the wire produces');
            assert.strictEqual(doge.params.description, gasParams.description,
                'the DOGE row\'s description (' + doge.params.description + ') does not match ' +
                'gasTokenParams() (' + gasParams.description + ')');
            assert.strictEqual(Number(doge.params.mint_start_block), Number(gasParams.mintStartBlock),
                'the DOGE row\'s mint_start_block (' + doge.params.mint_start_block + ') does not match ' +
                'gasTokenParams() (' + gasParams.mintStartBlock + ')');

            // The owner is a different string on each chain BY CONSTRUCTION, so it is compared
            // by ROLE. Asserting the strings equal would be asserting something false.
            const dogeGas = await venue.roleAddress('DOGE', 'GAS');
            assert.strictEqual(doge.ownerAddress, dogeGas);
        });
    });

    // ── AT2 ────────────────────────────────────────────────────────────────────────
    describe('AT2: a v1 burn of ' + AT2_BURN + ' back to a BTC address', function () {

        it('releases the escrow to the exact BTC address and lowers the DOGE supply', async function () {
            this.timeout(0);
            if (needsFederation(this, 'AT2')) return;

            const dest = await venue.funded('AT2.DEST',
                () => cryptoHelper.getNewFundedAddress('AT2.DEST', 'bitcoin', NETWORK, null, 'legacy', 0, 1, false));
            assert.ok(at1Dest, 'AT2 burns the units AT1 minted from the address AT1 named, so AT1 must ' +
                'have run and left its destination record');
            const burner = at1Dest.address;

            const before = {
                btcDest: await venue.addressBalance('BTC', dest.address, GAS_TICK),
                escrow: escrowOf(await venue.bridgeBalances('BTC', GAS_TICK), 'DOGE'),
                dogeSupply: (await venue.bridgeBalances('DOGE', GAS_TICK)).supply,
            };

            const burnTx = await chainRail.withRail(dogeRail, () =>
                transactionHelper.createAndSendTransaction(
                    at1Dest, burnWireV1(dest.address, AT2_BURN, '')));
            evidence.at2_burnTx = burnTx;

            const row = await venue.waitForFinalizedTransfer(
                (r) => String(r.src_chain) === 'DOGE' && String(r.dest_chain) === 'BTC' &&
                       String(r.dest_address) === dest.address);
            assert.ok(row, 'no bridge_transfers row for the burn to ' + dest.address + ' finalized.\n' +
                venue.hubTails(30));
            evidence.at2_transferId = row.transfer_id;

            // The out leg's destination is BTC, so BTC is the chain that must apply it
            // before its balances mean anything; same barrier, other direction.
            const applied = await venue.waitForBridgeApplied('BTC', row.transfer_id);
            assert.ok(applied, 'the venue BTC indexer never recorded a bridge_settlements row for ' +
                row.transfer_id + ', so the out leg was never applied.\n' + venue.indexerTails(40));
            evidence.at2_appliedBlock = String(applied.block_index);

            const after = {
                btcDest: await venue.addressBalance('BTC', dest.address, GAS_TICK),
                escrow: escrowOf(await venue.bridgeBalances('BTC', GAS_TICK), 'DOGE'),
                dogeSupply: (await venue.bridgeBalances('DOGE', GAS_TICK)).supply,
            };
            // THE SOURCE LEG FINALIZED ONCE, asserted before the arithmetic and named rather
            // than inferred from a number. On drive 11 this one burn of 2 finalized as two
            // transfers (`a037a13d…`@1052 and `58b7cc56…`@1053) and the escrow fell by 4, and a
            // red on the escrow alone reads as an arithmetic mystery instead of as the
            // duplicate it is. This is the rail's check on the landed hub fix.
            const dupes = await venue.duplicateSourceTransfers();
            const burnLeg = dupes.filter((g) => String(g.srcChain) === String(row.src_chain) &&
                String(g.actionIndex) === String(row.src_action_index));
            evidence.at2_duplicateSourceLegs = burnLeg;
            assert.deepStrictEqual(burnLeg, [],
                'the burn at ' + row.src_chain + ':' + row.src_action_index + ' finalized as more ' +
                'than one transfer: ' + JSON.stringify(burnLeg) + '. The escrow arithmetic below ' +
                'cannot hold while one source leg is paid out twice.');

            evidence.at2 = { before, after, destAddress: dest.address };

            assert.strictEqual(Number(after.btcDest) - Number(before.btcDest), AT2_BURN,
                dest.address + ' did not gain exactly ' + AT2_BURN + ' on BTC');
            // Section 15's "the escrow address is 3" and "DOGE supply is 3" are the readings
            // on a virgin rail; here the same claim is the baseline plus AT1's lock less
            // this burn, which is the identical arithmetic with the rail's own history in it.
            assert.strictEqual(Number(after.escrow), Number(baseline.escrow) + AT1_LOCK - AT2_BURN,
                'the escrow reads ' + after.escrow + ' and not ' +
                (Number(baseline.escrow) + AT1_LOCK - AT2_BURN));
            assert.strictEqual(Number(after.dogeSupply), Number(baseline.dogeSupply) + AT1_LOCK - AT2_BURN,
                'the DOGE supply reads ' + after.dogeSupply + ' and not ' +
                (Number(baseline.dogeSupply) + AT1_LOCK - AT2_BURN));
        });
    });

    // ── AT5 ────────────────────────────────────────────────────────────────────────
    describe('AT5: a same-chain ORDER of FUFU against XCHAIN on DOGE', function () {

        it('matches and settles locally with no COINPAY', async function () {
            this.timeout(0);
            if (needsFederation(this, 'AT5')) return;
            // The base-pair goal: once XCHAIN is a real balance on DOGE, a DOGE-native token
            // trades against it LOCALLY. Two orders, not one: a single ORDER names a price,
            // and the claim AT5 makes is about what happens when the two sides MEET. The
            // assertion that carries it is `settlement_type = 'instant'` on the match plus
            // the ABSENCE of any coinpay obligation against it, because a native-coin leg
            // would have produced both.
            assert.ok(at1Dest && baseline, 'AT5 trades against the XCHAIN AT1 bridged in, so AT1 must have run');
            // The venue's seeded DOGE/USD is older than the 1800 s an ISSUE will price
            // against by the time this case runs; see refreshVenuePrices. Recorded before the
            // reseed AND after it, so a later reader can tell a clock refusal from a pricing
            // one without re-running the drive: drive 11's red claimed the clock, and
            // `at5_price.before.stale` is the reading that either confirms that or refutes it.
            evidence.at5_price = { asThisCaseStarted: priceBeforeCase };
            await venue.refreshVenuePrices();
            evidence.at5_price.afterReseed = await venue.readVenuePrice('DOGE/USD');
            const maker = await venue.funded('AT5.MAKER',
                () => chainRail.withRail(dogeRail, () => cryptoHelper.getNewFundedAddress(
                    'AT5.MAKER', 'dogecoin', NETWORK, null, 'legacy', 0, 5, false)));

            // Raw, and read on the VENUE ledger: `sendIssueV0` waits on the standing DOGE
            // indexer's database, which is a different ledger from this one.
            const issue = await dogeAction(maker,
                () => issueHelper.sendIssueV0Raw(maker, 'FUFU', 1000, 1000, 0, 'AT5 base pair', 100),
                'issues');
            evidence.at5_issue = issue;
            assert.strictEqual(issue.status, 'valid',
                'the FUFU issue on the venue DOGE ledger was graded ' + issue.status);

            const expiry = EXPIRY();
            // ORDER v0: VERSION|GIVE_COIN|GIVE_TICK|GIVE_AMOUNT|GIVE_OWNERSHIP|GET_COIN|
            // GET_TICK|GET_AMOUNT|GET_OWNERSHIP|GET_ADDRESS|EXPIRATION|ALLOW_LIST|BLOCK_LIST|
            // MEMO. EXPIRATION is a unix timestamp and not a height; at a height-shaped value
            // both sides refuse `invalid: EXPIRATION (past)` before any tick logic runs.
            // GET_ADDRESS is left empty on both legs so they meet on the book rather than
            // being directed at each other, which is the same match a real pair makes.
            const makerOrder = await dogeAction(maker,
                'ORDER|0|DOGE|FUFU|1||DOGE|' + GAS_TICK + '|1|||' + expiry + '|||AT5 base pair', 'orders');
            evidence.at5_makerOrder = makerOrder;
            assert.strictEqual(makerOrder.status, 'valid',
                'the FUFU-for-XCHAIN order was graded ' + makerOrder.status);

            const takerOrder = await dogeAction(at1Dest,
                'ORDER|0|DOGE|' + GAS_TICK + '|1||DOGE|FUFU|1|||' + expiry + '|||AT5 base pair', 'orders');
            evidence.at5_takerOrder = takerOrder;
            assert.strictEqual(takerOrder.status, 'valid',
                'the XCHAIN-for-FUFU order was graded ' + takerOrder.status);

            // The match is the indexer's own row, polled because it is written when the
            // second order's block is parsed and not when the broadcast returns.
            const deadline = Date.now() + 10 * 60 * 1000;
            let match = null;
            while (Date.now() < deadline && !match) {
                const rows = await venue.queryIndexerDb('DOGE',
                    'SELECT m.*, s.status AS status FROM order_matches m ' +
                    'LEFT JOIN index_statuses s ON s.id = m.status_id ' +
                    'WHERE (m.give_action_index = ? AND m.get_action_index = ?) ' +
                    '   OR (m.give_action_index = ? AND m.get_action_index = ?) LIMIT 1',
                    [makerOrder.actionIndex, takerOrder.actionIndex,
                     takerOrder.actionIndex, makerOrder.actionIndex]);
                if (rows.length) match = rows[0];
                else await new Promise((r) => setTimeout(r, 5000));
            }
            assert.ok(match, 'the two DOGE-local orders (' + makerOrder.actionIndex + ' giving FUFU, ' +
                takerOrder.actionIndex + ' giving ' + GAS_TICK + ') never produced an order_matches row ' +
                'on the venue DOGE ledger.\n' + venue.indexerTails(40));
            evidence.at5_match = { actionIndex: String(match.action_index),
                settlementType: String(match.settlement_type), status: String(match.status) };
            assert.strictEqual(String(match.settlement_type), 'instant',
                'the DOGE-local FUFU/' + GAS_TICK + ' match settled as ' + match.settlement_type +
                ' rather than instant, which means it took the native-coin path this AT exists to rule out');
            assert.strictEqual(String(match.status), 'valid');

            // NO COINPAY, asserted against the match by id rather than by an empty-table
            // count, which would pass on a ledger where the tables were never built.
            const obligations = await venue.queryIndexerDb('DOGE',
                'SELECT * FROM coinpay_obligations WHERE action_index = ?', [String(match.action_index)]);
            evidence.at5_coinpayObligations = obligations.length;
            assert.strictEqual(obligations.length, 0,
                'the same-chain match raised ' + obligations.length + ' coinpay obligation(s)');

            // And the units actually moved, by identity on both sides.
            const makerXchain = await venue.addressBalance('DOGE', maker.address, GAS_TICK);
            const takerFufu   = await venue.addressBalance('DOGE', at1Dest.address, 'FUFU');
            evidence.at5_settled = { maker: maker.address, makerXchain: makerXchain,
                taker: at1Dest.address, takerFufu: takerFufu };
            assert.strictEqual(Number(makerXchain), 1,
                'the maker ' + maker.address + ' holds ' + makerXchain + ' ' + GAS_TICK + ' and not 1');
            assert.strictEqual(Number(takerFufu), 1,
                'the taker ' + at1Dest.address + ' holds ' + takerFufu + ' FUFU and not 1');
        });
    });

    // ── AT7 ────────────────────────────────────────────────────────────────────────
    // BEFORE AT6, because AT6 ends by putting a permanent surplus of 1 on the rail and AT7
    // asserts the invariant is equal. Section 15 writes AT6 as "after AT1 to AT5", which
    // AT7 running in between does not disturb: every leg it adds is backed.
    describe('AT7: the distribution rail', function () {

        it('mints ' + AT7_MINT + ' on BTC, locks all of it and airdrops ' + AT7_EACH + ' to three DOGE addresses', async function () {
            this.timeout(0);
            if (needsFederation(this, 'AT7')) return;
            assert.ok(baseline, 'AT7 asserts an invariant reading, so the baseline case must have run');
            await venue.refreshVenuePrices();

            const operator = await venue.funded('AT7.OPERATOR', () => chainRail.withRail(dogeRail,
                () => cryptoHelper.getNewFundedAddress('AT7.OPERATOR', 'dogecoin', NETWORK, null, 'legacy', 0, 5, false)));
            const gasIssuer = await venue.funded('AT7.GAS',
                () => cryptoHelper.getNewFundedAddress('AT7.GAS', 'bitcoin', NETWORK, null, 'legacy', 0, 1, false));
            await mintHelper.sendMintV0(gasIssuer, GAS_TICK, AT7_MINT, gasIssuer.address, '');
            const lockTx = await transactionHelper.createAndSendTransaction(
                gasIssuer, lockWireV0('DOGE', operator.address, AT7_MINT, ''));
            const row = await venue.waitForFinalizedTransfer(
                (r) => String(r.dest_address) === operator.address && Number(r.amount) === AT7_MINT);
            assert.ok(row, 'the AT7 lock of ' + AT7_MINT + ' never finalized.\n' + venue.hubTails(30));
            // The operator cannot airdrop units the destination has not credited yet.
            const applied = await venue.waitForBridgeApplied('DOGE', row.transfer_id);
            assert.ok(applied, 'the venue DOGE indexer never applied the AT7 lock ' + row.transfer_id +
                ', so the operator address holds nothing to distribute.\n' + venue.indexerTails(40));
            evidence.at7_appliedBlock = String(applied.block_index);

            const recipients = [];
            await chainRail.withRail(dogeRail, async () => {
                for (const label of ['AT7.R1', 'AT7.R2', 'AT7.R3']) {
                    recipients.push(await cryptoHelper.getNewAddress(label, 'dogecoin', NETWORK, null, 'legacy', 0));
                }
            });

            // AIRDROP v0 IS `VERSION|TICK|AMOUNT|LIST_ACTION_INDEX|MEMO` and LIST_ACTION_INDEX
            // is the action index of a prior type-2 (address) LIST, not a list of addresses.
            // Drive 7 passed the address array straight into the wire, the handler refused it
            // and the helper's waiting form reported "never landed at status=valid", which
            // reads as a bridge fault and was a wire-format fault.
            const list = await dogeAction(operator,
                'LIST|0|2||' + recipients.map((r) => r.address).join('|'), 'lists');
            evidence.at7_list = list;
            assert.strictEqual(list.status, 'valid',
                'the address LIST the airdrop distributes over was graded ' + list.status);

            const airdrop = await dogeAction(operator,
                'AIRDROP|0|' + GAS_TICK + '|' + AT7_EACH + '|' + list.actionIndex + '|', 'airdrops');
            evidence.at7_airdrop = airdrop;
            assert.strictEqual(airdrop.status, 'valid',
                'the AIRDROP of ' + AT7_EACH + ' ' + GAS_TICK + ' over list ' + list.actionIndex +
                ' was graded ' + airdrop.status + ' on the venue DOGE ledger');

            const landed = {};
            for (const r of recipients) landed[r.address] = await venue.addressBalance('DOGE', r.address, GAS_TICK);
            const inv = await venue.bridgeInvariant(GAS_TICK);
            const doge = inv[GAS_TICK].DOGE;
            const halves = await chainHalves();
            evidence.at7 = { lockTx, transferId: row.transfer_id, operator: operator.address, landed,
                dogeSupply: halves.supply, escrow: halves.escrow,
                nonBridgeEscrow: halves.nonBridge, backedByLocks: halves.backed,
                invariant: doge };

            // BY IDENTITY: each named recipient holds exactly its share. "Three addresses hold
            // 30 between them" is the assertion that passes when the split is wrong.
            for (const r of recipients) {
                assert.strictEqual(Number(landed[r.address]), AT7_EACH,
                    r.address + ' holds ' + landed[r.address] + ' and not ' + AT7_EACH);
            }
            // The two chain halves, which is what "the invariant is equal" is a claim about.
            assertBacked(halves, 'AT7');
            assert.strictEqual(classifyInvariant(doge).verdict, 'equal',
                'the hub reports ' + JSON.stringify(doge) + ' rather than equal');
            assert.strictEqual(String(doge.in_flight), '0');
        });
    });

    // ── AT6 ────────────────────────────────────────────────────────────────────────
    describe('AT6: the invariant, the two closures and the D65 surplus', function () {

        it('reads equal on BTC and DOGE with nothing in flight', async function () {
            this.timeout(0);
            if (needsFederation(this, 'AT6 invariant')) return;
            const inv = await venue.bridgeInvariant(GAS_TICK);
            const doge = inv[GAS_TICK].DOGE;
            // BOTH readings recorded: the two chain halves the invariant is a claim about,
            // and the hub's own verdict over them. They can disagree, and which one is wrong
            // is the finding. `delta = escrow - (supply + in_flight)`, and in_flight is
            // accumulated from `getpendingbridgetransfers`, which answers every XBRIDGE leg
            // the chain ever carried with no settled filter, so on a rail with history the
            // hub's delta is permanently negative while the chains are exactly level.
            const halves = await chainHalves();
            evidence.at6_invariant = { hub: doge, chainHalves: halves };
            assertBacked(halves, 'AT6');
            assert.strictEqual(classifyInvariant(doge).verdict, 'equal',
                'the invariant on DOGE reads ' + JSON.stringify(doge) + ' rather than equal');
            assert.strictEqual(String(doge.in_flight), '0');
        });

        it('refuses a DESTROY of XCHAIN on DOGE with invalid: TICK (use XBRIDGE v1)', async function () {
            this.timeout(0);
            if (needsFederation(this, 'AT6 DESTROY closure')) return;
            // Federation-gated NOT because the refusal needs one, but because `invalid:
            // TICK (unknown)` is checked FIRST in destroy.js: with no XCHAIN row on DOGE
            // the action refuses for the wrong reason and the case would pass while proving
            // nothing. So the row has to exist, which means AT1 has to have run.
            assert.ok(at1Dest, 'the DESTROY is signed by the address AT1 credited, so AT1 must have run');
            await venue.refreshVenuePrices();
            const got = await dogeAction(at1Dest, 'DESTROY|0|' + GAS_TICK + '|1|', 'destroys');
            evidence.at6_destroy = got;
            assert.strictEqual(got.status, 'invalid: TICK (use XBRIDGE v1)',
                'the DOGE closure wrote ' + got.status + ' for tx ' + got.tx);
        });

        it('reports a surplus of exactly 1 for DOGE after a plain SEND to the escrow, and the watch raises WARN not CRIT', async function () {
            this.timeout(0);
            if (needsFederation(this, 'AT6 D65 surplus')) return;

            const escrowAddr = await venue.roleAddress('BTC', 'BRIDGE_DOGE');
            assert.ok(escrowAddr, 'the BTC config carries no ADDRESS.BRIDGE_DOGE for ' + NETWORK);
            const before = await chainHalves();
            const hubBefore = classifyInvariant((await venue.bridgeInvariant(GAS_TICK))[GAS_TICK].DOGE);
            const sender = await venue.funded('AT6.SEND',
                () => cryptoHelper.getNewFundedAddress('AT6.SEND', 'bitcoin', NETWORK, null, 'legacy', 0, 1, false));
            await mintHelper.sendMintV0(sender, GAS_TICK, 1, sender.address, '');
            const sendHelper = require('../helpers/sendHelper');
            await sendHelper.sendSendV0(sender, GAS_TICK, 1, escrowAddr, '');

            const inv = await venue.bridgeInvariant(GAS_TICK);
            const doge = inv[GAS_TICK].DOGE;
            const cls = classifyInvariant(doge);
            const after = await chainHalves();
            evidence.at6_surplus = { hub: doge, escrowAddr: escrowAddr, before: before, after: after,
                hubBefore: hubBefore, hubAfter: cls };
            // The stray credit landed on the escrow and nowhere else: that is the D65 claim,
            // and it is asserted on the chain halves as well as on the hub's verdict.
            assert.strictEqual(Number(after.escrow) - Number(before.escrow), 1,
                'the escrow ' + escrowAddr + ' moved from ' + before.escrow + ' to ' + after.escrow +
                ' on a plain SEND of 1');
            assert.strictEqual(after.supply, before.supply,
                'the DOGE supply moved on a BTC-side stray credit, which it must not (D65)');
            // AND THE LEDGER RECORDED IT AS A NON-BRIDGE CREDIT, which is the other half of
            // D65: the unit reached the escrow through a SEND, no transfer record was created
            // for it, and nothing on the destination was minted against it. Asserted on the
            // measured term rather than inferred from the supply staying still.
            assert.strictEqual(Number(after.nonBridge.net) - Number(before.nonBridge.net), 1,
                'the non-bridge credits to ' + escrowAddr + ' moved from ' + before.nonBridge.net +
                ' to ' + after.nonBridge.net + ' on a plain SEND of 1, so the ledger did not ' +
                'record the stray credit as a non-bridge credit');
            assert.strictEqual(after.backed, before.backed,
                'the units BACKED by locks moved from ' + before.backed + ' to ' + after.backed +
                ' on a stray SEND, which mints nothing and therefore backs nothing (D65)');
            // THE HUB'S OWN VERDICT, asserted as a MOVEMENT. Its `delta` is
            // `escrow - (supply + in_flight)` and its in_flight term counts every XBRIDGE leg
            // the source chain has ever carried (the indexer's `getpendingbridgetransfers` has
            // no settled filter, and the hub adds every row it answers), so the absolute delta
            // on a rail with history is a large negative number that says nothing about this
            // SEND. What the SEND must do is move it by exactly one, in the surplus direction,
            // and that is the same claim without the broken offset. The absolute reading is in
            // the evidence, and the in_flight term is reported as a production finding.
            assert.strictEqual(cls.delta - hubBefore.delta, 1,
                'the hub delta moved from ' + hubBefore.delta + ' to ' + cls.delta +
                ' on a plain SEND of 1 to the escrow, so the surplus it reports is not this ' +
                'stray credit: ' + JSON.stringify(doge));

            // THE WATCH ITEM, driven rather than described: the real classifier from
            // the platform's own watch script is handed the real answer.
            const watch = require('../../../claude/scripts/xchain-watch.js');
            const items = watch.bridgeInvariantVerdicts([{ label: 'venue-hub-0', ok: true, byTick: inv }]);
            const forDoge = items.filter((i) => i.tick === GAS_TICK && i.chain === 'DOGE');
            evidence.at6_watch = forDoge.map((i) => ({ sev: i.sev, kind: i.kind }));
            assert.strictEqual(forDoge.length, 1);
            // D65's asymmetry, driven on the REAL hub answer and deliberately not on a
            // corrected copy of it. A CRIT here is not the classifier being wrong: it is the
            // hub's `in_flight` term reaching the watch item, because the term counts every
            // XBRIDGE leg the source chain has ever carried and a chain with history therefore
            // reads as a permanent deficit. That is a production finding about the hub read,
            // and feeding this assertion a patched invariant would hide it.
            assert.strictEqual(forDoge[0].sev, 'warn',
                'the watch raised ' + forDoge[0].sev + '/' + forDoge[0].kind + ' on the hub answer ' +
                JSON.stringify(doge) + '. A deficit here with the chain halves level (escrow ' +
                after.escrow + ', non-bridge ' + after.nonBridge.net + ', supply ' + after.supply +
                ') is the in_flight term, not a real deficit.');
            assert.strictEqual(forDoge[0].kind, 'BRIDGE_INVARIANT_SURPLUS');
        });
    });

    // ── AT9 ────────────────────────────────────────────────────────────────────────
    describe('AT9: the verdict witness', function () {

        it('carries the same controller-guarded verdicts on DOGE after the XCHAIN row exists', async function () {
            this.timeout(0);
            if (needsFederation(this, 'AT9 after-half')) return;
            // BOTH HALVES ON ONE LEDGER. The before-half was taken by this suite, on this
            // venue's own DOGE indexer, while it provably held no XCHAIN row; the guards
            // suite's witness is taken on a CLONED ledger that already carries the pre-D62
            // row, so comparing across the two measures the clone and not the bridge, which
            // is how drive 7 came back with `insufficient funds` against `TICK (unknown)`.
            assert.ok(witnessBefore, 'no witness was taken before the XCHAIN row existed, so AT9 has ' +
                'nothing to compare against');
            assert.strictEqual(await venue.hasTokenRow('DOGE', GAS_TICK), true,
                'AT9 compares the verdicts across the XCHAIN row APPEARING, and it has not appeared ' +
                'on this ledger, so there is no event to compare across');
            const after = await chainRail.withRail(dogeRail, () => driveVerdictWitness(
                { cryptoHelper, transactionHelper, network: NETWORK, gasTick: GAS_TICK },
                venue.dogeVenue, 'AT9.AFTER'));
            const before = { SEND: witnessBefore.SEND, ORDER: witnessBefore.ORDER,
                DISPENSER: witnessBefore.DISPENSER };
            const afterOnly = { SEND: after.SEND, ORDER: after.ORDER, DISPENSER: after.DISPENSER };
            // Was the tick UNKNOWN to the grader in the before-half? On a fresh-replay ledger
            // it was, and that decides which form of AT9's claim is even satisfiable.
            const tickWasUnknown = Object.values(before).some((v) => /TICK \(unknown\)/.test(String(v)));
            evidence.at9 = { before: before, beforeTxids: witnessBefore.txids, beforeSource: witnessBefore.source,
                after: afterOnly, afterTxids: after.txids, afterSource: after.source,
                tickWasUnknownBefore: tickWasUnknown };

            // WHAT AT9 ACTUALLY PINS, and why the strict form is wrong on this ledger.
            //
            // Section 9's obligation (and the row that gated it) is that the `getTokenInfo(GAS)`
            // branches must not flip a controller-guarded action's verdict when the XCHAIN row
            // appears off BTC: specifically that the guard-gas reservation stays gated off BTC
            // until milestone 2's flag day, and that nothing a guard refuses becomes VALID.
            //
            // A literal string equality expresses that only on a ledger where the grader
            // already KNEW the tick in both halves. On a fresh-replay ledger the row genuinely
            // appears mid-drive, and then the before-half can only ever read `TICK (unknown)`
            // (the grader stops at tick resolution) while the after-half reaches the balance
            // check and reads `insufficient funds`: drive 11 measured exactly that pair. That
            // difference is forced by the tick existing at all, on any correct implementation,
            // so demanding the strings match is asserting something no code can satisfy. The
            // guards suite passes the strict form only because ITS ledger is a clone that
            // already carried the pre-D62 row, i.e. it witnesses no appearance at all.
            //
            // So: every action stays REFUSED, none of them on the guard-gas branch, and the
            // strict equality is held exactly where it is meaningful.
            for (const action of ['SEND', 'ORDER', 'DISPENSER']) {
                assert.ok(/^invalid\b/.test(String(afterOnly[action])),
                    'the controller-guarded ' + action + ' on DOGE is no longer refused once the ' +
                    'XCHAIN row exists on that chain: ' + afterOnly[action] + ' (before: ' +
                    before[action] + ')');
                assert.ok(!/guard gas/i.test(String(afterOnly[action])),
                    'the ' + action + ' is refused on the GUARD-GAS branch now that the XCHAIN row ' +
                    'exists off BTC (' + afterOnly[action] + '), which section 9 gates on milestone ' +
                    "2's flag day and not on the row's existence");
            }
            if (!tickWasUnknown) {
                assert.deepStrictEqual(afterOnly, before,
                    'a controller-guarded verdict on DOGE moved when the XCHAIN row appeared on that ' +
                    'chain, and the grader already knew the tick in both halves, so nothing about the ' +
                    "row's appearance can account for the move");
            }
        });
    });

    // ── AT2, second run ────────────────────────────────────────────────────────────
    // LAST, and deliberately so. It re-pins the federation's DOGE depth at 60 and then waits
    // out sixty DOGE blocks, and the burn it leaves behind sits in flight for the BTC relay
    // margin afterwards; running it earlier would leave an unapplied out leg inside AT6's and
    // AT7's invariant readings. Its own claim is a MEASUREMENT and depends on nothing later.
    describe('AT2, second run: the raised depth', function () {

        it('waits the raised depth when XCHAIN_CONFIRMATIONS_DOGE is 60, and measures it', async function () {
            this.timeout(0);
            if (needsFederation(this, 'AT2 raised depth')) return;
            assert.ok(at1Dest, 'AT2 burns from the address AT1 named, so AT1 must have run');

            // The measurement is the POINT of this case: a depth the engine silently ignored
            // would finalize in seconds and the case would pass for the wrong reason, so the
            // elapsed DOGE height at finalization is asserted, not the wall clock.
            await venue.rewireHubs({ DOGE: 60 });
            const dest = await venue.funded('AT2B.DEST',
                () => cryptoHelper.getNewFundedAddress('AT2B.DEST', 'bitcoin', NETWORK, null, 'legacy', 0, 1, false));

            const heightAt = async () => Number((await chainRail.withRail(dogeRail,
                () => indexerConnector.call('getblockhashes', {}))).block_index);
            const startHeight = await heightAt();

            const burnTx = await chainRail.withRail(dogeRail, () =>
                transactionHelper.createAndSendTransaction(
                    at1Dest, burnWireV1(dest.address, 1, '')));
            const row = await venue.waitForFinalizedTransfer(
                (r) => String(r.dest_address) === dest.address, { timeoutMs: 60 * 60 * 1000 });
            const endHeight = await heightAt();
            evidence.at2b = { burnTx, startHeight, endHeight, depth: endHeight - startHeight,
                finalized: !!row, transferId: row ? row.transfer_id : null };
            assert.ok(row, 'the 60-confirmation burn never finalized within the budget (DOGE moved from ' +
                startHeight + ' to ' + endHeight + ')');
            assert.ok(endHeight - startHeight >= 60,
                'the transfer finalized after only ' + (endHeight - startHeight) + ' DOGE block(s), ' +
                'so XCHAIN_CONFIRMATIONS_DOGE=60 was not honoured');
            await venue.rewireHubs({ DOGE: 1 });
        });
    });
});
