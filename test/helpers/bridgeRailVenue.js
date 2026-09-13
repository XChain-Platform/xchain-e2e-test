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
 * BRIDGE RAIL VENUE: the federation the XBRIDGE acceptance drives run on.
 *
 * WHY A VENUE AT ALL, and it is a fact about the rail rather than a defect in the
 * code (the base bridge spec, dq 1, ruled (a) by the operator 2026-09-12).
 * The standing regtest hub's staker key is lost, so it holds 10000 of the 210000
 * XCHAIN staked into the `cross_chain` and `price` capability sets: under 5 percent.
 * Stake-weighted quorum is active on regtest from block 0, so that hub can never
 * finalize a bridge transfer alone no matter how long a drive waits, and the
 * `1 prepares, 0 commits, quorum 3` timeouts it logs are correct behaviour. The
 * ruling's remedy is that a drive brings its own quorum: four in-process hubs on the
 * other four seated keys, holding 200000 of 210000, with the standing hub left as the
 * minority peer it is. Nothing is staked, nothing is reset, and every other rail lane's
 * fixtures are untouched.
 *
 * AND THE REMEDY NEEDS ONE THING THE HARNESS CANNOT DERIVE FOR ITSELF: the seeding
 * mnemonic. The four seated keys are idle GENERATIONS 0 to 3 of an operator secret, and
 * `mirrorDrillFixture._knownSignerSeeds()` sweeps generations only when
 * `XC_ROLLCALL_FEDERATION_MNEMONIC` is in the environment. Without it the harness holds
 * four keys, none of them seated, signs for 0 of 210000 staked units, and every round
 * times out at `0 commits`, which reads at the drive as "the bridge does not work"
 * (measured 2026-09-12). WITH it the harness adopts 4 of the 5 seated keys and holds
 * 200000 of 210000. The secret belongs to the venue operator and is never named, quoted
 * or defaulted in this tree: a drive sources it from the operator's own 0600 store into
 * its environment and passes it no other way. So `resolveVenueQuorum` below is the gate
 * every federated case is behind, it says exactly what is missing when it refuses, and a
 * correctly sourced drive passes it and runs the whole set with no other change.
 *
 * WHY A VENUE BTC INDEXER EXISTS AT ALL, AND WHEN TO SKIP IT. The ruling names the
 * STANDING BTC indexer as the server of the BTC-side legs. When this was written that
 * container ran `1bbc68ae`, which predates the bridge: no `src/actions/xbridge.js` at
 * all, so it would not have applied the lock it was asked to serve and it answered none
 * of `getpendingbridgetransfers`, `getbridgebalances` or `getbridgeescrowproof` that the
 * hub engine polls and the destination's D2 cross-check fetches. A venue BTC indexer on
 * the tree's bridge code, cloning the standing BTC chain database the same way the DOGE
 * one does, was the only way to honour the ruling while the redeploy was blocked.
 *
 * THE REDEPLOY LANDED MID-RUN on 2026-09-12: all three standing indexers now read
 * `97e7ae1f` and the hub `cb8a56c7`, both bridge code, so the ruled shape is available
 * again. Pass `btcIndexerUrl` to point the venue federation's engine at the standing BTC
 * indexer and take the ruling literally; leave it unset and the venue builds its own,
 * which stays the right default for a rail whose containers are mid-roll. Either way
 * `servedBy()` records which service answered which readout, so the evidence names it
 * rather than implying it.
 *
 * THE ORDER OF BRING-UP IS FORCED, and this is the one piece of real machinery here.
 * `CrossChainBridgeEngine` reads `<COIN>_INDEXER_URL` out of its environment IN ITS
 * CONSTRUCTOR (xchain-hub/src/CrossChainBridgeEngine.js), and the constructor runs
 * inside `hub.startCrossChain()` at hub boot. The venue indexers do not exist until
 * after the hubs are up, because an indexer needs a hub to follow and because
 * `AttestMirrorVenue` probes its ports in one pass at `start()`. So the hubs boot
 * once with no bridge wiring (the engine idles, by design, without indexer URLs),
 * the two indexers are built against them, and then each hub is restarted with the
 * real URLs in `hubExtraEnv`. Hub state is in MariaDB and identities are the venue's,
 * so a restart costs a boot and loses nothing. Guessing the ports instead was the
 * alternative and it is the bug `AttestMirrorVenue.start()` already documents: ports
 * that are only PLANNED are still free to a second probe.
 *
 * THE RAIL HAS HISTORY AND CANNOT BE MADE VIRGIN AGAIN, which shapes every assertion a
 * drive can make. A v0 lock debits the sender and credits `ADDRESS.BRIDGE_<COIN>` on BTC
 * the moment it is parsed, with no federation involved, so every drive attempt that got
 * as far as broadcasting a lock left units in the escrow permanently: 35 XCHAIN as of
 * 2026-09-12. Returning them would mean burning them back from the DOGE addresses they
 * were locked to, and `cryptoHelper` derives a label's wallet from a mnemonic generated
 * FRESH IN EACH PROCESS, so those keys ceased to exist when the drive exited. A drive
 * therefore arms the engine, lets the backlog finalize and settle (`waitForRailSettled`),
 * takes a BASELINE, and asserts exact DELTAS against it. The absolute readings section 15
 * writes for AT1 and AT2 ("the escrow address is 3") describe a rail whose escrow starts
 * empty and are recorded as deltas of the same size instead; nothing else changes.
 *
 * WHAT THIS FILE DELIBERATELY DOES NOT DO. It stakes nothing, it migrates nothing,
 * it touches no standing container and no standing database. The venue databases it
 * creates are its own. It composes `AttestMirrorVenue` rather than extending it, so
 * a bridge-specific need can never change what an attestation drill gets.
 *
 * Spec: the base bridge spec, sections 7, 8, 12 and 15; dq 1.
 *
 ********************************************************************/

'use strict';

const assert  = require('assert');
const axios   = require('axios');
const mariadb = require('mariadb');

const { AttestMirrorVenue } = require('./attestMirrorVenue');
const chainRail             = require('./chainRail');

// The four chains the hub engine knows, as the hub spells them. Kept local rather
// than imported from the hub so a unit run needs no hub module on NODE_PATH.
const BRIDGE_CHAINS = ['BTC', 'DOGE', 'LTC'];

// The rail's pinned depth. Spec section 15 names 1 for AT1 and AT2's first run; AT2's
// second run raises DOGE to 60 to measure the real wait, which is why this is a
// parameter of the venue rather than a constant of the drive.
const DEFAULT_CONFIRMATIONS = { BTC: 1, DOGE: 1, LTC: 1 };

// How often the engine polls each chain's indexer for confirmed legs.
//
// AND IT IS THE HUB'S OWN DEFAULT, NOT A FASTER ONE, because "lowering a poll cadence
// changes no verdict" turned out to be false and the measurement is worth keeping. At 3000
// ms a single XBRIDGE v0 lock of 5 XCHAIN (BTC action_index 103) was finalized FIVE times
// under five different transfer_ids and minted five times on DOGE to
// mrN1X35cW5rjfNwFZJKcQL6rGVnB5Pwn7j: 25 units against 5 units of escrow, measured
// 2026-09-12 on drive 10. The hub derives `transfer_id` from the moving `snapshot_block`
// and dedupes a source leg only by `bridgeTransferExistsForSource`, checked BEFORE the
// round; a poll shorter than a round therefore starts several rounds on one leg before the
// first row exists, and each closes under its own id. The destination's idempotency key is
// the transfer_id, so it cannot tell the five apart.
//
// The defect is the hub's and is reported as such; this constant simply stops the venue
// from manufacturing it. A drive pays about a minute more per leg for the honesty.
const DEFAULT_POLL_MS = 15000;

// ---------------------------------------------------------------------------
// The pure layer. Every function below is a pure function of its arguments and is
// exported for test/unit/helpers/bridgeRailVenue.test.js, because each one encodes a
// decision that would otherwise only be checkable by standing up a chain.
// ---------------------------------------------------------------------------

/**
 * The extra environment the venue hubs need for their bridge engine.
 *
 * PURE. The three groups are three different obligations and conflating them is how a
 * venue boots looking healthy and finalizes nothing:
 *   <COIN>_INDEXER_URL  where the engine READS confirmed legs and chain state. Absent,
 *                       `CrossChainBridgeEngine.start()` idles with a logged reason and
 *                       the drive waits forever on a row no one is building.
 *   XCHAIN_CONFIRMATIONS_<TICK>  the depth a leg must reach before the engine will
 *                       propose it. coins.resolveConfirmations clamps an override back
 *                       UP to the per-coin default on mainnet and testnet, so this can
 *                       only ever lower a depth on regtest.
 *   XBRIDGE_POLL_MS     cadence only.
 *
 * @param {object} spec
 * @param {object} spec.indexerUrls   `{BTC: url, DOGE: url}`; a chain omitted is left unwired
 * @param {object} [spec.indexerKeys] `{BTC: key}` for an indexer that wants one
 * @param {object} [spec.confirmations] per-TICK depth; defaults to the rail's pinned 1
 * @param {number} [spec.pollMs]
 * @returns {object} a flat environment overlay
 */
function bridgeEngineHubEnv(spec) {
    const s = spec || {};
    const urls = s.indexerUrls || {};
    const keys = s.indexerKeys || {};
    const conf = Object.assign({}, DEFAULT_CONFIRMATIONS, s.confirmations || {});
    const env  = {};
    for (const chain of BRIDGE_CHAINS) {
        if (urls[chain]) env[chain + '_INDEXER_URL'] = String(urls[chain]);
        if (keys[chain]) env[chain + '_INDEXER_API_KEY'] = String(keys[chain]);
    }
    for (const tick of Object.keys(conf)) {
        const depth = Number(conf[tick]);
        if (!Number.isInteger(depth) || depth <= 0) {
            throw new Error('bridgeRailVenue: XCHAIN_CONFIRMATIONS_' + tick + '=' + conf[tick] +
                ' is not a positive integer. A non-integer depth parses to NaN in the hub and ' +
                'falls back to the per-coin default silently, so a drive that meant to pin 1 ' +
                'would wait the mainnet depth with nothing to say why.');
        }
        env['XCHAIN_CONFIRMATIONS_' + tick] = String(depth);
    }
    env.XBRIDGE_POLL_MS = String(s.pollMs === undefined ? DEFAULT_POLL_MS : s.pollMs);
    return env;
}

/**
 * The checkpoint cadence a venue federation must run for a bridge in leg to be PROVABLE.
 *
 * PURE, and this is the constraint that stalled the whole acceptance set on drive 8, so it
 * is written out in full. The destination's D2 cross-check will not mint against a
 * transfer without a quorum-established state checkpoint of the ORIGIN chain at or after
 * that transfer's `snapshot_block` (xchain-indexer/src/bridge_proof_client.js
 * `selectCheckpoint`, which requires `block_index >= snapshot_block`). Both numbers are
 * derived from the same BTC tip and both sit BELOW it:
 *
 *   the hub stamps    snapshot_block = tip - CANONICAL_REORG_BUFFER (6)
 *   the hub publishes checkpoints at  block_index = tip - CHECKPOINT_CONFIRMATIONS (6)
 *
 * so a checkpoint taken at the same moment as the transfer lands exactly one buffer SHORT
 * of qualifying, and only a checkpoint taken six or more blocks later can serve it. At the
 * shipped cadence (a round every CHECKPOINT_INTERVAL_BLOCKS = 6 BTC blocks) that is up to
 * twelve BTC blocks of waiting AFTER the relay margin, and on a regtest chain that mines
 * only when a transaction arrives it is a deadlock: the drive waits for blocks that only
 * the drive would produce. Measured 2026-09-12: transfer b743a79a snapshot_block 611, the
 * only quorum checkpoint block_index 605, and the destination deferred the block every five
 * seconds for half an hour with `no quorum-established checkpoint at or after the transfer
 * snapshot_block is held locally`.
 *
 * `CHECKPOINT_CONFIRMATIONS=0` is the seam the engine itself documents for this ("0 is
 * meaningful, checkpoint the tip itself, the regtest venue setting"), and it closes the gap
 * outright: a checkpoint at the tip is at or above every snapshot_block derived from it.
 * The interval and poll are lowered for the same reason a bridge poll is; neither changes a
 * verdict, only how soon a round is attempted.
 *
 * @param {object} [spec]
 * @param {number} [spec.pollMs]
 * @param {Array}  [spec.chains] chains to checkpoint; LTC is dropped by default because the
 *                 venue has no LTC indexer and every tick would log a skip for it
 * @returns {object}
 */
