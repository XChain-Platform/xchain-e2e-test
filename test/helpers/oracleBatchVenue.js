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
 * ORACLE PUBLISH VENUE: a real quorum federation wired to a real regtest
 * publish rail.
 *
 * WHY THIS EXISTS. The two halves of an oracle publish have never met in a
 * test. multiHubOracleWeighted / multiHubFiatOracle drive a REAL PBFT round on
 * an in-process MultiValidatorHub and stop at finalizeRound(): nothing they do
 * reaches a chain. The single-host regtest stack runs ONE hub, so it has a
 * chain but no quorum and cannot produce a multi-signature PRICE at all.
 * Between them, `xchain-hub/src/OraclePublisher.js` - the class that decides
 * which validator publishes, builds the wire, guards the spend and owns the
 * durable at-most-once markers - has never been driven by anything in this
 * repo. This venue closes that: N in-process validators finalize real rounds,
 * the REAL OraclePublisher elects its leader and hands the REAL wire to a REAL
 * regtest broadcast, and the landed action is read back out of the landing
 * chain's own indexer.
 *
 * WHAT IS REAL AND WHAT IS SEEDED, stated plainly so nothing here reads as more
 * than it is:
 *   REAL - the hubs, their identities, their P2P mesh, OracleConsensus, the
 *          PBFT propose/prepare/commit round, the per-hub price_snapshots
 *          write, OraclePublisher's leader rotation, its wire builder, its
 *          durable queue and marker table, the encoder, the signature, the
 *          node broadcast, the block, the decoder, the indexer's parse.
 *   SEEDED - the capability snapshots. An in-process hub has no indexer to
 *          read a staked validator set from, so seededWeightSnapshot (the
 *          `price` weighted quorum) and seededStakeSnapshot (the
 *          `oracle_publish` member set the publisher ranks itself in) stand in,
 *          exactly as every other multi-hub suite does.
 *
 * THE WIRE VERSION IS A PARAMETER, NOT AN ASSUMPTION. Nothing here builds or
 * matches on `PRICE|0|`. The venue captures whatever wire the publisher hands
 * its broadcast hook and reads the version out of field 1, so a publisher that
 * later emits a PRICE v2 batch needs no venue change: the drill asserts on the
 * captured version instead. `expectWireVersion` only sharpens the failure
 * message when a run gets a version it did not plan for.
 *
 * KNOWN CEILING ON THE LANDED VERDICT, measured 2026-08-26 and NOT a venue
 * fault. On any non-BTC chain the indexer resolves the `price` capability set
 * from its own `stakes` table, and capability staking is BTC-only
 * (xchain-indexer/src/coins/DOGE.js: `CAPABILITIES: {}`). The hub-mirrored
 * `capability_snapshots` fallback in db.getValidatorsByCapability /
 * getStakeWeightsByCapability is scoped to `cross_chain` and `oracle_publish`
 * and does not cover `price`. A PRICE landing on DOGE therefore qualifies zero
 * signers and records `invalid: insufficient signer stake`, whatever the
 * federation did. The venue records the verdict it observes rather than
 * asserting a verdict it wants; `expectValidationStatus` lets a drill pin the
 * one it expects once that gap is closed.
 *
 * ONE VENUE AT A TIME. startDisposableHubDb self-provisions its throwaway
 * MariaDB on a fixed port (13307) when the environment's hub DB credentials do
 * not answer, which is the path this stack takes, so two venue runs in parallel
 * would fight over that container. Run drills against this venue serially.
 ********************************************************************/

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const { MultiValidatorHub, loadHubModule } = require('./multiValidatorHubHelper');
const { startDisposableHubDb } = require('./disposableHubDb');
const { seedWeightSnapshot }   = require('./seededWeightSnapshot');
const { seedStakeSnapshot }    = require('./seededStakeSnapshot');
const { waitForMesh, waitFor } = require('./consensusWait');
const { waitForTxIndexed }     = require('./indexerWait');
const chainRail                = require('./chainRail');

