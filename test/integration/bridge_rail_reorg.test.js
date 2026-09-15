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
 * ── HOW TO RUN IT, on the regtest rail host, from this repository root ──────────────
 *
 *   nohup ~/scratch/xc-meta/doge-loop.sh >/dev/null 2>&1 & echo $! > ~/scratch/xc-meta/doge-loop.pid
 *   COIN=bitcoin NETWORK=regtest NODE_PATH=<the chunked module directory> \
 *     npx mocha --timeout 0 --exit --require ./test/initialCheck.test.js \
 *     test/integration/bridgeRailReorg.rail.test.js
 *   kill $(cat ~/scratch/xc-meta/doge-loop.pid)
 *
 * ── THE SAME QUORUM GATE ───────────────────────────────────────────────────────────
 * Every case here needs a federation, for the same reason and behind the same gate
 * bridgeRailBase.rail.test.js documents at length: the four seated roster keys are idle
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
const transactionHelper = require('../transactionHelper');
const mintHelper        = require('../helpers/mintHelper');
const fixture           = require('../attestMirror/mirrorDrillFixture');
const {
    BridgeRailVenue,
    resolveVenueQuorum,
    lockWireV0,
    classifyInvariant,
    escrowOf,
    journalCase,
    minimalQuorumSigners,
    assertShallowOrphan,
    withMiningPaused,
} = require('../helpers/bridgeRailVenue');

const GAS_TICK = 'XCHAIN';

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

/**
 * Orphan the BTC block at `height` and re-mine past it.
 *
 * Only ever called on a height this suite itself mined; see the header.
 */
async function reorgBtcFrom(height, replaceWith) {
    assert.ok(height > startTip,
        'refusing to invalidate BTC block ' + height + ', which existed before this suite started');
    // THE SAME LEVER THE ATTESTATION REORG DRILLS USE, because the first run of this suite
    // called a `regtestMinerConnector.call()` that does not exist (`call is not a function`)
    // and a miner RPC that does not either: the miner sidecar mines, the NODE orphans. The
    // hash also comes from the node rather than an indexer, which is the other half of the
    // same correction: the block was mined seconds ago and an indexer answers
    // `block not indexed: <height>` until it has parsed it.
    const tipBefore = Number(await nodeConnector.getBlockCount());
    // THE WINDOW GUARD, pulled into the shared pure layer so it has one unit-tested
    // home instead of a copy per reorg drill; the message stays byte-identical.
    assertShallowOrphan(Number(height), tipBefore, TRACKER_UNDO_BLOCKS);
    const hash = await nodeConnector.getBlockHash(Number(height));
    assert.ok(hash, 'the BTC node could not name the block at height ' + height + ' to orphan');
    await nodeConnector.invalidateBlock(hash);
    const rolled = Number(await nodeConnector.getBlockCount());
    assert.strictEqual(rolled, Number(height) - 1,
        'the node sits at ' + rolled + ' after invalidating block ' + height);
    // Re-mine through the miner sidecar, which owns the coinbase address, and OVERTAKE the
    // height that was there: a competing chain no longer than the one it replaced leaves
    // the orphan reachable and the reorg unobserved.
    const need = Math.max(Number(replaceWith || 2), tipBefore - rolled + 1);
    await regtestMinerConnector.generateBlocks(need);
    const tipAfter = Number(await nodeConnector.getBlockCount());
    assert.ok(tipAfter > tipBefore,
        'the competing chain reached ' + tipAfter + ', which does not overtake ' + tipBefore);
    assert.notStrictEqual(await nodeConnector.getBlockHash(Number(height)), hash,
        'block ' + height + ' still has its original hash, so nothing actually reorged');
    return hash;
}

bridgeParts.provide({
    setup: setUpBridgeRail,
    teardown: tearDownBridgeRail,
    beforeEach: refreshBridgePrices,
    afterEach: journalBridgeTest,
    snapshot: () => ({ venue, dogeRail, blocked, evidence, needsFederation }),
});

function registerBridgeTest(group, title, callback) {
    describe('XBRIDGE acceptance drive: reorg and falsification (AT3, AT4)', function () {
        bridgeParts.install();
        describe(group, function () {
            it(title, callback);
        });
    });
}


