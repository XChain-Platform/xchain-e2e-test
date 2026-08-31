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
 *   SEEDED - the capability snapshots, on BOTH sides. An in-process hub has no
 *          indexer to read a staked validator set from, so seededWeightSnapshot
 *          (the `price` weighted quorum) and seededStakeSnapshot (the
 *          `oracle_publish` member set the publisher ranks itself in) stand in,
 *          exactly as every other multi-hub suite does; and the LANDING chain's
 *          `price` capability rows are written by the venue rather than by the
 *          hub, for the reasons set out at _seedLandingChainPriceCapability.
 *
 * THE WIRE VERSION IS A PARAMETER, NOT AN ASSUMPTION. Nothing here builds or
 * matches on `PRICE|0|`. The venue captures whatever wire the publisher hands
 * its broadcast hook and reads the version out of field 1, so a publisher that
 * later emits a PRICE batch needs no venue change: the drill asserts on the
 * captured version instead. `expectWireVersion` only sharpens the failure
 * message when a run gets a version it did not plan for.
 *
 * THE LANDED VERDICT NEEDS ONE MORE PRECONDITION, and the venue supplies it as
 * SETUP. Capability staking is BTC-only, so on any other chain the indexer
 * resolves the `price` capability set from the hub-mirrored
 * `capability_snapshots` at the batch's signed BTC anchor. In production the hub
 * writes those rows itself when a round finalizes; this venue's hubs are
 * in-process on disposable databases the landing chain's indexer never reads, so
 * `_seedLandingChainPriceCapability` writes the venue's OWN validator set there
 * instead, and takes it back at teardown. That comment states in full what it
 * substitutes for and what would retire it. Nothing about the indexer's judgment
 * is weakened: parse, signature verification and the weighted-quorum test all
 * still run, and the venue records the verdict it observes rather than asserting
 * a verdict it wants. `expectValidationStatus` lets a drill pin the one it
 * expects.
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

// ---- the `price` capability precondition -----------------------------------
//
// VENUE SETUP STANDING IN FOR A PRODUCTION PRECONDITION, and deliberately owned
// here rather than by any one drill, so every rig that has to JUDGE a batch this
// venue publishes gets the identical rows.
//
// WHAT IT SUBSTITUTES FOR. In production these rows are the hub's own work:
// OracleConsensus persists a `price` capability snapshot when a round finalizes,
// and every indexer that judges a batch resolves the qualifying set from its own
// copy of `capability_snapshots` at the batch's signed BTC anchor. Capability
// staking is BTC-only, so on any other chain that mirrored table is the ONLY
// source (getValidatorsByCapability / getStakeWeightsByCapability redirect
// `price` there); nothing on the wire carries the set. With no row the
// qualifying set is empty, stake sums to zero, and the weighted quorum fails
// closed as `invalid: insufficient signer stake` however good the federation's
// own quorum was.
//
// WHY IT CANNOT BE GOT THE PRODUCTION WAY HERE. The federation is four
// in-process hubs on disposable databases that no indexer in these drills reads.
// The hub a standing stack's indexer does mirror cannot finalize a price round at
// all (one hub against a federation-sized quorum denominator never reaches
// commit, so it never reaches the persist), and a purpose-built node's own fresh
// hub is empty by construction: it has no peers, no oracle round, and so nothing
// to persist. The in-memory fixtures the venue already applies
// (seededWeightSnapshot, seededStakeSnapshot) stub hub methods and write no row
// anywhere, so neither can supply this.
//
// WHAT WOULD MAKE IT UNNECESSARY. A rig whose federation writes into a hub
// database the judging indexer mirrors. Then the hub's own finalization persist
// arrives by the production route and this whole section is deleted, not adjusted.
//
// NOTHING HERE WEAKENS A VERDICT. The rows carry the venue's OWN validator
// pubkeys, sources and weights, lifted verbatim from the weight snapshot its hubs
// ran the rounds against so the two views cannot disagree, at the same BTC anchor
// the batch signs. Every indexer still parses the wire, still verifies every
// signature against the batch canonical, and still applies the full
// source-deduped two-thirds stake test. A batch whose signatures do not verify,
// or whose signers do not carry two-thirds of this stake, still records invalid.

// One row per validator key, in the shape the mirrored `cross_chain` /
// `oracle_publish` rows already use: snapshot_block is a BTC height (the batch's
// own signed anchor, never the landing chain's), and `source` is non-blank
// because the quorum test fails closed on a blank one (it would collapse every
// row into a single dedupe bucket and drop the bar to one signature).
function priceCapabilityRows(validators, snapshotBlock) {
    return (validators || []).map((v) => ({
        snapshotBlock: snapshotBlock,
        pubkey: String(v.pubkey).toLowerCase(),
        source: String(v.source),
        amount: String(v.weight === undefined ? v.amount : v.weight)
    }));
}

