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
 * THE ATTEST-RESPONSE MIRROR VENUE: five hubs that actually SERVE `/hub-db/*`,
 * and two independent indexers that consume it through the mirror.
 *
 * WHY A NEW VENUE. An ATTEST response no longer rides an on-chain transaction:
 * it is finalized over P2P, written to the hub's `attestation_responses` table,
 * gossiped to the whole federation, and carried to every indexer by the hub
 * mirror. Nothing in this repo could exercise that shape. `MultiValidatorHub`
 * runs its hubs IN PROCESS with P2P only and starts no hub API at all, so it has
 * no `/hub-db/snapshot/*` route, no WebSocket broadcaster and therefore no
 * mirror; `oracleBatchVenue` seeds `capability_snapshots` by hand and likewise
 * starts no hub API. The one precedent that spawns REAL `xchain-hub/src/api.js`
 * and `xchain-indexer/src/api.js` children wired to each other over the mirror is
 * `oracleBatchReplay.js`, and this file is that precedent widened from one node
 * to a federation.
 *
 * WHAT IT STANDS UP:
 *   - N hubs (default 5), each a real `api.js` child with its own database, its
 *     own Ed25519 identity, its own P2P port and its own HTTP port, mutually
 *     seeded so `ATTEST_RESULT` gossip flows across the whole federation. Every
 *     hub serves `/hub-db/snapshot/attestation_responses` and the WS broadcaster,
 *     which is the half `MultiValidatorHub` cannot provide.
 *   - M indexers (default 2), each a real `api.js` child on BTC regtest with its
 *     own indexer database and its own MIRROR database, FOLLOWING A DIFFERENT
 *     HUB. Two indexers on two different hubs is the whole point: the dissemination
 *     test asks whether an indexer whose hub was never in the responsible set
 *     reaches the identical state, and one indexer cannot ask that.
 *   - The regtest-only timing seams turned all the way down, so a response binds
 *     in seconds rather than in the frozen 120 + 120: the hubs get
 *     `ATTEST_RESPONSE_FORWARD_S_OVERRIDE`, and the indexers get
 *     `HUB_SYNC_ATTEST_RESPONSE_GRACE_S` / `HUB_SYNC_PRICE_GRACE_S` /
 *     `HUB_SYNC_ORACLE_GRACE_S` at 0. Both seams are refused off regtest by the
 *     product itself, so neither can travel.
 *
 * WHAT CANNOT BE TURNED DOWN, so a drill budgets for it rather than meeting it
 * by surprise: the attestation round's discovery poll and its round timeout.
 * `ATTESTATION_POLL_MS` and `ATTESTATION_ROUND_TIMEOUT_MS` are read off
 * `hub.p2pConfig`, and `xchain-hub/src/api.js` does not put either key into the
 * p2pConfig it assembles, so exporting them to a spawned hub does nothing. A
 * request waits up to one 15s poll before a round starts, whatever the forward
 * margin is. `MultiValidatorHub` can move both only because it builds p2pConfig
 * itself; a real `api.js` child cannot.
 *
 * WHAT IT DELIBERATELY DOES NOT DO:
 *   - It does not stake. A responsible set is resolved from BTC stake, and the
 *     staking pipeline (fund, gas, `sendStakeV1`, mine past the burial) belongs
 *     to the driving suite, which already owns `stakeHelper` and the funded
 *     wallets. Pass the identities you staked in as `opts.identities` and the
 *     hubs will sign with exactly those keys.
 *   - It does not make requests. `attestationHelper` and `vmHelper` do that.
 *   - It borrows, read-only, the standing stack's BTC regtest decoder database
 *     (the chain in parsed form) and its BTC indexer API (the chain's own
 *     capability oracle and the request feed the hubs poll). Every coordinate for
 *     both comes from the standing hub's config oracle, exactly as
 *     `oracleBatchReplay` resolves them, so nothing here is hardcoded and no
 *     credential is written to a file or a command line.
 *
 * SERIAL. Five hub processes plus two indexer processes plus their databases is
 * the heaviest venue in the suite, and it shares the one disposable MariaDB
 * container with the oracle drills. Run one at a time.
 ********************************************************************/

const fs   = require('fs');
const net  = require('net');
const os   = require('os');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const mariadb = require('mariadb');
const axios   = require('axios');

const { startDisposableHubDb } = require('./disposableHubDb');
const { waitFor }              = require('./consensusWait');
const { loadHubModule, ValidatorIdentity, pickFreePorts } = require('./multiValidatorHubHelper');
const { computeResponsibleSigners }  = require('./attestationHelper');
const XChainHubConnector     = require('../../src/XChainHubConnector.js');
const XChainIndexerConnector = require('../../src/XChainIndexerConnector.js');

// Five hubs at redundancy 3 is the shape the mirror design names: with a
// three-slot responsible set on a five-hub federation, two hubs never run the
// round and can only learn the result from gossip, which is the property the
// dissemination leg exists to prove.
const DEFAULT_HUB_COUNT     = 5;
const DEFAULT_INDEXER_COUNT = 2;

// Redundancy is a REQUEST parameter, not a hub knob: the contract passes it to
// `xchain.attestation.request({ redundancy: 3 })`. Exported so a suite and this
// header cannot drift about what the venue is sized for.
const VENUE_REDUNDANCY = 3;

// The regtest-only forward margin. The frozen constant is 120s, and on regtest,
// where blocks are stamped at about wall clock now, that means no response can
// bind for two real minutes per attestation. Five is long enough to survive
// gossip plus stream lag on a loaded venue and short enough that a drill closes
// in seconds.
const DEFAULT_FORWARD_S = 5;

// The batch window, same seam. Small so a window can be closed inside a drill.
const DEFAULT_BATCH_WINDOW_S = 30;

// The gossip hop this venue budgets for, and the figure both timing invariants are
// judged against. It is a BUDGET, not a measurement: five hubs on loopback hop in
// milliseconds, and the number is the ceiling the venue is willing to call ordinary
// once process scheduling on a loaded host is included. AT2 deliberately drives the
// delay proxy far above it, which is the point of that test and not a violation of
// this: the invariant governs the venue's own resting knobs.
const GOSSIP_HOP_BUDGET_S = 2;

// The two window keyings this venue knows how to reason about, named so a verdict cannot
// be spelled two ways in the helper and its guard. `effective_time` is the signed field
// every hub reads identically; `finalized_at` is the per-hub wall clock older hubs keyed
// on, kept because XCHAIN_HUB_PATH can point at one.
const WINDOW_KEY_SIGNED     = 'effective_time';
const WINDOW_KEY_WALL_CLOCK = 'finalized_at';

// Every mirror barrier the indexer has a grace for, read from the indexer itself so
// this venue cannot fall behind a barrier being added. The names are the keys; the
// frozen values are irrelevant here because the venue sets all of them to zero.
const { HUB_SYNC_WATERMARK_GRACE_S } = require('../../../xchain-indexer/src/hub_db_sync.js');
const MIRROR_BARRIERS = Object.freeze(Object.keys(HUB_SYNC_WATERMARK_GRACE_S));

// `attestResponse` -> `HUB_SYNC_ATTEST_RESPONSE_GRACE_S`, the spelling
// `resolveWatermarkGrace` reads for that barrier.
function graceEnvKey(barrier) {
    return 'HUB_SYNC_' + String(barrier).replace(/[A-Z]/g, (c) => '_' + c).toUpperCase() + '_GRACE_S';
}

// The env pairs for every barrier, each defaulting to zero and each overridable by name.
function graceEnv(graces) {
    const out = {};
    for (const barrier of MIRROR_BARRIERS) {
        const v = (graces || {})[barrier];
        out[graceEnvKey(barrier)] = String(v === undefined || v === null ? DEFAULT_GRACE_S : v);
    }
    return out;
}

// Mirror barrier graces, at zero: the barrier then holds only for content the
// stream has not yet delivered, which is the thing under test, rather than for a
// fixed wait. Set to 0 rather than left unset because the frozen 120 would make
// every block wait out the grace on a chain stamped at now.
const DEFAULT_GRACE_S = 0;

// How long a child has to boot far enough to answer. The indexer's
// verifyTables/runMigrations against an empty database is where most of it goes.
const BOOT_WAIT_MS = 180_000;

// The indexer JSON-RPC ports as the stack PUBLISHES them, which are not the ports the
// hub's config oracle stores (those are container-internal, 3004 on every chain). Same
// convention `oracleBatchReplay` carries.
//
// Per-coin rather than BTC-only because the config oracle's value is wrong for a
// host-run process on EVERY chain, not just bitcoin: falling back to it dials a port
// nothing listens on and the caller sees a connection refused it can only swallow.
const PUBLISHED_INDEXER_API_PORT = { BTC: 3024, DOGE: 3124, LTC: 3224 };
const DEFAULT_BTC_INDEXER_API_PORT = PUBLISHED_INDEXER_API_PORT.BTC;

// Child output kept for a failure message. A hub that dies during boot says why
// on its own stderr and nowhere else.
const LOG_TAIL_LINES = 200;

// Guards every identifier interpolated into SQL. Database names cannot be
// parameterized, so the only safe posture is to refuse anything that is not a
// plain identifier rather than to escape it.
const SAFE_IDENT = /^[A-Za-z0-9_]+$/;

// What the hub's config oracle puts where a password would go.
//
// `getallconfigs` REDACTS every credential it serves, returning this literal for the
// node RPC, the decoder database and the indexer database alike. So the oracle is a
// source of COORDINATES and never of credentials, and a helper that reads `pass` off it
// is holding the string '[redacted]', which fails authentication and reports itself as
// ER_ACCESS_DENIED_ERROR: indistinguishable, from the outside, from a rotated password.
// Recognising the sentinel is what turns that into a message naming the real cause.
const HUB_CONFIG_REDACTION = '[redacted]';

// Where a per-coin credential actually lives: the xchain-node config sidecar the
// containers themselves are built from. Tried relative to this checkout the same way
// the hub source is resolved, because the harness runs both from the monorepo and from
// an image where the layout differs.
function resolveCoinConfigSidecar(coin, network) {
    const rel = 'xchain-node/config/' + coin + '-' + network + '.local';
    const candidates = [
        process.env.XCHAIN_NODE_CONFIG_DIR && path.join(process.env.XCHAIN_NODE_CONFIG_DIR, coin + '-' + network + '.local'),
        path.resolve(__dirname, '../../..', rel),
        path.resolve(__dirname, '../../../..', rel)
    ].filter(Boolean);
    for (const p of candidates) {
        if (fs.existsSync(p)) return p;
    }
    return null;
}

/**
 * The decoder database credential, from the first store that actually holds one.
 *
 * THREE STORES DISAGREE ON THIS VALUE and only one of them is ever right, so the order
 * is deliberate rather than a cascade of fallbacks:
 *
 *   1. An explicit `DECODER_DB_PASS` in the environment. An operator running the drill
 *      against a venue whose credential they hold should not have to edit a file.
 *   2. The per-coin config sidecar, which is the documented single source of truth and
 *      the file the containers are built from.
 *   3. The hub's config oracle, which cannot supply one at all (see the sentinel above)
 *      and is kept only so the failure below can say so precisely.
 *
 * Returns `{user, pass, source}`, or `{problem}` naming the store to fix. It never logs
 * a value and never puts one on a command line.
 */
function resolveDecoderCredential(dec, coin, network) {
    const user = process.env.DECODER_DB_USER || dec.user;

    if (process.env.DECODER_DB_PASS) {
        return { user, pass: process.env.DECODER_DB_PASS, source: 'DECODER_DB_PASS in the environment' };
    }

    const sidecar = resolveCoinConfigSidecar(coin, network);
    if (sidecar) {
        let parsed = {};
        try { parsed = require('dotenv').parse(fs.readFileSync(sidecar)); }
        catch (_) { /* an unreadable sidecar is treated as absent */ }
        if (parsed.DECODER_DB_PASS) {
            return { user, pass: parsed.DECODER_DB_PASS, source: sidecar };
        }
    }

    if (dec.pass && dec.pass !== HUB_CONFIG_REDACTION) {
        return { user, pass: dec.pass, source: "the standing hub's config oracle" };
    }

    return {
        problem: 'no usable ' + coin + '/' + network + ' decoder database credential. The standing ' +
            "hub's config oracle redacts every password it serves (it returned " +
            JSON.stringify(HUB_CONFIG_REDACTION) + '), so it can only supply coordinates' +
            (sidecar
                ? ', and the config sidecar ' + sidecar + ' carries no DECODER_DB_PASS'
                : ', and no ' + coin + '-' + network + '.local config sidecar was found') +
            '. Set DECODER_DB_PASS in the harness environment, or reconcile the sidecar with the ' +
            'credential the running decoder actually uses; the two are known to drift apart ' +
            'whenever a container is recreated and nothing propagates the new value back.'
    };
}

// Prefix for every database this venue creates, and it is NOT cosmetic.
//
// The platform hub account holds no global CREATE: its grant is
// `XChain\_%\_MVH\_%`, deliberately narrow so a test fixture can make and drop its own
// databases and touch nothing else. A name outside that pattern is refused with
// ER_DBACCESS_DENIED at the first CREATE DATABASE, which is why the segment is pinned
// here in one place rather than spelled at each of the three call sites: hub, indexer
// and mirror databases must all match, and a name that drifts out of the pattern fails
// only on a live venue, never in a pure test.
const DB_PREFIX = 'XChain_AM_MVH_';

function ident(name, what) {
    if (!SAFE_IDENT.test(String(name || ''))) {
        throw new Error('attestMirrorVenue: refusing to interpolate an unsafe ' + what + ': ' + name);
    }
    return String(name);
}