function venueCheckpointEnv(spec) {
    const s = spec || {};
    const chains = (s.chains || ['BTC', 'DOGE']).map((c) => String(c).toUpperCase());
    return {
        CHECKPOINT_ENABLED: 'true',
        CHECKPOINT_CONFIRMATIONS: '0',
        CHECKPOINT_INTERVAL_BLOCKS: '1',
        CHECKPOINT_POLL_MS: String(s.pollMs === undefined ? 5000 : s.pollMs),
        CHECKPOINT_CHAINS: chains.join(','),
        // AND NOTHING GOES ON CHAIN. A checkpoint round at every block would otherwise hand
        // StateAnchorPublisher an ANCHOR to broadcast on each chain it covers, from a venue
        // key that owns no coin, against the SHARED regtest chains every other rail lane's
        // fixtures hang off. The D2 proof reads the MIRRORED checkpoint, not an on-chain
        // anchor, so nothing this drive asserts needs the publication.
        ANCHOR_ENABLED: 'false',
    };
}

/**
 * The environment overlay a venue INDEXER needs to fetch a D2 escrow proof.
 *
 * PURE. The destination indexer's settle pass resolves the origin chain's endpoint as
 * `<COIN>_INDEXER_API_URL` then `<COIN>_INDEXER_URL` then config
 * (xchain-indexer/src/bridge_proof_client.js `resolveOriginEndpoint`). With none of
 * them set every in leg raises BridgeProofUnavailableError and the block loop DEFERS
 * under `bridge_proof_barrier` rather than refusing, so the symptom of forgetting this
 * is a DOGE indexer that stops advancing at the transfer's block and never says
 * "misconfigured".
 *
 * @param {object} spec
 * @param {object} spec.indexerUrls  `{BTC: url}`; the origin chain's endpoint
 * @param {number} [spec.proofTimeoutMs]
 * @returns {object}
 */
function bridgeProofIndexerEnv(spec) {
    const s = spec || {};
    const urls = s.indexerUrls || {};
    const env = {};
    for (const chain of BRIDGE_CHAINS) {
        if (urls[chain]) env[chain + '_INDEXER_URL'] = String(urls[chain]);
    }
    if (s.proofTimeoutMs) env.BRIDGE_PROOF_TIMEOUT_MS = String(s.proofTimeoutMs);
    return env;
}

/**
 * Which seated keys this harness can sign for, and what share of the stake that buys.
 *
 * PURE, and the reason it is a function rather than a constant: the seated set is read
 * off the chain at drive time and the seeds are derived from the operator's rollcall
 * configuration, so neither side is knowable here. A drive that cannot reach a
 * supermajority must say so BEFORE it broadcasts a lock, because the failure
 * afterwards is indistinguishable from an engine that does not work.
 *
 * @param {Array} seated   `[{pubkey, stake}]` from the capability set, any case
 * @param {Map}   known    pubkey -> {seedHex, origin}, mirrorDrillFixture's `_knownSignerSeeds`
 * @returns {{adopted: Array, unsignable: Array, ourStake: number, totalStake: number,
 *            share: number, supermajority: boolean}}
 */
function selectBridgeSigners(seated, known) {
    const rows = Array.isArray(seated) ? seated : [];
    const haveSeeds = (known && typeof known.get === 'function') ? known : new Map();
    const adopted = [], unsignable = [];
    let ourStake = 0, totalStake = 0;
    for (const row of rows) {
        const pk = String((row && row.pubkey) || '').toLowerCase();
        const stake = Number((row && row.stake) || 0);
        if (!/^[0-9a-f]{64}$/.test(pk)) continue;
        totalStake += Number.isFinite(stake) ? stake : 0;
        const seed = haveSeeds.get(pk);
        if (seed) {
            adopted.push({ pubkeyHex: pk, seedHex: seed.seedHex, origin: seed.origin, stake: stake });
            ourStake += Number.isFinite(stake) ? stake : 0;
        } else {
            unsignable.push({ pubkeyHex: pk, stake: stake });
        }
    }
    // Strictly greater than two thirds, the rule stake_weighted_quorum enforces. Equal
    // to two thirds is NOT a quorum, and rounding it up here would make a venue that
    // cannot finalize look like one that can.
    const share = totalStake > 0 ? ourStake / totalStake : 0;
    return {
        adopted, unsignable, ourStake, totalStake, share,
        supermajority: totalStake > 0 && ourStake * 3 > totalStake * 2
    };
}

/**
 * Can this harness bring its own quorum, and if not, exactly what is missing?
 *
 * PURE, and it is the single most important function in this file, because the answer
 * changed the shape of this whole row. `selectBridgeSigners` says WHETHER; this says
 * WHY in the words the next reader needs, and it returns a reason rather than throwing
 * so a suite can skip with the blocker named instead of failing thirty minutes later on
 * a round that was never going to close.
 *
 * MEASURED 2026-09-12 ON THE RAIL. All four capability sets on BTC regtest (cross_chain,
 * price, oracle_publish, attestation) hold the same five keys at block 597: the four
 * roster keys at 50000 each and the standing hub's at 10000. The seated four were staked
 * on 2026-09-08 by `test/tools/reseedAttestationRoster.test.js`, which draws from
 * `_knownSignerSeeds()`, and they are idle generations 0 to 3 of the venue's seeding
 * mnemonic. `_knownSignerSeeds()` reproduces them ONLY when
 * `XC_ROLLCALL_FEDERATION_MNEMONIC` is in the environment: it sweeps generations 0 to
 * IDLE_GENERATION_SCAN off that one value, and with the variable absent it holds four
 * keys (three fixed federation signing seeds and the legacy fixed idle seed), none of
 * them seated. Both readings were taken on the rail, minutes apart, with nothing but
 * that variable different: 0 of 210000 staked units without it, 200000 of 210000 with
 * it.
 *
 * SO THE FAILURE THIS GATE CATCHES IS A DRIVE THAT WAS NOT GIVEN THE SECRET, and the
 * remedy is to source it from the operator's own 0600 store into the drive's
 * environment. The value is never named, quoted or defaulted anywhere in this tree, and
 * a drive must not echo it, log it or pass it on a command line. The alternative, if the
 * operator would rather not hand it over at all, is for the roll-call lane to unstake
 * those four keys so a derivable set can be seated instead; that is the operator's call
 * and not this lane's.
 *
 * @param {Array} seated  the capability set, `[{pubkey, weight|stake}]`
 * @param {Map}   known   pubkey -> {seedHex, origin}
 * @returns {{ok: boolean, reason: (string|null), signers: object}}
 */
function resolveVenueQuorum(seated, known) {
    const normalised = (Array.isArray(seated) ? seated : []).map((r) => ({
        pubkey: String((r && r.pubkey) || '').toLowerCase(),
        stake: Number((r && (r.stake !== undefined ? r.stake : r.weight)) || 0),
    }));
    const signers = selectBridgeSigners(normalised, known);
    if (signers.totalStake <= 0) {
        return { ok: false, signers, reason:
            'the bridge capability set is EMPTY or unreadable, so no quorum can be resolved at all' };
    }
    if (!signers.supermajority) {
        const held = signers.adopted.map((a) => a.pubkeyHex.slice(0, 16)).join(', ') || 'none';
        const missing = signers.unsignable.map((u) => u.pubkeyHex.slice(0, 16) + '@' + u.stake).join(', ');
        return { ok: false, signers, reason:
            'this harness can sign for ' + signers.ourStake + ' of ' + signers.totalStake +
            ' staked units in the bridge capability set (' +
            (signers.share * 100).toFixed(1) + ' percent), which is not the stake-weighted ' +
            'supermajority a bridge transfer needs. Holds: ' + held + '. Cannot sign for: ' + missing +
            '. Supply XC_ROLLCALL_FEDERATION_MNEMONIC (with XC_ROLLCALL_IDLE_GENERATION) or ' +
            'XC_ROLLCALL_IDLE_SEED to the drive so the seated keys can be derived, or have the ' +
            'roll-call lane unstake them so a derivable set can be seated. Refusing to broadcast ' +
            'a lock that no federation here can finalize.' };
    }
    return { ok: true, reason: null, signers };
}

/**
 * The SMALLEST set of adopted signers that still clears the stake-weighted supermajority.
 *
 * PURE, and it exists because of a divergence measured on the rail 2026-09-12 rather than
 * for tidiness. With four hubs holding 200000 of 210000, a round closes on any THREE of
 * them, and the fourth then holds no record of it: transfer `2764c037` finalized
 * `BTC:99 -> DOGE 5 XCHAIN (3 sigs)` and hubs 1, 2 and 3 each wrote the `bridge_transfers`
 * row while hub 0 wrote nothing, logged nothing, and never re-proposed the leg. That is
 * fatal to a drive rather than merely untidy, because an indexer mirrors exactly ONE hub:
 * the venue DOGE indexer followed hub 0, so the transfer the federation had agreed could
 * never reach the destination at all.
 *
 * Running the venue on the minimum quorum instead makes every finalizing round unanimous:
 * three hubs at 50000 each clear two thirds of 210000 only if all three sign, so a round
 * that closes has written the row on every hub in the mesh and whichever one an indexer
 * follows carries it. The cost is that the venue no longer tolerates a faulty hub, and that
 * is the right trade for a drive: a stalled round is visible in the log, a hub that quietly
 * diverges is not.
 *
 * Highest stake first, so the set is the smallest possible and is deterministic; ties break
 * on the pubkey so two processes reading the same capability set build the same mesh.
 *
 * @param {Array} adopted `[{pubkeyHex, seedHex, stake}]` from selectBridgeSigners
 * @param {number} totalStake the whole capability set's stake, including keys we cannot sign for
 * @returns {Array} the prefix that clears the supermajority, or [] when none does
 */
function minimalQuorumSigners(adopted, totalStake) {
    const rows = (Array.isArray(adopted) ? adopted.slice() : []).sort((a, b) => {
        const d = Number(b.stake || 0) - Number(a.stake || 0);
        return d !== 0 ? d : String(a.pubkeyHex).localeCompare(String(b.pubkeyHex));
    });
    const total = Number(totalStake || 0);
    let held = 0;
    for (let i = 0; i < rows.length; i++) {
        held += Number(rows[i].stake || 0);
        if (total > 0 && held * 3 > total * 2) return rows.slice(0, i + 1);
    }
    return [];
}

/**
 * The XBRIDGE v0 lock wire, BTC only: `XBRIDGE|0|DEST_COIN|DEST_ADDRESS|AMOUNT|MEMO`.
 * PURE. Built here rather than inline in each drive so one typo cannot make one AT
 * pass against a differently shaped action than another.
 */
function lockWireV0(destCoin, destAddress, amount, memo) {
    assert.ok(destCoin && destAddress, 'bridgeRailVenue: a v0 lock needs a destination coin and address');
    return ['XBRIDGE', '0', String(destCoin), String(destAddress), String(amount), String(memo || '')].join('|');
}

/**
 * The XBRIDGE v1 burn wire, non-BTC only: `XBRIDGE|1|BTC_ADDRESS|AMOUNT|MEMO`.
 * PURE.
 */
function burnWireV1(btcAddress, amount, memo) {
    assert.ok(btcAddress, 'bridgeRailVenue: a v1 burn needs a BTC destination address');
    return ['XBRIDGE', '1', String(btcAddress), String(amount), String(memo || '')].join('|');
}

/**
 * The indexer's own per-chain config, for the protocol role addresses.
 *
 * Lazy and cached: `roleAddress` is the only caller, the unit tier never reaches it, and
 * requiring the indexer's config module at load time would make the pure layer
 * unrequirable on a box without the indexer checked out beside this repo.
 */