const OracleConsensus  = loadHubModule('src/OracleConsensus.js');
const OracleRound      = loadHubModule('src/OracleRound.js');
const OraclePublisher  = loadHubModule('src/OraclePublisher.js');
const ValidatorIdentity = loadHubModule('src/ValidatorIdentity.js');

// A deadline, not a settle: waitForMesh returns on the first fully-peered poll.
const MESH_WAIT_MS = 60_000;
// How long one finalized round has to reach a broadcast. The window covers the
// PBFT round plus a full encoder build, sign, broadcast and confirmation, so it
// is generous; it is spent polling and returns the moment the hook resolves.
const PUBLISH_WAIT_MS = 240_000;

// Pairs the venue finalizes by default. Deliberately NOT XCHAIN/USD or
// <COIN>/USD: nativeFeeHelper.seedGlobalPrices clears and re-seeds exactly those
// two pairs on every action tx, so a venue that used them would have its own
// finalized rounds deleted underneath it by its own fee output.
const DEFAULT_PAIRS = [
    { coinPair: 'BTC/USD', price: '61000' },
    { coinPair: 'LTC/USD', price: '76' }
];

// Per-validator price submissions for one round. Every hub is handed the SAME
// set so each independently aggregates the identical canonical and the leader's
// proposal verifies on every follower; the per-round nudge keeps consecutive
// rounds from being byte-identical, which is what makes a batch of K rounds a
// meaningful payload rather than one round repeated K times.
function submissionsForRound(pairs, roundOffset) {
    return pairs.map((p) => ({
        coinPair: p.coinPair,
        price: String(Number(p.price) + roundOffset)
    }));
}

// Version field of a PRICE wire (`PRICE|<version>|...`), or null when the wire
// is not a PRICE at all. Parsed rather than assumed so the venue carries no
// opinion about which version the publisher under test emits.
function wireVersionOf(wire) {
    const parts = String(wire || '').split('|');
    if (parts[0] !== 'PRICE') return null;
    const v = parseInt(parts[1], 10);
    return Number.isFinite(v) ? v : null;
}

class OracleBatchVenue {

    /**
     * @param opts.coin/network         landing chain for the publish (default dogecoin/regtest,
     *                                  the chain OraclePublisher targets in production)
     * @param opts.validatorCount       in-process hubs (default 4: quorum 3, tolerates 1 fault)
     * @param opts.basePort             P2P port probe base
     * @param opts.pairs                [{coinPair, price}] finalized each round
     * @param opts.roundBase            first round number; defaults to a run-scoped value so a
     *                                  rerun never collides with a previous run's rounds
     * @param opts.anchorHeight         BTC anchor height the rounds lock their snapshot at
     * @param opts.anchorTimeBase       BTC block time (seconds) of the first round
     * @param opts.fundAmount           coin funded to the shared publisher wallet
     * @param opts.expectWireVersion    sharpens the failure message only; nothing branches on it
     * @param opts.expectValidationStatus  indexer verdict a drill expects, or null to record
     *                                  whatever lands (default null)
     */
    constructor(opts) {
        opts = opts || {};
        this.coin            = opts.coin    || 'dogecoin';
        this.network         = opts.network || 'regtest';
        this.validatorCount  = opts.validatorCount || 4;
        this.basePort        = opts.basePort || 33800;
        this.pairs           = opts.pairs || DEFAULT_PAIRS;
        // Round numbers must not repeat across runs: OraclePublisher's durable
        // marker table is per-hub and disposable, but the LANDING chain is not, and
        // a rerun that reused round numbers would leave two on-chain PRICE actions
        // for one round and make any "exactly one wire covers these rounds" claim
        // unreadable. Seconds-since-epoch is monotonic enough for that and stays
        // well inside the parser's ROUND bound.
        this.roundBase       = opts.roundBase || Math.floor(Date.now() / 1000);
        this.anchorHeight    = opts.anchorHeight || 100;
        this.anchorTimeBase  = opts.anchorTimeBase || 1700000000;
        this.fundAmount      = opts.fundAmount || 200;
        this.expectWireVersion       = opts.expectWireVersion === undefined ? 0 : opts.expectWireVersion;
        this.expectValidationStatus  = opts.expectValidationStatus || null;

        // Why the venue can't run here, when it can't. Non-null means every caller
        // should skip rather than fail: a venue that was never reachable proves
        // nothing either way.
        this.unavailable = null;

        this.rail        = null;
        this.hubDb       = null;
        this.mvh         = null;
        this.publisherAddress = null;
        this.publishers  = [];
        this.rounds      = [];        // [{round, anchorHeight, anchorTime, prices, signatures}]
        this.publications = [];       // [{round, hubIndex, wire, wireVersion, wireBytes, txid, publishedAt}]

        this._railSaved   = null;
        this._weightSeed  = null;
        this._countSeed   = null;
        this._oracles     = [];
        this._queueDir    = null;
        this._portOverrides = null;
        this._finalizedEvents = new Map();   // round -> [event per hub index]
    }

