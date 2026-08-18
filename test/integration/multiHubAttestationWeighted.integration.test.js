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
 * L2 integration: STAKE_WEIGHTED_QUORUM (WI-1) for the attestation capability:
 * responsible-set SOURCE-dedup (Suite A2 of the regtest e2e plan).
 *
 * Attestation is an independent-REPLICATION check (REDUNDANCY validators
 * independently fetch + agree on external data), NOT a stake vote, so the
 * within-subset quorum stays COUNT-based. The WI-1-relevant risk is delegation
 * SLOT-INFLATION: the responsible set is chosen by sha256(requestId‖pubkey) rank,
 * so a source that DELEGATEs N keys gets N bites at the responsible slots and can
 * occupy MULTIPLE of them, re-introducing the very key-multiplication WI-1 kills.
 *
 * The fix (operator-ratified): when weighted, AttestationRound._computeResponsibleSet
 * dedupes by staking SOURCE (one slot per source, keep the source's lowest-hash
 * key). This drives the REAL hub method over a delegated set (one source with many
 * keys + several single-key sources) and asserts:
 *
 *   - WEIGHTED: every responsible slot is a DISTINCT source (a multi-key source
 *     can never occupy more than one slot, for ANY requestId.
 *   - COUNT (pre-activation): NO dedup; there exists a requestId where the
 *     multi-key source occupies ≥2 of the top-`redundancy` slots. The same
 *     requestId under the weighted rule collapses it to exactly one. This is the
 *     inflation the dedup closes.
 *
 * _computeResponsibleSet is a pure ranking over the seeded validator set (no P2P,
 * no providers, no chain); we boot one real hub for a fully-constructed
 * AttestationRound and call it directly. Disposable Docker MariaDB; skips when
 * neither an env DB nor Docker is available.
 *
 * The second describe drives the SAME rule through the live pipeline, because the
 * pure-helper tests above cannot see a wiring regression: a change that stopped
 * passing `weighted` into _computeResponsibleSet, or that recomputed the set
 * without dedup between AttestationRound and AttestationConsensus, leaves both of
 * them green and leaves the three-hub federation suite green too (it stakes one
 * key per source, so dedup is a no-op there). Five in-process hubs run a real
 * ATTEST_PROPOSE -> PREPARE -> COMMIT round over a delegated multi-key source and
 * assert on the FINALIZED signature set:
 *
 *   - CONTROL (count path, dedup off): a rid where the whale holds >=2 of the
 *     top-REDUNDANCY slots finalizes with >=2 whale signatures. This is the
 *     failure the dedup exists to stop, reproduced live, so the negative case
 *     below is known to be measuring dedup and not a dead federation.
 *   - POSITIVE (weighted, 3 sources): the finalized response carries exactly one
 *     signature per distinct source, the whale contributing exactly one.
 *   - NEGATIVE (weighted, 2 sources < REDUNDANCY): nothing finalizes on any hub,
 *     because dedup leaves too few distinct sources to reach the gate.
 *
 * Spec: the cross-chain quorum security spec §3.5, §3.7, §10; plan §A2.
 ********************************************************************/

'use strict';

const dotenv = require('dotenv');
dotenv.config();

const assert = require('assert');
const http   = require('http');
const crypto = require('crypto');
const { MultiValidatorHub }    = require('../helpers/multiValidatorHubHelper');
const { startDisposableHubDb } = require('../helpers/disposableHubDb');

const PEER_WAIT_MS = 60_000;   // a deadline for the bring-up poll below, not a settle
const REDUNDANCY   = 3;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One WHALE source delegating 5 keys + four single-key small sources (9 keys, 5
// sources). Pubkeys are arbitrary distinct 32-byte hex; the selection only
// hashes them, it never verifies a signature here.
function hx(n) { return String(n).padStart(2, '0').repeat(32); }
const VALIDATORS = [
    // Weights are all above the http_get PROVIDER floor of 10000, which the weighted
    // responsible-set derivation applies before dedupe. This suite isolates the dedupe
    // rule, so nothing here may sit under the floor or empty the set for unrelated reasons.
    { pubkey: hx(1),  source: 'whale', weight: '50000' },
    { pubkey: hx(2),  source: 'whale', weight: '50000' },
    { pubkey: hx(3),  source: 'whale', weight: '50000' },
    { pubkey: hx(4),  source: 'whale', weight: '50000' },
    { pubkey: hx(5),  source: 'whale', weight: '50000' },
    { pubkey: hx(11), source: 'sA',    weight: '10000' },
    { pubkey: hx(12), source: 'sB',    weight: '10000' },
    { pubkey: hx(13), source: 'sC',    weight: '10000' },
    { pubkey: hx(14), source: 'sD',    weight: '10000' },
]

// The http_get provider stake floor. In production AttestationRound resolves
// this from the block-anchored provider history; here it is passed literally so the
// ranking stays a pure function of the seeded set.
const PROVIDER_FLOOR = '10000'
const whaleKeys = new Set(VALIDATORS.filter(v => v.source === 'whale').map(v => v.pubkey));
const sourcesOf = (set) => set.map(v => v.source);
const whaleSlots = (set) => set.filter(v => whaleKeys.has(v.pubkey)).length;

describe('MultiValidatorHub: STAKE_WEIGHTED_QUORUM attestation source-dedup (WI-1 Suite A2, L2)', function () {
    this.timeout(180_000);

    let db, mvh, ar;

    before(async function () {
        db = await startDisposableHubDb();
        if (!db) { console.log('Skipping A2: no env DB and Docker unavailable'); this.skip(); }
        mvh = new MultiValidatorHub({ count: 1, basePort: 33600 });   // startAttestation defaults on
        await mvh.start();
        // One hub, so there is no mesh to form: what this block actually needs is the
        // attestation round wired up, which is exactly what the next line asserts.
        // Poll for it instead of betting PEER_WAIT_MS that startAttestation finished.
        await waitUntil(() => {
            const round = mvh.hubs[0] && mvh.hubs[0].attestationRound;
            return !!(round && typeof round._computeResponsibleSet === 'function');
        }, PEER_WAIT_MS);
        ar = mvh.hubs[0].attestationRound;
        assert.ok(ar && typeof ar._computeResponsibleSet === 'function', 'hub.attestationRound not available');
    });

    after(async function () {
        if (mvh) { await mvh.stop(); await mvh.dropDatabases(); }
        if (db)  { await db.stop(); }
    });

    it('WEIGHTED: every responsible slot is a distinct source; a multi-key source can take at most one slot', function () {
        for (let i = 0; i < 300; i++) {
            const rid = 'req-weighted-' + i;
            const set = ar._computeResponsibleSet(VALIDATORS, rid, REDUNDANCY, true, PROVIDER_FLOOR);
            const srcs = sourcesOf(set);
            assert.strictEqual(new Set(srcs).size, srcs.length,
                'rid ' + rid + ': a source occupies >1 responsible slot under weighting (' + JSON.stringify(srcs) + ')');
            assert.ok(whaleSlots(set) <= 1, 'rid ' + rid + ': the 5-key whale took >1 slot under weighting');
        }
    });

    it('COUNT path inflates (≥2 whale slots for some rid); the SAME rid dedups to one under weighting', function () {
        // Find a requestId where the count rule lets the whale's keys occupy ≥2 of
        // the top-REDUNDANCY slots (the slot-inflation the weighted dedup closes).
        let witness = null;
        for (let i = 0; i < 1000 && !witness; i++) {
            const rid = 'req-' + i;
            const countSet = ar._computeResponsibleSet(VALIDATORS, rid, REDUNDANCY, false, PROVIDER_FLOOR);
            if (whaleSlots(countSet) >= 2) witness = rid;
        }
        assert.ok(witness, 'expected some requestId where the count path gives the whale ≥2 slots (5 of 9 keys)');

        // Same rid, weighted: the whale collapses to exactly one slot, all sources distinct.
        const weightedSet = ar._computeResponsibleSet(VALIDATORS, witness, REDUNDANCY, true, PROVIDER_FLOOR);
        assert.strictEqual(whaleSlots(weightedSet), 1,
            'witness ' + witness + ': weighting must collapse the whale to exactly one slot (got ' + whaleSlots(weightedSet) + ')');
        const srcs = sourcesOf(weightedSet);
        assert.strictEqual(new Set(srcs).size, srcs.length, 'witness ' + witness + ': weighted set has a duplicate source');
    });
});

// ---------------------------------------------------------------------------
// Live drive: the same dedup rule through real PBFT (see the header block).
// ---------------------------------------------------------------------------

const LIVE_BASE_PORT   = 33640;
const LIVE_MESH_MS     = 60000;
const LIVE_FINALIZE_MS = 60000;
const LIVE_QUIET_MS    = 15000;
const LIVE_POLL_MS     = 250;
const LIVE_BLOCK       = 100;
const FIXED_BODY       = '{"score":42,"meta":"a2-live"}';

// Poll a condition to a deadline. Every wait below goes through this rather than
// a fixed `await sleep(n)` before an assertion, which passes or fails on how busy
// the venue is (scripts/check-sleep-flake.js ratchets that shape).
async function waitUntil(predicate, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await predicate()) return true;
        await sleep(LIVE_POLL_MS);
    }
    return false;
}