const _roleConfigCache = new Map();
function roleConfigFor(chain, network) {
    const key = String(chain).toUpperCase() + '/' + String(network || 'regtest');
    if (_roleConfigCache.has(key)) return _roleConfigCache.get(key);
    const configModule = require('./bridgeSettleContext').loadIndexerModule('src/config.js');
    const config = configModule.getConfig(String(chain).toUpperCase(), String(network || 'regtest'));
    _roleConfigCache.set(key, config);
    return config;
}

/**
 * Has the bridge settled for one chain: nothing in flight and the two sides equal.
 *
 * PURE, and separate from `classifyInvariant` because the two questions differ. That one
 * asks which DIRECTION a discrepancy points; this asks whether the rail is quiet enough
 * for a drive to take a baseline off it. `in_flight` is the term that distinguishes them:
 * a rail with escrow 35, supply 0 and in_flight 35 is CONSISTENT and merely mid-flight,
 * while the same row with in_flight 0 is a real deficit.
 */
function bridgeSettled(entry) {
    const cls = classifyInvariant(entry);
    const flight = Number((entry || {}).in_flight);
    return cls.verdict === 'equal' && Number.isFinite(flight) && flight === 0;
}

/**
 * One chain's entry from a `getbridgeinvariant` answer, normalised.
 *
 * PURE. `delta` is the signed escrow-minus-(supply+in_flight) the hub computes, and the
 * three states it encodes are NOT symmetric (D65): a deficit is someone else's units
 * being unbacked, a surplus is the sender's own loss. Returning a verdict string here
 * rather than comparing numbers at each call site is what lets the drive assert the
 * DIRECTION rather than the magnitude alone.
 *
 * A null delta means the hub could not read one side's chain state and says so, which
 * is neither equal nor broken: 'unknown', never quietly folded into 'equal'.
 */
function classifyInvariant(entry) {
    const e = entry || {};
    if (e.delta === null || e.delta === undefined || e.delta === '') return { verdict: 'unknown', delta: null };
    const d = Number(e.delta);
    if (!Number.isFinite(d)) return { verdict: 'unknown', delta: null };
    if (d === 0) return { verdict: 'equal', delta: 0 };
    return { verdict: d > 0 ? 'surplus' : 'deficit', delta: d };
}

/**
 * The escrow this chain's role address holds, from a `getbridgebalances` answer.
 *
 * PURE. The indexer keys the map by the ROLE suffix it read (`ADDRESS.BRIDGE_<COIN>`),
 * and the platform spells a chain both as a coin symbol and as a full name across its
 * configuration, so a lookup on one spelling alone silently reads `undefined` as zero.
 * Returns null for absent, never '0': "this chain has no escrow row" and "this chain's
 * escrow is empty" are different readouts and AT1 asserts the transition between them.
 */
function escrowOf(balances, chain) {
    const map = (balances && balances.escrow) || {};
    const want = String(chain || '').toUpperCase();
    for (const key of Object.keys(map)) {
        if (String(key).toUpperCase() === want) return String(map[key]);
    }
    return null;
}

// How long one funding call may take before the drive calls it a stall.
//
// WHY A BUDGET EXISTS AT ALL, measured rather than guessed: the harness's funding helper
// re-sends and re-waits forever when its transaction does not reach a block, printing the
// same three lines on a loop with no error and no diagnosis, and that loop ended drives 10,
// 11 and 13 (the last one 22 minutes into a single funding call, with every venue process
// alive and the miner answering, each new block carrying only its coinbase). A drive that
// hangs teaches nothing and costs the whole rail: the cases behind it never run, and a
// human has to notice. So the wait is bounded and a breach FAILS the case with the address,
// the transaction and the service it was waiting on.
//
// EIGHT MINUTES, and the number is a measurement: a funding call on this rail needs one
// block for the funding transaction and one for the utxo-tracker to index it, and the
// mining loops add a block every 20 seconds on both chains, so a healthy call is under a
// minute and the three recorded stalls were all past ten. Override per call or through
// BRIDGE_RAIL_FUNDING_BUDGET_MS when a drive deliberately mines slower.
const DEFAULT_FUNDING_BUDGET_MS = 8 * 60 * 1000;

// What each funding progress line means and WHICH SERVICE owns the wait. The helper's own
// console output is the only place this state exists (it returns nothing until it is done),
// so the classifier reads the lines it prints.
const FUNDING_WAIT_STAGES = [
    { re: /Waiting for the utxo-tracker to index confirmed UTXOs from tx ([0-9a-fA-F]+)/,
      stage: 'utxo-tracker indexing the funding transaction',
      service: 'the standing utxo-tracker for this chain', capture: 'txid' },
    { re: /Waiting for the (?:second )?transaction \(([0-9a-fA-F]+)\) to be confirmed/,
      stage: 'the funding transaction reaching a block',
      service: 'the coin node and the regtest mining loop', capture: 'txid' },
    { re: /Waiting for the utxos for ([A-Za-z0-9]+)/,
      stage: 'the funded address showing a spendable utxo',
      service: 'the standing indexer serving this address', capture: 'address' },
    { re: /Sending funds \(([0-9.]+)\) to ([A-Za-z0-9]+)/,
      stage: 'the funding transaction being built and broadcast',
      service: 'the harness funding wallet and the coin node', capture: 'sendTo' },
];

/**
 * What a funding call was waiting for, read off the progress lines it printed.
 *
 * PURE. Takes the lines in the order they were printed and answers the LAST stage any of
 * them names, because the helper prints a line per stage and the most recent one is the
 * one it is stuck in. Returns nulls for output that names no stage at all, which is a
 * different finding (the call never got as far as sending) and must not be reported as a
 * transaction wait.
 *
 * @param {Array<string>} lines the funding call's console output, in order
 * @returns {{stage: (string|null), service: (string|null), txid: (string|null),
 *            address: (string|null), line: (string|null)}}
 */
function classifyFundingWait(lines) {
    const out = { stage: null, service: null, txid: null, address: null, line: null };
    for (const raw of (Array.isArray(lines) ? lines : [])) {
        const line = String(raw === null || raw === undefined ? '' : raw);
        for (const s of FUNDING_WAIT_STAGES) {
            const m = line.match(s.re);
            if (!m) continue;
            out.stage = s.stage;
            out.service = s.service;
            out.line = line.trim();
            if (s.capture === 'txid') out.txid = m[1];
            if (s.capture === 'address') out.address = m[1];
            if (s.capture === 'sendTo') out.address = m[2];
        }
    }
    return out;
}

/**
 * What the chain itself says about a funding transaction, for a breach's diagnosis.
 *
 * Asked of the rail's own node through the harness's `nodeConnector`, because the three
 * services a funding call waits on fail in ways that look identical from the helper's console
 * output: a transaction the node never accepted, one sitting in the mempool that no block
 * includes, and one confirmed but not yet indexed downstream. Never throws, and never assumes
 * the connector exists: this runs on a failure path.
 */
async function nodeDiagnosis(txid) {
    const node = (typeof global !== 'undefined' && global.nodeConnector) ? global.nodeConnector : null;
    if (!node) return { node: 'no rail node connector in scope, so the chain was not asked' };
    if (!txid) return { node: 'no transaction was named, so the chain was not asked' };
    const out = {};
    try {
        const mem = await node.getRawMempool();
        out.mempoolSize = Array.isArray(mem) ? mem.length : null;
        out.inMempool = Array.isArray(mem) ? mem.indexOf(String(txid)) >= 0 : null;
    } catch (e) { out.mempool = 'unreadable: ' + String(e && e.message).slice(0, 60); }
    try {
        const tx = await node.getTransaction(txid);
        out.knownToNode = !!tx;
        out.confirmations = tx ? Number(tx.confirmations || 0) : null;
    } catch (e) { out.knownToNode = 'unreadable: ' + String(e && e.message).slice(0, 60); }
    try { out.nodeHeight = await node.getBlockCount(); } catch (e) { /* height is a nicety */ }
    return out;
}

/**
 * Which service owes the answer, in one sentence, from what the chain said.
 *
 * PURE, and the point of the whole budget: a stall that names the waiting service sends the
 * next reader to the right place, where "funding timed out" sends them to the log.
 */
function interpretFundingNode(wait, node) {
    const n = node || {};
    if (n.knownToNode === false)
        return 'The node has never seen this transaction, so it was never accepted: the fault is ' +
               'upstream of the chain (the sender\'s inputs, the fee, or a refused broadcast), not ' +
               'the miner.';
    if (n.inMempool === true)
        return 'The transaction is in the mempool and no block has included it, so the wait is on ' +
               'the miner and the block cadence.';
    if (Number(n.confirmations) >= 1)
        return 'The transaction is confirmed at depth ' + n.confirmations + ', so the wait is ' +
               'downstream of the chain: whatever indexes it has not caught up.';
    if (n.knownToNode === true)
        return 'The node knows the transaction but reports no confirmation, so it is accepted and ' +
               'unmined.';
    return 'The chain could not be asked about this transaction, so which service owes the answer ' +
           'is undetermined.';
}

/**
 * The message a breached funding budget fails with.
 *
 * PURE, and separate from the wrapper so the unit tier can assert the message names the
 * thing that was waited for rather than asserting on a string the code also writes. Every
 * field it has is stated: a diagnosis that says "funding timed out" sends a reader back to
 * the log, which is the situation this exists to end.
 */
function fundingBudgetMessage(label, budgetMs, elapsedMs, wait, context) {
    const w = wait || {};
    const ctx = context || {};
    const parts = [];
    parts.push('bridge rail funding STALLED for ' + label + ': ' + Math.round(elapsedMs / 1000) +
        's elapsed against a budget of ' + Math.round(budgetMs / 1000) + 's.');
    parts.push('Waiting on: ' + (w.stage || 'no stage was ever printed, so the call never got ' +
        'as far as sending a funding transaction') + '.');
    if (w.service) parts.push('Owned by: ' + w.service + '.');
    if (w.address) parts.push('Address: ' + w.address + '.');
    if (w.txid) parts.push('Transaction: ' + w.txid + '.');
    if (ctx.tipsAtStart || ctx.tipsAtBreach) {
        parts.push('Chain tips at the start ' + JSON.stringify(ctx.tipsAtStart || null) +
            ' and at the breach ' + JSON.stringify(ctx.tipsAtBreach || null) +
            ' (tips that moved while the transaction did not reach a block point at the ' +
            'mempool or the fee, not at a stopped chain).');
    }
    if (ctx.node) {
        parts.push('The chain says ' + JSON.stringify(ctx.node) + '. ' +
            interpretFundingNode(w, ctx.node));
    }
    if (w.line) parts.push('Last progress line: ' + w.line);
    return parts.join(' ');
}

/**
 * Run one funding call under a budget, and fail loudly with what it was waiting for.
 *
 * The helper being wrapped lives in the shared harness (`cryptoHelper.getNewFundedAddress`
 * and the DOGE rail form of it) and cannot be cancelled, so the budget RACES it: on a
 * breach this throws and the underlying call is left to finish or die on its own, with its
 * rejection swallowed so a late failure cannot surface as an unhandled rejection in a
 * later case.
 *
 * The progress lines are captured by wrapping `console.log` for the duration and forwarding
 * every line through to it unchanged, so the drive log reads exactly as it did before.
 *
 * @param {string} label the drive's own name for the address (AT1.SENDER, AT2B.DEST)
 * @param {function(): Promise} fn the funding call, already bound to its rail
 * @param {object} [opts] budgetMs, and diagnose() for the readings to quote on a breach
 */
