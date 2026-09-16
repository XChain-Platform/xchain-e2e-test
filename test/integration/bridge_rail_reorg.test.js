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
 * THE BRIDGE ACCEPTANCE DRIVE, the adversarial legs: AT3 (reorg) and AT4 (falsification).
 *
 * WHY THESE ARE THEIR OWN FILE AND THEIR OWN RUN. Every case here deliberately breaks
 * the chain or the mirror under a live federation, and two of them leave the BTC escrow
 * in a state the base legs' arithmetic would then read as a fault. Running them beside
 * AT1 and AT2 would make each suite's failures look like the other's.
 *
 * ── ONE SUITE IN TWO PLACES ────────────────────────────────────────────────────────
 * This root holds the venue bring-up, the teardown that proves the shared chain was left
 * no shorter, and the reorg lever; the cases live in `bridge_rail_reorg.test/0*.test.js`
 * (AT3, then AT4) and reach all of it through `./bridge_rail_reorg.test/helpers/fixture`.
 * The parts are ONE mocha run and must sit on the same command line, root first, with the
 * glob quoted so mocha expands it:
 *
 *   npx mocha test/integration/bridge_rail_reorg.test.js "test/integration/bridge_rail_reorg.test/*.test.js"
 *
 * mocha keeps the command-line order and sorts a glob's matches among themselves, so the
 * `0N_` prefixes order the parts. The root alone registers no case, so it drives nothing
 * and never brings the venue up; a part alone has no root to bind to and fails at its
 * first `before`.
 *
 * ── HOW TO RUN IT, on the regtest rail host, from this repository root ──────────────
 *
 *   nohup ~/scratch/xc-meta/doge-loop.sh >/dev/null 2>&1 & echo $! > ~/scratch/xc-meta/doge-loop.pid
 *   COIN=bitcoin NETWORK=regtest NODE_PATH=<the chunked module directory> \
 *     npx mocha --timeout 0 --exit --require ./test/initialCheck.test.js \
 *     test/integration/bridge_rail_reorg.test.js "test/integration/bridge_rail_reorg.test/*.test.js"
 *   kill $(cat ~/scratch/xc-meta/doge-loop.pid)
 *
 * ── THE SAME QUORUM GATE ───────────────────────────────────────────────────────────
 * Every case here needs a federation, for the same reason and behind the same gate
 * bridge_rail_base.test.js documents at length: the four seated roster keys are idle
 * generations of `XC_ROLLCALL_FEDERATION_MNEMONIC`, an operator secret that a drive
 * sources from the operator's own 0600 store into its environment and passes no other
 * way. The gate is `resolveVenueQuorum`; a drive given the secret runs every case below
 * with no other change, and a drive without it skips them with the reason named.
 *
 * ── THE ONE THING AT3 MUST NOT DO ──────────────────────────────────────────────────
 * `invalidateblock` on BTC regtest is the lever, and the standing stack shares that
 * chain with every other rail lane. Each leg therefore reorgs only blocks THIS SUITE
 * mined, never a block that was there when it started, and it re-mines to at least the
 * height it found. The starting tip is captured in `before` and asserted in `after`: a
 * suite that leaves the shared chain shorter than it found it has damaged a fixture it
 * does not own, and that must fail loudly here rather than silently in someone else's
 * lane tomorrow.
 *
 * Spec: the base bridge spec, section 15 (AT3, AT4), D16, D65.
 *
 ********************************************************************/

'use strict';

const assert = require('assert');

const chainRail         = require('../helpers/chainRail');
const stakeTeardown     = require('../helpers/stakeTeardown');
const cryptoHelper      = require('../cryptoHelper');
const fixture           = require('../attestMirror/mirrorDrillFixture');
const {
    BridgeRailVenue,
    resolveVenueQuorum,
    journalCase,
    minimalQuorumSigners,
    assertShallowOrphan,
    confirmedHeight,
    orphanWithEmptyBlocks,
} = require('../helpers/bridgeRailVenue');

// The standing utxo-tracker's undo window, the same 12 the attestation reorg drills pin. A
// reorg deeper than this halts the tracker and needs a resync, and the tracker is shared with
// every other lane on this rail, so the depth is asserted rather than hoped for.
const TRACKER_UNDO_BLOCKS = 12;