// Peers a hub currently holds an OPEN socket to, inbound or outbound.
function openPeerCount(hub) {
    const pm = hub.peerManager;
    if (!pm || !pm.peers) return 0;
    let n = 0;
    for (const [, peer] of pm.peers) if (peer && peer.ws && peer.ws.readyState === 1) n++;
    return n;
}

// Pin both capability snapshots plus the network on every hub.
// The shared seedWeightSnapshot helper stubs only the SOURCE-keyed half, and the
// count CONTROL below runs with weighting OFF, which sends _startRound down
// getSnapshot() instead; a hub left with a live getSnapshot there would resolve an
// empty snapshot and skip the round, which would read as a passing control.
function seedLiveSnapshot(mvh, validators, network) {
    const base  = {
        validators,
        count:       validators.length,
        sourceCount: new Set(validators.map((v) => String(v.source))).size,
        blockIndex:  LIVE_BLOCK
    };
    const fresh = (capability) => Object.assign({}, base, { capability, validators: validators.slice() });

    const restores = [];
    for (const hub of mvh.hubs) {
        const cs   = hub.capabilitySnapshot;
        const orig = {
            activeWeight: cs.getActiveWeightSnapshot,
            weight:       cs.getWeightSnapshot,
            count:        cs.getSnapshot,
            block:        hub._resolveBtcLatestBlock,
            network:      hub.network
        };
        cs.getActiveWeightSnapshot = async () => fresh('*');
        cs.getWeightSnapshot       = async (capability) => fresh(capability);
        cs.getSnapshot             = async (capability) => fresh(capability);
        hub._resolveBtcLatestBlock = async () => LIVE_BLOCK;
        hub.network                = network;
        restores.push(() => {
            cs.getActiveWeightSnapshot = orig.activeWeight;
            cs.getWeightSnapshot       = orig.weight;
            cs.getSnapshot             = orig.count;
            hub._resolveBtcLatestBlock = orig.block;
            hub.network                = orig.network;
        });
    }
    return { restore() { restores.forEach((r) => r()); restores.length = 0; } };
}