async function fundUnderBudget(label, fn, opts) {
    const o = opts || {};
    const budgetMs = Number(o.budgetMs || process.env.BRIDGE_RAIL_FUNDING_BUDGET_MS ||
        DEFAULT_FUNDING_BUDGET_MS);
    const lines = [];
    const started = Date.now();
    const original = console.log;
    console.log = function () {
        const text = Array.from(arguments).map((a) => (typeof a === 'string' ? a : String(a))).join(' ');
        // BOUNDED, because a stalled call prints the same three lines for minutes and the
        // classifier only ever needs the latest of each.
        lines.push(text);
        if (lines.length > 200) lines.splice(0, lines.length - 200);
        return original.apply(console, arguments);
    };
    let timer = null;
    try {
        const call = Promise.resolve().then(fn);
        const budget = new Promise((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error('__BRIDGE_RAIL_FUNDING_BUDGET__')), budgetMs);
        });
        return await Promise.race([call, budget]).catch(async (err) => {
            if (!err || String(err.message) !== '__BRIDGE_RAIL_FUNDING_BUDGET__') throw err;
            // Never let the abandoned call's own later failure land on a different case.
            call.catch(() => {});
            const wait = classifyFundingWait(lines);
            let context = {};
            if (typeof o.diagnose === 'function') {
                try { context = (await o.diagnose(wait)) || {}; } catch (e) {
                    context = { diagnoseFailed: String(e && e.message) };
                }
            }
            const failure = new Error(fundingBudgetMessage(label, budgetMs, Date.now() - started,
                wait, context));
            failure.fundingWait = wait;
            failure.fundingContext = context;
            throw failure;
        });
    } finally {
        if (timer) clearTimeout(timer);
        console.log = original;
    }
}

/**
 * Append one line to the drive's durable case journal, and never throw.
 *
 * WHY IT EXISTS: drive 13's baseline failure message and its whole evidence block were lost
 * because the run was interrupted before mocha printed its epilogue, and the epilogue is
 * the only place a mocha failure message appears. A journal written AS EACH CASE ENDS
 * survives an interrupt, a crash and a kill, so the next reader has the per-case verdicts
 * even when the summary never prints.
 *
 * Silent on a missing directory: a unit run has no log directory and a journal that threw
 * would turn a reporting convenience into a test failure.
 */
function journalCase(entry) {
    const dir = process.env.BRIDGE_RAIL_JOURNAL_DIR || process.env.ATTEST_VENUE_LOG_DIR || null;
    if (!dir) return false;
    try {
        const fs = require('fs');
        const path = require('path');
        fs.appendFileSync(path.join(dir, 'case-journal.jsonl'),
            JSON.stringify(Object.assign({ at: new Date().toISOString() }, entry)) + '\n');
        return true;
    } catch (e) { return false; }
}

// ---------------------------------------------------------------------------
// The venue.
// ---------------------------------------------------------------------------

class BridgeRailVenue {

    /**
     * @param opts.label          short name, used in database names and log lines
     * @param opts.identities     `[{pubkeyHex, privkeyHex}]` for the seated keys; REQUIRED,
     *                            because a venue that cannot sign for the seated set
     *                            finalizes nothing and a generated key would look identical
     *                            at boot
     * @param opts.network        default regtest; the venue refuses anything else
     * @param opts.confirmations  `{BTC: 1, DOGE: 1}`; the rail's pinned depth
     * @param opts.basePort       port probe base
     * @param opts.dogeRail       a chainRail for dogecoin; built here when omitted
     * @param opts.pollMs         engine poll cadence
     */
    constructor(opts) {
        const o = opts || {};
        this.label   = String(o.label || 'bridgerail').replace(/[^A-Za-z0-9]/g, '');
        this.network = o.network || 'regtest';
        if (this.network !== 'regtest') {
            throw new Error('bridgeRailVenue: refusing to build on ' + this.network +
                '. This venue clones chain databases, spawns validators on borrowed stake and ' +
                'pins confirmation depths down; every one of those is a regtest-only act.');
        }
        this.identities    = o.identities || null;
        this.confirmations = Object.assign({}, DEFAULT_CONFIRMATIONS, o.confirmations || {});
        this.basePort      = o.basePort || 43000;
        this.pollMs        = o.pollMs === undefined ? DEFAULT_POLL_MS : o.pollMs;
        this.dogeRail      = o.dogeRail || null;
        // WHICH TREE THE IN-PROCESS HUBS AND INDEXERS ARE LOADED FROM, and the evidence
        // depends on it. attestMirrorVenue spawns `<repoRoot>/xchain-hub/src/api.js` and
        // `<repoRoot>/xchain-indexer/src/api.js` and defaults repoRoot to the checkout this
        // file sits in, which is SHARED: several sessions' uncommitted hub edits are on disk
        // there at any moment, and drive 12 was aborted because its four venue hubs would
        // have been three other sessions' work rather than the landed bridge code. Pointing
        // this at a root of detached worktrees at named SHAs is what makes an acceptance
        // readout attributable. Env fallback so a drive script can set it without a code
        // edit; unset keeps the old shared-tree behaviour.
        this.repoRoot = o.repoRoot || process.env.BRIDGE_RAIL_REPO_ROOT || null;
        // The ruled shape: the STANDING BTC indexer serves the BTC-side legs. Unset means
        // build a venue BTC indexer instead; see the header for when each is right.
        this.standingBtcIndexerUrl = o.btcIndexerUrl || null;
        // dq 5, ruled (a) 2026-09-12: the venue DOGE indexer REPLAYS the standing DOGE
        // chain under this tree's bridge code rather than copying the standing node's
        // ledger, so the pre-D62 self-seeded XCHAIN ISSUE at DOGE action_index 326 is
        // refused and AT1's precondition (no XCHAIN row on the destination ledger) is a
        // fact about the ledger rather than a wish. Default ON for this venue, because a
        // bridge rail built on the cloned ledger cannot assert AT1 at all; pass
        // `dogeReplayChain: false` for a drive that deliberately wants the standing
        // grading, and say why.
        this.dogeReplayChain = o.dogeReplayChain === undefined ? true : (o.dogeReplayChain === true);
        // LEAVE THE BRIDGE ENGINE UNARMED AT start(), and this exists for one measured
        // reason. `getpendingbridgetransfers` answers EVERY valid XBRIDGE leg this chain
        // has ever carried, with no settlement filter of its own (xchain-indexer
        // src/db.js getPendingBridgeTransfers); deduplication is the hub's, against its
        // own `bridge_transfers`. A venue hub's database is new on every run, so the
        // instant its engine has indexer URLs it re-proposes the whole history of locks
        // on the rail, and a destination ledger with no prior `bridge_settlements` row
        // applies them. On this rail that is 35 XCHAIN from earlier drive attempts whose
        // keys were random per process and are gone, so the escrow cannot be drained and
        // the rail can never be virgin again.
        //
        // A drive that must READ the destination ledger before any of that happens (AT1's
        // precondition, AT9's before-witness) therefore arms the engine itself, by calling
        // `rewireHubs()` once those readings are taken, rather than racing a 240-second
        // effective_time window it does not control.
        this.deferBridgeWiring = o.deferBridgeWiring === true;

        this.btcVenue  = null;   // hubs + the BTC indexer
        this.dogeVenue = null;   // the DOGE indexer, attached to the same hubs
        this.unavailable = null; // non-null means the caller should SKIP

        // Which indexer answered which readout, recorded rather than assumed. The ruling
        // named the standing BTC indexer; the header says why it cannot serve today, and
        // this is the record the evidence quotes.
        this._served = {};
    }

    get hubs()    { return this.btcVenue ? this.btcVenue.hubs : []; }
    get hubDb()   { return this.btcVenue ? this.btcVenue.hubDb : null; }
    btcIndexer()  { return this.btcVenue  ? this.btcVenue.indexers[0]  : null; }
    dogeIndexer() { return this.dogeVenue ? this.dogeVenue.indexers[0] : null; }
    btcIndexerUrl()  {
        if (this.standingBtcIndexerUrl) return this.standingBtcIndexerUrl;
        const ix = this.btcIndexer();
        return ix ? ix.apiUrl : '';
    }
    dogeIndexerUrl() { const ix = this.dogeIndexer(); return ix ? ix.apiUrl : ''; }

    /**
     * Record and report which service served a readout, so the evidence names it.
     */
    servedBy(readout, service) {
        if (service !== undefined) this._served[readout] = service;
        return this._served[readout];
    }
    servedMap() { return Object.assign({}, this._served); }

    /**
     * Bring the mesh up. Returns true when it is usable, false with `unavailable` set.
     */
    async start() {
        assert.ok(Array.isArray(this.identities) && this.identities.length >= 1,
            'bridgeRailVenue: identities are required. A venue on generated keys holds no stake, ' +
            'so its rounds time out at `0 commits` and the drive reads an engine fault where the ' +
            'real fact is an unstaked federation.');

        // PHASE 1: the hubs, and the BTC indexer that follows them. The bridge engine
        // constructs itself here with no indexer URLs and idles, which is exactly what it
        // should do on a hub that has none. See the header for why this cannot be one pass.
        this.btcVenue = new AttestMirrorVenue({
            label: this.label,
            coin: 'bitcoin',
            network: this.network,
            hubCount: this.identities.length,
            indexerCount: 1,
            identities: this.identities,
            basePort: this.basePort,
            // Undefined when unset, so attestMirrorVenue's own default still applies.
            repoRoot: this.repoRoot || undefined,
            // FROM BOOT, not from the rewire: the checkpoint engine starts with the hub, and
            // a transfer the engine finalizes before the rewire is stamped against a tip that
            // only a tip-height checkpoint can serve. See venueCheckpointEnv.
            hubExtraEnv: Object.assign({}, venueCheckpointEnv({}),
                // AND THE DISARM IS A DEPTH, not a missing URL. A venue hub already carries a
                // BTC indexer URL at boot for its other engines, so `deferBridgeWiring` alone
                // leaves the bridge engine free to finalize the rail's backlog while the
                // drive is still taking the two readings that must precede any in leg: on
                // drive 10 an XCHAIN row appeared on the destination ledger in the middle of
                // the AT9 before-witness, which the witness case caught and refused. Pinning
                // every depth out of reach idles the engine on a leg it can see but must not
                // sign yet, and `rewireHubs` replaces these with the rail's real pins the
                // moment the drive is ready. coins.resolveConfirmations only ever clamps an
                // override UP off regtest, so this can never loosen a depth anywhere.
                this.deferBridgeWiring ? {
                    XCHAIN_CONFIRMATIONS_BTC:  '1000000',
                    XCHAIN_CONFIRMATIONS_DOGE: '1000000',
                    XCHAIN_CONFIRMATIONS_LTC:  '1000000',
                } : {}),
            // The proof client and the settle pass both live on the block-processing path,
            // so an indexer barrier that stays shut parks the block. Every grace at 0 is
            // the venue default and is what the attest drills already rely on.
            graces: {},
        });
        const btcUp = await this.btcVenue.start();
        if (!btcUp) { this.unavailable = this.btcVenue.unavailable; return false; }

        // PHASE 2: the DOGE indexer, attached to the SAME hubs and sharing their hub
        // database. Started INSIDE the DOGE rail so the chain-database clone reads the
        // standing DOGE node and the decoder discovered is DOGE's; the attest mirror
        // venue's own AT5 drill established that shape.
        const rail = this.dogeRail || await chainRail.createRail('dogecoin', this.network);
        this.dogeRail = rail;
        this.dogeVenue = await chainRail.withRail(rail, async () => {
            const dv = new AttestMirrorVenue({
                label: this.label + 'doge',
                coin: 'dogecoin',
                network: this.network,
                attachHubs: this.btcVenue.hubs,
                hubDb: this.btcVenue.hubDb,
                indexerCount: 1,
                // The harness DECODER_DB_* describe Bitcoin; this venue's decoder is DOGE's.
                useEnvDecoderCredential: false,
                basePort: this.basePort + 200,
                graces: {},
                // Same tree as the BTC half: this venue spawns the DOGE indexer.
                repoRoot: this.repoRoot || undefined,
                // See the constructor: AT1's precondition is a property of the ledger this
                // indexer builds, not of the chain, and only a replay builds the one AT1
                // describes.
                replayChain: this.dogeReplayChain,
                // The hubs this venue attaches to were seeded for BITCOIN, so DOGE/USD is
                // whatever the venue oracle published for it (about 0.085) and the tip
                // barrier's one BTC-sized sanity band rejects that. Seed the pair here,
                // which is also what a standalone DOGE venue does for itself, so both DOGE
                // indexers in a rail drive price DOGE actions the same way.
                seedAttachedHubPrices: true,
                // The D2 escrow-proof client runs on the DESTINATION indexer and fetches
                // `getbridgeescrowproof` from the ORIGIN chain's endpoint. The BTC venue
                // indexer exists by now, which is the other half of why bring-up is
                // ordered the way it is.
                indexerExtraEnv: bridgeProofIndexerEnv({
                    indexerUrls: { BTC: this.btcIndexerUrl() },
                }),
            });
            const ok = await dv.start();
            if (!ok) return { failed: dv.unavailable };
            return dv;
        });
        if (this.dogeVenue && this.dogeVenue.failed) {
            this.unavailable = 'the attached DOGE venue did not start: ' + this.dogeVenue.failed;
            this.dogeVenue = null;
            return false;
        }

        // PHASE 3: rewire. Every hub is restarted carrying the two venue indexer URLs, so
        // its bridge engine polls the BTC indexer for confirmed locks and the DOGE indexer
        // for the destination's chain state. Deferred when the caller says so; see
        // `deferBridgeWiring` for the reading that has to happen first.
        if (!this.deferBridgeWiring) await this.rewireHubs();

        return true;
    }