// MariaDB hands back BIGINT as BigInt and DECIMAL as string; both an assertion
// message and console output want plain JSON, and a BigInt in either throws.
function plain(rows) {
    return JSON.parse(JSON.stringify(rows, (k, v) => (typeof v === 'bigint' ? Number(v) : v)));
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ---------------------------------------------------------------------------
// Composition: the pure half
//
// Everything below this line is a function of its arguments alone. That is not
// tidiness: a venue this expensive cannot be booted to check whether it wired
// the right database into the right variable, so the wiring is pinned by a unit
// test (test/unit/helpers/attestMirrorVenue.test.js) and only the processes are
// left to the live drill.
// ---------------------------------------------------------------------------

/**
 * Which hub each indexer follows.
 *
 * Spread to the ENDS of the hub list rather than packed at the front, so with
 * two indexers on five hubs they follow hub 0 and hub 4. The dissemination test
 * needs one indexer whose hub is outside the request's responsible set, and the
 * responsible set is a hash ranking over pubkeys: nothing makes hub 0 and hub 1
 * likelier to differ than any other pair, but keeping the followed hubs as far
 * apart as the list allows also keeps them from sharing anything else the venue
 * might later assign by adjacency.
 *
 * Throws rather than returning duplicates: two indexers following ONE hub is a
 * venue that silently cannot ask the question it exists for.
 */
function assignFollowedHubs(hubCount, indexerCount) {
    if (!(hubCount >= 1) || !(indexerCount >= 1)) {
        throw new Error('attestMirrorVenue: hubCount and indexerCount must both be >= 1');
    }
    if (indexerCount > hubCount) {
        throw new Error('attestMirrorVenue: ' + indexerCount + ' indexers cannot each follow a distinct hub ' +
            'when there are only ' + hubCount + ' hubs');
    }
    const out = [];
    for (let i = 0; i < indexerCount; i++) {
        out.push(indexerCount === 1 ? 0 : Math.round((i * (hubCount - 1)) / (indexerCount - 1)));
    }
    if (new Set(out).size !== out.length) {
        throw new Error('attestMirrorVenue: followed-hub assignment collided: ' + out.join(','));
    }
    return out;
}

/**
 * How many ports the venue needs, and what each one is for.
 *
 * Three per hub (HTTP API, P2P listener, and the delay proxy that fronts the
 * P2P listener) plus one per indexer. Named here so the allocation and the
 * partition below cannot disagree about the count.
 */
function portCount(hubCount, indexerCount) {
    return (hubCount * 3) + indexerCount;
}

/**
 * Partition one already-allocated, already-free port list into the venue's four
 * roles.
 *
 * ONE allocation call and a pure partition, rather than four calls from four
 * bases. Separate probes from separate bases can hand back the same port when
 * the bases are close together or the probe races itself, and a hub whose API
 * port equals another hub's P2P port fails at listen time with an EADDRINUSE
 * that reads as a flaky venue rather than as an allocation bug. Partitioning a
 * single distinct list makes the collision unrepresentable.
 */
function planPorts(ports, hubCount, indexerCount) {
    const need = portCount(hubCount, indexerCount);
    if (!Array.isArray(ports) || ports.length < need) {
        throw new Error('attestMirrorVenue: need ' + need + ' ports for ' + hubCount + ' hubs and ' +
            indexerCount + ' indexers, got ' + (Array.isArray(ports) ? ports.length : typeof ports));
    }
    const used = ports.slice(0, need);
    if (new Set(used).size !== used.length) {
        throw new Error('attestMirrorVenue: port allocation handed back duplicates: ' + used.join(','));
    }
    return {
        hubApi:   used.slice(0, hubCount),
        p2p:      used.slice(hubCount, hubCount * 2),
        p2pProxy: used.slice(hubCount * 2, hubCount * 3),
        indexerApi: used.slice(hubCount * 3, hubCount * 3 + indexerCount)
    };
}

/**
 * Refuse a knob combination that makes an acceptance test flaky rather than failing.
 *
 * THE TWO SEAMS INTERACT, and nothing else in the venue notices. `forwardS` and
 * `batchWindowS` are independent regtest overrides turned all the way down so a drill
 * closes in seconds, and turned down far enough they stop describing a system the
 * acceptance ladder can measure. Both rules below are read off the code being driven,
 * not chosen:
 *
 * RULE A, `forwardS` must exceed the gossip hop. The leader stamps
 * `effective_time = now + forwardS` and signs it. A follower has to receive, verify and
 * store that row while the time is still in the future; below the hop the row is already
 * applicable when it arrives, and the follower's bound on the leader's choice is what
 * then rejects it. This is the regtest-scaled form of the protocol's own sizing of the
 * frozen 120 as federation gossip plus stream lag plus hub clock skew.
 *
 * RULE B, and WHICH rule B depends on how the hub keys a window, which is why the keying
 * is read off the hub rather than assumed:
 *
 *   SIGNED KEYING (`effective_time`, the shape shipped today). Every hub holding a row
 *   reads the same signed value, so all five partition the boundary identically and the
 *   straddle rule B guards against cannot happen. What carries the weight instead is not
 *   a second
 *   knob relation but a stronger reading of rule A: a row's effective time is its leader's
 *   clock plus the forward margin, so a row destined for a window is written a whole
 *   forward margin before that window can close. The margin therefore has to cover the hop
 *   twice over, once for the follower's future-time bound and once for the co-signer's
 *   rebuild to hold the same rows the leader's does, and both are already rule A. So there
 *   is NO window-versus-margin constraint under this keying, and asserting one would be
 *   inventing a rule the hub does not have.
 *
 *   WALL-CLOCK KEYING (`finalized_at`, kept because a venue may be pointed at an older
 *   hub). `finalized_at` is per-hub wall clock the schema explicitly allows two hubs to
 *   disagree on, so two stamps for one logical row can straddle a boundary and land it in
 *   different windows. The follower's completeness check forgives exactly that, but only
 *   inside `BOUNDARY_SKEW_S` of the boundary, and that band is CLAMPED TO A QUARTER OF THE
 *   WINDOW. A small window shrinks the band below the hop and an honest window
 *   intermittently loses its quorum. Intermittently is the whole problem: it reads as a
 *   venue defect rather than as a misconfigured knob. Stated in terms of the band rather
 *   than as a ratio between the two knobs, because the band is what the hub computes.
 *
 * @param {number} forwardS       ATTEST_RESPONSE_FORWARD_S_OVERRIDE the venue will set
 * @param {number} batchWindowS   ATTEST_BATCH_WINDOW_S_OVERRIDE the venue will set
 * @param {object} keying         `resolveWindowKeying()`'s verdict for the hub being driven
 * @param {number} [hopBudgetS]   the hop this venue budgets for
 */
function assertTimingInvariants(forwardS, batchWindowS, keying, hopBudgetS = GOSSIP_HOP_BUDGET_S) {
    const f = Number(forwardS), w = Number(batchWindowS), hop = Number(hopBudgetS);
    for (const [name, v] of [['forwardS', f], ['batchWindowS', w], ['hopBudgetS', hop]]) {
        if (!Number.isFinite(v) || v <= 0) {
            throw new Error('attestMirrorVenue: ' + name + ' must be a positive number, got ' + String(v));
        }
    }
    const key = keying && keying.key;
    if (key !== WINDOW_KEY_SIGNED && key !== WINDOW_KEY_WALL_CLOCK) {
        throw new Error('attestMirrorVenue: window keying must be the verdict of ' +
            'resolveWindowKeying(), got ' + JSON.stringify(keying));
    }

    if (!(f > hop)) {
        throw new Error('attestMirrorVenue: refusing to boot. The forward margin ' +
            'ATTEST_RESPONSE_FORWARD_S_OVERRIDE=' + f + 's does not exceed the ' + hop +
            's gossip hop this venue budgets for, so a follower can receive a mirror row whose ' +
            'signed effective time has already passed and reject it' +
            (key === WINDOW_KEY_SIGNED
                ? ', and a co-signer can rebuild a closing window without a row the leader ' +
                  'already holds. Under ' + WINDOW_KEY_SIGNED + ' keying the margin is the only ' +
                  'thing standing between the drill and both faults'
                : '') +
            '. Wanted forwardS > ' + hop + '; raise the margin or lower the hop budget deliberately.');
    }

    // The straddle only exists under wall-clock keying. Under the signed key the rows a
    // window holds are the same on every hub by construction, so there is no band to size.
    if (key === WINDOW_KEY_WALL_CLOCK) {
        const skew = Number(keying.boundarySkewS);
        if (!Number.isFinite(skew) || skew <= 0) {
            throw new Error('attestMirrorVenue: boundarySkewS must be a positive number under ' +
                WINDOW_KEY_WALL_CLOCK + ' keying, got ' + String(keying.boundarySkewS));
        }
        // The hub's own clamp, recomputed here rather than assumed, so this stays true if the
        // hub changes how it narrows the band.
        const band = Math.min(skew, Math.floor(w / 4));
        if (!(band >= hop)) {
            throw new Error('attestMirrorVenue: refusing to boot. With ' +
                'ATTEST_BATCH_WINDOW_S_OVERRIDE=' + w + 's the batch completeness band is ' +
                'min(BOUNDARY_SKEW_S ' + skew + ', floor(' + w + '/4) = ' + Math.floor(w / 4) + ') = ' +
                band + 's, which is under the ' + hop + 's gossip hop, so two hubs stamping one row ' +
                'either side of a window boundary will intermittently cost an honest window its ' +
                'quorum and redden the batch drill at random. Wanted a band >= ' + hop +
                ', i.e. batchWindowS >= ' + (4 * hop) + 's at this BOUNDARY_SKEW_S ' +
                '(forwardS is ' + f + 's).');
        }
    }
}

/**
 * How the hub being driven keys a batch window, or a refusal saying the invariant no
 * longer describes it.
 *
 * READ FROM THE HUB, never assumed, because a venue outlives the hub it was written
 * against: one keyed on `finalized_at`, the next on the signed `effective_time`, and a
 * guard pinned to either spelling refuses to boot on the other for want of a constant
 * that belongs to only one of them. Absence of `BOUNDARY_SKEW_S` is therefore not by
 * itself the signal, and neither is its presence: the window read is, so the verdict comes from the
 * column `_selectWindowRows` actually filters on and the band is only collected once that
 * read says wall clock.
 *
 * Refused rather than defaulted when neither shape is recognizable. A third keying would
 * run the drill under an invariant checked against nothing, which is worse than the flake
 * the invariant exists to prevent.
 */
function resolveWindowKeying() {
    return resolveWindowKeyingFrom(loadHubModule('src/AttestationBatchPublisher.js'));
}

/**
 * Refuse an llm drill on a box that cannot serve one, and SAY WHICH HALF is missing.
 *
 * The llm provider needs two independent things and they live in different places, so a
 * box can have exactly one of them and look broken in the other's direction:
 *
 *   - a credential directory, which the hub reads through `HUB_CLAUDE_CONFIG_DIR`;
 *   - the `claude` binary, on the PATH THE HUBS WILL ACTUALLY RECEIVE.
 *
 * The PATH clause is the subtle half. A hub child inherits the harness's
 * `process.env.PATH`, and for a non-interactive shell that is not the PATH a human sees,
 * so a binary that runs fine when typed by hand can be absent from every hub in the
 * federation. Probing an interactive PATH would pass here and fail in the children.
 *
 * NAMING THE MISSING HALF is the point of this function rather than a nicety. A bare
 * "llm unavailable" sends the reader hunting for credentials when the answer is a PATH,
 * which is the wrong direction and has already cost this train time.
 *
 * PURE, with both probes injected, so a refusal can be driven for a box this run is not
 * on and neither branch depends on the machine the suite happens to execute on.
 *
 * @param {object} spec   `{claudeConfigDir, pathEnv}` exactly as the hubs will receive them
 * @param {object} probes `{dirExists(path), isExecutable(path)}`
 */
function assertLlmAvailable(spec, probes) {
    const dir     = spec && spec.claudeConfigDir;
    const pathEnv = String((spec && spec.pathEnv) || '');
    const missing = [];

    if (!dir) {
        missing.push('no credential directory is configured: the drill declares it needs the llm ' +
            'provider but nothing set HUB_CLAUDE_CONFIG_DIR, and this venue deliberately will not ' +
            "fall back to an interactive CLAUDE_CONFIG_DIR, because borrowing a human's store is " +
            'the thing to avoid');
    } else if (!probes.dirExists(dir)) {
        missing.push('the credential directory ' + dir + ' does not exist ON THIS BOX. The harness ' +
            'environment is shared across boxes, so a path configured for one of them reads as ' +
            'correct in a place where it is not');
    }

    // Every PATH entry, in order, exactly as a child would resolve it.
    const entries = pathEnv.split(':').filter((p) => p.length > 0);
    if (!entries.some((p) => probes.isExecutable(p.replace(/\/+$/, '') + '/claude'))) {
        missing.push('the `claude` binary is not executable on the PATH THE HUBS WILL RECEIVE (' +
            (entries.length ? entries.join(':') : '<empty>') + '). An interactive shell may well ' +
            'resolve it; a hub child inherits this PATH and will not');
    }

    if (missing.length === 0) return;
    throw new Error('attestMirrorVenue: refusing to boot an llm drill. ' + missing.length +
        ' of the 2 halves the llm provider needs ' + (missing.length === 1 ? 'is' : 'are') +
        ' missing here:\n  - ' + missing.join('\n  - ') +
        '\nRun this drill on a box that has BOTH, or extend the PATH the harness passes to its ' +
        'children. Do not copy credentials to make it work somewhere else.');
}

/**
 * The decision itself, over a publisher module rather than over a checkout.
 *
 * Split out so both keyings and both refusals are directly assertable: the venue resolves
 * exactly one hub, so a guard that could only call `resolveWindowKeying()` would be able
 * to test whichever shape that checkout happens to have and nothing else.
 *
 * @param {Function} pub  the hub's `AttestationBatchPublisher` module export
 */
function resolveWindowKeyingFrom(pub) {
    const select = pub && pub.prototype && pub.prototype._selectWindowRows;
    const src    = typeof select === 'function' ? String(select) : '';
    const onSigned = /effective_time\s*>=\s*\?/.test(src);
    const onWall   = /finalized_at\s*>=\s*\?/.test(src);

    if (onSigned && !onWall) return { key: WINDOW_KEY_SIGNED, boundarySkewS: null };

    if (onWall && !onSigned) {
        const skew = Number(pub && pub.BOUNDARY_SKEW_S);
        if (!Number.isFinite(skew) || skew <= 0) {
            throw new Error('attestMirrorVenue: refusing to boot. The hub this venue resolves ' +
                'keys its batch window on finalized_at but exports no positive BOUNDARY_SKEW_S ' +
                '(got ' + String(pub && pub.BOUNDARY_SKEW_S) + '), so the completeness band this ' +
                'venue has to size against cannot be read. Re-derive the invariant against that ' +
                'hub, or point XCHAIN_HUB_PATH at the hub revision this venue is meant to drive.');
        }
        return { key: WINDOW_KEY_WALL_CLOCK, boundarySkewS: skew };
    }

    throw new Error('attestMirrorVenue: refusing to boot. The hub this venue resolves keys its ' +
        'batch window on neither effective_time alone nor finalized_at alone (' +
        (select ? 'its _selectWindowRows matches ' + (onSigned && onWall ? 'both' : 'neither') :
            'it exposes no _selectWindowRows') + '), so this venue\'s window invariant no longer ' +
        'describes it. Re-derive the invariant against that hub, or point XCHAIN_HUB_PATH at the ' +
        'hub revision this venue is meant to drive.');
}

/**
 * The environment one hub child is launched with.
 *
 * PURE, and every value that could carry a credential arrives as an argument
 * rather than being read here, so this function can be driven in a unit test
 * without a database and without ever holding a real secret.
 *
 * Three things in here are load-bearing and not obvious:
 *
 *   - `SIGNING_PRIVKEY_SECRET`, not `SIGNING_PRIVKEY_HEX`. Both names resolve
 *     (`xchain-hub/src/secret-env.js`), but the `_SECRET` spelling is the one an
 *     operator's redaction filter catches, and setting BOTH to different values
 *     is a hard error in the hub, so only one is set.
 *   - `HUB_API_KEY` is deliberately ABSENT. The `/hub-db/snapshot` middleware
 *     passes every request through when no key is configured, which is the
 *     posture the venue wants; setting a key would additionally require the
 *     indexers to carry it and buys the drill nothing. Keyless operation in
 *     validator mode must be DECLARED, hence `HUB_ALLOW_UNAUTHENTICATED`, or the
 *     hub refuses to boot.
 *   - `P2P_VALIDATOR_ADDR` and every peer address name the DELAY PROXY's port,
 *     not the hub's own P2P port. See P2pDelayProxy for why the proxy is always
 *     in the path even when its delay is zero.
 */
function buildHubEnv(spec) {
    const s = spec || {};
    for (const key of ['dbName', 'apiPort', 'p2pPort', 'proxyPort', 'privkeyHex', 'network', 'db']) {
        if (s[key] === undefined || s[key] === null || s[key] === '') {
            throw new Error('attestMirrorVenue.buildHubEnv: missing required field ' + key);
        }
    }
    const env = {
        PATH: s.path || '',
        HOME: s.home || '',

        HUB_DB_HOST:   String(s.db.host),
        HUB_DB_PORT:   String(s.db.port),
        HUB_DB_NAME:   String(s.dbName),
        HUB_DB_USER:   String(s.db.user),
        HUB_DB_SECRET: String(s.db.pass),

        HUB_PORT:    String(s.apiPort),
        HUB_HOST:    '127.0.0.1',
        HUB_NETWORK: String(s.network),
        HUB_ALLOW_UNAUTHENTICATED: 'true',
        TELEMETRY_ENABLED: 'false',
        CORS_ORIGIN: 'http://localhost',

        P2P_PORT:            String(s.p2pPort),
        P2P_HOST:            '127.0.0.1',
        // The address peers dial, and the address this hub is registered under:
        // the proxy, so a delay injected there covers every connection that
        // terminates at this hub.
        P2P_VALIDATOR_ADDR:  '127.0.0.1:' + s.proxyPort,
        SEED_NODES:          (s.seedNodes || []).join(','),
        SIGNING_PRIVKEY_SECRET: String(s.privkeyHex),
        REQUIRE_SIGNATURES:  'true',
        P2P_HEARTBEAT_INTERVAL: '15000',
        P2P_RECONNECT_BASE: '2000',
        P2P_RECONNECT_MAX:  '60000',
        P2P_MSG_DEDUP_TTL:  '60000',
        P2P_MAX_PAYLOAD:    '1048576',
        // Every validator here shares 127.0.0.1, so the production per-IP cap of
        // 3 starves the mesh at N > 4 (the symptom is one signature and no
        // quorum, never a connection error). Same default MultiValidatorHub bakes.
        P2P_MAX_CONNECTIONS_PER_IP: String(s.maxConnectionsPerIp || Math.max(64, (s.hubCount || DEFAULT_HUB_COUNT) * 4)),

        // Required in validator mode; all hubs must share the value or their
        // oracle round numbering diverges.
        ORACLE_EPOCH_START: String(s.oracleEpochStart),

        // The chain's own BTC indexer: where the hubs read pending requests, the
        // stake behind each pubkey, and the capability snapshot a responsible set
        // is resolved from. Attestation stake is Bitcoin-only, so a hub with no
        // Bitcoin view resolves no responsible set at all.
        BTC_INDEXER_API_URL: String(s.btcIndexerApiUrl || ''),

        // Per-capability MIN_STAKE. A hub whose capability registry is live but
        // empty refuses to build a snapshot at all, by design, so this is
        // ordinary node configuration rather than a test lever.
        HUB_CAPABILITY_CONFIG: String(s.capabilityConfigPath || ''),

        // The regtest-only forward margin (see DEFAULT_FORWARD_S). The hub
        // refuses this key off regtest and THROWS on a non-integer on regtest, so
        // a typo fails loudly at boot rather than producing rows no verifier can
        // rebuild.
        ATTEST_RESPONSE_FORWARD_S_OVERRIDE: String(s.forwardS),

        // The batch cadence seam, on the same regtest-only pattern. Passed
        // through by xchain-node today; the hub gains its reader with the batch
        // publisher, so setting it here is forward wiring and inert until then.
        ATTEST_BATCH_WINDOW_S_OVERRIDE: String(s.batchWindowS)
    };
    if (s.btcIndexerApiKey) env.BTC_INDEXER_API_KEY = String(s.btcIndexerApiKey);
    // EXPLICIT ONLY, and never defaulted from an interactive CLAUDE_CONFIG_DIR: the llm
    // provider reads a real credential store, and a hub that silently picked up whichever
    // one the operator happened to be logged into would be borrowing a human's.
    if (s.claudeConfigDir) env.HUB_CLAUDE_CONFIG_DIR = String(s.claudeConfigDir);
    if (s.extraEnv) Object.assign(env, s.extraEnv);
    return env;
}

/**
 * The environment one indexer child is launched with.
 *
 * PURE, same contract as buildHubEnv.
 *
 * The three databases are three different things and conflating any two is the
 * classic mirror bug:
 *   INDEXER_DB_*  this node's own ledger, which it creates and owns;
 *   DECODER_DB_*  the chain in parsed form, borrowed read-only from the stack;
 *   HUB_DB_*      this node's local MIRROR, which hub_db_sync owns and re-pages
 *                 from the hub on every bootstrap. Pointing it at the hub's own
 *                 authoritative database would put the hub's rows under a
 *                 replication client that deletes and re-pages them.
 *
 * `HUB_API_URL` names WHICH hub this indexer follows, and it is the only thing
 * that makes two indexers on one federation see the mirror through two different
 * eyes.
 */
function buildIndexerEnv(spec) {
    const s = spec || {};
    for (const key of ['coin', 'network', 'apiPort', 'indexerDbName', 'mirrorDbName', 'hubApiUrl', 'db', 'decoder']) {
        if (s[key] === undefined || s[key] === null || s[key] === '') {
            throw new Error('attestMirrorVenue.buildIndexerEnv: missing required field ' + key);
        }
    }
    const graces = s.graces || {};
    const g = (v) => String(v === undefined || v === null ? DEFAULT_GRACE_S : v);
    const node    = s.node    || {};
    const tracker = s.tracker || {};
    const env = {
        PATH: s.path || '',
        HOME: s.home || '',

        INDEXER_COIN:     String(s.coin),
        INDEXER_NETWORK:  String(s.network),
        INDEXER_API_PORT: String(s.apiPort),
        INDEXER_ALLOW_UNAUTHENTICATED: 'true',

        DECODER_DB_HOST: String(s.decoder.host),
        DECODER_DB_PORT: String(s.decoder.port),
        DECODER_DB_NAME: String(s.decoder.name),
        DECODER_DB_USER: String(s.decoder.user),
        DECODER_DB_PASS: String(s.decoder.pass),

        INDEXER_DB_HOST: String(s.db.host),
        INDEXER_DB_PORT: String(s.db.port),
        INDEXER_DB_NAME: String(s.indexerDbName),
        INDEXER_DB_USER: String(s.db.user),
        INDEXER_DB_PASS: String(s.db.pass),

        HUB_DB_HOST: String(s.db.host),
        HUB_DB_PORT: String(s.db.port),
        HUB_DB_NAME: String(s.mirrorDbName),
        HUB_DB_USER: String(s.db.user),
        HUB_DB_PASS: String(s.db.pass),
        HUB_DB_SYNC_ENABLED: 'true',
        HUB_API_URL: String(s.hubApiUrl),

        // Carried for parity with the replay rig, which sets them. Measured
        // 2026-09-03: no file under xchain-indexer/src reads any of the four; the
        // indexer reaches the chain through the decoder database and the tracker,
        // never through the coin node's RPC.
        NODE_URL:      String(node.host || '127.0.0.1'),
        NODE_PORT:     String(node.port || ''),
        NODE_USER:     String(node.user || ''),
        NODE_PASSWORD: String(node.pass || ''),

        UTXO_TRACKER_URL:      String(tracker.host || ''),
        UTXO_TRACKER_API_PORT: String(tracker.port || ''),

        // The mirror barriers, EVERY ONE OF THEM, generated from the indexer's own
        // grace table rather than listed here. Honoured on regtest only and ignored
        // with a loud warning elsewhere (`resolveWatermarkGrace`), so they cannot
        // travel to a real network.
        //
        // ALL OR NOTHING IS THE WHOLE POINT. The barriers sit in sequence in one block
        // loop, so the FIRST one whose grace is not turned down parks the block and the
        // ones after it are never reached. Turning down three of six left the block
        // parked on `anchor_attest_barrier` at its frozen 120s, which on a chain stamped
        // at about wall clock is never satisfiable, and made the attest-response barrier
        // this venue exists to drive permanently unobservable. Generating the set means a
        // seventh barrier cannot be silently missed the same way.
        ...graceEnv(graces),

        // The push outbox's default first retry is 30s, which on a venue driving
        // a response in seconds is the difference between a mirror that keeps up
        // with the block loop and one that does not.
        HUB_PUSH_RETRY_INTERVAL_MS: '2000',
        HUB_PUSH_RETRY_BASE_MS:     '2000',
        HUB_DB_SYNC_POLL_INTERVAL:  '5000',

        CORS_ORIGIN: 'http://localhost'
    };
    if (s.feeDestination) {
        env['XCHAIN_FEE_DESTINATION_' + String(s.coin) + '_' + String(s.network).toUpperCase()] = String(s.feeDestination);
        env.FEE_DESTINATION = String(s.feeDestination);
    }
    if (s.indexerApiKey) env.INDEXER_API_KEY = String(s.indexerApiKey);
    if (s.extraEnv) Object.assign(env, s.extraEnv);
    return env;
}

/**
 * The indexer whose followed hub is OUTSIDE a request's responsible set.
 *
 * This is the dissemination test's whole premise: a hub that never ran the round
 * can only have learned the response from `ATTEST_RESULT` gossip, so an indexer
 * following it reaching the identical applied state is the proof that the mirror
 * carries the result rather than the round doing so.
 *
 * Pubkey comparison is case-insensitive because the responsible set arrives in
 * three spellings across this codebase (the hub's registration, the ranking's
 * lower-cased form, and a mirror row's `signer_pubkeys`), and a case mismatch
 * would silently report every indexer as outside the set, which is the failure
 * mode that makes a dissemination test pass without testing anything.
 *
 * Throws when every indexer is inside: that is a venue the test cannot be run
 * on, and returning null would let the caller quietly skip its own assertion.
 */
function pickOutsideIndexer(indexers, responsiblePubkeys) {
    const inSet = new Set((responsiblePubkeys || []).map((p) => String(p).toLowerCase()));
    if (inSet.size === 0) {
        throw new Error('attestMirrorVenue: an empty responsible set cannot place any indexer outside it');
    }
    const outside = (indexers || []).filter((ix) => !inSet.has(String(ix && ix.hubPubkey).toLowerCase()));
    if (outside.length === 0) {
        throw new Error('attestMirrorVenue: every indexer follows a hub inside the responsible set (' +
            (indexers || []).map((ix) => String(ix.hubPubkey).slice(0, 16)).join(', ') +
            '); the dissemination leg cannot be driven on this request');
    }
    return outside[0];
}

// ---------------------------------------------------------------------------
// The P2P delay proxy
// ---------------------------------------------------------------------------

/**
 * A byte-level TCP relay in front of one hub's P2P listener, with a settable
 * per-chunk delay.
 *
 * WHY A PROXY RATHER THAN AN ENV KNOB OR A SIGNAL. Three options were available
 * and only this one delays the right thing:
 *
 *   - An env knob the hub already honours: there is none. The gossip send is an
 *     unconditional `peerManager.broadcast('ATTEST_RESULT', ...)` with no delay,
 *     jitter or hold seam anywhere on the path, and inventing one would put a
 *     test lever inside a consensus engine.
 *   - SIGSTOP on the hub process: it works, and it is kept below as
 *     `freezeHub`, but it freezes the hub's HTTP surface too. An indexer
 *     following a frozen hub then stops receiving the mirror STREAM as well as
 *     the gossip, so its barrier would hold for the wrong reason and the
 *     assertion would pass without demonstrating anything about the forward
 *     margin.
 *   - This proxy: it delays only the P2P bytes. The hub keeps serving
 *     `/hub-db/*`, its followed indexer keeps its mirror stream, and the ONLY
 *     thing running late is the gossiped row.
 *
 * P2P messages are signed at the application layer, so a pass-through relay
 * changes nothing a verifier can see; the delay is indistinguishable from a slow
 * link, which is what it is modelling.
 *
 * ORDER IS PRESERVED. Each direction chains its chunks onto the previous one's
 * timer rather than scheduling them independently, so a delay change mid-stream
 * cannot reorder a WebSocket frame into gibberish.
 *
 * SCOPE, stated exactly: the proxy fronts hub i's LISTENER, so it holds every
 * byte on a connection a peer dialled INTO hub i. A connection hub i dialled out
 * on terminates at another hub's proxy and is held by that one instead. Pass
 * `inboundOnlyHubs: [i]` to start() to give hub i no seed nodes at all, which
 * makes every connection it has inbound and the delay therefore total.
 */
class P2pDelayProxy {

    constructor(listenPort, targetPort, label) {
        this.listenPort = listenPort;
        this.targetPort = targetPort;
        this.label      = label || ('p2p:' + listenPort);
        this.delayMs    = 0;
        this._server    = null;
        this._sockets   = new Set();
    }

    async start() {
        await new Promise((resolve, reject) => {
            this._server = net.createServer((client) => this._wire(client));
            this._server.once('error', reject);
            this._server.listen(this.listenPort, '127.0.0.1', () => {
                this._server.removeListener('error', reject);
                resolve();
            });
        });
    }

    setDelay(ms) {
        const v = Number(ms);
        if (!Number.isFinite(v) || v < 0) throw new Error('attestMirrorVenue: delay must be a non-negative number of ms');
        this.delayMs = v;
    }

    _wire(client) {
        const upstream = net.connect(this.targetPort, '127.0.0.1');
        this._sockets.add(client);
        this._sockets.add(upstream);
        const drop = () => {
            for (const s of [client, upstream]) {
                this._sockets.delete(s);
                try { s.destroy(); } catch (_) { /* already gone */ }
            }
        };
        this._relay(client, upstream, drop);
        this._relay(upstream, client, drop);
        client.on('error', drop);
        upstream.on('error', drop);
    }

    _relay(from, to, drop) {
        let chain = Promise.resolve();
        from.on('data', (chunk) => {
            const held = this.delayMs;
            chain = chain.then(async () => {
                if (held > 0) await sleep(held);
                if (!to.destroyed) to.write(chunk);
            });
        });
        // The close is chained too: closing the far side ahead of the bytes still
        // held would silently drop exactly the traffic the delay is modelling.
        from.on('end', () => { chain = chain.then(() => { try { to.end(); } catch (_) { drop(); } }); });
        from.on('close', () => { chain = chain.then(drop); });
    }

    async stop() {
        for (const s of this._sockets) { try { s.destroy(); } catch (_) { /* already gone */ } }
        this._sockets.clear();
        if (this._server) {
            await new Promise((resolve) => this._server.close(resolve));
            this._server = null;
        }
    }
}

// ---------------------------------------------------------------------------
// The hub-DB mirror proxy: a per-table, per-edge withhold and delay
// ---------------------------------------------------------------------------

/**
 * WHY THIS EXISTS, and why nothing coarser will do. Operator ruling 2026-09-04.
 *
 * The mirror barriers sit in SEQUENCE in one block loop and every one of them
 * reads the SAME global stream watermark, differing only in the grace it adds. So
 * stopping a hub starves all of them at once and the earliest in the loop,
 * `anchor_attest_barrier`, reports first: `attest_response_sync_barrier` can never
 * be the observed stall class that way, which is precisely why AT0's last clause
 * could not be driven. What is needed instead is a fault that starves ONE TABLE of
 * ONE indexer's mirror while leaving every other table, every other barrier and
 * every other hub untouched.
 *
 * WHERE IT HAS TO SIT. An indexer reaches its hub's mirror through exactly one
 * coordinate, `HUB_API_URL`: the snapshot route is `<hubUrl>/hub-db/snapshot/<table>`
 * and the live stream is `ws://<host>/hub-db/subscribe` derived from the same value
 * (`xchain-indexer/src/hub_db_sync.js`). One proxy in front of that value therefore
 * governs the whole mirror for one indexer, and pointing only that indexer at it is
 * what makes the fault per-edge rather than per-hub: indexer 0's feed of hub 2 can
 * be starved while indexer 1 reads the same hub normally.
 *
 * WHAT IT MUST NOT TOUCH, stated because conflating these is how a test proves the
 * wrong thing. It does not touch the hub's own database writes, and it does not
 * touch P2P gossip. A hub behind this proxy still reaches quorum, still writes its
 * row and still gossips it to its peers; only what the mirror SERVES to one
 * follower changes. Delaying gossip specifically is a different lever and it is
 * `P2pDelayProxy` above.
 *
 * THE TWO FIELDS IT ALWAYS PASSES THROUGH are what make this surgical rather than
 * blunt, and they were measured before this was written:
 *   - `watermark`: the bootstrap takes each table's mark from the last page it
 *     fetches and advances the global stream watermark to the MINIMUM across every
 *     table, after which live advancement rides the hub's heartbeat, gated on the
 *     bootstrap having drained. Suppress the watermark and every barrier starves,
 *     which is the blunt failure this exists to avoid.
 *   - `schema_version`: a mismatch parks the WHOLE mirror by design, and an absent
 *     value would read as an older hub.
 * An empty `rows` array with both fields intact is a legitimate, fully drained
 * "nothing new for you" answer, so the mirror stays live and every other barrier
 * stays satisfied while the withheld table alone starves.
 *
 * COMPRESSION IS REFUSED ON PURPOSE. The proxy strips `Sec-WebSocket-Extensions`
 * from the upgrade request, so the hub cannot negotiate permessage-deflate and
 * every server frame arrives as readable text. Without that the frames would be
 * compressed and the table name unreadable, and the alternative was taking a new
 * WebSocket dependency into this repo for a test lever.
 */

// Filter modes. `withhold` suppresses indefinitely; `delay` releases each row a
// fixed time after the proxy first saw it.
const MIRROR_WITHHOLD = 'withhold';
const MIRROR_DELAY    = 'delay';

// Verdicts for one row or one stream event.
const MIRROR_PASS = 'pass';
const MIRROR_DROP = 'drop';
const MIRROR_HOLD = 'hold';

/**
 * The table a hub-DB snapshot request is asking for, or null for any other path.
 *
 * Deliberately strict about the prefix: the proxy must not filter a path that
 * merely contains the words, and it must leave `/hub-db/subscribe` alone (that is
 * the socket, handled on the upgrade).
 */
function snapshotTableOf(reqUrl) {
    const p = String(reqUrl || '').split('?')[0];
    const m = /^\/hub-db\/snapshot\/([A-Za-z0-9_]+)$/.exec(p);
    return m ? m[1] : null;
}

/**
 * What happens to one row or one row event of a filtered table.
 *
 * PURE, and the only place the two modes are interpreted, so the REST half and
 * the WebSocket half of this proxy can never disagree about what a filter means.
 *
 * @param {object|null} filter       `{mode, delayMs}` or null for unfiltered
 * @param {number}      firstSeenMs  when this proxy first observed the row
 * @param {number}      nowMs        now
 * @returns {'pass'|'drop'|'hold'}
 */
function mirrorFilterVerdict(filter, firstSeenMs, nowMs) {
    if (!filter) return MIRROR_PASS;
    if (filter.mode === MIRROR_WITHHOLD) return MIRROR_DROP;
    if (filter.mode === MIRROR_DELAY) {
        // Refused BY NAME before Number(), which turns null and '' into 0: a row whose
        // first-seen is unknown would otherwise look infinitely old and be served
        // immediately, which is a fault injector failing OPEN. Holding is the safe
        // direction, because a held row shows up as an unmet condition rather than as
        // a barrier that silently never fired.
        const unreadable = (v) => v === null || v === undefined || v === '' || typeof v === 'boolean';
        if (unreadable(firstSeenMs) || unreadable(filter.delayMs)) return MIRROR_HOLD;
        const first = Number(firstSeenMs);
        const delay = Number(filter.delayMs);
        if (!Number.isFinite(first) || !Number.isFinite(delay)) return MIRROR_HOLD;
        return (Number(nowMs) - first >= delay) ? MIRROR_PASS : MIRROR_HOLD;
    }
    throw new Error('attestMirrorVenue: unknown mirror filter mode ' + JSON.stringify(filter && filter.mode));
}

/**
 * A snapshot response body with the filtered table's rows removed.
 *
 * Returns a NEW object; `watermark`, `schema_version` and `table` are carried over
 * verbatim for the reasons in the header, and `count` is corrected to what is
 * actually being served so the body stays internally consistent.
 *
 * `seen` is the proxy's first-seen ledger, keyed by row id, and is updated here
 * because the REST path is usually where a row is observed first.
 */
function filterSnapshotBody(body, table, filter, seen, nowMs) {
    if (!body || !Array.isArray(body.rows) || !filter) return { body: body, held: 0 };
    const kept = [];
    let held = 0;
    for (const row of body.rows) {
        const key = table + ':' + String(row && row.id);
        if (!seen.has(key)) seen.set(key, nowMs);
        const verdict = mirrorFilterVerdict(filter, seen.get(key), nowMs);
        if (verdict === MIRROR_PASS) kept.push(row);
        else held++;
    }
    const out = Object.assign({}, body);
    out.rows  = kept;
    out.count = kept.length;
    return { body: out, held: held };
}

/**
 * Read whole server-to-client WebSocket frames out of a buffer.
 *
 * PURE. Returns the frames it could delimit and whatever tail bytes remain, so a
 * caller can carry the tail into the next chunk. Server frames are unmasked by
 * protocol, so nothing here needs to unmask; and because the proxy forwards the
 * ORIGINAL bytes rather than re-encoding, a frame it does not understand is
 * forwarded intact instead of being mangled.
 *
 * `text` is the decoded payload only for a complete, unfragmented text frame,
 * which is the only shape this proxy filters. Everything else is `opaque`.
 */
function readServerFrames(buf) {
    const frames = [];
    let off = 0;
    while (off + 2 <= buf.length) {
        const b0 = buf[off];
        const b1 = buf[off + 1];
        const fin    = (b0 & 0x80) !== 0;
        const opcode = b0 & 0x0f;
        const masked = (b1 & 0x80) !== 0;
        let len = b1 & 0x7f;
        let headerLen = 2;
        if (len === 126) {
            if (off + 4 > buf.length) break;
            len = buf.readUInt16BE(off + 2);
            headerLen = 4;
        } else if (len === 127) {
            if (off + 10 > buf.length) break;
            const big = buf.readBigUInt64BE(off + 2);
            // A frame this large is not something the hub's broadcaster produces; refuse
            // to buffer it rather than allocating against a wire value.
            if (big > BigInt(64 * 1024 * 1024)) return { frames: frames, rest: buf.subarray(off), overlong: true };
            len = Number(big);
            headerLen = 10;
        }
        if (masked) headerLen += 4;
        const total = headerLen + len;
        if (off + total > buf.length) break;
        const bytes = buf.subarray(off, off + total);
        let text = null;
        if (fin && opcode === 0x1 && !masked) {
            text = bytes.subarray(headerLen).toString('utf8');
        }
        frames.push({ bytes: bytes, opcode: opcode, fin: fin, text: text, opaque: text === null });
        off += total;
    }
    return { frames: frames, rest: buf.subarray(off) };
}

/**
 * The table one stream frame concerns, or null when the frame is not a row event.
 *
 * `row:inserted` and `row:deleted` are the only frames that carry table data; a
 * `ready` or `watermark` frame must always pass, and returning null here is what
 * guarantees that.
 */
function mirrorFrameTable(text) {
    let event = null;
    try { event = JSON.parse(text); } catch (_) { return null; }
    if (!event || (event.type !== 'row:inserted' && event.type !== 'row:deleted')) return null;
    return event.table ? String(event.table) : null;
}

/**
 * An HTTP-plus-WebSocket proxy in front of one hub's API port, with a per-table
 * withhold and delay on the hub-DB mirror.
 *
 * Explicit only: with no filter armed it is a transparent relay, and it must be
 * asked for a table by name. Releasable mid-run, because a wedge test has to show
 * the indexer RESUMING and converging with its peer, not merely stalling.
 */
class HubDbMirrorProxy {

    constructor(listenPort, targetPort, label) {
        this.listenPort = listenPort;
        this.targetPort = targetPort;
        this.label      = label || 'mirror-proxy';
        this.filters    = new Map();   // table -> {mode, delayMs}
        this.seen       = new Map();   // 'table:id' -> first-seen ms
        this.stats      = { snapshotRowsHeld: 0, framesDropped: 0, framesHeld: 0, opaqueFrames: 0 };
        this._server    = null;
        this._sockets   = new Set();
        this._timers    = new Set();
    }

    async start() {
        this._server = http.createServer((req, res) => this._proxyHttp(req, res));
        this._server.on('upgrade', (req, socket) => this._proxyUpgrade(req, socket));
        await new Promise((resolve, reject) => {
            this._server.once('error', reject);
            this._server.listen(this.listenPort, '127.0.0.1', () => {
                this._server.removeListener('error', reject);
                resolve();
            });
        });
    }

    get url() { return 'http://127.0.0.1:' + this.listenPort; }

    // ---- the levers -----------------------------------------------------

    /** Serve nothing for `table`, on this edge only, until released. */
    withholdTable(table) {
        this.filters.set(String(table), { mode: MIRROR_WITHHOLD });
    }

    /** Hold every row of `table` for `ms` past when the proxy first saw it. */
    delayTable(table, ms) {
        const delayMs = Number(ms);
        if (!Number.isFinite(delayMs) || delayMs < 0) {
            throw new Error('attestMirrorVenue: a mirror delay must be a non-negative number of ms');
        }
        this.filters.set(String(table), { mode: MIRROR_DELAY, delayMs: delayMs });
    }

    /**
     * Stop filtering `table`.
     *
     * RECONNECT IS THE DEFAULT AND IT MATTERS. Rows withheld from the live stream
     * are gone from it: the hub does not resend them, so releasing alone would
     * leave this indexer permanently missing the row and diverging, which is a
     * fault the test injected rather than one it found. Dropping the socket makes
     * the indexer's own reconnect path re-run the bootstrap, and
     * `attestation_responses` is a FULL_REPAGE table whose drain re-pages from
     * id 0, so the withheld rows arrive through the node's ordinary recovery.
     */
    releaseTable(table, opts) {
        const o = opts || {};
        this.filters.delete(String(table));
        if (o.reconnect !== false) this.dropSockets();
    }

    releaseAll(opts) {
        this.filters.clear();
        if (!opts || opts.reconnect !== false) this.dropSockets();
    }

    /** Cut every proxied connection, so the client reconnects and re-bootstraps. */
    dropSockets() {
        for (const s of this._sockets) { try { s.destroy(); } catch (_) { /* already gone */ } }
        this._sockets.clear();
    }

    // ---- plumbing -------------------------------------------------------

    _proxyHttp(req, res) {
        const table  = snapshotTableOf(req.url);
        const filter = table ? this.filters.get(table) : null;
        const headers = Object.assign({}, req.headers);
        headers.host = '127.0.0.1:' + this.targetPort;
        // Identity encoding, so a filtered body is readable rather than compressed.
        headers['accept-encoding'] = 'identity';

        const upstream = http.request({
            host: '127.0.0.1', port: this.targetPort, method: req.method,
            path: req.url, headers: headers,
        }, (up) => {
            const chunks = [];
            up.on('data', (c) => chunks.push(c));
            up.on('end', () => {
                const raw = Buffer.concat(chunks);
                if (!filter || up.statusCode !== 200) {
                    res.writeHead(up.statusCode, this._forwardableHeaders(up.headers));
                    return res.end(raw);
                }
                let parsed = null;
                try { parsed = JSON.parse(raw.toString('utf8')); } catch (_) { parsed = null; }
                if (!parsed) {
                    res.writeHead(up.statusCode, this._forwardableHeaders(up.headers));
                    return res.end(raw);
                }
                const filtered = filterSnapshotBody(parsed, table, filter, this.seen, Date.now());
                this.stats.snapshotRowsHeld += filtered.held;
                const body = Buffer.from(JSON.stringify(filtered.body), 'utf8');
                const out = this._forwardableHeaders(up.headers);
                out['content-length'] = String(body.length);
                res.writeHead(up.statusCode, out);
                res.end(body);
            });
        });
        upstream.on('error', () => { try { res.destroy(); } catch (_) { /* client gone */ } });
        req.pipe(upstream);
    }

    // Content-length is recomputed for a filtered body and transfer-encoding cannot
    // survive a buffered rewrite, so both are dropped here and set deliberately.
    _forwardableHeaders(headers) {
        const out = {};
        for (const [k, v] of Object.entries(headers || {})) {
            const key = k.toLowerCase();
            if (key === 'content-length' || key === 'transfer-encoding' || key === 'content-encoding') continue;
            out[key] = v;
        }
        return out;
    }

    _proxyUpgrade(req, socket) {
        const upstream = net.connect(this.targetPort, '127.0.0.1');
        this._sockets.add(socket);
        this._sockets.add(upstream);

        const lines = [req.method + ' ' + req.url + ' HTTP/1.1'];
        for (const [k, v] of Object.entries(req.headers)) {
            // See the header: refusing the extension negotiation is what keeps every
            // server frame readable, and it is the only header this proxy rewrites.
            if (k.toLowerCase() === 'sec-websocket-extensions') continue;
            if (k.toLowerCase() === 'host') { lines.push('host: 127.0.0.1:' + this.targetPort); continue; }
            lines.push(k + ': ' + v);
        }
        upstream.write(lines.join('\r\n') + '\r\n\r\n');

        // Client to hub is never inspected: those frames are masked, and nothing this
        // proxy models happens in that direction.
        socket.pipe(upstream);

        let handshakeDone = false;
        let buffered = Buffer.alloc(0);
        upstream.on('data', (chunk) => {
            if (!handshakeDone) {
                buffered = Buffer.concat([buffered, chunk]);
                const end = buffered.indexOf('\r\n\r\n');
                if (end === -1) return;
                const head = buffered.subarray(0, end + 4);
                this._write(socket, head);
                buffered = buffered.subarray(end + 4);
                handshakeDone = true;
            } else {
                buffered = Buffer.concat([buffered, chunk]);
            }
            const read = readServerFrames(buffered);
            buffered = read.rest;
            for (const frame of read.frames) this._forwardFrame(socket, frame);
        });

        const close = () => {
            this._sockets.delete(socket);
            this._sockets.delete(upstream);
            try { socket.destroy(); } catch (_) { /* already gone */ }
            try { upstream.destroy(); } catch (_) { /* already gone */ }
        };
        socket.on('error', close);
        socket.on('close', close);
        upstream.on('error', close);
        upstream.on('close', close);
    }

    _forwardFrame(socket, frame) {
        if (frame.opaque) {
            // Fragmented, binary or control: forwarded untouched. Counted so a drill
            // that expected to filter something can tell that it never saw text.
            this.stats.opaqueFrames++;
            return this._write(socket, frame.bytes);
        }
        const table = mirrorFrameTable(frame.text);
        const filter = table ? this.filters.get(table) : null;
        if (!filter) return this._write(socket, frame.bytes);

        // A live event's first-seen is now: this is the moment it would have been
        // served. The REST ledger is shared, so a row already seen there keeps its
        // original clock rather than having it reset by arriving twice.
        const key = table + ':' + this._frameRowId(frame.text);
        if (!this.seen.has(key)) this.seen.set(key, Date.now());
        const verdict = mirrorFilterVerdict(filter, this.seen.get(key), Date.now());

        if (verdict === MIRROR_PASS) return this._write(socket, frame.bytes);
        if (verdict === MIRROR_DROP) { this.stats.framesDropped++; return; }

        this.stats.framesHeld++;
        const waitMs = Math.max(0, Number(filter.delayMs) - (Date.now() - this.seen.get(key)));
        const timer = setTimeout(() => {
            this._timers.delete(timer);
            // Re-checked on release: a withhold armed while this was in flight must
            // still suppress it, and a released filter must let it through.
            const now = this.filters.get(table);
            if (now && now.mode === MIRROR_WITHHOLD) { this.stats.framesDropped++; return; }
            this._write(socket, frame.bytes);
        }, waitMs);
        // Unref'd: a held frame must never keep the mocha process alive.
        if (timer.unref) timer.unref();
        this._timers.add(timer);
    }

    _frameRowId(text) {
        try {
            const event = JSON.parse(text);
            const row = event && event.row;
            return String(row && row.id !== undefined ? row.id : text.length);
        } catch (_) { return 'unparsed'; }
    }

    _write(socket, bytes) {
        if (!socket.destroyed) { try { socket.write(bytes); } catch (_) { /* client gone */ } }
    }

    async stop() {
        for (const t of this._timers) clearTimeout(t);
        this._timers.clear();
        this.dropSockets();
        if (this._server) {
            await new Promise((resolve) => this._server.close(resolve));
            this._server = null;
        }
    }
}

// ---------------------------------------------------------------------------
// The venue
// ---------------------------------------------------------------------------

class AttestMirrorVenue {

    /**
     * @param opts.label            short name used in database names and log lines
     * @param opts.hubCount         hubs to stand up (default 5)
     * @param opts.indexerCount     indexers to stand up (default 2, one per distinct hub)
     * @param opts.identities       pre-staked `[{pubkeyHex, privkeyHex}]`; REQUIRED for a
     *                              real drill, because a responsible set is resolved from
     *                              BTC stake and the venue does not stake. Absent, fresh
     *                              keypairs are generated and no request will ever select
     *                              these hubs.
     * @param opts.coin/network     the chain the indexers index (default bitcoin/regtest)
     * @param opts.basePort         port probe base (default 41000)
     * @param opts.hubDb            an already-started disposableHubDb handle to share
     * @param opts.repoRoot         monorepo root; defaults to the checkout this file is in
     * @param opts.forwardS         ATTEST_RESPONSE_FORWARD_S_OVERRIDE (default 5)
     * @param opts.batchWindowS     ATTEST_BATCH_WINDOW_S_OVERRIDE (default 30)
     * @param opts.graces           { attestResponse, price, oracle } seconds, default 0 each
     * @param opts.inboundOnlyHubs  hub indexes given NO seed nodes, so every connection they
     *                              hold is inbound through their proxy and a gossip delay on
     *                              them is total. See P2pDelayProxy.
     */
    constructor(opts) {
        opts = opts || {};
        this.label        = String(opts.label || 'attestmirror').replace(/[^A-Za-z0-9]/g, '');
        this.hubCount     = opts.hubCount     || DEFAULT_HUB_COUNT;
        this.indexerCount = opts.indexerCount || DEFAULT_INDEXER_COUNT;
        this.coin         = opts.coin    || 'bitcoin';
        this.network      = opts.network || 'regtest';
        this.basePort     = opts.basePort || 41000;
        this.repoRoot     = opts.repoRoot || path.resolve(__dirname, '../../..');
        this.forwardS     = opts.forwardS     === undefined ? DEFAULT_FORWARD_S     : opts.forwardS;
        this.batchWindowS = opts.batchWindowS === undefined ? DEFAULT_BATCH_WINDOW_S : opts.batchWindowS;
        // Every barrier at zero by default, not the three that were once listed by hand.
        this.graces       = Object.assign(
            MIRROR_BARRIERS.reduce((acc, b) => { acc[b] = DEFAULT_GRACE_S; return acc; }, {}),
            opts.graces || {});
        this.inboundOnlyHubs = new Set(opts.inboundOnlyHubs || []);
        // `{0: {attestResponse: 120}}`: a per-indexer overlay on `graces`. See the
        // comment at the buildIndexerEnv call site for why the grace is the only term
        // that can single out one barrier.
        this.indexerGraces   = opts.indexerGraces || {};
        // Extra environment for every hub child, applied last. The seam exists for the
        // attestation BATCH publisher, which needs a signer module, a DOGE encoder and
        // a funded DOGE address that only a drill can supply; see the buildHubEnv call.
        this.hubExtraEnv     = opts.hubExtraEnv || null;
        // A drill that reaches the llm provider says so, and the venue then refuses to
        // boot on a box that cannot serve one. HUB_CLAUDE_CONFIG_DIR only, never the
        // interactive CLAUDE_CONFIG_DIR.
        this.needsLlm        = !!opts.needsLlm;
        this.claudeConfigDir = opts.claudeConfigDir || process.env.HUB_CLAUDE_CONFIG_DIR || null;
        this.presetIdentities = opts.identities || null;
        this.oracleEpochStart = opts.oracleEpochStart || (Date.now() - 60_000);
        this.btcIndexerApiUrl = opts.btcIndexerApiUrl || null;

        // Why the venue could not be built, when it could not be. Non-null means
        // the caller should SKIP: a venue that never booted proves nothing.
        this.unavailable = null;

        this.hubDb      = opts.hubDb || null;
        this._ownsHubDb = false;

        this.hubs     = [];   // [{index, apiUrl, apiPort, p2pPort, proxyPort, p2pAddr, pubkey, dbName, proc, proxy}]
        this.indexers = [];   // [{index, apiUrl, apiPort, followsHub, hubPubkey, indexerDbName, mirrorDbName, proc}]

        this._conn  = null;   // to the disposable MariaDB (every venue database)
        this._cwd   = null;   // neutral working directory for the children
        this._logs  = {};     // per-child stdout/stderr tail
        this._live  = null;   // resolved standing-stack endpoints
        this._identities = [];
        this._capabilityConfigPath = null;
        this._minStakes = null;
    }

    // ---- bring-up -------------------------------------------------------

    /**
     * Build the venue. Returns true when it is usable, false with `unavailable`
     * set when a dependency this helper does not own is missing.
     */
    async start() {
        // BEFORE anything is spawned or provisioned. A knob combination that makes the
        // batch drill intermittently red must stop the run here, where the message names
        // the two values, and not thirty minutes later as a flaky assertion.
        assertTimingInvariants(this.forwardS, this.batchWindowS, resolveWindowKeying());

        // Same posture, for the other thing a drill can declare. The PATH probed is the
        // one the CHILDREN will inherit, not an interactive one, because that is the only
        // PATH that decides whether a hub can reach the provider.
        if (this.needsLlm) {
            assertLlmAvailable(
                { claudeConfigDir: this.claudeConfigDir, pathEnv: process.env.PATH },
                {
                    dirExists: (p) => { try { return fs.statSync(p).isDirectory(); } catch (_) { return false; } },
                    isExecutable: (p) => { try { fs.accessSync(p, fs.constants.X_OK); return true; } catch (_) { return false; } }
                });
        }

        this._live = await this._resolveStandingStack();
        if (!this._live) return false;

        if (!this.hubDb) {
            this.hubDb = await startDisposableHubDb();
            this._ownsHubDb = true;
            if (!this.hubDb) { this.unavailable = 'no env hub DB and Docker unavailable'; return false; }
        }

        this._identities = [];
        for (let i = 0; i < this.hubCount; i++) {
            if (this.presetIdentities) {
                if (!this.presetIdentities[i]) {
                    throw new Error('attestMirrorVenue: identities provided (' + this.presetIdentities.length +
                        ') < hubCount (' + this.hubCount + ')');
                }
                this._identities.push({
                    pubkeyHex:  this.presetIdentities[i].pubkeyHex,
                    privkeyHex: this.presetIdentities[i].privkeyHex
                });
            } else {
                this._identities.push(ValidatorIdentity.generate());
            }
        }

        const stamp = process.pid + '_' + Date.now().toString(36);
        this._dbStamp = stamp;

        this._conn = await mariadb.createConnection({
            host: this.hubDb.host, port: parseInt(this.hubDb.port, 10),
            user: this.hubDb.user, password: this.hubDb.pass, connectTimeout: 10_000
        });

        // A neutral working directory. Both `src/api.js` files call
        // dotenv.config(), which reads `<cwd>/.env`; run from the checkout, a
        // child would silently inherit the standing stack's settings for every
        // variable this venue does not set.
        this._cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'xchain-attestmirror-' + this.label + '-'));
        this._capabilityConfigPath = this._writeCapabilityConfig();

        // ONE PROBE, TWO CONSUMERS, and it has to be one probe.
        //
        // The venue needs `portCount()` ports for its children plus one mirror proxy per
        // indexer. A SECOND independent `pickFreePorts` call for the proxies looks
        // equivalent and is not: the first call's ports are only PLANNED at that moment,
        // nothing is bound yet, so the second probe finds them free and hands back the
        // very ports the indexers are about to use. Measured exactly that way on the
        // first boot of this lever, where the two proxies took 61015 and 61016, which
        // `planPorts` had already assigned to the two indexer APIs; the indexers then had
        // no API to serve and every `/status` read answered with a hub's JSON-RPC error
        // instead of a height, which reads as a venue that will not come up rather than
        // as a port collision. So the pool is probed once and sliced: the head is exactly
        // what `planPorts` expects, and the tail is the proxies'.
        const planned = portCount(this.hubCount, this.indexerCount);
        const pool = await pickFreePorts(planned + this.indexerCount, this.basePort);
        const ports = planPorts(pool.slice(0, planned), this.hubCount, this.indexerCount);
        this._mirrorProxyPorts = pool.slice(planned);
        const followed = assignFollowedHubs(this.hubCount, this.indexerCount);

        await this._startHubs(ports, stamp);
        await this._startIndexers(ports, followed, stamp);
        return true;
    }

    async _startHubs(ports, stamp) {
        // Proxies first: a hub whose seed list names a proxy that is not
        // listening yet spends its whole reconnect backoff catching up.
        for (let i = 0; i < this.hubCount; i++) {
            const proxy = new P2pDelayProxy(ports.p2pProxy[i], ports.p2p[i], this.label + '-hub' + i);
            await proxy.start();
            this.hubs.push({
                index:     i,
                apiPort:   ports.hubApi[i],
                apiUrl:    'http://127.0.0.1:' + ports.hubApi[i],
                p2pPort:   ports.p2p[i],
                proxyPort: ports.p2pProxy[i],
                p2pAddr:   '127.0.0.1:' + ports.p2pProxy[i],
                pubkey:    this._identities[i].pubkeyHex,
                dbName:    DB_PREFIX + this.label + '_' + stamp + '_Hub' + i,
                proxy:     proxy,
                proc:      null,
                connector: null,
                frozen:    false
            });
        }

        // Sequential, so log lines interleave cleanly and the hubs' schema
        // bootstraps do not race each other on one MariaDB.
        for (let i = 0; i < this.hubCount; i++) await this._spawnHub(i);
    }

    async _spawnHub(i) {
        const hub = this.hubs[i];
        const seeds = this.inboundOnlyHubs.has(i)
            ? []
            : this.hubs.filter((h) => h.index !== i).map((h) => h.p2pAddr);
        const env = buildHubEnv({
            db:        { host: this.hubDb.host, port: this.hubDb.port, user: this.hubDb.user, pass: this.hubDb.pass },
            claudeConfigDir: this.claudeConfigDir,
            dbName:    hub.dbName,
            apiPort:   hub.apiPort,
            p2pPort:   hub.p2pPort,
            proxyPort: hub.proxyPort,
            seedNodes: seeds,
            privkeyHex: this._identities[i].privkeyHex,
            network:   this.network,
            hubCount:  this.hubCount,
            oracleEpochStart: this.oracleEpochStart,
            btcIndexerApiUrl: this._live.btcOracle.url,
            btcIndexerApiKey: this._live.btcOracle.apiKey,
            capabilityConfigPath: this._capabilityConfigPath,
            forwardS:     this.forwardS,
            batchWindowS: this.batchWindowS,
            // Explicit extra hub environment, for the one subsystem this venue does not
            // configure: the attestation BATCH publisher. It is constructed and started
            // on every real hub boot and regtest is armed at 0, so those hubs are already
            // closing windows, but they can publish nothing without a signer module, a
            // DOGE encoder URL and a funded DOGE address. Wiring those means funding a
            // wallet on another chain, which is a drill's business rather than a venue's,
            // so the venue offers the seam and AT5 fills it or skips saying what is
            // missing. Applied LAST, so a drill can override anything above deliberately.
            extraEnv: this.hubExtraEnv,
            path: process.env.PATH,
            home: process.env.HOME
        });
        hub.proc = this._spawn('hub' + i, path.join(this.repoRoot, 'xchain-hub', 'src', 'api.js'), [], env);

        const connector = new XChainHubConnector(['http://127.0.0.1:' + hub.apiPort]);
        const up = await waitFor(async () => {
            if (hub.proc.exitCode !== null) return { ok: false, dead: true };
            try { return { ok: await connector.ping() }; } catch (_) { return { ok: false }; }
        }, { timeoutMs: BOOT_WAIT_MS, intervalMs: 500 });
        if (!up.ok) {
            throw new Error('attestMirrorVenue[' + this.label + ']: hub ' + i + ' did not answer on 127.0.0.1:' +
                hub.apiPort + ' within ' + up.waitedMs + 'ms.\n' + this._tail('hub' + i));
        }
        hub.connector = connector;

        // Mutual validator registration. Each hub keeps its own `validators`
        // table, consulted by PeerManager for signature verification and by
        // consensus for leader rotation; without it every signed peer message is
        // dropped as "Invalid signature". Production bootstraps this over
        // `registervalidator`, so the venue calls the same JSON-RPC rather than
        // reaching into a database. Every hub already up is told about this one
        // and vice versa, which keeps the mesh complete as it grows.
        for (const other of this.hubs) {
            if (!other.connector) continue;
            await this._registerValidator(other, hub);
            if (other.index !== hub.index) await this._registerValidator(hub, other);
        }
    }

    // The JSON-RPC surface directly rather than through XChainHubConnector: the
    // connector attaches the STANDING stack's HUB_API_KEY from the ambient
    // environment, and these hubs are keyless.
    async _registerValidator(onHub, forHub) {
        try {
            await axios.post(onHub.apiUrl, {
                jsonrpc: '2.0', id: 1, method: 'registervalidator',
                params: { signing_pubkey: forHub.pubkey, addr: forHub.p2pAddr }
            }, { timeout: 10_000 });
        } catch (e) {
            console.warn('attestMirrorVenue[' + this.label + ']: registervalidator ' +
                forHub.index + ' on hub ' + onHub.index + ' failed: ' + (e && e.message));
        }
    }

    async _startIndexers(ports, followed, stamp) {
        // One mirror proxy per indexer, in front of the hub that indexer follows, on
        // the tail of the single port pool `start()` probed. See the comment there for
        // why these cannot come from a probe of their own.
        const proxyPorts = this._mirrorProxyPorts;
        if (!Array.isArray(proxyPorts) || proxyPorts.length < this.indexerCount) {
            throw new Error('attestMirrorVenue: the mirror proxy ports were not reserved from the ' +
                'venue port pool; start() must slice them off the single probe');
        }

        for (let i = 0; i < this.indexerCount; i++) {
            const hub = this.hubs[followed[i]];
            const mirrorProxy = new HubDbMirrorProxy(proxyPorts[i], hub.apiPort,
                this.label + '-mirror' + i);
            await mirrorProxy.start();
            this.indexers.push({
                index:  i,
                apiPort: ports.indexerApi[i],
                apiUrl:  'http://127.0.0.1:' + ports.indexerApi[i],
                followsHub: hub.index,
                // THE INDEXER READS ITS MIRROR THROUGH THE PROXY, always: the snapshot
                // route and the subscribe socket both derive from this one value, so this
                // is what puts the per-table lever on this edge. With no filter armed it
                // is a transparent relay. `hub.apiUrl` stays available on the hub record
                // for a drill that wants to ask the HUB what it holds, which is how a
                // withhold is told apart from a hub that never got the row.
                hubApiUrl:  mirrorProxy.url,
                mirrorProxy: mirrorProxy,
                hubPubkey:  hub.pubkey,
                indexerDbName: DB_PREFIX + this.label + '_' + stamp + '_Ixr' + i,
                mirrorDbName:  DB_PREFIX + this.label + '_' + stamp + '_Mirror' + i,
                proc: null,
                connector: null
            });
        }
        for (let i = 0; i < this.indexerCount; i++) await this._spawnIndexer(i);
    }

    async _spawnIndexer(i) {
        const ix = this.indexers[i];

        // The mirror database is the one NOBODY creates for itself, and that is a
        // property of the code rather than an oversight here: `XChainIndexer.start()`
        // calls verifyTables() on `indexerDb` only, so a missing mirror schema leaves
        // hub_db_sync probing SHOW COLUMNS, logging "not ready for bootstrap" forever,
        // and the barrier never opening on mirror content.
        await this._conn.query('CREATE DATABASE IF NOT EXISTS `' + ident(ix.mirrorDbName, 'database name') + '`');
        await this._provisionMirrorSchema(ix.mirrorDbName);

        const env = buildIndexerEnv({
            coin:    coinCode(this.coin),
            network: this.network,
            apiPort: ix.apiPort,
            indexerDbName: ix.indexerDbName,
            mirrorDbName:  ix.mirrorDbName,
            hubApiUrl:     ix.hubApiUrl,
            db:      { host: this.hubDb.host, port: this.hubDb.port, user: this.hubDb.user, pass: this.hubDb.pass },
            decoder: this._live.decoder,
            node:    this._live.node,
            tracker: this._live.tracker,
            // PER-INDEXER graces, layered over the venue-wide set.
            //
            // Every barrier reads the SAME global stream watermark and differs only in
            // the grace it adds, so the grace is the only per-barrier term there is: a
            // barrier whose grace exceeds every other barrier's is the only one that can
            // be unsatisfied while the rest are clear, which is what lets a stall be
            // attributed BY NAME. Per indexer rather than venue-wide because the
            // attribution also needs an unaffected peer to advance past the parked node.
            graces:  Object.assign({}, this.graces, this.indexerGraces[i] || {}),
            feeDestination: this._live.feeDestination,
            path: process.env.PATH,
            home: process.env.HOME
        });

        // --no-node-snapshot mirrors the package's own `api` script: the contract
        // VM binding will not load under a Node snapshot, and an attestation
        // callback is an EXECUTE.
        ix.proc = this._spawn('indexer' + i, path.join(this.repoRoot, 'xchain-indexer', 'src', 'api.js'),
            ['--no-node-snapshot'], env);

        const up = await waitFor(async () => {
            if (ix.proc.exitCode !== null) return { ok: false, dead: true };
            try {
                const rows = await this._conn.query(
                    'SELECT COUNT(*) AS c FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?', [ix.indexerDbName]);
                return { ok: Number(rows[0].c) > 0, tables: Number(rows[0].c) };
            } catch (_) { return { ok: false }; }
        }, { timeoutMs: BOOT_WAIT_MS, intervalMs: 1000 });
        if (!up.ok) {
            throw new Error('attestMirrorVenue[' + this.label + ']: indexer ' + i + ' never created its schema in ' +
                ix.indexerDbName + ' within ' + up.waitedMs + 'ms.\n' + this._tail('indexer' + i));
        }
        ix.connector = new XChainIndexerConnector('127.0.0.1', ix.apiPort, null);
    }

    /**
     * Give a mirror database its schema, from the indexer's own shipped DDL.
     *
     * The WHOLE indexer schema is applied rather than only the mirrored tables,
     * because `hubDb` is not just hub_db_sync's target: the settlement path reads
     * stakes, delegations and rewards through the same connection. In the
     * single-host topology that connection is a full schema, so making it one
     * here matches production rather than padding.
     */
    async _provisionMirrorSchema(dbName) {
        const dir = path.join(this.repoRoot, 'xchain-indexer', 'src', 'sql');
        await this._conn.query('USE `' + ident(dbName, 'database name') + '`');
        for (const file of fs.readdirSync(dir)) {
            if (!file.endsWith('.sql')) continue;
            // Strip the license block and every `--` comment before splitting on
            // ';': a trailing comment can carry a semicolon and would otherwise
            // cut a CREATE TABLE in half.
            const sql = fs.readFileSync(path.join(dir, file), 'utf8')
                .replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n\r]*/g, '');
            for (const stmt of sql.split(';').map((s) => s.trim()).filter(Boolean)) {
                try { await this._conn.query(stmt); }
                catch (e) { /* a DDL this schema version cannot apply is not this venue's to fix */ }
            }
        }
    }

    /**
     * The venue's capability thresholds, written where each hub reads them.
     *
     * A hub whose capability registry is started and holds NO threshold for a
     * capability refuses to build a snapshot for it at all, deliberately: omitting
     * MIN_STAKE would let each indexer apply its own floor and fork the qualified
     * set. The values are lifted from the hub's own canonical coins registry
     * rather than typed here, so they cannot drift from the floor the hub asserts
     * them against.
     */
    _writeCapabilityConfig() {
        const coins = loadHubModule('src/coins/index.js');
        const cfg = coins.getCoinConfig('BTC', this.network);
        const canonical = (cfg && cfg.STAKING && cfg.STAKING.CAPABILITIES) || null;
        if (!canonical) throw new Error('attestMirrorVenue: the hub coins registry carries no BTC STAKING.CAPABILITIES');
        const caps = {};
        for (const cap of Object.keys(canonical)) caps[cap] = { MIN_STAKE: String(canonical[cap].MIN_STAKE) };
        this._minStakes = caps;
        const file = path.join(this._cwd, 'capabilities.json');
        fs.writeFileSync(file, JSON.stringify({ CAPABILITIES: caps }, null, 2));
        return file;
    }

    /**
     * The standing stack's endpoints: the decoder database (the chain, parsed),
     * the coin node RPC, and the BTC indexer the hubs poll.
     *
     * Every coordinate comes from the hub the standing stack already serves, the
     * same route `oracleBatchReplay` takes, so no credential is written to a file
     * or assembled on a command line here.
     */
    async _resolveStandingStack() {
        let cfg = null;
        try {
            const hub = new XChainHubConnector(XChainHubConnector.parseEndpoints());
            if (!(await hub.ping())) {
                this.unavailable = 'stack hub unreachable, cannot discover the ' + this.coin + ' decoder database';
                return null;
            }
            cfg = await hub.getAllConfig();
        } catch (e) {
            this.unavailable = 'stack hub config lookup failed: ' + (e && e.message);
            return null;
        }
        const svc = cfg && cfg[this.coin] && cfg[this.coin][this.network];
        if (!svc) { this.unavailable = 'stack hub has no config for ' + this.coin + '/' + this.network; return null; }

        const dec = svc['xchain-decoder'] || {};
        if (!dec.name) { this.unavailable = 'stack hub config carries no decoder database for ' + this.coin; return null; }

        // The hub stores the CONTAINER-internal database host; a host-side process
        // must use the published one. Same substitution chainRail makes.
        const dbHost = process.env.DATABASE_URL  || '127.0.0.1';
        const dbPort = parseInt(process.env.DATABASE_PORT, 10) || 13306;

        const btcOracle = this._resolveBtcOracle(cfg);
        if (!btcOracle) {
            this.unavailable = 'the stack hub names no bitcoin/' + this.network + ' indexer, so the hubs could not ' +
                'be given the Bitcoin capability oracle a responsible set is resolved from';
            return null;
        }

        // Resolved rather than read straight off the oracle, which serves a redaction
        // sentinel in place of every password. Refusing here, with the store named, beats
        // spawning seven children that each die on ER_ACCESS_DENIED four minutes later.
        const cred = resolveDecoderCredential(dec, this.coin, this.network);
        if (cred.problem) { this.unavailable = cred.problem; return null; }
        this.decoderCredentialSource = cred.source;

        // PROVE the credential before spawning anything. Resolving one only means some
        // store had a value, and these stores are known to hold stale values: the sidecar
        // keeps whatever the decoder used before its last recreate, and nothing propagates
        // the new one back. Without this probe a stale value is discovered by seven
        // children dying on ER_ACCESS_DENIED several minutes in, and the error names the
        // account rather than the store, which is the wrong thing to go looking at.
        const denied = await this._probeDecoderAccess(
            { host: dbHost, port: dbPort, name: dec.name, user: cred.user, pass: cred.pass });
        if (denied) {
            this.unavailable = 'the ' + this.coin + '/' + this.network + ' decoder database credential from ' +
                cred.source + ' does not work: ' + denied + '. The venue needs to read ' + dec.name +
                ' as ' + cred.user + '. These stores drift apart whenever a container is recreated, so ' +
                'reconcile that store with the credential the running decoder actually uses, or set ' +
                'DECODER_DB_PASS in the harness environment, or grant the harness account SELECT on ' +
                dec.name + '.';
            return null;
        }

        return {
            decoder: { host: dbHost, port: dbPort, name: dec.name, user: cred.user, pass: cred.pass },
            node:    svc['node'] || {},
            tracker: svc['xchain-utxo-tracker'] || {},
            feeDestination: await this._resolveFeeDestination(svc),
            btcOracle: btcOracle
        };
    }

    /**
     * Can we actually read the decoder database with this credential?
     *
     * Returns null when yes, and a short reason when no. It probes the READ the indexers
     * depend on rather than only the connection, because authenticating and being unable
     * to see the tables are different failures with different fixes: the first is a wrong
     * password, the second a missing grant, and the message has to say which.
     */
    async _probeDecoderAccess(d) {
        let conn = null;
        try {
            conn = await mariadb.createConnection({
                host: d.host, port: d.port, user: d.user, password: d.pass, connectTimeout: 5000
            });
            await conn.query('SELECT 1 FROM `' + ident(d.name, 'database name') + '`.blocks LIMIT 1');
            return null;
        } catch (e) {
            const code = (e && e.code) ? e.code : String(e && e.message);
            if (code === 'ER_ACCESS_DENIED_ERROR') return 'authentication was refused (' + code + ')';
            if (code === 'ER_TABLEACCESS_DENIED_ERROR' || code === 'ER_DBACCESS_DENIED_ERROR') {
                return 'it authenticates but has no read grant (' + code + ')';
            }
            return code;
        } finally {
            if (conn) { try { await conn.end(); } catch (_) { /* already closed */ } }
        }
    }

    /**
     * The BTC indexer the hubs poll: the request feed and the capability oracle.
     *
     * Discovered through the standing hub's config oracle. The one substitution is
     * the API port: the hub stores the container-internal one and a host-side
     * process must dial the published one.
     */
    _resolveBtcOracle(cfg) {
        if (this.btcIndexerApiUrl) {
            return { url: this.btcIndexerApiUrl, apiKey: process.env.BTC_INDEXER_API_KEY || process.env.INDEXER_API_KEY || null };
        }
        if (process.env.BTC_INDEXER_API_URL) {
            return { url: process.env.BTC_INDEXER_API_URL, apiKey: process.env.BTC_INDEXER_API_KEY || process.env.INDEXER_API_KEY || null };
        }
        const svc = cfg && cfg['bitcoin'] && cfg['bitcoin'][this.network];
        if (!svc || !svc['xchain-indexer'] || !svc['xchain-indexer'].name) return null;
        const host = process.env.BTC_SERVICE_HOST || 'localhost';
        const port = parseInt(process.env.BTC_INDEXER_API_PORT, 10) || DEFAULT_BTC_INDEXER_API_PORT;
        return {
            url: 'http://' + host + ':' + port,
            apiKey: process.env.BTC_INDEXER_API_KEY || process.env.INDEXER_API_KEY || null
        };
    }

    /**
     * The chain's own fee destination, asked of the standing indexer.
     *
     * Consensus-pinned per-coin configuration with a regtest-only override: every
     * node on one network must hold the same value or their fee verdicts diverge
     * by configuration rather than by anything under test.
     */
    async _resolveFeeDestination(svc) {
        try {
            const code = coinCode(this.coin);
            const host = process.env[code + '_SERVICE_HOST'] || 'localhost';
            let port = process.env[code + '_INDEXER_API_PORT'];
            if (!port) {
                const file = path.resolve(__dirname, '../../.env.' + String(code).toLowerCase());
                if (fs.existsSync(file)) {
                    try { port = require('dotenv').parse(fs.readFileSync(file)).INDEXER_API_PORT; }
                    catch (_) { /* fall through to the hub's own value */ }
                }
            }
            // The published port BEFORE the hub's own value: the config oracle stores the
            // container-internal port, so using it from the host dials nothing and the
            // fee destination silently resolves to null. The hub's value stays as the
            // last resort for a coin this map does not know.
            if (!port) port = PUBLISHED_INDEXER_API_PORT[code];
            if (!port) port = svc['xchain-indexer'] && svc['xchain-indexer'].port;
            if (!port) return null;
            const conn = new XChainIndexerConnector(host, port,
                process.env[code + '_INDEXER_API_KEY'] || process.env.INDEXER_API_KEY || null);
            const sched = await conn.call('feeschedule', {});
            if (!sched || sched.error || !sched.feeDestination) return null;
            return String(sched.feeDestination);
        } catch (e) {
            return null;
        }
    }

    // ---- handles --------------------------------------------------------

    // Validator pubkeys in hub-index order. Stake THESE, or no request will ever
    // select this venue's hubs.
    getPubkeys() { return this.hubs.map((h) => h.pubkey); }

    hub(i)     { return this.hubs[i]; }
    indexer(i) { return this.indexers[i]; }

    // The identities the hubs sign with. Handed back so a suite can stake them
    // BEFORE start() (pass them in as opts.identities) or read the generated set
    // afterwards; never logged by this file.
    identities() { return this._identities.map((id) => ({ pubkeyHex: id.pubkeyHex, privkeyHex: id.privkeyHex })); }

    /**
     * The responsible set for a request, computed the way the indexer computes it.
     *
     * A MIRROR, and named as one: the hub exposes no method that answers "who is
     * responsible for request X" (there is no such JSON-RPC in `xchain-hub/src/api.js`),
     * so the only pre-finalization answer available to a test is the shared
     * ranking in `attestationHelper.computeResponsibleSigners`, which is itself
     * pinned against the indexer's `_computeResponsibleSet`. Once the round has
     * finalized, prefer `responsibleSetFromMirror`: that reads the pubkeys that
     * actually signed, from the row itself, and is not a mirror of anything.
     *
     * `validators` defaults to this venue's own hubs, which is correct only when
     * they are the ONLY staked attestation keys on the chain; on a shared chain
     * pass the full session-staked set (`attestationHelper.getSessionStakedValidators`).
     */
    responsibleSetFor(requestId, opts) {
        opts = opts || {};
        const validators = opts.validators
            || this.hubs.map((h) => ({ pubkey: h.pubkey, source: opts.sourceOf ? opts.sourceOf(h) : null, weight: opts.weight || null }));
        const chosen = computeResponsibleSigners(
            requestId,
            opts.redundancy === undefined ? VENUE_REDUNDANCY : opts.redundancy,
            validators,
            opts.snapshotBlock,
            this.network,
            opts.minStake);
        return chosen.map((v) => String(v.pubkey).toLowerCase());
    }

    // The pubkeys that actually signed the finalized row, read from an indexer's
    // mirror. Authoritative, and available only once the row has arrived.
    async responsibleSetFromMirror(indexerIndex, requestId) {
        const rows = await this.readMirrorRows(indexerIndex, { requestId: requestId });
        if (rows.length === 0) return null;
        let keys = rows[0].signer_pubkeys;
        if (typeof keys === 'string') { try { keys = JSON.parse(keys); } catch (_) { return null; } }
        return Array.isArray(keys) ? keys.map((k) => String(k).toLowerCase()) : null;
    }

    // The indexer whose followed hub is OUTSIDE the given responsible set.
    pickIndexerOutsideResponsibleSet(responsiblePubkeys) {
        return pickOutsideIndexer(this.indexers, responsiblePubkeys);
    }

    // ---- driving --------------------------------------------------------

    // Stop one hub's process, leaving its database and its proxy in place so
    // startHub() brings the SAME hub back rather than a new one. This is the
    // anti-wedge lever: an indexer whose hub is gone must park on the barrier and
    // resume with no divergence when it returns.
    async stopHub(i) {
        const hub = this.hubs[i];
        if (!hub) throw new Error('attestMirrorVenue: no hub ' + i);
        await this._kill(hub.proc);
        hub.proc = null;
        hub.connector = null;
    }

    async startHub(i) {
        const hub = this.hubs[i];
        if (!hub) throw new Error('attestMirrorVenue: no hub ' + i);
        if (hub.proc) return;
        await this._spawnHub(i);
    }

    /**
     * Starve indexer `i`'s mirror of ONE table, indefinitely, until released.
     *
     * Route-level and edge-scoped: the hub keeps writing, keeps gossiping and keeps
     * serving that table to every other follower, and every OTHER table keeps
     * flowing to this indexer, watermark and schema version included. That is what
     * leaves the other barriers satisfied so the one under test can be the only
     * thing holding a block.
     *
     * This is NOT the gossip lever. To make a hub learn a row late, use
     * `delayHubGossip`; to make an indexer learn it late, use `delayMirrorTable`.
     */
    withholdMirrorTable(indexerIndex, table) {
        const ix = this.indexers[indexerIndex];
        if (!ix) throw new Error('attestMirrorVenue: no indexer ' + indexerIndex);
        ix.mirrorProxy.withholdTable(table);
    }

    /** Hold every row of `table` for `ms` before serving it to indexer `i`. */
    delayMirrorTable(indexerIndex, table, ms) {
        const ix = this.indexers[indexerIndex];
        if (!ix) throw new Error('attestMirrorVenue: no indexer ' + indexerIndex);
        ix.mirrorProxy.delayTable(table, ms);
    }

    /**
     * Stop filtering `table` for indexer `i`.
     *
     * Drops the mirror socket by default, which is what makes the release a real
     * recovery rather than a permanent hole: rows withheld from the live stream are
     * never resent, so the indexer has to re-bootstrap to pick them up, and
     * `attestation_responses` re-pages from id 0 when it does.
     */
    releaseMirrorTable(indexerIndex, table, opts) {
        const ix = this.indexers[indexerIndex];
        if (!ix) throw new Error('attestMirrorVenue: no indexer ' + indexerIndex);
        ix.mirrorProxy.releaseTable(table, opts);
    }

    /** What one indexer's mirror proxy actually held back, for a failure message. */
    mirrorProxyStats(indexerIndex) {
        const ix = this.indexers[indexerIndex];
        if (!ix) throw new Error('attestMirrorVenue: no indexer ' + indexerIndex);
        return Object.assign({ filters: Array.from(ix.mirrorProxy.filters.entries()) }, ix.mirrorProxy.stats);
    }

    // Delay every byte on a connection terminating at hub i. See P2pDelayProxy
    // for why this and not an env knob or a signal, and for the exact scope.
    delayHubGossip(i, ms) {
        const hub = this.hubs[i];
        if (!hub) throw new Error('attestMirrorVenue: no hub ' + i);
        hub.proxy.setDelay(ms);
    }

    releaseHubGossip(i) { this.delayHubGossip(i, 0); }

    /**
     * Freeze a whole hub process with SIGSTOP.
     *
     * The blunt instrument, kept for a case that wants the hub unresponsive on
     * EVERY surface at once. It is not the gossip-delay lever: it also stops the
     * hub answering `/hub-db/*`, so an indexer following a frozen hub loses its
     * mirror stream too and any barrier it holds is ambiguous about which of the
     * two caused it.
     */
    freezeHub(i) {
        const hub = this.hubs[i];
        if (!hub || !hub.proc) throw new Error('attestMirrorVenue: hub ' + i + ' is not running');
        hub.proc.kill('SIGSTOP');
        hub.frozen = true;
    }

    unfreezeHub(i) {
        const hub = this.hubs[i];
        if (!hub || !hub.proc) throw new Error('attestMirrorVenue: hub ' + i + ' is not running');
        hub.proc.kill('SIGCONT');
        hub.frozen = false;
    }

    // Block until an indexer has committed up to `height`. Watches its OWN
    // `blocks` table rather than an endpoint: the claim is about what the node's
    // database ends up holding, and a health endpoint can report progress the
    // block transaction later rolls back.
    async waitForHeight(indexerIndex, height, opts) {
        opts = opts || {};
        const ix = this.indexers[indexerIndex];
        const db = ident(ix.indexerDbName, 'database name');
        const target = Number(height);
        const result = await waitFor(async () => {
            if (ix.proc && ix.proc.exitCode !== null) return { ok: false, dead: true };
            try {
                const rows = await this._conn.query('SELECT MAX(block_index) AS h FROM `' + db + '`.blocks');
                const at = rows[0].h === null ? null : Number(rows[0].h);
                return { ok: at !== null && at >= target, at: at };
            } catch (_) { return { ok: false, at: null }; }
        }, { timeoutMs: opts.timeoutMs || 30 * 60 * 1000, intervalMs: opts.intervalMs || 2000 });
        if (!result.ok) {
            const at = result.last && result.last.at;
            throw new Error('attestMirrorVenue[' + this.label + ']: indexer ' + indexerIndex + ' reached block ' +
                at + ' of ' + target + ' after ' + result.waitedMs + 'ms.\n' + this._tail('indexer' + indexerIndex));
        }
        return result;
    }

    // ---- reading --------------------------------------------------------

    /**
     * One hub's `/hub-db/snapshot/attestation_responses` route, as an indexer
     * bootstrapping its mirror would see it.
     *
     * Returns the parsed body ({table, rows, count, watermark, schema_version}).
     * Reading the ROUTE rather than the hub's table is the point: the venue's
     * claim is that these hubs SERVE the mirror, and a direct database read would
     * pass on a hub whose HTTP surface never came up.
     */
    async hubSnapshot(hubIndex, opts) {
        opts = opts || {};
        const hub = this.hubs[hubIndex];
        if (!hub) throw new Error('attestMirrorVenue: no hub ' + hubIndex);
        const url = hub.apiUrl + '/hub-db/snapshot/attestation_responses' +
            '?since_id=' + (opts.sinceId || 0) + (opts.limit ? '&limit=' + opts.limit : '');
        const res = await axios.get(url, { timeout: opts.timeoutMs || 10_000, validateStatus: () => true });
        if (res.status !== 200) {
            throw new Error('attestMirrorVenue: hub ' + hubIndex + ' answered ' + res.status +
                ' on the attestation_responses snapshot route');
        }
        return res.data;
    }

    /**
     * The mirrored `attestation_responses` rows an indexer actually holds.
     *
     * Read from the indexer's MIRROR database, which is where hub_db_sync writes
     * them, and never from the hub's own table: the two agreeing is the whole
     * claim, so reading the source and calling it the destination would make the
     * assertion vacuous.
     */
    async readMirrorRows(indexerIndex, opts) {
        opts = opts || {};
        const ix = this.indexers[indexerIndex];
        if (!ix) throw new Error('attestMirrorVenue: no indexer ' + indexerIndex);
        const db = ident(ix.mirrorDbName, 'database name');
        let sql = 'SELECT id, network, request_id, request_action_index, request_block_index, provider_id, ' +
                  'status, response_payload, response_hash, meta, effective_time, signer_pubkeys, signatures, ' +
                  'widen, batch_action_index FROM `' + db + '`.attestation_responses';
        const params = [];
        if (opts.requestId) { sql += ' WHERE request_id = ?'; params.push(String(opts.requestId)); }
        sql += ' ORDER BY id ASC';
        return plain(await this._conn.query(sql, params));
    }

    // The indexer's `/status`, parsed. Carries `stallReason`, `stallClass`,
    // `stallClearsAt`, `degraded` and the block counters: the anti-wedge leg reads
    // `attest_response_sync_barrier` out of `stallReason` here.
    async statusOf(indexerIndex) {
        const ix = this.indexers[indexerIndex];
        if (!ix) throw new Error('attestMirrorVenue: no indexer ' + indexerIndex);
        const res = await axios.get(ix.apiUrl + '/status', { timeout: 10_000, validateStatus: () => true });
        return { httpStatus: res.status, body: res.data };
    }

    async stallClassOf(indexerIndex) {
        const s = await this.statusOf(indexerIndex);
        return { stallClass: s.body && s.body.stallClass, stallReason: s.body && s.body.stallReason,
                 stallClearsAt: s.body && s.body.stallClearsAt, degraded: s.body && s.body.degraded };
    }

    /**
     * Whether an indexer's mirror is up, as far as anything observable says.
     *
     * COMPOSITE, and deliberately explicit about why. Neither `/status` nor the
     * `health` JSON-RPC reports hub-mirror connectivity or a per-table mirror
     * watermark, so "the mirror is connected" is not a field this can read; what
     * it can establish is that the indexer answers, that its mirror database
     * carries the mirrored table, and that hub_db_sync has paged the followed
     * hub's rows into it (row counts equal, once the hub has any). Callers get all
     * three parts back rather than one boolean, so an assertion can say which half
     * failed.
     */
    async mirrorConnected(indexerIndex) {
        const ix = this.indexers[indexerIndex];
        if (!ix) throw new Error('attestMirrorVenue: no indexer ' + indexerIndex);
        const status = await this.statusOf(indexerIndex);
        let tablePresent = false;
        let mirrorRows = null;
        try {
            const rows = await this._conn.query(
                'SELECT COUNT(*) AS c FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?',
                [ix.mirrorDbName, 'attestation_responses']);
            tablePresent = Number(rows[0].c) > 0;
            if (tablePresent) {
                const cnt = await this._conn.query('SELECT COUNT(*) AS c FROM `' +
                    ident(ix.mirrorDbName, 'database name') + '`.attestation_responses');
                mirrorRows = Number(cnt[0].c);
            }
        } catch (_) { tablePresent = false; }
        const hubRows = await this.hubSnapshot(ix.followsHub).then((s) => Number(s.count)).catch(() => null);
        return {
            answering:    status.httpStatus === 200 || status.httpStatus === 503,
            httpStatus:   status.httpStatus,
            stallClass:   status.body && status.body.stallClass,
            followsHub:   ix.followsHub,
            tablePresent: tablePresent,
            mirrorRows:   mirrorRows,
            hubRows:      hubRows,
            connected:    (status.httpStatus === 200 || status.httpStatus === 503) && tablePresent &&
                          hubRows !== null && mirrorRows !== null && mirrorRows >= hubRows
        };
    }

    logTail(which) { return this._tail(which); }

    // ---- process plumbing ------------------------------------------------

    _spawn(which, script, nodeArgs, env) {
        this._logs[which] = this._logs[which] || [];
        const proc = spawn(process.execPath, [...nodeArgs, script], {
            cwd: this._cwd, env: env, stdio: ['ignore', 'pipe', 'pipe']
        });
        const keep = (buf) => {
            const lines = String(buf).split('\n').filter((l) => l.length > 0);
            const log = this._logs[which];
            log.push(...lines);
            if (log.length > LOG_TAIL_LINES) log.splice(0, log.length - LOG_TAIL_LINES);
        };
        proc.stdout.on('data', keep);
        proc.stderr.on('data', keep);
        proc.on('error', (e) => keep('spawn error: ' + (e && e.message)));
        return proc;
    }

    _tail(which) {
        const log = this._logs[which] || [];
        return '  last ' + log.length + ' line(s) from ' + which + ':\n    ' + log.join('\n    ');
    }

    async _kill(proc) {
        if (!proc || proc.exitCode !== null) return;
        // A frozen process cannot handle SIGTERM; wake it first or the kill waits
        // out its whole budget and then SIGKILLs.
        try { proc.kill('SIGCONT'); } catch (_) { /* not frozen */ }
        const ended = new Promise((resolve) => proc.once('exit', resolve));
        proc.kill('SIGTERM');
        const settled = await Promise.race([ended.then(() => true), sleep(15_000).then(() => false)]);
        if (!settled) { proc.kill('SIGKILL'); await ended; }
    }

    // ---- teardown -------------------------------------------------------

    /**
     * Give everything back, in reverse order, never letting one failure skip the
     * rest: indexers, hubs, proxies, then every database this venue created, then
     * the working directory, and finally the shared MariaDB handle if this venue
     * is the one that started it.
     */
    async stop() {
        const problems = [];
        const attempt = async (label, fn) => {
            try { await fn(); } catch (e) { problems.push(label + ': ' + (e && e.message)); }
        };

        for (const ix of this.indexers) await attempt('indexer ' + ix.index + ' stop', async () => this._kill(ix.proc));
        for (const ix of this.indexers) {
            await attempt('mirror proxy ' + ix.index + ' stop',
                async () => ix.mirrorProxy && ix.mirrorProxy.stop());
        }
        for (const hub of this.hubs)    await attempt('hub ' + hub.index + ' stop',    async () => this._kill(hub.proc));
        for (const hub of this.hubs)    await attempt('proxy ' + hub.index + ' stop',  async () => hub.proxy && hub.proxy.stop());

        if (this._conn) {
            const names = []
                .concat(this.indexers.map((ix) => ix.mirrorDbName))
                .concat(this.indexers.map((ix) => ix.indexerDbName))
                .concat(this.hubs.map((h) => h.dbName));
            for (const name of names) {
                if (!name) continue;
                await attempt('drop ' + name, async () =>
                    this._conn.query('DROP DATABASE IF EXISTS `' + ident(name, 'database name') + '`'));
            }
            await attempt('conn close', async () => this._conn.end());
            this._conn = null;
        }

        this.indexers = [];
        this.hubs = [];

        if (this._cwd) {
            await attempt('cwd', async () => fs.rmSync(this._cwd, { recursive: true, force: true }));
            this._cwd = null;
        }
        if (this.hubDb && this._ownsHubDb) {
            await attempt('hub db stop', async () => this.hubDb.stop());
            this.hubDb = null;
        }

        if (problems.length > 0) console.warn('attestMirrorVenue[' + this.label + ']: teardown problems: ' + problems.join(' | '));
        return problems;
    }
}