registerBridgeTest('AT3: a source leg reorged out', "(a) a lock orphaned before the federation signs never produces a bridge_transfers row", async function () {
    this.timeout(0);
    if (needsFederation(this, 'AT3a')) return;

    // The lock is mined and then orphaned INSIDE the confirmation window, so the
    // engine never sees it at depth. The assertion is the ABSENCE of a row for
    // this destination address, which is why the address is fresh: "no row" is
    // only a claim if nothing else could have written one.
    const dest = await venue.funded('AT3A.DEST', () => chainRail.withRail(dogeRail,
        () => cryptoHelper.getNewFundedAddress('AT3A.DEST', 'dogecoin', NETWORK, null, 'legacy', 0, 1, false)));
    const sender = await venue.funded('AT3A.SENDER',
        () => cryptoHelper.getNewFundedAddress('AT3A.SENDER', 'bitcoin', NETWORK, null, 'legacy', 0, 1, false));
    await mintHelper.sendMintV0(sender, GAS_TICK, 1, sender.address, '');

    const before = Number((await indexerConnector.call('getblockhashes', {})).block_index);
    const lockTx = await transactionHelper.createAndSendTransaction(
        sender, lockWireV0('DOGE', dest.address, 1, ''));
    const minedAt = Number((await indexerConnector.call('getblockhashes', {})).block_index);
    const orphaned = await reorgBtcFrom(Math.max(minedAt, before + 1), 3);
    evidence.at3a = { lockTx, minedAt, orphanedHash: orphaned, destAddress: dest.address };

    const row = await venue.waitForFinalizedTransfer(
        (r) => String(r.dest_address) === dest.address, { timeoutMs: 90000 });
    assert.strictEqual(row, null,
        'a bridge_transfers row exists for ' + dest.address + ' whose source lock was orphaned ' +
        'before it ever reached depth: ' + JSON.stringify(row));
    assert.strictEqual(await venue.addressBalance('DOGE', dest.address, GAS_TICK), '0',
        dest.address + ' was credited on DOGE from a lock that is not on the BTC chain');
});

registerBridgeTest('AT3: a source leg reorged out', "(b) a finalized row whose source is orphaned before effective_time is retracted and never applied", async function () {
    this.timeout(0);
    if (needsFederation(this, 'AT3b')) return;

    const dest = await venue.funded('AT3B.DEST', () => chainRail.withRail(dogeRail,
        () => cryptoHelper.getNewFundedAddress('AT3B.DEST', 'dogecoin', NETWORK, null, 'legacy', 0, 1, false)));
    const sender = await venue.funded('AT3B.SENDER',
        () => cryptoHelper.getNewFundedAddress('AT3B.SENDER', 'bitcoin', NETWORK, null, 'legacy', 0, 1, false));
    await mintHelper.sendMintV0(sender, GAS_TICK, 1, sender.address, '');

    const hashesBefore = await venue.blockHashes('DOGE');
    const lockTx = await transactionHelper.createAndSendTransaction(
        sender, lockWireV0('DOGE', dest.address, 1, ''));
    const minedAt = Number((await indexerConnector.call('getblockhashes', {})).block_index);
    const row = await venue.waitForFinalizedTransfer((r) => String(r.dest_address) === dest.address);
    assert.ok(row, 'the AT3b lock never finalized, so there is nothing to retract');

    const orphaned = await reorgBtcFrom(minedAt, 3);
    // The retraction is FENCED and CO-SIGNED: the row is removed from the mirror
    // stream by a quorum act, not by one hub deleting a row. What the destination
    // must never do is apply it, so the DOGE credit and the DOGE hashes are what
    // the assertions read.
    const retracted = await venue.waitForFinalizedTransfer(
        (r) => String(r.transfer_id) === String(row.transfer_id) &&
               String(r.status || '').toLowerCase().includes('retract'),
        { timeoutMs: 180000 });
    const hashesAfter = await venue.blockHashes('DOGE', hashesBefore[0].block_index);
    evidence.at3b = { lockTx, transferId: row.transfer_id, orphanedHash: orphaned,
        retracted: !!retracted, destAddress: dest.address };

    assert.strictEqual(await venue.addressBalance('DOGE', dest.address, GAS_TICK), '0',
        'the DOGE indexer applied a transfer whose source leg is no longer on the BTC chain');
    assert.strictEqual(String(hashesAfter[0].ledger_hash), String(hashesBefore[0].ledger_hash),
        'the DOGE ledger_hash at block ' + hashesBefore[0].block_index + ' moved');
    assert.strictEqual(String(hashesAfter[0].actions_hash), String(hashesBefore[0].actions_hash),
        'the DOGE actions_hash at block ' + hashesBefore[0].block_index + ' moved');
});