    /**
     * Restart every hub with the bridge engine pointed at the venue indexers.
     *
     * Exposed rather than private because AT2's second run re-pins DOGE's depth at 60 and
     * has to make the federation read the new value, and a drive that reached into
     * `hubExtraEnv` and restarted hubs by hand would be reimplementing this.
     *
     * @param {object} [confirmations] a new per-TICK depth map, merged over the venue's
     */
    async rewireHubs(confirmations) {
        assert.ok(this.btcVenue, 'bridgeRailVenue: rewireHubs before start');
        if (confirmations) this.confirmations = Object.assign({}, this.confirmations, confirmations);
        const overlay = bridgeEngineHubEnv({
            indexerUrls: { BTC: this.btcIndexerUrl(), DOGE: this.dogeIndexerUrl() },
            confirmations: this.confirmations,
            pollMs: this.pollMs,
        });
        this.btcVenue.hubExtraEnv = Object.assign({}, this.btcVenue.hubExtraEnv || {}, overlay);
        // ONE AT A TIME, and never all four down at once: the mesh's p2p seed lists name
        // each other, and a hub that boots into a dead mesh spends its whole reconnect
        // backoff before it can take part in a round.
        for (const hub of this.btcVenue.hubs) {
            await this.btcVenue.stopHub(hub.index);
            await this.btcVenue.startHub(hub.index);
        }
        return overlay;
    }

    /**
     * JSON-RPC against one venue hub, keyless.
     *
     * The harness's XChainHubConnector attaches the STANDING stack's HUB_API_KEY from the
     * ambient environment and these hubs are keyless, which is why AttestMirrorVenue's own
     * validator registration goes around it too.
     */
    async hubRpc(hubIndex, method, params) {
        const hub = this.hubs[hubIndex];
        assert.ok(hub, 'bridgeRailVenue: no hub ' + hubIndex);
        const res = await axios.post(hub.apiUrl,
            { jsonrpc: '2.0', id: Date.now(), method: method, params: params || {} },
            { timeout: 20000 });
        if (res.data && res.data.error) {
            throw new Error('bridgeRailVenue: hub ' + hubIndex + ' ' + method + ' answered error ' +
                JSON.stringify(res.data.error));
        }
        return res.data ? res.data.result : null;
    }

    /**
     * JSON-RPC against a venue indexer by chain code.
     */
    async indexerRpc(chain, method, params) {
        const url = String(chain).toUpperCase() === 'BTC' ? this.btcIndexerUrl() : this.dogeIndexerUrl();
        assert.ok(url, 'bridgeRailVenue: no venue indexer for ' + chain);
        const res = await axios.post(url,
            { jsonrpc: '2.0', id: Date.now(), method: method, params: params || {} },
            { timeout: 30000 });
        if (res.data && res.data.error) {
            throw new Error('bridgeRailVenue: ' + chain + ' indexer ' + method + ' answered error ' +
                JSON.stringify(res.data.error));
        }
        const result = res.data ? res.data.result : null;
        if (result && result.error) {
            throw new Error('bridgeRailVenue: ' + chain + ' indexer ' + method + ' refused: ' + result.error);
        }
        return result;
    }

    /**
     * `getbridgebalances` on one chain's venue indexer, with the serving indexer recorded.
     */
    async bridgeBalances(chain, tick) {
        const answer = await this.indexerRpc(chain, 'getbridgebalances', { tick: String(tick || 'XCHAIN') });
        this.servedBy('bridgebalances:' + chain, 'venue ' + chain + ' indexer ' +
            (String(chain).toUpperCase() === 'BTC' ? this.btcIndexerUrl() : this.dogeIndexerUrl()));
        return answer;
    }

    /**
     * `getbridgeinvariant` from one hub. Read from a hub rather than assembled here: the
     * in-flight term is the hub's own view of what it has signed and not yet seen applied,
     * and nothing outside the hub can rebuild it.
     */
    async bridgeInvariant(tick, hubIndex) {
        const answer = await this.hubRpc(hubIndex === undefined ? 0 : hubIndex,
            'getbridgeinvariant', tick ? { tick: String(tick) } : {});
        this.servedBy('bridgeinvariant', 'venue hub ' + (hubIndex === undefined ? 0 : hubIndex));
        return answer;
    }

    /**
     * A read against one venue indexer's own ledger database.
     *
     * Direct SQL rather than an RPC because the per-address balance the acceptance tests
     * assert on has no open read: `getbridgebalances` reports supply and the escrow roles,
     * and the drive needs an arbitrary address. The connection is to the venue's own
     * disposable MariaDB, never the standing stack's.
     */
    async queryIndexerDb(chain, sql, params) {
        const ix = String(chain).toUpperCase() === 'BTC' ? this.btcIndexer() : this.dogeIndexer();
        assert.ok(ix, 'bridgeRailVenue: no venue indexer for ' + chain);
        const db = this.hubDb;
        assert.ok(db, 'bridgeRailVenue: the venue has no hubDb; it is not started');
        assert.ok(/^[A-Za-z0-9_]+$/.test(String(ix.indexerDbName)),
            'bridgeRailVenue: refusing an unsafe database identifier ' + ix.indexerDbName);
        let conn = null;
        try {
            conn = await mariadb.createConnection({
                host: db.host, port: parseInt(db.port, 10), user: db.user, password: db.pass,
                database: String(ix.indexerDbName), connectTimeout: 10000,
            });
            return await conn.query(sql, params || []);
        } finally {
            if (conn) await conn.end().catch(() => {});
        }
    }

    /**
     * The balance one address holds in one tick, on one venue indexer, as a decimal string.
     *
     * Credits minus debits rather than a `balances` projection, because that is the sum the
     * ledger itself is built from and it cannot disagree with the rows an assertion quotes.
     * Returns '0' for an address the chain has never seen, which is the honest reading: an
     * absent row and a zero balance are the same claim about spendable units.
     */
    async addressBalance(chain, address, tick) {
        const rows = await this.queryIndexerDb(chain,
            `SELECT
                (SELECT COALESCE(SUM(CAST(c.amount AS DECIMAL(60,18))),0) FROM credits c
                    INNER JOIN index_addresses ad ON (ad.id=c.address_id)
                    INNER JOIN index_tickers   ti ON (ti.id=c.tick_id)
                    WHERE ad.address=? AND ti.tick=?) AS cr,
                (SELECT COALESCE(SUM(CAST(d.amount AS DECIMAL(60,18))),0) FROM debits d
                    INNER JOIN index_addresses ad ON (ad.id=d.address_id)
                    INNER JOIN index_tickers   ti ON (ti.id=d.tick_id)
                    WHERE ad.address=? AND ti.tick=?) AS dr`,
            [String(address), String(tick), String(address), String(tick)]);
        if (!rows.length) return '0';
        const cr = Number(rows[0].cr), dr = Number(rows[0].dr);
        return String(cr - dr);
    }

    /**
     * The token row for a tick on one chain, projected to the PARAMETERS.
     *
     * AT1 asserts the DOGE row "matches BTC's parameters byte for byte". `SELECT *` cannot
     * state that: a token row carries per-chain facts that MUST differ, and comparing them
     * would make the assertion impossible to pass rather than meaningful. So the projection
     * is every column of `tokens` MINUS the exclusion set below, taken from the live schema
     * rather than a list retyped here, which is what keeps a column added tomorrow inside
     * the comparison instead of silently outside it.
     *
     * THE EXCLUSIONS, each with the reason it is one:
     *   id, tick_id                per-chain surrogate keys into that chain's own tables
     *   action_index,
     *   last_action_index          the consensus action index the row was created at, which
     *                              is a different position in a different chain's history
     *   supply                     BTC holds every unit ever minted; a foreign chain holds
     *                              the shadow of its escrow. Equal supplies would be the bug
     *   owner_id                   an id into THIS chain's index_addresses. The owner is
     *                              compared by ROLE instead (see ownerRole below), because
     *                              ADDRESS.GAS is a different string on every chain
     *   coin_price, coin_floor     market state, not an issuance parameter
     *   bridged                    set by the first applied v3 lock, per chain by definition
     *   escrow_action_index        an ORDER/SWAP/DISPENSER holding ownership, per chain
     *
     * @returns {Promise<{params: object, ownerAddress: (string|null)}|null>}
     */
    async tokenParameters(chain, tick) {
        const EXCLUDE = new Set(['id', 'tick_id', 'action_index', 'last_action_index', 'supply',
            'owner_id', 'coin_price', 'coin_floor', 'bridged', 'escrow_action_index']);
        const rows = await this.queryIndexerDb(chain,
            `SELECT tk.*, ad.address AS owner_address
             FROM tokens tk
             INNER JOIN index_tickers ti ON (ti.id=tk.tick_id)
             LEFT  JOIN index_addresses ad ON (ad.id=tk.owner_id)
             WHERE ti.tick=? LIMIT 1`,
            [String(tick)]);
        if (!rows.length) return null;
        const row = rows[0];
        const params = {};
        for (const key of Object.keys(row)) {
            if (EXCLUDE.has(key) || key === 'owner_address') continue;
            // Normalised to a string so a driver that hands back BigInt on one chain and
            // Number on the other cannot fail an assertion about the LEDGER.
            params[key] = row[key] === null || row[key] === undefined ? null : String(row[key]);
        }
        return { params: params, ownerAddress: row.owner_address === undefined ? null : row.owner_address };
    }

    /**
     * The address one protocol role resolves to on a chain, read from the INDEXER'S OWN
     * per-chain config module in this tree.
     *
     * NOT an RPC, and the first cut's `getinfo` was the bug: the indexer serves no such
     * method (measured on the rail 2026-09-12, `-32601 Method not found - getinfo`), and
     * its allowlist has no read that answers the ADDRESS role map at all. The addresses
     * are compile-time constants of `src/coins/<COIN>.js` per network, so the honest
     * source is the same module the running indexer resolved them from: a difference
     * between this read and the indexer's behaviour would be a difference between two
     * loads of one file, which is not a thing that happens.
     *
     * Loaded lazily so the pure layer stays requirable without the indexer on disk.
     */
    async roleAddress(chain, role) {
        const config = roleConfigFor(chain, this.network);
        const addresses = (config && config.ADDRESS) || {};
        return addresses[String(role)] === undefined ? null : addresses[String(role)];
    }

    /**
     * Does this chain's ledger hold a row for `tick` at all? AT1's precondition.
     */
    async hasTokenRow(chain, tick) {
        const rows = await this.queryIndexerDb(chain,
            'SELECT 1 AS present FROM tokens tk INNER JOIN index_tickers ti ON (ti.id=tk.tick_id) ' +
            'WHERE ti.tick=? LIMIT 1', [String(tick)]);
        return rows.length > 0;
    }