    // ---- bring-up -------------------------------------------------------

    // Stand the venue up. Returns true when it is usable; false (with
    // `unavailable` set to a human-readable reason) when the venue's own
    // dependencies are missing, which is a SKIP for the caller, never a pass.
    async up() {
        this._applyChainPortOverrides();
        this.rail = await chainRail.createRail(this.coin, this.network);
        const failures = await chainRail.railFailures(this.rail);
        if (failures.length > 0) {
            this.unavailable = this.rail.code + ' ' + this.network + ' rail unreachable: ' + failures.join(', ');
            return false;
        }
        // Entered for the venue's whole lifetime, not per call: the broadcast hook
        // runs inside hub code (an EventEmitter callback), so the globals the
        // transaction helpers read have to already be this chain's when it fires.
        this._railSaved = chainRail.enterRail(this.rail);

        this.hubDb = await startDisposableHubDb();
        if (!this.hubDb) {
            chainRail.exitRail(this._railSaved);
            this._railSaved = null;
            this.unavailable = 'no env hub DB and Docker unavailable';
            return false;
        }

        await this._fundPublisherWallet();
        await this._startFederation();
        this._seedSnapshots();
        await this._attachOracles();
        await this._attachPublishers();
        return true;
    }

    // Point chainRail at where THIS stack actually publishes the second chain's
    // services, by lifting the port numbers out of the suite's own `.env.<code>`
    // into the `<CODE>_<KEY>` overrides chainRail reads.
    //
    // Needed because chainRail.DEFAULT_PORTS encodes a convention, not a
    // measurement, and this venue's stack does not follow it: DOGE's indexer is
    // published on 3004 while the convention says 3124. Without the lift, every
    // indexer read (feeschedule, the price readback, the action wait) would talk
    // to a closed port and the venue would report "rail unreachable" on a stack
    // that is perfectly healthy.
    //
    // ONLY port keys are copied. The same file holds the node RPC password, which
    // chainRail reads out of the file itself; nothing credential-bearing is put
    // into the environment or into a log line here.
    _applyChainPortOverrides() {
        const code = chainRail.COIN_CODE_MAP[this.coin] || String(this.coin).toUpperCase().slice(0, 3);
        const file = path.resolve(__dirname, '../../.env.' + String(code).toLowerCase());
        if (!fs.existsSync(file)) return;
        let parsed = {};
        try { parsed = require('dotenv').parse(fs.readFileSync(file)); }
        catch (e) { return; }

        const PORT_KEYS = ['NODE_PORT', 'UTXO_TRACKER_API_PORT', 'DECODER_API_PORT',
                           'ENCODER_API_PORT', 'INDEXER_API_PORT', 'REGTEST_MINER_API_PORT'];
        this._portOverrides = {};
        for (const key of PORT_KEYS) {
            if (!parsed[key]) continue;
            const name = code + '_' + key;
            this._portOverrides[name] = process.env[name];
            process.env[name] = String(parsed[key]);
        }
    }