// FREEZE BTC from here, not sooner: the source leg is already finalized, and
// every step left is a wait on the DESTINATION's own clock (the hub stamps
// effective_time off wall time and DOGE applies at its own next block past
// it), so no further BTC block buys this case anything. Left unfrozen, the
// standing miner keeps mining BTC on its own ambient cadence regardless of
// this case, and a multi-minute mint wait burns through the tracker's undo
// window before the orphan is even attempted (measured: 16 deep against a
// 12-block window). Mining resumes in every path out of this block.
registerBridgeTest('AT3: a source leg reorged out', "(c) a lock orphaned AFTER the mint applied leaves the credit, and the deficit reads CRIT", async function () {
    this.timeout(0);
    if (needsFederation(this, 'AT3c')) return;

    // D16, ruled: milestone 1 ships NO destination-side unwind. So the correct
    // behaviour is the uncomfortable one, and this case pins it: the DOGE credit
    // STAYS, the DOGE hashes do not move, the BTC escrow falls away with BTC's own
    // rollback, and the invariant is what surfaces the damage.
    const dest = await venue.funded('AT3C.DEST', () => chainRail.withRail(dogeRail,
        () => cryptoHelper.getNewFundedAddress('AT3C.DEST', 'dogecoin', NETWORK, null, 'legacy', 0, 1, false)));
    const sender = await venue.funded('AT3C.SENDER',
        () => cryptoHelper.getNewFundedAddress('AT3C.SENDER', 'bitcoin', NETWORK, null, 'legacy', 0, 1, false));
    await mintHelper.sendMintV0(sender, GAS_TICK, 1, sender.address, '');

    const lockTx = await transactionHelper.createAndSendTransaction(
        sender, lockWireV0('DOGE', dest.address, 1, ''));
    const minedAt = Number((await indexerConnector.call('getblockhashes', {})).block_index);
    const row = await venue.waitForFinalizedTransfer((r) => String(r.dest_address) === dest.address);
    assert.ok(row, 'the AT3c lock never finalized');

    let dogeHashBefore;
    const orphaned = await withMiningPaused(regtestMinerConnector, async () => {
        // Wait for the mint to APPLY before the orphan; orphaning first would be AT3b.
        const deadline = Date.now() + 240000;
        while (Date.now() < deadline &&
               Number(await venue.addressBalance('DOGE', dest.address, GAS_TICK)) < 1) {
            await new Promise((r) => setTimeout(r, 3000));
        }
        assert.strictEqual(await venue.addressBalance('DOGE', dest.address, GAS_TICK), '1',
            'the mint never applied on DOGE, so this case cannot orphan "after the mint"');

        dogeHashBefore = await venue.blockHashes('DOGE');
        return reorgBtcFrom(minedAt, 4);
    });

    const inv = await venue.bridgeInvariant(GAS_TICK);
    const entry = inv[GAS_TICK].DOGE;
    const cls = classifyInvariant(entry);
    const dogeHashAfter = await venue.blockHashes('DOGE', dogeHashBefore[0].block_index);
    evidence.at3c = { lockTx, transferId: row.transfer_id, orphanedHash: orphaned,
        invariant: entry, escrow: escrowOf(await venue.bridgeBalances('BTC', GAS_TICK), 'DOGE') };

    assert.strictEqual(await venue.addressBalance('DOGE', dest.address, GAS_TICK), '1',
        'the DOGE credit was unwound, which milestone 1 explicitly does not do (D16)');
    assert.strictEqual(String(dogeHashAfter[0].ledger_hash), String(dogeHashBefore[0].ledger_hash),
        'a BTC reorg moved a DOGE ledger hash');
    assert.strictEqual(cls.verdict, 'deficit',
        'getbridgeinvariant reads ' + JSON.stringify(entry) + ' rather than a deficit');

            const watch = require('../../../claude/scripts/xchain-watch.js');
    const items = watch.bridgeInvariantVerdicts([{ label: 'venue-hub-0', ok: true, byTick: inv }])
        .filter((i) => i.tick === GAS_TICK && i.chain === 'DOGE');
    evidence.at3c_watch = items.map((i) => ({ sev: i.sev, kind: i.kind }));
    assert.strictEqual(items.length, 1);
    assert.strictEqual(items[0].sev, 'crit');
    assert.strictEqual(items[0].kind, 'BRIDGE_INVARIANT_DEFICIT');
});