    /**
     * Hold until the DESTINATION indexer has APPLIED the leg named by `transferId`.
     *
     * WHY THIS IS A SEPARATE BARRIER FROM `waitForFinalizedTransfer`, measured on the rail
     * 2026-09-12 rather than reasoned about. A finalized `bridge_transfers` row means the
     * FEDERATION agreed; it says nothing about the destination. Between the two sit the
     * hub push, the destination's mirror sync, the D2 escrow-proof fetch and the block the
     * v2 in leg is injected into. AT1 read the destination balance the instant the hub row
     * appeared, got 0, and reported "the DOGE balance did not gain exactly 5" for a mint
     * that had not been attempted yet: a real assertion failing on a fixture race, which is
     * the most expensive kind of red because it reads as a protocol fault.
     *
     * BY THE SETTLEMENT ROW, keyed on the transfer id, never by watching a balance move.
     * `bridge_settlements` is the destination's own record that it applied THIS leg, so the
     * wait cannot be satisfied by some other credit arriving, and the row it returns carries
     * the block the leg landed in, which the evidence quotes.
     *
     * AND THE WAIT IS LONG BY DESIGN, so the budget is not a guess. The hub stamps
     * `effective_time = now + relayMarginFloorS(destChain)` and every indexer applies the
     * row at the first block whose time reaches it (xchain-hub src/lib/relay_margin.js:
     * 4 nominal blocks of the DESTINATION chain, so 240s to DOGE and 2400s to BTC), and
     * off mainnet the block time a handler compares against is median-time-past, which
     * lags the tip by roughly half the median window. Measured on the rail 2026-09-12:
     * a lock finalized at 17:38:02 carried effective_time 17:42:02. So an out leg to BTC
     * needs the better part of an hour and a budget under that reports "never applied"
     * for a transfer that was on schedule.
     *
     * @param {string} chain       destination chain code, as the venue spells it
     * @param {string} transferId  `bridge_transfers.transfer_id`
     * @returns {Promise<object|null>} the settlement row, or null on timeout
     */
    async waitForBridgeApplied(chain, transferId, opts) {
        const o = opts || {};
        const deadline = Date.now() + Number(o.timeoutMs ||
            (String(chain).toUpperCase() === 'BTC' ? 70 : 25) * 60 * 1000);
        const id = String(transferId);
        while (Date.now() < deadline) {
            let rows = [];
            try {
                rows = await this.queryIndexerDb(chain,
                    'SELECT * FROM bridge_settlements WHERE transfer_id = ? LIMIT 1', [id]);
            } catch (e) {
                // A destination that has not built the table yet has certainly not applied
                // the leg, which is the same answer as an empty result.
                rows = [];
            }
            if (rows.length) {
                this.servedBy('bridgesettlement:' + chain, 'venue ' + chain + ' indexer ' +
                    (String(chain).toUpperCase() === 'BTC' ? this.btcIndexerUrl() : this.dogeIndexerUrl()));
                return rows[0];
            }
            await new Promise((r) => setTimeout(r, 3000));
        }
        return null;
    }

    /**
     * Poll a venue hub's `bridge_transfers` for a finalized row naming `txHash`.
     *
     * BY PERSISTED ROW, never by event, which is the shape the multi-hub PBFT case in
     * bridgeTransferE2E already uses: a finalized row is what the mirror carries and what
     * an indexer applies, while a round event is an artifact of one hub's process.
     *
     * AND ACROSS EVERY HUB, not just hub 0, because the four do not agree. Measured on the
     * rail 2026-09-12: round `2764c037` finalized `BTC:99 -> DOGE 5 XCHAIN (3 sigs)` and
     * hubs 1, 2 and 3 each wrote the row while hub 0, the one that was not among the three
     * signers, wrote nothing and logged nothing. A poll of hub 0 alone therefore reported
     * "no bridge_transfers row was finalized by the venue federation" for a transfer the
     * federation had finalized four minutes earlier. Which hub is left out is a property of
     * the round, so a drive must ask all of them; `finalizedOn` records who answered, since
     * a row present on some hubs and absent on others is itself a finding.
     *
     * @returns {Promise<object|null>} the row, or null on timeout
     */
    async waitForFinalizedTransfer(match, opts) {
        const o = opts || {};
        const deadline = Date.now() + Number(o.timeoutMs || 240000);
        assert.ok(this.hubs.length, 'bridgeRailVenue: no hub database to poll');
        let last = null;
        while (Date.now() < deadline) {
            const seen = [];
            let found = null;
            for (const hub of this.hubs) {
                let rows = [];
                try {
                    rows = await this.queryHubDb(hub.dbName,
                        'SELECT * FROM bridge_transfers ORDER BY id DESC LIMIT 50');
                } catch (e) { rows = []; }
                for (const row of rows) {
                    if (!match(row)) continue;
                    seen.push(hub.index);
                    if (!found) found = row;
                }
                last = { hub: hub.index, rows: rows.length };
            }
            if (found) { found.finalizedOn = seen; return found; }
            await new Promise((r) => setTimeout(r, 2000));
        }
        this._lastTransferPoll = last;
        return null;
    }

    /**
     * Re-seed the venue hubs' COIN/USD prices, so a DOGE action later in a long drive is
     * still priced.
     *
     * THE PRICE GOES STALE IN THIRTY MINUTES AND THIS DRIVE IS LONGER THAN THAT. The venue
     * seeds DOGE/USD and XCHAIN/USD once at bring-up and its oracle publishes nothing
     * afterwards (`OraclePublisher: no broadcast pipeline configured ... round will remain
     * queued`), while every ISSUE prices its fee against a quote no older than 1800 s. AT2's
     * out leg alone costs forty minutes waiting out the BTC relay margin, so AT5's FUFU
     * issue landed fifty-one minutes after bring-up and was refused `invalid: no current
     * oracle price for DOGE/USD (missing or stale beyond 1800s)`, measured on drive 10. That
     * is a property of the FIXTURE's clock, not of the bridge, so the fixture refreshes it
     * rather than the drive adapting its assertions to it.
     */
    async refreshVenuePrices() {
        if (!this.dogeVenue || typeof this.dogeVenue._seedHubPrices !== 'function') return false;
        await chainRail.withRail(this.dogeRail, () => this.dogeVenue._seedHubPrices());
        return true;
    }

    /**
     * The freshest finalized quote a venue hub holds for one pair, and how old it is RIGHT NOW.
     *
     * MEASURED BEFORE EVERY RESEED, so the reseed cannot hide why a priced action was refused.
     * `refreshVenuePrices` above is the right fix for a quote that has aged past the 1800 s
     * window, and it is also a perfect mask: call it in front of a case and a refusal caused by
     * the PRICING CODE reads exactly like a refusal caused by the CLOCK, because both go away.
     * Reading the row first separates them. A case that was refused with a row this method
     * reports as fresh has found something in the pricing path, not the fixture's clock.
     *
     * Reads hub 0's database (the venue seeds every hub identically, and `_seedHubPrices`
     * writes the same two rounds into each).
     *
     * @param {string} pair e.g. 'DOGE/USD'
     * @returns {Promise<object|null>} {pair, hubDb, price, blockTimestamp, ageSeconds, stale,
     *   rowCount} or null when the venue is not up
     */
    async readVenuePrice(pair) {
        const hubDbName = this.hubs[0] ? this.hubs[0].dbName : null;
        if (!hubDbName) return null;
        const rows = await this.queryHubDb(hubDbName,
            'SELECT round_number, price, block_timestamp FROM price_snapshots ' +
            "WHERE coin_pair = ? AND status = 'finalized' ORDER BY block_timestamp DESC LIMIT 1",
            [String(pair)]);
        const now = Math.floor(Date.now() / 1000);
        if (!rows || !rows.length) {
            return { pair: String(pair), hubDb: hubDbName, price: null, blockTimestamp: null,
                ageSeconds: null, stale: true, rowCount: 0 };
        }
        const ts = Number(rows[0].block_timestamp);
        return { pair: String(pair), hubDb: hubDbName, price: String(rows[0].price),
            round: Number(rows[0].round_number), blockTimestamp: ts, ageSeconds: now - ts,
            // The handler's own window, the one that produced `stale beyond 1800s` on drive 11.
            stale: (now - ts) > 1800, rowCount: rows.length };
    }

    /**
     * A read against one venue indexer's MIRROR database.
     *
     * A venue indexer keeps two databases and conflating them cost this row a whole drive.
     * `indexerDbName` holds the LEDGER it parsed (tokens, credits, bridge_settlements);
     * `mirrorDbName` holds what `hub_db_sync` copied down from the hub (bridge_transfers,
     * policy_snapshots, capability_snapshots). Drive 7 read `bridge_transfers` out of the
     * ledger database, found 0, and reported that the mirror had never delivered the row,
     * while the mirror database held both rows the whole time.
     */
    async queryMirrorDb(chain, sql, params) {
        const ix = String(chain).toUpperCase() === 'BTC' ? this.btcIndexer() : this.dogeIndexer();
        assert.ok(ix, 'bridgeRailVenue: no venue indexer for ' + chain);
        const db = this.hubDb;
        assert.ok(db, 'bridgeRailVenue: the venue has no hubDb; it is not started');
        assert.ok(/^[A-Za-z0-9_]+$/.test(String(ix.mirrorDbName)),
            'bridgeRailVenue: refusing an unsafe database identifier ' + ix.mirrorDbName);
        let conn = null;
        try {
            conn = await mariadb.createConnection({
                host: db.host, port: parseInt(db.port, 10), user: db.user, password: db.pass,
                database: String(ix.mirrorDbName), connectTimeout: 10000,
            });
            return await conn.query(sql, params || []);
        } finally {
            if (conn) await conn.end().catch(() => {});
        }
    }

    /**
     * The finalized transfers one chain's indexer has been handed by the mirror.
     */
    async mirroredTransfers(chain) {
        try {
            return await this.queryMirrorDb(chain,
                "SELECT transfer_id, src_chain, dest_chain, dest_address, amount, tick, status, " +
                "effective_time FROM bridge_transfers WHERE status <> 'retracted' ORDER BY id ASC");
        } catch (e) {
            // A mirror that has not built the table yet carries no transfers, which is the
            // same answer as an empty one.
            return [];
        }
    }

    /**
     * The verdict one broadcast action carries ON THIS VENUE'S OWN LEDGER.
     *
     * Every `*Helper.send*` in the harness waits on the global `indexerDatabase`, which is
     * the STANDING indexer's database for whichever rail is current. For the BTC legs that
     * is the same chain parsed by the same code and the two agree; for the DOGE legs it is
     * a DIFFERENT LEDGER (this venue replays, the standing node cloned its own history), so
     * a drive that waits there is reading a verdict about a ledger no assertion below is
     * about. AT7's airdrop failed exactly that way on drive 7.
     */
    async verdict(chain, table, txHash, opts) {
        const av = String(chain).toUpperCase() === 'BTC' ? this.btcVenue : this.dogeVenue;
        assert.ok(av, 'bridgeRailVenue: no venue for ' + chain);
        return verdictOf(av, table, txHash, opts);
    }