// Written through a caller-supplied `query(sql, args)` rather than against a
// connection this module opens, because the same rows have to reach two very
// different databases: the standing stack's indexer DB (through the suite's
// pooled Database) and a purpose-built node's own hub-mirror DB (through that
// rig's connection, which is why `table` can be schema-qualified). No credential
// is assembled, read or logged here.
async function applyPriceCapabilityRows(query, rows, table) {
    const t = table || 'capability_snapshots';
    for (const r of rows) {
        // Idempotent across reruns on uq_cap_snap (snapshot_block, capability,
        // signing_pubkey, source), so a second run re-states the same set instead
        // of duplicating it or erroring.
        await query('INSERT INTO ' + t + ' (snapshot_block, capability, signing_pubkey, amount, source) ' +
                    "VALUES (?, 'price', ?, ?, ?) ON DUPLICATE KEY UPDATE amount = VALUES(amount)",
                    [r.snapshotBlock, r.pubkey, r.amount, r.source]);
    }
    return rows.length;
}

// Take back exactly what was written, keyed on the anchor, pubkey and source that
// were inserted. Scoped, never a blanket DELETE on the capability: the mirrored
// cross_chain / oracle_publish rows, and any real price snapshot a hub later
// mirrors, are none of a test venue's business.
async function removePriceCapabilityRows(query, rows, table) {
    const t = table || 'capability_snapshots';
    for (const r of rows) {
        await query('DELETE FROM ' + t + " WHERE snapshot_block = ? AND capability = 'price' " +
                    'AND signing_pubkey = ? AND source = ?',
                    [r.snapshotBlock, r.pubkey, r.source]);
    }
    return rows.length;
}

// ---- the SAME set, in the form a BITCOIN capability oracle answers from ------
//
// WHY THERE ARE TWO FORMS OF ONE PRECONDITION. Chain-only reconstruction requires
// the node to also run a Bitcoin indexer: capability staking is Bitcoin-only by
// design, so a node with no Bitcoin view legitimately cannot resolve who was
// eligible to sign a batch. A node's HUB therefore resolves the qualifying `price`
// set by asking a real BTC indexer (CapabilitySnapshot.getSnapshot ->
// getcapabilityvalidators), and that RPC answers from the BTC indexer's own
// `stakes` rows: `usesCapabilitySnapshot` is FALSE when the coin is BTC, so the
// mirrored capability_snapshots the LANDING chain reads are not consulted there at
// all. The rows above and the rows here are one validator set written into the two
// stores that have to agree, which is exactly what the production mirror keeps in
// step (the hub's BTC read is what it later persists and mirrors down).
//
// THE WINDOW, and why it is bounded at both ends. CapabilitySnapshot buries every
// read by CANONICAL_REORG_BUFFER before it resolves, so the height actually asked
// for is (anchor - 6), not the anchor. A row that exists only AT the anchor is
// therefore invisible to the hub. `stakes` is a range store rather than a
// point-in-time one (`activation_block <= N AND (deactivation_block IS NULL OR
// deactivation_block > N)`), so the window is opened below the buried height and
// CLOSED just above the anchor. Closing it is what keeps this seed out of every
// tip-anchored read the standing federation on the same chain performs: at the BTC
// tip these rows are already deactivated and no other hub's quorum denominator
// moves while a drill runs.
const CANONICAL_REORG_BUFFER = loadHubModule('src/snapshot_reorg_buffer.js').CANONICAL_REORG_BUFFER;

// Reserved `stakes.action_index` values for the seeded rows. The column carries a
// UNIQUE index, so the seed needs its own range: high enough that no real action on
// a regtest chain can reach it, and deterministic so a rerun overwrites its
// predecessor instead of accumulating rows.
const PRICE_CAPABILITY_STAKE_ACTION_BASE = 9000000000000;