    _restoreChainPortOverrides() {
        if (!this._portOverrides) return;
        for (const name of Object.keys(this._portOverrides)) {
            if (this._portOverrides[name] === undefined) delete process.env[name];
            else process.env[name] = this._portOverrides[name];
        }
        this._portOverrides = null;
    }

    // One shared publisher wallet rather than one per validator. Publishes are
    // driven strictly one round at a time (see finalizeRounds), so there is no
    // concurrent spend to race, and a single address keeps transactionHelper's
    // per-address confirmed-UTXO cache warm across rounds instead of forcing a
    // tracker round trip per publish. seedGas is off: PRICE is carried on a
    // native-fee chain here, so the wallet needs coin, not XCHAIN.
    async _fundPublisherWallet() {
        const cryptoHelper = require('../cryptoHelper');
        this.publisherAddress = await cryptoHelper.getNewFundedAddress(
            'oracle-publish-venue', this.coin, this.network, null, 'legacy', 0, this.fundAmount, false);
    }

    async _startFederation() {
        this.mvh = new MultiValidatorHub({
            count:            this.validatorCount,
            basePort:         this.basePort,
            startAttestation: false,
            dbNamePrefix:     'XChain_OracleBatchVenue_' + process.pid + '_'
        });
        await this.mvh.start();
        await waitForMesh(this.mvh, { timeoutMs: MESH_WAIT_MS });
    }

    // Two snapshots, because the round and the publish read different ones.
    // The PRICE round resolves the SOURCE-keyed weight snapshot (regtest
    // activates stake-weighted quorum at genesis), while OraclePublisher ranks
    // itself in the COUNT snapshot for `oracle_publish`. The two fixtures stub
    // disjoint methods, so both can be applied; seeding only one leaves either a
    // round that never finalizes or a publisher that fails closed with rank null.
    _seedSnapshots() {
        this._weightSeed = seedWeightSnapshot(this.mvh, {
            blockIndex: this.anchorHeight,
            network:    this.network
        });
        this._countSeed = seedStakeSnapshot(this.mvh, { blockIndex: this.anchorHeight });
    }

    // A real OracleConsensus per hub, wired onto hub.oracleConsensus (the field
    // OraclePublisher.start() subscribes to). OracleRound is constructed but NOT
    // started: its cadence would fetch live prices off the internet and race the
    // rounds this venue drives deterministically.
    async _attachOracles() {
        for (const hub of this.mvh.hubs) {
            const round = new OracleRound(hub);
            const oc    = new OracleConsensus(hub, round);
            round.setConsensus(oc);
            oc.setValidatorSet(await hub._loadValidatorSet());
            await oc.start();
            hub.oracle          = round;
            hub.oracleConsensus = oc;
            const hubIndex = this._oracles.length;
            // The signature set a round finalized on is NOT recoverable from
            // price_snapshots: `consensus_proof` stores the commit ADDRESSES
            // (`JSON.stringify([...pending.commits])`), not the signatures. The
            // signatures exist only on the round:finalized event, which is also
            // exactly what OraclePublisher puts on the wire, so capture them here.
            oc.on('round:finalized', (event) => {
                if (!this._finalizedEvents.has(event.round)) this._finalizedEvents.set(event.round, []);
                this._finalizedEvents.get(event.round)[hubIndex] = event;
            });
            this._oracles.push({ oc, round });
        }
    }