// Coin name to the three-letter code every per-chain env var is keyed on. Kept
// local so the venue can build a node without entering a rail.
const COIN_CODE_MAP = { bitcoin: 'BTC', litecoin: 'LTC', dogecoin: 'DOGE' };
function coinCode(coin) {
    return COIN_CODE_MAP[coin] || String(coin).toUpperCase().slice(0, 3);
}

module.exports = {
    AttestMirrorVenue,
    P2pDelayProxy,
    HubDbMirrorProxy,
    // The mirror proxy's pure decision layer, exported so the fault injection can be
    // falsified without a venue.
    snapshotTableOf,
    mirrorFilterVerdict,
    filterSnapshotBody,
    readServerFrames,
    mirrorFrameTable,
    MIRROR_WITHHOLD,
    MIRROR_DELAY,
    MIRROR_PASS,
    MIRROR_DROP,
    MIRROR_HOLD,
    // The pure composition layer, exported for test/unit/helpers/attestMirrorVenue.test.js.
    assignFollowedHubs,
    planPorts,
    portCount,
    buildHubEnv,
    buildIndexerEnv,
    pickOutsideIndexer,
    assertTimingInvariants,
    resolveWindowKeying,
    assertLlmAvailable,
    resolveWindowKeyingFrom,
    resolveDecoderCredential,
    HUB_CONFIG_REDACTION,
    coinCode,
    DEFAULT_HUB_COUNT,
    DEFAULT_INDEXER_COUNT,
    DEFAULT_FORWARD_S,
    DEFAULT_BATCH_WINDOW_S,
    DEFAULT_GRACE_S,
    GOSSIP_HOP_BUDGET_S,
    WINDOW_KEY_SIGNED,
    WINDOW_KEY_WALL_CLOCK,
    DB_PREFIX,
    VENUE_REDUNDANCY
};