// Drive ONE attestation round on every hub and return the finalize events.
// Non-responsible hubs return early inside _startRound, so calling all of them
// mirrors what the pollers do rather than pre-selecting the responsible set (a
// pre-selection would hide exactly the membership regression under test).
//
// `expect` is how many hubs should finalize. A positive value waits for exactly
// that many and returns as soon as they arrive; 0 means "prove a negative", so it
// polls for a counterexample until the quiet budget runs out.
async function driveAttestationRound(mvh, requestId, url, redundancy, expect) {
    const request = {
        request_id:     requestId,
        provider_id:    'http_get',
        redundancy:     redundancy,
        block_index:    LIVE_BLOCK,
        action_index:   1,
        deadline_block: LIVE_BLOCK + 30,
        payload:        url,
        fee_amount:     '100000000'
    };

    const events    = [];
    const listeners = mvh.hubs.map((hub, i) => {
        const fn = (ev) => events.push(Object.assign({ hubIndex: i }, ev));
        hub.attestationConsensus.on('request:finalized', fn);
        return fn;
    });

    // latestBlock = snapshot block + confirmations keeps the leader on slot 0
    // (no escalation step), so the round leader is the responsible set's head.
    await Promise.all(mvh.hubs.map((hub) => hub.attestationRound._startRound(request, LIVE_BLOCK + 3).catch(() => {})));
    if (expect > 0) await waitUntil(() => events.length >= expect, LIVE_FINALIZE_MS);
    else            await waitUntil(() => events.length > 0,       LIVE_QUIET_MS);
    mvh.hubs.forEach((hub, i) => hub.attestationConsensus.removeListener('request:finalized', listeners[i]));
    return events;
}