    /**
     * Hold until the bridge is QUIET for `tick`: nothing in flight and the escrow equal to
     * the destination supply on every chain the hub reports.
     *
     * WHY A DRIVE NEEDS THIS BEFORE IT ASSERTS ANYTHING. See `deferBridgeWiring`: arming
     * the engine on a rail with history re-finalizes every historical lock, and those legs
     * land on the destination minutes later, at a moment nothing in the drive controls. A
     * balance delta measured across that window is measuring two events and attributing
     * both to one. So the drive arms the engine, waits here until the backlog has drained,
     * and only then takes the baseline every later assertion is a delta from.
     *
     * AND IT IS MEASURED ON THE SETTLEMENT ROWS, NOT ON `in_flight`, because that term is
     * broken on this rail and waiting for it would hang forever. Measured 2026-09-12: the
     * hub adds every row `getpendingbridgetransfers` returns to its in-flight view on each
     * poll (CrossChainBridgeEngine._recordPending, called before the finalization dedup),
     * and the indexer read has no settled filter at all (db.js getPendingBridgeTransfers
     * selects every valid XBRIDGE leg forever). So a leg that finalized and applied months
     * ago is still counted in flight, and `delta = escrow - (supply + in_flight)` sits
     * permanently negative. The chain halves themselves are correct; only the term between
     * them is. See the drive's AT6 for the readout this produces.
     *
     * @param {string} tick
     * @returns {Promise<{applied: Array, invariant: object}|null>} null on timeout
     */
    async waitForRailSettled(tick, opts) {
        const o = opts || {};
        const deadline = Date.now() + Number(o.timeoutMs || 45 * 60 * 1000);
        const hubDbName = this.hubs[0] ? this.hubs[0].dbName : null;
        assert.ok(hubDbName, 'bridgeRailVenue: no hub database to poll');
        let last = null;
        while (Date.now() < deadline) {
            const pending = [];
            const applied = [];
            // THE BACKLOG IS THE CHAIN'S, NOT THE MIRROR'S, and asking the mirror would be
            // circular: a fresh venue's mirror is empty at boot, so "nothing pending" would
            // be true a second after the engine was armed and before it had proposed a
            // thing. `getpendingbridgetransfers` answers every valid XBRIDGE leg on the
            // chain, so it is the complete list of what this federation is about to
            // re-finalize.
            for (const src of ['BTC', 'DOGE']) {
                let legs = [];
                try {
                    const res = await this.indexerRpc(src, 'getpendingbridgetransfers', { limit: 500 });
                    legs = (res && Array.isArray(res.transfers)) ? res.transfers : [];
                } catch (e) {
                    // AN UNREADABLE SOURCE INDEXER IS NOT AN EMPTY BACKLOG, and reading it as
                    // one is the worst answer this method can give: it would report the rail
                    // DRAINED while the whole chain's legs were still unsigned, and every
                    // absolute reading taken against that baseline would be arithmetic on a
                    // number nobody had waited for. So the failure becomes an outstanding
                    // entry: the poll can never conclude quiet from a read that did not happen.
                    pending.push({ stage: 'source read unreadable', chain: src,
                                   error: String(e && e.message).slice(0, 200) });
                    continue;
                }
                for (const leg of legs) {
                    if (tick && String(leg.tick) !== String(tick)) continue;
                    const dest = String(leg.dest_chain).toUpperCase();
                    // A leg bound for a chain this venue has no indexer for can never be
                    // observed applying, so waiting on it would hang the whole drive. It is
                    // recorded as unobservable rather than folded into either answer.
                    if (dest !== 'BTC' && dest !== 'DOGE') {
                        this._unobservableLegs = (this._unobservableLegs || []).concat(
                            [{ src: src, dest: dest, actionIndex: String(leg.src_action_index) }]);
                        continue;
                    }
                    const where = { chain: src, dest: dest, actionIndex: String(leg.src_action_index),
                                    amount: String(leg.amount) };
                    const hubRows = await this.queryHubDb(hubDbName,
                        'SELECT transfer_id, status FROM bridge_transfers ' +
                        'WHERE src_chain = ? AND src_action_index = ? LIMIT 1',
                        [src, Number(leg.src_action_index)]);
                    if (!hubRows.length) { pending.push(Object.assign({ stage: 'unfinalized' }, where)); continue; }
                    const transferId = String(hubRows[0].transfer_id);
                    let settled = [];
                    try {
                        settled = await this.queryIndexerDb(dest,
                            'SELECT * FROM bridge_settlements WHERE transfer_id = ? LIMIT 1', [transferId]);
                    } catch (e) { settled = []; }
                    if (settled.length) applied.push(Object.assign({ transferId: transferId,
                        block: String(settled[0].block_index) }, where));
                    else pending.push(Object.assign({ stage: 'unapplied', transferId: transferId }, where));
                }
            }
            last = { applied: applied, pending: pending };
            // Published every poll, not only at the timeout: a case that fails for another
            // reason while the drain is still running can then quote how far it had got.
            this._lastSettlePoll = last;
            if (!pending.length) {
                let invariant = null;
                try { invariant = await this.bridgeInvariant(tick); } catch (e) { invariant = null; }
                return { applied: applied, invariant: invariant };
            }
            await new Promise((r) => setTimeout(r, 5000));
        }
        this._lastSettlePoll = last;
        return null;
    }

    /**
     * The source legs this venue's federation finalized more than once, read off hub 0's
     * own database. See `overFinalizedSourceLegs` for what the answer means and the reading
     * that put it here.
     *
     * Read from the HUB rather than from the destination's `bridge_settlements`, because the
     * duplication happens at finalization: a destination that refused the second mint would
     * still be riding a federation that signed two records for one lock.
     *
     * @returns {Promise<Array>} empty when every finalized leg is unique
     */
    async duplicateSourceTransfers() {
        const hubDbName = this.hubs[0] ? this.hubs[0].dbName : null;
        assert.ok(hubDbName, 'bridgeRailVenue: no hub database to read');
        const rows = await this.queryHubDb(hubDbName,
            'SELECT transfer_id, src_chain, src_action_index, amount, status, snapshot_block ' +
            'FROM bridge_transfers');
        return overFinalizedSourceLegs(rows);
    }

    /**
     * Hold until `predicate` answers true, and fail loudly with what was being waited for.
     *
     * WHY IT IS HERE rather than a fixed sleep: a fixed settle wait before an assertion
     * passes or fails on how busy the venue is, and on this rail the venue is three hubs,
     * two indexers and two chains that a peer lane may also be mining. The predicate may be
     * async and may throw, and a throw is treated as "not yet" so a read against a service
     * that is still starting does not end the wait.
     *
     * @param {string} what the thing being waited for, quoted verbatim in the failure
     * @param {function(): (boolean|Promise<boolean>)} predicate
     */
    async waitUntil(what, predicate, opts) {
        const o = opts || {};
        const timeoutMs = Number(o.timeoutMs || 120000);
        const everyMs = Number(o.everyMs || 2000);
        const deadline = Date.now() + timeoutMs;
        let lastError = null;
        while (Date.now() < deadline) {
            try { if (await predicate()) return true; } catch (e) { lastError = e; }
            await new Promise((r) => setTimeout(r, everyMs));
        }
        assert.fail('bridgeRailVenue: waited ' + Math.round(timeoutMs / 1000) + 's for ' + what +
            ' and it never happened' + (lastError ? '. The last read failed with: ' +
            String(lastError.message).slice(0, 200) : '') + '\n' + this.indexerTails(40));
    }

    /**
     * One chain's `ledger_hash` and `actions_hash` as STRINGS, at a height or at the tip.
     *
     * THE JOIN IS THE WHOLE POINT, and its absence is what AT3b and AT3c died on the first
     * time they ran: `blocks` carries `ledger_hash_id` and `actions_hash_id`, ids into
     * `index_transactions`, and there is no `ledger_hash` column at all, so a SELECT naming
     * one fails with `Unknown column 'ledger_hash' in 'SELECT'`. AT3's claim is that a BTC
     * reorg moves NO DOGE hash, so the reading has to be the hash itself rather than an id
     * that could be re-pointed.
     *
     * @param {string} chain BTC or DOGE
     * @param {number} [blockIndex] the height to read; the tip when omitted
     */
    async blockHashes(chain, blockIndex) {
        const at = (blockIndex === undefined || blockIndex === null) ? null : Number(blockIndex);
        const rows = await this.queryIndexerDb(chain,
            'SELECT b.block_index AS block_index, lh.hash AS ledger_hash, ah.hash AS actions_hash ' +
            'FROM blocks b ' +
            'LEFT JOIN index_transactions lh ON (lh.id = b.ledger_hash_id) ' +
            'LEFT JOIN index_transactions ah ON (ah.id = b.actions_hash_id) ' +
            (at === null ? '' : 'WHERE b.block_index = ? ') +
            'ORDER BY b.block_index DESC LIMIT 1',
            at === null ? [] : [at]);
        assert.ok(rows.length, 'bridgeRailVenue: the ' + chain + ' venue ledger holds no block ' +
            (at === null ? 'at all' : at) + ', so there is no hash to compare');
        return rows;
    }

    /**
     * Both venue indexers' tip heights, for a diagnosis. Never throws: this is called from
     * a failure path, where a second failure would replace the finding with its own.
     */
    async venueTips() {
        const tips = {};
        for (const chain of ['BTC', 'DOGE']) {
            try {
                const answer = await this.indexerRpc(chain, 'getblockhashes', {});
                tips[chain] = answer ? Number(answer.block_index) : null;
            } catch (e) { tips[chain] = 'unreadable: ' + String(e && e.message).slice(0, 80); }
        }
        return tips;
    }

    /**
     * Fund an address under a budget, so a stalled funding call fails the case with a
     * diagnosis instead of hanging the drive.
     *
     * The wait itself is `fundUnderBudget`; what this adds is the venue's own readings on a
     * breach: both chains' tip heights before the call and at the breach, which separate
     * "the chain stopped" from "the chain moved and this transaction still never reached a
     * block". Every funding call in the three rail suites goes through here.
     *
     * @param {string} label the drive's name for the address
     * @param {function(): Promise} fn the funding call, already bound to its rail
     */
    async funded(label, fn, opts) {
        const tipsAtStart = await this.venueTips();
        return fundUnderBudget(label, fn, Object.assign({}, opts, {
            diagnose: async (wait) => ({ tipsAtStart: tipsAtStart, tipsAtBreach: await this.venueTips(),
                node: await nodeDiagnosis(wait ? wait.txid : null) }),
        }));
    }

    /**
     * What credited this chain's bridge escrow address OTHER than an XBRIDGE leg, net of
     * debits, with the crediting actions listed.
     *
     * WHY THE DRIVE NEEDS IT. The escrow is a plain address and D65 is the ruling that a
     * stray SEND to it is the sender's own loss and mints nothing: the units stay there for
     * good, and the escrow key is nobody's, so they can never be spent back out. This rail
     * has carried three such SENDs from earlier drive attempts, so the escrow balance is
     * permanently ABOVE the destination supply by their total, and the acceptance claim
     * "the invariant reads equal on BTC and DOGE" is only an identity once they are
     * subtracted. Measured here rather than assumed, off the venue's own ledger, so the
     * number a case asserts with is the one that ledger holds and not a constant retyped
     * from a previous drive.
     *
     * @returns {Promise<{net: number, credits: number, debits: number, byAction: Array}>}
     */
    async escrowNonBridgeCredits(chain, role, tick) {
        const address = await this.roleAddress(chain, role);
        assert.ok(address, 'bridgeRailVenue: no ' + role + ' address on ' + chain);
        const sum = async (table) => {
            const rows = await this.queryIndexerDb(chain,
                'SELECT ia.action AS action, COUNT(*) AS n, ' +
                'COALESCE(SUM(CAST(m.amount AS DECIMAL(60,18))),0) AS total ' +
                'FROM ' + table + ' m ' +
                'INNER JOIN index_addresses ad ON (ad.id=m.address_id) ' +
                'INNER JOIN index_tickers   ti ON (ti.id=m.tick_id) ' +
                'INNER JOIN actions a ON (a.action_index=m.action_index) ' +
                'INNER JOIN index_actions ia ON (ia.id=a.action_id) ' +
                'WHERE ad.address = ? AND ti.tick = ? AND ia.action <> \'XBRIDGE\' ' +
                'GROUP BY ia.action',
                [String(address), String(tick)]);
            return rows.map((r) => ({ action: String(r.action), count: Number(r.n),
                total: Number(r.total), table: table }));
        };
        const credits = await sum('credits');
        const debits = await sum('debits');
        const total = (rows) => rows.reduce((n, r) => n + Number(r.total || 0), 0);
        this.servedBy('escrowNonBridge:' + chain, 'venue ' + chain + ' indexer ledger database');
        return { address: address, credits: total(credits), debits: total(debits),
                 net: total(credits) - total(debits), byAction: credits.concat(debits) };
    }

    /**
     * A read against one venue hub's own database.
     */
    async queryHubDb(dbName, sql, params) {
        const db = this.hubDb;
        assert.ok(db, 'bridgeRailVenue: the venue has no hubDb; it is not started');
        assert.ok(/^[A-Za-z0-9_]+$/.test(String(dbName)),
            'bridgeRailVenue: refusing an unsafe database identifier ' + dbName);
        let conn = null;
        try {
            conn = await mariadb.createConnection({
                host: db.host, port: parseInt(db.port, 10), user: db.user, password: db.pass,
                database: String(dbName), connectTimeout: 10000,
            });
            return await conn.query(sql, params || []);
        } finally {
            if (conn) await conn.end().catch(() => {});
        }
    }

