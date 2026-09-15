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
 *********************************************************************/

'use strict';

const assert = require('assert');

const chainRail         = require('../../helpers/chainRail');
const stakeTeardown     = require('../../helpers/stakeTeardown');
const cryptoHelper      = require('../../cryptoHelper');
const transactionHelper = require('../../transactionHelper');
const issueHelper       = require('../../helpers/issueHelper');
const mintHelper        = require('../../helpers/mintHelper');
const fixture           = require('../../attestMirror/mirrorDrillFixture');
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
} = require('../../helpers/bridgeRailVenue');

const GAS_TICK = 'XCHAIN';

// AT1 locks 5, AT2 burns 2 of them, AT7 mints and locks 30. Named rather than inlined
// so the invariant arithmetic at AT6 quotes the same numbers the legs moved.
const AT1_LOCK   = 5;
const AT2_BURN   = 2;
const AT7_MINT   = 30;
const AT7_EACH   = 10;

const state = {
    venue: null,
    quorum: null,
    dogeRail: null,
    // AT1's destination address RECORD (address plus its key material), kept so AT2, AT5
    // and AT6 can sign from it. `cryptoHelper.getWallet(label)` answers the WALLET
    // (mnemonic, seed, an addresses array) and NOT one address, so `w.privateKey` is
    // undefined and a burn signed from it dies in ecpair with "Expected Buffer, got
    // undefined" before it is ever a bridge question. Never folded into `evidence`, which
    // is printed.
    at1Dest: null,
    // The AT9 witness taken on THIS venue's own DOGE ledger, before any in leg. NOT the
    // guards suite's: that one runs against a CLONED ledger which already holds the
    // pre-D62 XCHAIN row, so its verdicts are the ones a chain WITH XCHAIN carries and
    // comparing them to this ledger's measures the clone, not the bridge. Drive 7 failed
    // AT9 exactly there, `insufficient funds` against `TICK (unknown)`.
    witnessBefore: null,
    // What the rail already held when this drive armed the engine and the backlog drained.
    // Every later assertion is an exact delta from this; see note 3 in the header.
    baseline: null,
    blocked: null,      // non-null: the measured reason no federated case can run
    // The venue's DOGE/USD quote and its age as the CURRENT case started, read before the
    // per-case reseed touched it. This is the only reading that can tell a clock refusal from
    // a pricing-code refusal, because after the reseed every row is fresh by construction.
    priceBeforeCase: null,
    evidence: {},       // every readout this drive took, printed at the end
};

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
    const tx = await chainRail.withRail(state.dogeRail, () => (typeof wire === 'function'
        ? wire()
        : transactionHelper.createAndSendTransaction(from, wire)));
    const got = await state.venue.verdict('DOGE', table, tx);
    assert.ok(got, 'the venue DOGE indexer never graded the ' + table + ' action in tx ' + tx +
        ' within the budget.\n' + state.venue.indexerTails(40));
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
    const escrow = escrowOf(await state.venue.bridgeBalances('BTC', GAS_TICK), 'DOGE');
    const supply = (await state.venue.bridgeBalances('DOGE', GAS_TICK)).supply;
    const nonBridge = await state.venue.escrowNonBridgeCredits('BTC', 'BRIDGE_DOGE', GAS_TICK);
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

async function recordSourceContext() {
    // WHICH TREE THIS DRIVE IS ACTUALLY RUNNING, recorded rather than assumed. A drive
    // can pin the code under test to one worktree through BRIDGE_RAIL_REPO_ROOT, and the
    // venue spawns its hubs and indexers out of it, but the TEST process loads indexer
    // modules of its own (the barrier names, and the gas-token parameter set AT1 grades
    // against). On drive 13 those came from the shared checkout while everything else came
    // from the pinned root, and the only reason it did not matter is that the two copies
    // differed by one comment line. So the module cache is read here and quoted in the
    // readouts: a path outside the pinned root is visible in the evidence instead of being
    // something a later reader has to re-derive.
    state.evidence.repoRoot = process.env.BRIDGE_RAIL_REPO_ROOT || null;
    state.evidence.indexerModulesLoaded = Object.keys(require.cache)
        .filter((p) => /xchain-indexer[\\/]src[\\/]/.test(String(p))).sort();

    state.dogeRail = await chainRail.createRail('dogecoin', NETWORK);
}

async function prepareQuorum() {
    // THE QUORUM GATE, and it is read off the LIVE chain rather than from a fixture:
    // the seated set is what it is at drive time, and a gate on a hard-coded roster
    // would keep passing after the roster changed.
    const tip = await indexerConnector.call('getblockhashes', {});
    const buried = Number(tip.block_index) -
        Number(require('../../helpers/hubMirrorTopology').CANONICAL_REORG_BUFFER || 6);
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
    state.quorum = resolveVenueQuorum(seated, fixture._knownSignerSeeds());
    state.evidence.seated = seated.map((s) => s.pubkey.slice(0, 16) + '@' + s.stake).join(', ');
    state.evidence.buriedBlock = buried;
    state.evidence.btcTip = Number(tip.block_index);

    if (!state.quorum.ok) {
        state.blocked = state.quorum.reason;
        console.log('\nBRIDGE RAIL: no federation can be built here.\n  ' + state.blocked +
            '\n  seated at block ' + buried + ': ' + state.evidence.seated + '\n');
        return null;
    }

    // THE MINIMUM QUORUM, NOT EVERY KEY THE HARNESS HOLDS. With all four seated keys a
    // round closes on any three and the fourth silently keeps no record; an indexer
    // mirrors exactly one hub, so whether the destination ever sees a transfer becomes a
    // coin toss. See `minimalQuorumSigners` for the measurement.
    const mesh = minimalQuorumSigners(state.quorum.signers.adopted, state.quorum.signers.totalStake);
    assert.ok(mesh.length, 'no subset of the adopted keys clears the supermajority, which ' +
        'resolveVenueQuorum should already have refused');
    state.evidence.meshSize = mesh.length;
    state.evidence.meshStake = mesh.reduce((n, a) => n + Number(a.stake || 0), 0) +
        ' of ' + state.quorum.signers.totalStake;
    return mesh;
}