    // A real OraclePublisher per hub, with the durable queue, dead-letter file and
    // spend-window state redirected into a throwaway directory. Left at their
    // defaults these are all './data/...' relative to the mocha cwd, so a run
    // would write a durable spend window and a publish queue into the checkout
    // and the NEXT run would inherit them.
    async _attachPublishers() {
        this._queueDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xchain-oracle-venue-'));
        for (let i = 0; i < this.mvh.hubs.length; i++) {
            const hub = this.mvh.hubs[i];
            const pub = new OraclePublisher(hub);
            pub.queuePath      = path.join(this._queueDir, 'publisher-queue-' + i + '.jsonl');
            pub.deadLetterPath = pub.queuePath.replace(/\.jsonl$/, '') + '.deadletter.jsonl';
            pub.spendGuard.statePath = path.join(this._queueDir, 'spend-state-' + i + '.json');
            pub.setBroadcastHook((wire) => this._broadcast(i, wire));
            await pub.start();
            this.publishers.push(pub);
        }
    }

    // ---- the publish rail ----------------------------------------------

    // The broadcast hook OraclePublisher calls with its finished wire. This is
    // the seam the venue exists to fill: everything above it is the hub deciding
    // WHAT to publish, everything below is a real transaction on a real chain.
    // The wire is passed through untouched, so whatever version the publisher
    // emits is what lands.
    async _broadcast(hubIndex, wire) {
        const transactionHelper = require('../transactionHelper');
        const capture = {};
        const txid = await transactionHelper.createAndSendTransaction(
            this.publisherAddress, wire, null, [], null, null, false, { capture });
        const record = {
            hubIndex:    hubIndex,
            wire:        wire,
            wireVersion: wireVersionOf(wire),
            wireBytes:   Buffer.byteLength(wire, 'utf8'),
            txid:        txid,
            encoding:    capture.encoding || null,
            fundingTxid: capture.fundingTxHash || null,
            publishedAt: Date.now()
        };
        this.publications.push(record);
        return { txid: txid };
    }

    // ---- driving rounds -------------------------------------------------

    // Finalize `count` rounds, one at a time, each one carried all the way to a
    // landed transaction before the next begins.
    //
    // Strictly sequential on purpose, twice over. OraclePublisher._processQueue
    // holds a self-overlap guard: a second pass entered while the first is still
    // awaiting a broadcast is SKIPPED, and its round then sits on the durable
    // queue until that hub next leads, which on a K-round run means it may never
    // publish at all. And the shared publisher wallet has one UTXO chain, so two
    // in-flight builds would select the same outputs.
    async finalizeRounds(count) {
        const out = [];
        for (let i = 0; i < count; i++) out.push(await this.finalizeRound(i));
        return out;
    }