const bridgeParts = require('./bridge_rail_reorg.test/helpers/fixture');

let venue = null;
let dogeRail = null;
let blocked = null;
let startTip = null;
const evidence = {};

async function setUpBridgeRail() {
    dogeRail = await chainRail.createRail('dogecoin', NETWORK);

    const tip = await indexerConnector.call('getblockhashes', {});
    startTip = Number(tip.block_index);
    evidence.startTip = startTip;

    const buried = startTip -
        Number(require('../helpers/hubMirrorTopology').CANONICAL_REORG_BUFFER || 6);
    const set = await stakeTeardown.readCapabilitySet({
        indexer: indexerConnector, capability: 'cross_chain', blockIndex: buried,
    });
    assert.ok(set && !set.error, 'the cross_chain capability set could not be read at ' + buried);
    const seated = set.pubkeys.map((pk) => {
        const row = set.byPubkey.get(pk) || {};
        return { pubkey: pk, stake: Number(row.weight || 0) };
    });
    const quorum = resolveVenueQuorum(seated, fixture._knownSignerSeeds());
    if (!quorum.ok) {
        blocked = quorum.reason;
        console.log('\nBRIDGE REORG: no federation can be built here.\n  ' + blocked + '\n');
        return;
    }
    // THE MINIMUM QUORUM, NOT EVERY ADOPTED KEY, for the reason the base suite measured:
    // with all four seated keys a round closes on ANY three and the fourth keeps no
    // record, while this venue's destination indexer mirrors exactly ONE hub. Whether the
    // mint AT3b and AT3c reason about ever reaches the destination would then be a coin
    // toss, and a leg that never arrived is indistinguishable here from a retraction that
    // correctly stopped it. At the minimum quorum every signature is load-bearing, so the
    // hub the indexer follows is always in the round.
    const mesh = minimalQuorumSigners(quorum.signers.adopted, quorum.signers.totalStake);
    assert.ok(mesh.length, 'no subset of the adopted keys clears the supermajority');
    evidence.meshSize = mesh.length;
    evidence.meshStake = mesh.reduce((n, a) => n + Number(a.stake || 0), 0) +
        ' of ' + quorum.signers.totalStake;
    venue = new BridgeRailVenue({
        label: 'bridgereorg',
        basePort: 44000,
        identities: mesh.map((a) => ({ pubkeyHex: a.pubkeyHex, privkeyHex: a.seedHex })),
        dogeRail: dogeRail,
        confirmations: { BTC: 1, DOGE: 1 },
    });
    const up = await venue.start();
    if (!up) { blocked = 'the venue could not be built: ' + venue.unavailable; return; }
    await fixture.waitForVenueIndexersAtTip(venue.btcVenue);
    await chainRail.withRail(dogeRail, () => fixture.waitForVenueIndexersAtTip(venue.dogeVenue));
}

async function tearDownBridgeRail() {
    if (venue) await venue.stop();
    if (startTip !== null && !blocked) {
        const tip = Number((await indexerConnector.call('getblockhashes', {})).block_index);
        evidence.endTip = tip;
        assert.ok(tip >= startTip,
            'this suite left the SHARED BTC regtest chain at height ' + tip + ' having found it at ' +
            startTip + '. Every other rail lane\'s fixtures hang off that chain.');
    }
    console.log('\n=== bridge reorg drive readouts ===\n' + JSON.stringify(evidence, null, 2) + '\n');
    journalCase({ suite: 'bridgeRailReorg', title: '=== readouts ===', state: 'evidence',
        evidence: evidence });
}

// The per-case journal, for the reason the base suite's copy states: a mocha failure
// message exists only in the epilogue, and an interrupted drive never prints one. AT3 and
// AT4 had never run at all before this suite got its own process, so their first readings
// are the ones that must not be lost.
function journalBridgeTest() {
    const test = this.currentTest || {};
    journalCase({
        suite: 'bridgeRailReorg',
        title: String(test.title || ''),
        state: String(test.state || 'unfinished'),
        durationMs: Number(test.duration || 0),
        error: test.err ? String(test.err.message).slice(0, 4000) : null,
    });
}