    /**
     * Every hub's tail, for a refusal that needs to name which hub said what.
     */
    hubTails(lines) {
        const n = Number(lines || 40);
        return this.hubs.map((h) => '--- hub ' + h.index + ' ---\n' +
            String(this.btcVenue.logTail('hub' + h.index) || '').split('\n').slice(-n).join('\n')).join('\n');
    }

    indexerTails(lines) {
        const n = Number(lines || 40);
        const out = [];
        if (this.btcVenue)  out.push('--- venue BTC indexer ---\n' +
            String(this.btcVenue.logTail('indexer0') || '').split('\n').slice(-n).join('\n'));
        if (this.dogeVenue) out.push('--- venue DOGE indexer ---\n' +
            String(this.dogeVenue.logTail('indexer0') || '').split('\n').slice(-n).join('\n'));
        return out.join('\n');
    }

    async stop() {
        // The DOGE venue first: it borrows the BTC venue's hubs and hub database, so
        // stopping the owner first would leave it talking to a mesh that is gone.
        if (this.dogeVenue) { await this.dogeVenue.stop().catch(() => {}); this.dogeVenue = null; }
        if (this.btcVenue)  { await this.btcVenue.stop().catch(() => {});  this.btcVenue = null; }
    }
}

/**
 * A DOGE-only venue indexer on the tree's bridge code, following one throwaway hub.
 *
 * WHY THIS IS A SEPARATE ENTRY POINT AND NOT A FLAG ON THE CLASS. Half of the acceptance
 * set is federation-free: the supply-path closures (D62, D63) and the AT9 verdict witness
 * are decisions one indexer makes about one broadcast action, with no transfer, no round
 * and no mirror in them. They still cannot be driven against the STANDING DOGE indexer,
 * which runs `1bbc68ae` and predates every one of those rules, so they need an indexer on
 * bridge code and nothing else. Giving them the whole mesh would make them inherit the
 * mesh's blocker (see resolveVenueQuorum) and stop proving what they can prove.
 *
 * The caller must already be inside the DOGE rail: `_resolveStandingStack` and the chain
 * clone both read the ambient endpoints and INDEXER_DB_*.
 *
 * @returns {Promise<AttestMirrorVenue|null>} null when a dependency is missing; the
 *          venue's own `unavailable` says which
 */
async function startDogeVenue(opts) {
    const o = opts || {};
    const venue = new AttestMirrorVenue({
        label: String(o.label || 'bridgeguard').replace(/[^A-Za-z0-9]/g, ''),
        coin: 'dogecoin',
        network: o.network || 'regtest',
        hubCount: 1,
        indexerCount: 1,
        basePort: o.basePort || 43600,
        // The harness DECODER_DB_* describe Bitcoin.
        useEnvDecoderCredential: false,
        graces: {},
        // The guards venue loads the same tree as the rail venue, or the parity case would be
        // comparing two different builds and calling the difference a grading fact.
        repoRoot: o.repoRoot || process.env.BRIDGE_RAIL_REPO_ROOT || undefined,
    });
    const up = await venue.start();
    if (!up) return null;
    return venue;
}

/**
 * The verdict one action table recorded for a broadcast transaction, on a venue indexer.
 *
 * Polls, because the action has to be mined and then parsed by a node that is catching
 * up. Returns null on timeout rather than throwing, so the caller can say which action
 * never landed instead of asserting against undefined.
 *
 * A verdict lives on the ACTION table (issues.status_id, sends.status_id, ...) and not on
 * `actions`, which is why the table is a parameter; it is validated as an identifier
 * because it is interpolated.
 *
 * @param {object} venue  an AttestMirrorVenue whose indexer 0 is the reader
 * @param {string} table  issues | sends | orders | dispensers | destroys ...
 * @param {string} txHash
 */
async function verdictOf(venue, table, txHash, opts) {
    const o = opts || {};
    assert.ok(/^[a-z_]+$/.test(String(table)), 'bridgeRailVenue: refusing an unsafe table identifier ' + table);
    const ix = venue.indexers[0];
    const db = venue.hubDb;
    const deadline = Date.now() + Number(o.timeoutMs || 300000);
    const sql =
        'SELECT s.status AS status, x.action_index AS action_index ' +
        'FROM `' + table + '` x ' +
        'JOIN actions a ON a.action_index = x.action_index ' +
        'JOIN transactions t ON t.tx_index = a.tx_index ' +
        'JOIN index_transactions it ON it.id = t.tx_hash_id ' +
        'JOIN index_statuses s ON s.id = x.status_id ' +
        'WHERE it.hash = ? LIMIT 1';
    while (Date.now() < deadline) {
        let conn = null;
        try {
            conn = await mariadb.createConnection({
                host: db.host, port: parseInt(db.port, 10), user: db.user, password: db.pass,
                database: String(ix.indexerDbName), connectTimeout: 10000,
            });
            const rows = await conn.query(sql, [String(txHash)]);
            if (rows.length) return { status: String(rows[0].status), actionIndex: String(rows[0].action_index) };
        } catch (e) { /* a fresh indexer may not have built the table yet */ }
        finally { if (conn) await conn.end().catch(() => {}); }
        await new Promise((r) => setTimeout(r, 3000));
    }
    return null;
}

/**
 * The AT9 witness: the three controller-guarded actions on DOGE from a source with no
 * XCHAIN, and the verdict each one carries.
 *
 * WHAT MAKES THIS A WITNESS. AT9 states a NEGATIVE: bringing XCHAIN into existence on a
 * chain must not silently re-grade actions that have nothing to do with the bridge. A
 * negative like that cannot be asserted at one instant, only COMPARED across the event,
 * so this is written to be run twice with its two outputs compared. It takes the label
 * from the caller for the same reason: funding the same address twice would carry the
 * first run's balances into the second and move a verdict for a reason that is not the
 * bridge, which is the false red this parameter exists to prevent.
 *
 * Lives in the helper rather than in either suite so both halves read ONE definition of
 * what is being witnessed. Two copies is how a witness stops witnessing.
 *
 * The caller must already be inside the DOGE rail.
 */
async function driveVerdictWitness(deps, venue, label) {
    const { cryptoHelper, transactionHelper, network, gasTick } = deps;
    const tick = gasTick || 'XCHAIN';
    const src = await cryptoHelper.getNewFundedAddress(
        label + '.SRC', 'dogecoin', network, null, 'legacy', 0, 1, false);
    // An ADDRESS, not a funded one: it is only ever a destination here, and
    // regtestMinerConnector refuses a zero-amount send outright ("Invalid amount: must
    // be a positive finite number"), so asking for 0 coins is an error and not a no-op.
    const dest = await cryptoHelper.getNewAddress(
        label + '.DEST', 'dogecoin', network, null, 'legacy', 0);

    // EXPIRATION IS A UNIX TIMESTAMP, not a block height, and getting that wrong is how
    // this witness first came back useless: at 100 both the ORDER and the DISPENSER
    // refused `invalid: EXPIRATION (past)` before reaching any tick logic at all, so the
    // verdict could not have moved when XCHAIN appeared and the comparison proved
    // nothing. Ninety days out, so the same wire is still live on a re-run tomorrow.
    const expiry = Math.floor(Date.now() / 1000) + 90 * 24 * 3600;

    const sendTx = await transactionHelper.createAndSendTransaction(
        src, 'SEND|0|' + tick + '|1|' + dest.address + '|');
    // Give XCHAIN, get native DOGE: GIVE_COIN|GIVE_TICK|GIVE_AMOUNT|GIVE_OWNERSHIP then
    // the get side, the counterparty address, expiration and the two lists.
    const orderTx = await transactionHelper.createAndSendTransaction(
        src, 'ORDER|0|DOGE|' + tick + '|1|0|DOGE||1|0|' + src.address + '|' + expiry + '|||');
    // The dispenser's GET_ADDRESS is where the BUYER's payment lands, so it is the
    // dispenser owner's own address and never the counterparty's.
    const dispTx = await transactionHelper.createAndSendTransaction(
        src, 'DISPENSER|0|DOGE|' + tick + '|1|0|1|DOGE||1|' + src.address + '||||' + expiry + '|||');

    const rows = {
        SEND:      await verdictOf(venue, 'sends', sendTx),
        ORDER:     await verdictOf(venue, 'orders', orderTx),
        DISPENSER: await verdictOf(venue, 'dispensers', dispTx),
    };
    return {
        SEND:      rows.SEND      ? rows.SEND.status      : null,
        ORDER:     rows.ORDER     ? rows.ORDER.status     : null,
        DISPENSER: rows.DISPENSER ? rows.DISPENSER.status : null,
        txids: { SEND: sendTx, ORDER: orderTx, DISPENSER: dispTx },
        source: src.address,
    };
}

/**
 * The source legs a federation finalized MORE THAN ONCE, from `bridge_transfers` rows.
 *
 * WHY THIS IS ASKED SEPARATELY FROM THE INVARIANT. One lock is one transfer is one mint:
 * the escrow on the origin chain pays for exactly one credit on the destination. When that
 * breaks, every arithmetic assertion downstream (the baseline's escrow-equals-supply, AT2's
 * release, AT6's equal read, AT7's totals) fails on a NUMBER, and a number says only that
 * two chains disagree, not which side invented value. This says which source leg was
 * over-finalized and by how much, so a red names the cause.
 *
 * MEASURED ON THE RAIL 2026-09-12 (drive 11), and this is the reading the function exists
 * for: BTC lock action 99 (5 XCHAIN) carried THREE finalized transfers, at snapshot blocks
 * 1017, 1018 and 1019, and action 95 (30 XCHAIN) carried two. 80 XCHAIN locked on BTC had
 * become 120 XCHAIN minted on DOGE. The hub derives `transfer_id` with `snapshot_block`
 * inside the preimage, so the same lock yields a new id at every BTC height, and both
 * dedupes it passes through are keyed on that id or on a row not yet persisted; the
 * follower's `_validateTransfer` has no source-uniqueness test at all, so the mesh co-signs
 * the duplicate. A retracted row is not a duplicate: retraction is the fence working.
 *
 * @param {Array} rows - bridge_transfers rows: {src_chain, src_action_index, amount, status,
 *                       transfer_id, snapshot_block}
 * @returns {Array} one entry per over-finalized source leg, empty when every leg is unique
 */
function overFinalizedSourceLegs(rows) {
    const groups = new Map();
    for (const r of (Array.isArray(rows) ? rows : [])) {
        if (!r) continue;
        if (String(r.status || '') === 'retracted') continue;
        const key = String(r.src_chain) + ':' + String(r.src_action_index);
        const g = groups.get(key) || { srcChain: String(r.src_chain),
            actionIndex: String(r.src_action_index), count: 0, amountTotal: 0, transfers: [] };
        g.count += 1;
        g.amountTotal += Number(r.amount || 0);
        g.transfers.push(String(r.transfer_id).slice(0, 16) + '@' + String(r.snapshot_block));
        groups.set(key, g);
    }
    const dupes = [];
    for (const g of groups.values()) if (g.count > 1) dupes.push(g);
    return dupes;
}

// The pins the federation-free half MEASURES and the federated half compares against.
// Module state rather than a file, because the two halves are two suites in one run.
const WITNESS_VERDICTS = {};

module.exports = {
    BridgeRailVenue,
    startDogeVenue,
    verdictOf,
    driveVerdictWitness,
    WITNESS_VERDICTS,
    // The pure layer, exported for the unit tier.
    bridgeEngineHubEnv,
    venueCheckpointEnv,
    bridgeProofIndexerEnv,
    selectBridgeSigners,
    resolveVenueQuorum,
    lockWireV0,
    burnWireV1,
    classifyInvariant,
    bridgeSettled,
    escrowOf,
    overFinalizedSourceLegs,
    minimalQuorumSigners,
    classifyFundingWait,
    fundingBudgetMessage,
    interpretFundingNode,
    nodeDiagnosis,
    fundUnderBudget,
    journalCase,
    BRIDGE_CHAINS,
    DEFAULT_CONFIRMATIONS,
    DEFAULT_POLL_MS,
    DEFAULT_FUNDING_BUDGET_MS,
};