    // Drive ONE real PBFT price round across every hub and wait for the elected
    // leader's publisher to land it. Returns the round record, including the
    // signatures the federation actually collected.
    async finalizeRound(index) {
        const round      = this.roundBase + index;
        const anchorTime = this.anchorTimeBase + index * 600;
        const prices     = submissionsForRound(this.pairs, index);
        const before     = this.publications.length;

        // Same submission set on every hub, keyed by each hub's validator addr, so
        // every hub aggregates the identical canonical.
        const addrs = this.mvh.hubs.map((h) => h.getPeerManager().validatorAddr);
        for (let i = 0; i < this.mvh.hubs.length; i++) {
            const subs = new Map();
            for (const addr of addrs) subs.set(addr, { prices: prices });
            this._oracles[i].round.submissions.set(round, subs);
        }

        await Promise.all(this.mvh.hubs.map((h, i) =>
            this._oracles[i].oc.finalizeRound(round, this.anchorHeight, anchorTime)
                .catch((e) => { console.warn('OracleBatchVenue: hub ' + i + ' finalizeRound threw:', e && e.message); })));

        // The round is finalized when every hub holds its own price_snapshots row.
        const finalized = await waitFor(async () => {
            const counts = [];
            for (const hub of this.mvh.hubs) {
                try { counts.push((await this._snapshotRows(hub, round)).length); }
                catch (_) { counts.push(0); }
            }
            return { ok: counts.length > 0 && counts.every((c) => c >= 1), counts: counts };
        }, { timeoutMs: PUBLISH_WAIT_MS });
        if (!finalized.ok) {
            throw new Error('OracleBatchVenue: round ' + round + ' never finalized on every hub within '
                + finalized.waitedMs + 'ms; price_snapshots row counts were ['
                + ((finalized.last && finalized.last.counts) || []).join(', ') + ']');
        }

        const rows   = await this._snapshotRows(this.mvh.hubs[0], round);
        const events = this._finalizedEvents.get(round) || [];
        const leadEvent = events.find((e) => e && Array.isArray(e.signatures)) || null;
        const signatures = leadEvent ? leadEvent.signatures : [];

        // The publish is fire-and-forget from the hub's side (onRoundFinalized is
        // called out of an EventEmitter listener), so wait on the record the hook
        // pushes rather than on the finalize call returning.
        const landed = await waitFor(
            async () => ({ ok: this.publications.length > before }),
            { timeoutMs: PUBLISH_WAIT_MS, intervalMs: 250 });
        if (!landed.ok) {
            throw new Error('OracleBatchVenue: round ' + round + ' finalized on every hub but no publisher '
                + 'broadcast within ' + landed.waitedMs + 'ms. Leader rank was '
                + this._rankSummary() + '; check the oracle_publish snapshot seed and the publishers\' stats.');
        }

        const record = {
            round:        round,
            anchorHeight: this.anchorHeight,
            anchorTime:   anchorTime,
            prices:       prices,
            signatures:   signatures,
            // Distinct qualified members whose PREPARE cleared quorum, as the hub
            // itself counted them.
            validatorCount: Number(rows[0].validator_count),
            // What price_snapshots.consensus_proof actually holds: the ADDRESSES that
            // sent a COMMIT, not signatures. Under a weighted quorum the round
            // finalizes on the signature tally rather than the commit tally, so this
            // list can be a single self-address on a hub that holds every signature.
            // Exposed for a drill that wants it; it is NOT a signature set and must
            // not be read as the round's endorsement breadth.
            commitSet:    JSON.parse(rows[0].consensus_proof || '[]'),
            snapshotRow:  rows[0],
            publication:  this.publications[this.publications.length - 1]
        };
        this.rounds.push(record);
        return record;
    }

    // FINALIZED rows only. A whole-round skip (no submissions, snapshot missing,
    // quorum unavailable) also writes price_snapshots rows, with status 'skipped',
    // so a row-count wait that ignored status would report a stalled round as a
    // finalized one and every later assertion would be measuring the skip.
    async _snapshotRows(hub, round) {
        return hub.db.doQuery(
            "SELECT * FROM price_snapshots WHERE round_number = ? AND status = 'finalized' ORDER BY coin_pair",
            [round]);
    }

    // Compact view of every publisher's leader-rotation state, for the failure
    // message when nothing published: a rank of null means the oracle_publish
    // snapshot never resolved and every hub failed closed.
    _rankSummary() {
        return this.publishers
            .map((p, i) => i + ':' + JSON.stringify(p.getStats().myRank) + '/' + JSON.stringify(p.getStats().leaderRank))
            .join(' ');
    }

    // ---- reading the landing chain back --------------------------------

    // Block until the landing chain's indexer has DECIDED the publish, then hand
    // back the `prices` row it wrote. Waits on the actions row first (written for
    // valid AND invalid alike) so an invalid verdict resolves promptly instead of
    // burning the whole price wait.
    async readIndexedPrice(txid, opts) {
        opts = opts || {};
        await waitForTxIndexed(txid, { timeoutMs: opts.timeoutMs || 120_000, db: this.rail.globals.indexerDatabase });
        const row = await this.rail.globals.indexerDatabase.waitForPrice(
            { txHash: txid }, opts.timeoutMs || 120_000);
        if (!row) throw new Error('OracleBatchVenue: indexer recorded an action for ' + txid
            + ' but no prices row; the decoder did not resolve it as a PRICE action');
        return row;
    }