// One `stakes` row per validator key, written through a caller-supplied
// query(sql, args) against a BTC indexer database. Returns the rows as written so
// a caller can hand the same list back to removePriceCapabilityStakes.
async function applyPriceCapabilityStakes(query, rows) {
    if (!rows || rows.length === 0) return [];
    const anchor       = Number(rows[0].snapshotBlock);
    const activation   = Math.max(0, anchor - 2 * CANONICAL_REORG_BUFFER);
    const deactivation = anchor + CANONICAL_REORG_BUFFER + 1;
    const landed       = Math.max(0, activation - CANONICAL_REORG_BUFFER);

    const statuses = await query("SELECT id FROM index_statuses WHERE status = 'valid' LIMIT 1", []);
    if (!statuses || statuses.length === 0) {
        throw new Error('oracleBatchVenue: the BTC capability oracle has no `valid` status row, so it has ' +
            'indexed nothing yet; a stake seeded against it could not qualify');
    }
    const validId = statuses[0].id;

    const written = [];
    for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        // index_pubkeys is a plain AUTO_INCREMENT lookup (getOrCreatePubkeyId does
        // exactly this INSERT IGNORE + refetch), so adding a key carries none of the
        // dense-id consensus weight index_addresses does. `source_id` is left at 0
        // rather than minting an address row for that reason: the count read the hub
        // performs joins only index_pubkeys, and a seed that cannot be summed by the
        // source-keyed weight read fails CLOSED there rather than inventing a weight.
        await query('INSERT IGNORE INTO index_pubkeys (pubkey) VALUES (?)', [r.pubkey]);
        const found = await query('SELECT id FROM index_pubkeys WHERE pubkey = ? LIMIT 1', [r.pubkey]);
        if (!found || found.length === 0) throw new Error('oracleBatchVenue: could not resolve a pubkey id for ' + r.pubkey);
        const pubkeyId    = found[0].id;
        const actionIndex = PRICE_CAPABILITY_STAKE_ACTION_BASE + i;

        await query('INSERT INTO stakes (action_index, source_id, version, signing_pubkey_id, amount, ' +
                    'status_id, block_index, activation_block, deactivation_block) ' +
                    'VALUES (?, 0, 1, ?, ?, ?, ?, ?, ?) ' +
                    'ON DUPLICATE KEY UPDATE signing_pubkey_id = VALUES(signing_pubkey_id), ' +
                    'amount = VALUES(amount), status_id = VALUES(status_id), block_index = VALUES(block_index), ' +
                    'activation_block = VALUES(activation_block), deactivation_block = VALUES(deactivation_block)',
                    [actionIndex, pubkeyId, r.amount, validId, landed, activation, deactivation]);
        written.push({ actionIndex: actionIndex, pubkeyId: pubkeyId, pubkey: r.pubkey });
    }
    return written;
}

// Take back exactly the rows applyPriceCapabilityStakes wrote, keyed on BOTH the
// reserved action_index and the pubkey it was written for, so a delete can never
// reach a row this venue did not create. The index_pubkeys entries are left in
// place: they are a bare id-to-key lookup shared with every other reader, and a key
// with no stake row qualifies for nothing.
async function removePriceCapabilityStakes(query, written) {
    for (const w of written || []) {
        await query('DELETE FROM stakes WHERE action_index = ? AND signing_pubkey_id = ?',
                    [w.actionIndex, w.pubkeyId]);
    }
    return (written || []).length;
}

// Landing-chain databases in THIS process that must be able to judge a batch a
// venue here publishes, and the last set a venue seeded.
//
// Two orders have to work and a per-drill call site handles neither cleanly. A
// node built BEFORE the venue (the live node of a replay drill) cannot know the
// validator set yet, so the venue pushes to it when it seeds. A node built AFTER
// the venue has already torn down (the replay node, which walks the very blocks
// the venue landed) still has to judge those batches, so it pulls the last seed
// when it registers. The record therefore outlives the venue on purpose: the
// transactions it explains are on the chain permanently, and each target removes
// its own rows in its own teardown.
const _capabilityTargets = new Set();
let _lastPriceCapabilitySeed = null;

// target: { label, apply(rows), remove(rows) }. Returns how many rows were applied.
async function registerPriceCapabilityTarget(target) {
    _capabilityTargets.add(target);
    if (!_lastPriceCapabilitySeed) return 0;
    await target.apply(_lastPriceCapabilitySeed.rows);
    return _lastPriceCapabilitySeed.rows.length;
}

function unregisterPriceCapabilityTarget(target) { _capabilityTargets.delete(target); }

