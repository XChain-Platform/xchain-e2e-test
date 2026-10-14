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
 * L2 integration, live half of STAKE_WEIGHTED_QUORUM attestation source-dedup
 * (WI-1 Suite A2): the same dedup rule driven through real PBFT over live P2P.
 * Positive: one signature per distinct source, the whale exactly one. Negative:
 * fewer distinct sources than REDUNDANCY finalizes on no hub. Control: the same
 * round with dedup off (count path) finalizes with an inflated whale.
 *
 * Spec: the cross-chain quorum security spec §3.5, §3.7, §10; plan §A2.
 ********************************************************************/

'use strict';

// Covers the live weighted attestation source-dedup through PBFT. One part of multiHubAttestationWeighted.integration.test.js.

const dotenv = require('dotenv');
dotenv.config();

const assert = require('assert');
const http   = require('http');
const crypto = require('crypto');
const { MultiValidatorHub }    = require('../../helpers/multiValidatorHubHelper');
const { startDisposableHubDb } = require('../../helpers/disposableHubDb');

const REDUNDANCY     = 3;
const PROVIDER_FLOOR = '10000';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));


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
// count CONTROL below runs with weighting OFF, which sends startRound down
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
            block:        hub.resolveBtcLatestBlock,
            network:      hub.network
        };
        cs.getActiveWeightSnapshot = async () => fresh('*');
        cs.getWeightSnapshot       = async (capability) => fresh(capability);
        cs.getSnapshot             = async (capability) => fresh(capability);
        hub.resolveBtcLatestBlock = async () => LIVE_BLOCK;
        hub.network                = network;
        restores.push(() => {
            cs.getActiveWeightSnapshot = orig.activeWeight;
            cs.getWeightSnapshot       = orig.weight;
            cs.getSnapshot             = orig.count;
            hub.resolveBtcLatestBlock = orig.block;
            hub.network                = orig.network;
        });
    }
    return { restore() { restores.forEach((r) => r()); restores.length = 0; } };
}

// Drive ONE attestation round on every hub and return the finalize events.
// Non-responsible hubs return early inside startRound, so calling all of them
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
    await Promise.all(mvh.hubs.map((hub) => hub.attestationRound.startRound(request, LIVE_BLOCK + 3).catch(() => {})));
    if (expect > 0) await waitUntil(() => events.length >= expect, LIVE_FINALIZE_MS);
    else            await waitUntil(() => events.length > 0,       LIVE_QUIET_MS);
    mvh.hubs.forEach((hub, i) => hub.attestationConsensus.removeListener('request:finalized', listeners[i]));
    return events;
}


// All responsible hubs fetch the same fixed body, so byte-equality consensus
// converges in-process with no judge.
async function startFixedBodyServer() {
    let server, url;
    await new Promise((resolve) => {
        server = http.createServer((internalReq, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(FIXED_BODY);
        });
        server.listen(0, '127.0.0.1', () => {
            url = 'http://127.0.0.1:' + server.address().port + '/score';
            resolve();
        });
    });
    return { server, url };
}