describe('MultiValidatorHub: LIVE weighted attestation source-dedup through PBFT (WI-1 Suite A2, L2)', function () {
    this.timeout(600_000);

    let db, mvh, httpServer, testUrl, seeded, httpGet, origFetch;
    let ids, whalePubkeys, sourceOfKey;
    // One request id used by BOTH the starved-weighted case and its count-path
    // control, so the pair differs in the activation flag and nothing else.
    let starvedRid;

    // 3 whale keys + 2 singles = 3 distinct sources, exactly REDUNDANCY, so the
    // weighted round is finalizable and every slot must be a different source.
    let weightedValidators;
    // 4 whale keys + 1 single = 2 distinct sources < REDUNDANCY: unfinalizable
    // under dedup, finalizable (with an inflated whale) without it.
    let dedupStarvedValidators;

    before(async function () {
        db = await startDisposableHubDb();
        if (!db) { console.log('Skipping A2 live: no env DB and Docker unavailable'); this.skip(); }

        // All responsible hubs fetch the same fixed body, so byte-equality
        // consensus converges in-process with no judge.
        await new Promise((resolve) => {
            httpServer = http.createServer((_req, res) => {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(FIXED_BODY);
            });
            httpServer.listen(0, '127.0.0.1', () => {
                testUrl = 'http://127.0.0.1:' + httpServer.address().port + '/score';
                resolve();
            });
        });

        mvh = new MultiValidatorHub({ count: 5, basePort: LIVE_BASE_PORT });
        await mvh.start();
        // PBFT only converges once the mesh is up, so wait on the sockets rather
        // than on a fixed settle: a slow venue would otherwise start the round
        // into a half-connected federation and read as a consensus failure.
        const meshed = await waitUntil(
            () => mvh.hubs.every((hub) => openPeerCount(hub) >= mvh.hubs.length - 1), LIVE_MESH_MS);
        assert.ok(meshed, 'hubs did not form a full mesh: ' +
            JSON.stringify(mvh.hubs.map((hub) => openPeerCount(hub))));

        // http_get refuses a non-https payload, and the test server is http on
        // loopback. Patch the module the hubs' own registry holds (one require
        // cache entry shared by all five) and restore it in after(), rather than
        // patching by path: a path mismatch would leave the real fetch in place
        // and every round would finalize as provider_error.
        httpGet = mvh.hubs[0].attestationRound.providerRegistry.getModule('http_get');
        assert.ok(httpGet && typeof httpGet.fetch === 'function', 'http_get provider module not resolvable from the hub registry');
        origFetch = httpGet.fetch;
        httpGet.fetch = async function _testPatchedFetch(payload, options) {
            if (typeof payload === 'string' && payload.startsWith('http://127.0.0.1:')) {
                const axios = require('axios');
                const res = await axios.get(payload, {
                    responseType:   'arraybuffer',
                    timeout:        (options && options.timeoutMs) || 10000,
                    maxRedirects:   0,
                    validateStatus: () => true
                });
                return { body: Buffer.from(res.data), meta: String(res.status) };
            }
            return origFetch(payload, options);
        };

        // The leader's publisher broadcasts on finalize; there is no chain here,
        // so hand it a hook that reports a synthetic txid.
        mvh.setBroadcastHook(async () => ({ txid: 'de'.repeat(32) }));

        ids          = mvh.identities.map((id) => String(id.pubkeyHex).toLowerCase());
        whalePubkeys = new Set([ids[0], ids[1], ids[2]]);
        // Every weight clears the http_get provider floor of 10000: these hubs run the
        // REAL _startRound, which filters below-floor sources out of the responsible set
        // before deduping; a starved set here would fail the assertions for the wrong reason.
        weightedValidators = [
            { pubkey: ids[0], source: 'whale', weight: '50000' },
            { pubkey: ids[1], source: 'whale', weight: '50000' },
            { pubkey: ids[2], source: 'whale', weight: '50000' },
            { pubkey: ids[3], source: 'sA',    weight: '10000' },
            { pubkey: ids[4], source: 'sB',    weight: '10000' }
        ];
        dedupStarvedValidators = [
            { pubkey: ids[0], source: 'whale', weight: '50000' },
            { pubkey: ids[1], source: 'whale', weight: '50000' },
            { pubkey: ids[2], source: 'whale', weight: '50000' },
            { pubkey: ids[3], source: 'whale', weight: '50000' },
            { pubkey: ids[4], source: 'sA',    weight: '10000' }
        ];
        sourceOfKey = (list) => new Map(list.map((v) => [String(v.pubkey).toLowerCase(), String(v.source)]));

        // Pick the shared request id up front: it has to be one where the COUNT
        // rule actually inflates the whale, otherwise the control below would
        // finalize a set the dedup had no reason to change and the pair would
        // prove nothing.
        const ar        = mvh.hubs[0].attestationRound;
        const starvedOf = sourceOfKey(dedupStarvedValidators);
        for (let i = 0; i < 2000 && !starvedRid; i++) {
            const rid = crypto.createHash('sha256').update('a2-live-starved-' + i).digest('hex');
            const set = ar._computeResponsibleSet(dedupStarvedValidators, rid, REDUNDANCY, false, PROVIDER_FLOOR);
            if (set.filter((v) => starvedOf.get(v.pubkey) === 'whale').length >= 2) starvedRid = rid;
        }
        assert.ok(starvedRid, 'no request id gave the whale >=2 count-path slots (4 of 5 keys)');
    });

    after(async function () {
        if (seeded)     seeded.restore();
        if (httpGet && origFetch) httpGet.fetch = origFetch;
        if (httpServer) await new Promise((r) => httpServer.close(() => r()));
        if (mvh) { await mvh.stop(); await mvh.dropDatabases(); }
        if (db)  { await db.stop(); }
    });

    afterEach(function () { if (seeded) { seeded.restore(); seeded = null; } });

    it('WEIGHTED: the finalized response carries one signature per distinct source, the whale exactly one', async function () {
        const rid   = crypto.createHash('sha256').update('a2-live-weighted').digest('hex');
        const srcOf = sourceOfKey(weightedValidators);

        seeded = seedLiveSnapshot(mvh, weightedValidators, 'regtest');
        const events = await driveAttestationRound(mvh, rid, testUrl, REDUNDANCY, REDUNDANCY);

        assert.strictEqual(events.length, REDUNDANCY,
            'expected all ' + REDUNDANCY + ' responsible hubs to finalize, got ' + events.length);
        for (const ev of events) {
            assert.strictEqual(ev.status, 'ok', 'hub ' + ev.hubIndex + ' finalized status=' + ev.status);
            assert.strictEqual(Buffer.from(ev.responseBody).toString('utf8'), FIXED_BODY,
                'hub ' + ev.hubIndex + ' finalized a body the test server never served');

            const pubkeys = (ev.signatures || []).map((s) => String(s.pubkey).toLowerCase());
            assert.ok(pubkeys.length >= REDUNDANCY,
                'hub ' + ev.hubIndex + ' finalized with ' + pubkeys.length + ' sigs, expected >= ' + REDUNDANCY);

            const sources = pubkeys.map((pk) => srcOf.get(pk));
            assert.ok(sources.every((s) => s !== undefined),
                'hub ' + ev.hubIndex + ' finalized with a signer outside the seeded snapshot');
            assert.strictEqual(new Set(sources).size, sources.length,
                'hub ' + ev.hubIndex + ': a source signed twice in the finalized set (' + JSON.stringify(sources) + ')');
            assert.strictEqual(pubkeys.filter((pk) => whalePubkeys.has(pk)).length, 1,
                'hub ' + ev.hubIndex + ': the 3-key whale contributed ' +
                pubkeys.filter((pk) => whalePubkeys.has(pk)).length + ' signatures, expected exactly 1');
        }
    });

    it('WEIGHTED: a round with fewer distinct sources than REDUNDANCY finalizes on no hub', async function () {
        seeded = seedLiveSnapshot(mvh, dedupStarvedValidators, 'regtest');
        const events = await driveAttestationRound(mvh, starvedRid, testUrl, REDUNDANCY, 0);

        // Deterministic half: _startRound refuses before consensus, so no hub may
        // hold a live round for this request id at all. The event budget above
        // then only has to rule out a late finalize.
        for (let i = 0; i < mvh.hubs.length; i++) {
            assert.strictEqual(mvh.hubs[i].attestationConsensus.isRoundActive(starvedRid), false,
                'hub ' + i + ' admitted a consensus round for a request with too few distinct sources');
        }
        assert.strictEqual(events.length, 0,
            'a round finalized on ' + events.length + ' hub(s) with only 2 distinct sources for redundancy ' +
            REDUNDANCY + ': ' + JSON.stringify(events.map((e) => ({
                hub:  e.hubIndex,
                sigs: (e.signatures || []).map((s) => String(s.pubkey).slice(0, 8))
            }))));
    });

    // The control for the case above, and the reason it means anything: SAME
    // request id, SAME validator set, only the activation flag differs. Without
    // it, "no hub finalized" is indistinguishable from a federation that never
    // finalizes anything, which is how a green refusal test certifies nothing.
    // It runs after that case so the shared request id reaches consensus clean
    // (the weighted round is refused in _startRound and never registers a
    // pending round or a fetch-cache row).
    it('CONTROL (dedup off): the SAME round finalizes, with >=2 of its signatures from the one whale source', async function () {
        const srcOf = sourceOfKey(dedupStarvedValidators);

        // network '' -> isStakeWeightedQuorumActive() is false -> the legacy count
        // path, i.e. how this round behaved before the source-dedup landed.
        seeded = seedLiveSnapshot(mvh, dedupStarvedValidators, '');
        const events = await driveAttestationRound(mvh, starvedRid, testUrl, REDUNDANCY, REDUNDANCY);

        assert.ok(events.length > 0,
            'the count path finalized nothing either, so the refusal above is not evidence of dedup');
        const ev      = events[0];
        const sources = (ev.signatures || []).map((s) => srcOf.get(String(s.pubkey).toLowerCase()));
        assert.ok(ev.signatures.length >= REDUNDANCY,
            'control finalized with ' + ev.signatures.length + ' sigs, expected >= ' + REDUNDANCY);
        assert.ok(sources.filter((s) => s === 'whale').length >= 2,
            'control did not reproduce the slot inflation the dedup exists to close: ' + JSON.stringify(sources));
    });
});