// Hold the FIXTURE's price clock still, exactly as the base suite does. This suite brings
// its own venue up hours into the drive and then spends minutes per case orphaning blocks
// and waiting out relay margins, while the venue's oracle publishes nothing after bring-up
// and every emission prices its fee against a quote no older than 1800 s. Without this a
// late AT3 or AT4 mint is refused `no current oracle price for <COIN>/USD (stale beyond
// 1800s)` and reads as a bridge refusal, which is what happened to AT5 on drive 11.
async function refreshBridgePrices() {
    if (!venue || blocked) return;
    await venue.refreshVenuePrices();
}

function needsFederation(ctx, at) {
    if (!blocked) return false;
    console.log('  ' + at + ' NOT DRIVEN: ' + blocked);
    ctx.skip();
    return true;
}

// The competing chain's coinbase destination: its own address, so the orphaned chain's
// coinbases and the replacement chain's are never confused with a case's funds.
let coinbaseAddress = null;
async function replacementCoinbase() {
    if (!coinbaseAddress) {
        coinbaseAddress = (await cryptoHelper.getNewAddress('BRIDGEREORG.COINBASE', 'bitcoin', NETWORK,
            null, 'legacy', 0)).address;
    }
    return coinbaseAddress;
}

/**
 * Orphan the BTC block holding `lockTx` and replace it with a LONGER chain of EMPTY blocks,
 * leaving the lock unconfirmed. Returns `{hash, height, tipBefore, tipAfter, mined}`, `hash`
 * being the orphaned block's.
 *
 * Only ever called on a height this suite itself mined; see the header. The height is the
 * lock's own confirming block as the NODE reports it, never an indexer tip read beside it.
 *
 * EMPTY blocks, mined at the node, are the whole point. `invalidateblock` hands the
 * disconnected blocks' transactions back to the mempool, and the miner sidecar's
 * `generatetoaddress` would mine them straight back in: the lock would be "orphaned" and yet
 * confirmed again one block later, the federation would finalize it correctly, and a case
 * that asserts the absence of a row for that lock would be asserting against a working
 * bridge. So the standing miner must ALSO be paused for as long as a case's claim depends on
 * the lock staying out of the chain: every caller runs inside `withMiningPaused`, and once
 * mining resumes the lock is mined again, finalized and applied, all of it legitimate.
 *
 * @param {string} lockTx      the lock's txid
 * @param {number} replaceWith a floor on the number of replacement blocks
 */
async function reorgBtcFrom(lockTx, replaceWith) {
    const height = await confirmedHeight(nodeConnector, lockTx);
    assert.ok(height > startTip,
        'refusing to invalidate BTC block ' + height + ', which existed before this suite started');
    const tipBefore = Number(await nodeConnector.getBlockCount());
    // THE WINDOW GUARD, in the shared pure layer so it has one unit-tested home instead of a
    // copy per reorg drill.
    assertShallowOrphan(height, tipBefore, TRACKER_UNDO_BLOCKS);
    const orphan = await orphanWithEmptyBlocks(nodeConnector, {
        height: height,
        coinbase: await replacementCoinbase(),
        atLeast: replaceWith,
        lockTx: lockTx,
    });
    return Object.assign({ height: height }, orphan);
}

/**
 * Hold until the venue BTC indexer has parsed the node's tip, so a reading taken after an
 * orphan is a reading of the ledger WITHOUT the lock rather than of the ledger a moment
 * before the rollback ran. The wait itself is the venue's, shared with the base suite's
 * after-reads; this binds it to the node's tip.
 */
async function venueBtcCaughtUp(what) {
    const tip = Number(await nodeConnector.getBlockCount());
    await venue.waitForVenueTip('BTC', tip, what, { timeoutMs: 180000, everyMs: 2000 });
    return tip;
}

bridgeParts.provide({
    setup: setUpBridgeRail,
    teardown: tearDownBridgeRail,
    beforeEach: refreshBridgePrices,
    afterEach: journalBridgeTest,
    // The lever and the catch-up wait ride along with the venue: they close over this
    // file's `startTip` and `venue`, which the parts never hold directly.
    snapshot: () => ({ venue, dogeRail, blocked, evidence, needsFederation, reorgBtcFrom, venueBtcCaughtUp }),
});