    // The block a landed publish was mined in, read from the node rather than the
    // indexer so it is evidence about the CHAIN and not about the indexer's view
    // of it.
    async blockOf(txid) {
        const raw = await this.rail.globals.nodeConnector.getTransaction(txid);
        if (!raw || !raw.blockhash) return null;
        const block = await this.rail.globals.nodeConnector.getBlock(raw.blockhash);
        return block ? { hash: raw.blockhash, height: block.height, time: block.time } : null;
    }

    // The canonical bytes a v0 round was signed over, built by the hub's OWN
    // producer (`OracleConsensus._buildPriceV0Payload`) rather than re-derived
    // here. Re-deriving it in a test would silently drop the EQUIV header wrap,
    // which IS active on regtest (activation is genesis) once the weight seed has
    // set hub.network, and every signature would then read as bad for a reason
    // that has nothing to do with the rail. `prices` entries take `pair` or
    // `coinPair`, exactly as the producer does.
    priceCanonical(round, timestamp, prices, anchorHeight) {
        return this._oracles[0].oc._buildPriceV0Payload(
            round, timestamp, prices, anchorHeight === undefined ? this.anchorHeight : anchorHeight);
    }

    // Publisher-side view of the rail: what each hub thinks it published, gave up
    // on, or dropped. A drill asserting a dead-letter or a timeout counter reads
    // it from here.
    publisherStats() {
        return this.publishers.map((p) => p.getStats());
    }

    // ---- teardown -------------------------------------------------------

    // Give every borrowed resource back, in the reverse order it was taken, and
    // never let one failure skip the rest. Everything the venue created off-chain
    // is disposable: the hub DBs are dropped, the queue/dead-letter/spend-state
    // files live in a temp directory that is removed, and the rail globals are
    // restored verbatim. What stays is exactly what should: the transactions on
    // the regtest chain, whose round numbers are run-scoped so a rerun cannot
    // collide with them.
    async down() {
        const problems = [];
        const attempt = async (label, fn) => {
            try { await fn(); } catch (e) { problems.push(label + ': ' + (e && e.message)); }
        };

        for (const pub of this.publishers) {
            // No timers on this class, so there is nothing to stop; clearing the
            // hook keeps a late queue sweep from broadcasting after teardown.
            await attempt('publisher hook', async () => pub.setBroadcastHook(null));
        }
        this.publishers = [];

        for (const o of this._oracles) {
            await attempt('oracle stop', async () => { if (o.oc.stop) await o.oc.stop(); });
        }
        this._oracles = [];

        if (this._countSeed)  await attempt('count seed restore',  async () => this._countSeed.restore());
        if (this._weightSeed) await attempt('weight seed restore', async () => this._weightSeed.restore());
        this._countSeed = this._weightSeed = null;

        if (this.mvh) {
            await attempt('mvh stop',  async () => this.mvh.stop());
            await attempt('mvh drop',  async () => this.mvh.dropDatabases());
            this.mvh = null;
        }
        if (this.hubDb) { await attempt('hub db stop', async () => this.hubDb.stop()); this.hubDb = null; }

        if (this._queueDir) {
            await attempt('queue dir', async () => fs.rmSync(this._queueDir, { recursive: true, force: true }));
            this._queueDir = null;
        }
        if (this._railSaved) { chainRail.exitRail(this._railSaved); this._railSaved = null; }
        this._restoreChainPortOverrides();

        if (problems.length > 0) console.warn('OracleBatchVenue: teardown problems: ' + problems.join(' | '));
        return problems;
    }
}

module.exports = {
    OracleBatchVenue,
    ValidatorIdentity,
    wireVersionOf,
    submissionsForRound,
    DEFAULT_PAIRS
};