function lastPriceCapabilitySeed() { return _lastPriceCapabilitySeed; }

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
        // The `price` capability_snapshots rows this venue wrote into the landing
        // chain's indexer DB, so teardown can take back exactly what it put there.
        this._capabilitySeed = null;
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
        await this._seedLandingChainPriceCapability();
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

    // Apply the `price` capability precondition to the LANDING CHAIN this venue
    // publishes to, and to every landing-chain database already registered in this
    // process. See the section above the class for what it substitutes for, why the
    // venue cannot get it the production way, and what would retire it.
    async _seedLandingChainPriceCapability() {
        const validators = (this._weightSeed && this._weightSeed.snapshot && this._weightSeed.snapshot.validators) || [];
        if (validators.length === 0) return;

        const rows = priceCapabilityRows(validators, this.anchorHeight);

        // Credentials come from the rail, which discovered them through the hub
        // config oracle; nothing is hardcoded here and no value is logged.
        await this._withRailQuery((q) => applyPriceCapabilityRows(q, rows));
        this._capabilitySeed = { snapshotBlock: this.anchorHeight, rows: rows };

        // The process-wide record, and the push to rigs that were built BEFORE this
        // venue existed (a replay drill's live node is already walking the chain when
        // the first batch lands, so it needs the rows now, not at its own bring-up).
        _lastPriceCapabilitySeed = { snapshotBlock: this.anchorHeight, rows: rows };
        const pushed = [];
        for (const target of _capabilityTargets) {
            try { await target.apply(rows); pushed.push(target.label); }
            catch (e) { console.warn('OracleBatchVenue: could not apply the price capability rows to ' + target.label + ': ' + (e && e.message)); }
        }

        console.log('OracleBatchVenue: seeded ' + rows.length + ' `price` capability_snapshots row(s) at BTC anchor '
            + this.anchorHeight + ' in the ' + this.rail.code + ' indexer DB'
            + (pushed.length > 0 ? ' and in [' + pushed.join(', ') + ']' : '')
            + ' (venue setup standing in for the hub\'s own persist at finalization; see the price capability '
            + 'precondition section in this file).');
    }

    // Run one function against a pooled connection to the rail's indexer database,
    // handing it a plain query(sql, args) so the shared row helpers never have to
    // know which kind of connection they are writing through.
    async _withRailQuery(fn) {
        const conn = await this.rail.globals.indexerDatabase.getConnection();
        try { return await fn((sql, args) => conn.query(sql, args)); }
        finally { await conn.release().catch(() => {}); }
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
            // bufferPath is derived from queuePath IN THE CONSTRUCTOR, so redirecting
            // queuePath afterwards leaves the batch buffer pointing at the checkout's own
            // data/ file, SHARED by every hub and surviving the run. It is the input to
            // _hydrateBuffer() and therefore to restart catch-up, so a stale window in it
            // re-publishes on the next drill and breaks any "exactly one wire" assertion.
            pub.bufferPath     = pub.queuePath.replace(/\.jsonl$/, '') + '.buffer.jsonl';
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
            // The batch rail DID bring timers to this class (window grace, buffer
            // catch-up), so the old "no timers, nothing to stop" comment is stale.
            // Clear the hook FIRST so a timer that fires mid-teardown cannot broadcast,
            // then stop the publisher itself.
            await attempt('publisher hook', async () => pub.setBroadcastHook(null));
            await attempt('publisher stop', async () => { if (pub.stop) await pub.stop(); });
        }
        this.publishers = [];

        for (const o of this._oracles) {
            await attempt('oracle stop', async () => { if (o.oc.stop) await o.oc.stop(); });
        }
        this._oracles = [];

        if (this._countSeed)  await attempt('count seed restore',  async () => this._countSeed.restore());
        if (this._weightSeed) await attempt('weight seed restore', async () => this._weightSeed.restore());
        this._countSeed = this._weightSeed = null;

        // Take back the `price` capability rows this venue wrote INTO ITS OWN RAIL,
        // so a shared regtest indexer is left as it was found. Rows pushed to
        // registered targets are not touched here: each target owns the database it
        // registered and removes them in its own teardown, and a target may still be
        // reading the chain these batches are on. The process-wide record
        // (_lastPriceCapabilitySeed) deliberately outlives this teardown, because a
        // node built later still has to judge the transactions this venue landed.
        if (this._capabilitySeed && this.rail) {
            await attempt('capability seed cleanup', async () =>
                this._withRailQuery((q) => removePriceCapabilityRows(q, this._capabilitySeed.rows)));
        }
        this._capabilitySeed = null;

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
    DEFAULT_PAIRS,
    // The `price` capability precondition, for any rig that owns a landing-chain
    // database of its own. See the section above the class.
    priceCapabilityRows,
    applyPriceCapabilityRows,
    removePriceCapabilityRows,
    // The same set in the form a real BITCOIN capability oracle answers from, for a
    // rig whose hub resolves the signer set the way the ruling requires.
    applyPriceCapabilityStakes,
    removePriceCapabilityStakes,
    CANONICAL_REORG_BUFFER,
    registerPriceCapabilityTarget,
    unregisterPriceCapabilityTarget,
    lastPriceCapabilitySeed
};