// http_get refuses a non-https payload, and the test server is http on
// loopback. Patch the module the hubs' own registry holds (one require
// cache entry shared by all five) and restore it in after(), rather than
// patching by path: a path mismatch would leave the real fetch in place
// and every round would finalize as provider_error.
function patchHttpGet(mvh) {
    const httpGet = mvh.hubs[0].attestationRound.providerRegistry.getModule('http_get');
    assert.ok(httpGet && typeof httpGet.fetch === 'function', 'http_get provider module not resolvable from the hub registry');
    const origFetch = httpGet.fetch;
    httpGet.fetch = async function internalTestPatchedFetch(payload, options) {
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
    return { httpGet, origFetch };
}

// Every weight clears the http_get provider floor of 10000: these hubs
// run the REAL startRound, which filters below-floor sources out of the
// responsible set before deduping, and a starved set here would fail the
// assertions for the wrong reason.
//   weighted: 3 whale keys + 2 singles = 3 distinct sources, exactly REDUNDANCY,
//             so the weighted round is finalizable and every slot is a different source.
//   starved:  4 whale keys + 1 single = 2 distinct sources < REDUNDANCY:
//             unfinalizable under dedup, finalizable (with an inflated whale) without it.
function liveValidatorSets(ids) {
    return {
        weightedValidators: [
            { pubkey: ids[0], source: 'whale', weight: '50000' },
            { pubkey: ids[1], source: 'whale', weight: '50000' },
            { pubkey: ids[2], source: 'whale', weight: '50000' },
            { pubkey: ids[3], source: 'sA',    weight: '10000' },
            { pubkey: ids[4], source: 'sB',    weight: '10000' }
        ],
        dedupStarvedValidators: [
            { pubkey: ids[0], source: 'whale', weight: '50000' },
            { pubkey: ids[1], source: 'whale', weight: '50000' },
            { pubkey: ids[2], source: 'whale', weight: '50000' },
            { pubkey: ids[3], source: 'whale', weight: '50000' },
            { pubkey: ids[4], source: 'sA',    weight: '10000' }
        ]
    };
}

const sourceOfKey = (list) => new Map(list.map((v) => [String(v.pubkey).toLowerCase(), String(v.source)]));

// Pick the shared request id up front: it has to be one where the COUNT
// rule actually inflates the whale, otherwise the control below would
// finalize a set the dedup had no reason to change and the pair would
// prove nothing.
function pickStarvedRid(mvh, starvedValidators) {
    const ar        = mvh.hubs[0].attestationRound;
    const starvedOf = sourceOfKey(starvedValidators);
    for (let i = 0; i < 2000; i++) {
        const rid = crypto.createHash('sha256').update('a2-live-starved-' + i).digest('hex');
        const set = ar.computeResponsibleSet(starvedValidators, rid, REDUNDANCY, false, PROVIDER_FLOOR);
        if (set.filter((v) => starvedOf.get(v.pubkey) === 'whale').length >= 2) return rid;
    }
    return undefined;
}

// PBFT only converges once the mesh is up, so wait on the sockets rather
// than on a fixed settle: a slow venue would otherwise start the round
// into a half-connected federation and read as a consensus failure.
async function startLiveFederation() {
    const mvh = new MultiValidatorHub({ count: 5, basePort: LIVE_BASE_PORT });
    await mvh.start();
    const meshed = await waitUntil(
        () => mvh.hubs.every((hub) => openPeerCount(hub) >= mvh.hubs.length - 1), LIVE_MESH_MS);
    assert.ok(meshed, 'hubs did not form a full mesh: ' +
        JSON.stringify(mvh.hubs.map((hub) => openPeerCount(hub))));
    return mvh;
}

function assertOneSignaturePerSource(events, srcOf, whalePubkeys) {
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
}

function assertStarvedRoundRefused(mvh, events, starvedRid) {
    // Deterministic half: startRound refuses before consensus, so no hub may
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
}

// The control for the case above, and the reason it means anything: SAME
// request id, SAME validator set, only the activation flag differs. Without
// it, "no hub finalized" is indistinguishable from a federation that never
// finalizes anything, which is how a green refusal test certifies nothing.
// It runs after that case so the shared request id reaches consensus clean
// (the weighted round is refused in startRound and never registers a
// pending round or a fetch-cache row).
function assertControlInflatesWhale(events, srcOf) {
    assert.ok(events.length > 0,
        'the count path finalized nothing either, so the refusal above is not evidence of dedup');
    const ev      = events[0];
    const sources = (ev.signatures || []).map((s) => srcOf.get(String(s.pubkey).toLowerCase()));
    assert.ok(ev.signatures.length >= REDUNDANCY,
        'control finalized with ' + ev.signatures.length + ' sigs, expected >= ' + REDUNDANCY);
    assert.ok(sources.filter((s) => s === 'whale').length >= 2,
        'control did not reproduce the slot inflation the dedup exists to close: ' + JSON.stringify(sources));
}

describe('MultiValidatorHub: LIVE weighted attestation source-dedup through PBFT (WI-1 Suite A2, L2)', function () {
    this.timeout(600_000);

    let db, mvh, server, testUrl, seeded, patch;
    let whalePubkeys, sets, starvedRid;   // starvedRid is shared by the starved case and its control

    before(async function () {
        db = await startDisposableHubDb();
        if (!db) { console.log('Skipping A2 live: no env DB and Docker unavailable'); this.skip(); }
        ({ server, url: testUrl } = await startFixedBodyServer());
        mvh = await startLiveFederation();
        patch = patchHttpGet(mvh);
        // The leader's publisher broadcasts on finalize; there is no chain here,
        // so hand it a hook that reports a synthetic txid.
        mvh.setBroadcastHook(async () => ({ txid: 'de'.repeat(32) }));

        const ids = mvh.identities.map((id) => String(id.pubkeyHex).toLowerCase());
        whalePubkeys = new Set([ids[0], ids[1], ids[2]]);
        sets = liveValidatorSets(ids);
        starvedRid = pickStarvedRid(mvh, sets.dedupStarvedValidators);
        assert.ok(starvedRid, 'no request id gave the whale >=2 count-path slots (4 of 5 keys)');
    });

    after(async function () {
        if (seeded) seeded.restore();
        if (patch) patch.httpGet.fetch = patch.origFetch;
        if (server) await new Promise((r) => server.close(() => r()));
        if (mvh) { await mvh.stop(); await mvh.dropDatabases(); }
        if (db)  { await db.stop(); }
    });

    afterEach(function () { if (seeded) { seeded.restore(); seeded = null; } });

    it('WEIGHTED: the finalized response carries one signature per distinct source, the whale exactly one', async function () {
        const rid = crypto.createHash('sha256').update('a2-live-weighted').digest('hex');
        seeded = seedLiveSnapshot(mvh, sets.weightedValidators, 'regtest');
        const events = await driveAttestationRound(mvh, rid, testUrl, REDUNDANCY, REDUNDANCY);
        assert.strictEqual(events.length, REDUNDANCY,
            'expected all ' + REDUNDANCY + ' responsible hubs to finalize, got ' + events.length);
        assertOneSignaturePerSource(events, sourceOfKey(sets.weightedValidators), whalePubkeys);
    });

    it('WEIGHTED: a round with fewer distinct sources than REDUNDANCY finalizes on no hub', async function () {
        seeded = seedLiveSnapshot(mvh, sets.dedupStarvedValidators, 'regtest');
        const events = await driveAttestationRound(mvh, starvedRid, testUrl, REDUNDANCY, 0);
        assertStarvedRoundRefused(mvh, events, starvedRid);
    });

    it('CONTROL (dedup off): the SAME round finalizes, with >=2 of its signatures from the one whale source', async function () {
        // network '' -> isStakeWeightedQuorumActive() is false -> the legacy count
        // path, i.e. how this round behaved before the source-dedup landed.
        seeded = seedLiveSnapshot(mvh, sets.dedupStarvedValidators, '');
        const events = await driveAttestationRound(mvh, starvedRid, testUrl, REDUNDANCY, REDUNDANCY);
        assertControlInflatesWhale(events, sourceOfKey(sets.dedupStarvedValidators));
    });
});
