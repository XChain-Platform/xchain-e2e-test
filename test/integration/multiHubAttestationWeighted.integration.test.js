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
 * The fix (operator-ratified): when weighted, AttestationRound.computeResponsibleSet
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
 * computeResponsibleSet is a pure ranking over the seeded validator set (no P2P,
 * no providers, no chain); we boot one real hub for a fully-constructed
 * AttestationRound and call it directly. Disposable Docker MariaDB; skips when
 * neither an env DB nor Docker is available.
 *
 * The second describe drives the SAME rule through the live pipeline, because the
 * pure-helper tests above cannot see a wiring regression: a change that stopped
 * passing `weighted` into computeResponsibleSet, or that recomputed the set
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
const { MultiValidatorHub }    = require('../helpers/multiValidatorHubHelper');
const { startDisposableHubDb } = require('../helpers/disposableHubDb');

const PEER_WAIT_MS = 60_000;   // a deadline for the bring-up poll below, not a settle
const REDUNDANCY   = 3;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Poll a condition to a deadline rather than a fixed `await sleep(n)` before an
// assertion, which passes or fails on how busy the venue is
// (scripts/check-sleep-flake.js ratchets that shape).
async function waitUntil(predicate, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await predicate()) return true;
        await sleep(250);
    }
    return false;
}

// One WHALE source delegating 5 keys + four single-key small sources (9 keys, 5
// sources). Pubkeys are arbitrary distinct 32-byte hex; the selection only
// hashes them, it never verifies a signature here.
function hx(n) { return String(n).padStart(2, '0').repeat(32); }
const VALIDATORS = [
    // Weights are all above the http_get PROVIDER floor of 10000, which the
    // weighted responsible-set derivation applies before the source dedupe. This suite
    // isolates the dedupe rule, so nothing here may sit under the floor or the set
    // empties for a reason that has nothing to do with what is being asserted.
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
            return !!(round && typeof round.computeResponsibleSet === 'function');
        }, PEER_WAIT_MS);
        ar = mvh.hubs[0].attestationRound;
        assert.ok(ar && typeof ar.computeResponsibleSet === 'function', 'hub.attestationRound not available');
    });

    after(async function () {
        if (mvh) { await mvh.stop(); await mvh.dropDatabases(); }
        if (db)  { await db.stop(); }
    });

    it('WEIGHTED: every responsible slot is a distinct source; a multi-key source can take at most one slot', function () {
        for (let i = 0; i < 300; i++) {
            const rid = 'req-weighted-' + i;
            const set = ar.computeResponsibleSet(VALIDATORS, rid, REDUNDANCY, true, PROVIDER_FLOOR);
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
            const countSet = ar.computeResponsibleSet(VALIDATORS, rid, REDUNDANCY, false, PROVIDER_FLOOR);
            if (whaleSlots(countSet) >= 2) witness = rid;
        }
        assert.ok(witness, 'expected some requestId where the count path gives the whale ≥2 slots (5 of 9 keys)');

        // Same rid, weighted: the whale collapses to exactly one slot, all sources distinct.
        const weightedSet = ar.computeResponsibleSet(VALIDATORS, witness, REDUNDANCY, true, PROVIDER_FLOOR);
        assert.strictEqual(whaleSlots(weightedSet), 1,
            'witness ' + witness + ': weighting must collapse the whale to exactly one slot (got ' + whaleSlots(weightedSet) + ')');
        const srcs = sourcesOf(weightedSet);
        assert.strictEqual(new Set(srcs).size, srcs.length, 'witness ' + witness + ': weighted set has a duplicate source');
    });
});


// Run the split parts in this suite's lane; the stubbed lane ignores their directory.
require('./multiHubAttestationWeighted.integration.test/02_live_source_dedup_through_pbft.test');