async function startVenue(mesh) {
    state.venue = new BridgeRailVenue({
        label: 'bridgerail',
        identities: mesh.map((a) => ({
            pubkeyHex: a.pubkeyHex,
            // ValidatorIdentity takes the seed; the adopted entry carries it.
            privkeyHex: a.seedHex,
        })),
        dogeRail: state.dogeRail,
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
    const up = await state.venue.start();
    if (!up) {
        state.blocked = 'the venue could not be built: ' + state.venue.unavailable;
        console.log('\nBRIDGE RAIL: ' + state.blocked + '\n');
        return;
    }
    await fixture.waitForVenueIndexersAtTip(state.venue.btcVenue);
    // FIVE HOURS FOR THE DOGE SIDE, not the fixture's default 150 minutes, because
    // this indexer REPLAYS the chain rather than cloning it (dq 5). DOGE regtest was
    // 10648 blocks on 2026-09-12 and the block loop adds one every 20 seconds while
    // the replay runs, so the first pass is hours and a barrier that gives up in the
    // middle of it reports a venue fault where the real fact is a long catch-up.
    // Later runs resume the same stable database and cost only the new blocks.
    await chainRail.withRail(state.dogeRail, () => fixture.waitForVenueIndexersAtTip(
        state.venue.dogeVenue, { timeoutMs: 300 * 60 * 1000 }));
}

async function prepareDrive() {
    await recordSourceContext();
    const mesh = await prepareQuorum();
    if (!mesh) return;
    await startVenue(mesh);
}

// EVERY CASE'S VERDICT, WRITTEN AS IT ENDS, and it exists because drive 13's whole
// result was lost: mocha prints a failure MESSAGE only in its epilogue, so a run that
// ends any other way than by finishing takes every message with it. Drive 13 was
// interrupted inside a stalled funding call and the baseline failure that six other reds
// cascaded off could not be read at all afterwards. A journal line per case survives an
// interrupt, a crash and a kill.
function recordCase() {
    const test = this.currentTest || {};
    const err = test.err || null;
    journalCase({
        suite: 'bridgeRailBase',
        title: String(test.title || ''),
        state: String(test.state || 'unfinished'),
        durationMs: Number(test.duration || 0),
        error: err ? String(err.message).slice(0, 4000) : null,
    });
}

async function finishDrive() {
    this.timeout(0);
    if (state.venue) await state.venue.stop();
    console.log('\n=== bridge rail drive readouts ===\n' +
        JSON.stringify(state.evidence, null, 2) + '\n');
    // AND ON DISK, for the same reason as the per-case journal: this block is the drive's
    // only complete readout and an interrupted run never prints it.
    journalCase({ suite: 'bridgeRailBase', title: '=== readouts ===', state: 'evidence',
        evidence: state.evidence });
}

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
async function refreshPrices() {
    this.timeout(0);
    if (!state.venue || state.blocked) return;
    state.priceBeforeCase = await state.venue.readVenuePrice('DOGE/USD');
    if (state.priceBeforeCase) {
        state.evidence.priceClock = state.evidence.priceClock || [];
        state.evidence.priceClock.push({
            case: this.currentTest ? String(this.currentTest.title).slice(0, 70) : null,
            ageSeconds: state.priceBeforeCase.ageSeconds, stale: state.priceBeforeCase.stale,
            rowCount: state.priceBeforeCase.rowCount, price: state.priceBeforeCase.price });
    }
    await state.venue.refreshVenuePrices();
}

/**
 * Skip THIS case with the measured blocker, and say which AT is going unproven.
 *
 * A skip that names nothing is indistinguishable from a case nobody wrote, which is
 * the whole reason the frontier could not tell "attempted and blocked" from
 * "skipped" the last time this row was tried.
 */
function needsFederation(ctx, at) {
    if (!state.blocked) return false;
    console.log('  ' + at + ' NOT DRIVEN: ' + state.blocked);
    ctx.skip();
    return true;
}

const OUTER_TITLE = 'XBRIDGE acceptance drive on the BTC/DOGE regtest rail (AT1, AT2, AT5, AT6, AT7, AT9)';
let outerSuite = null;

function registerHooks() {
    before(async function () {
        this.timeout(0);
        await prepareDrive();
    });
    afterEach(recordCase);
    after(finishDrive);
    beforeEach(refreshPrices);
}

function bridgeRailSuite(title, callback) {
    if (!outerSuite) {
        outerSuite = describe(OUTER_TITLE, function () {
            registerHooks();
        });
    }
    const child = describe(title, callback);
    const rootSuite = child.parent;
    rootSuite.suites.splice(rootSuite.suites.indexOf(child), 1);
    outerSuite.addSuite(child);
}

module.exports = {
    assert,
    chainRail,
    cryptoHelper,
    transactionHelper,
    issueHelper,
    mintHelper,
    lockWireV0,
    burnWireV1,
    classifyInvariant,
    escrowOf,
    driveVerdictWitness,
    GAS_TICK,
    AT1_LOCK,
    AT2_BURN,
    AT7_MINT,
    AT7_EACH,
    EXPIRY,
    state,
    dogeAction,
    chainHalves,
    assertBacked,
    needsFederation,
    bridgeRailSuite,
};
