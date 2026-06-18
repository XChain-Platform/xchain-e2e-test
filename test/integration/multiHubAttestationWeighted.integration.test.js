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
 * Spec: claude/reports/2026-06-14_cross-chain-quorum-security-spec.md §3.5, §3.7,
 * §10; plan §A2.
 ********************************************************************/

'use strict';

const dotenv = require('dotenv');
dotenv.config();

const assert = require('assert');
const { MultiValidatorHub }    = require('../helpers/multiValidatorHubHelper');
const { startDisposableHubDb } = require('../helpers/disposableHubDb');

const PEER_WAIT_MS = 6000;
const REDUNDANCY   = 3;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One WHALE source delegating 5 keys + four single-key small sources (9 keys, 5
// sources). Pubkeys are arbitrary distinct 32-byte hex; the selection only
// hashes them, it never verifies a signature here.
function hx(n) { return String(n).padStart(2, '0').repeat(32); }
const VALIDATORS = [
    { pubkey: hx(1),  source: 'whale', weight: '5000' },
    { pubkey: hx(2),  source: 'whale', weight: '5000' },
    { pubkey: hx(3),  source: 'whale', weight: '5000' },
    { pubkey: hx(4),  source: 'whale', weight: '5000' },
    { pubkey: hx(5),  source: 'whale', weight: '5000' },
    { pubkey: hx(11), source: 'sA',    weight: '1000' },
    { pubkey: hx(12), source: 'sB',    weight: '1000' },
    { pubkey: hx(13), source: 'sC',    weight: '1000' },
    { pubkey: hx(14), source: 'sD',    weight: '1000' },
];
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
        await sleep(PEER_WAIT_MS);
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
            const set = ar._computeResponsibleSet(VALIDATORS, rid, REDUNDANCY, true);
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
            const countSet = ar._computeResponsibleSet(VALIDATORS, rid, REDUNDANCY, false);
            if (whaleSlots(countSet) >= 2) witness = rid;
        }
        assert.ok(witness, 'expected some requestId where the count path gives the whale ≥2 slots (5 of 9 keys)');

        // Same rid, weighted: the whale collapses to exactly one slot, all sources distinct.
        const weightedSet = ar._computeResponsibleSet(VALIDATORS, witness, REDUNDANCY, true);
        assert.strictEqual(whaleSlots(weightedSet), 1,
            'witness ' + witness + ': weighting must collapse the whale to exactly one slot (got ' + whaleSlots(weightedSet) + ')');
        const srcs = sourcesOf(weightedSet);
        assert.strictEqual(new Set(srcs).size, srcs.length, 'witness ' + witness + ': weighted set has a duplicate source');
    });
});
