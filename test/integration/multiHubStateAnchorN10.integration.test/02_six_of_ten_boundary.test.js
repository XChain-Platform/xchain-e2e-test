/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available;
 * contact legal@dankest.llc.
 *
 * Track C.2: state-checkpoint signing at N=10 (validator-scale matrix cell).
 *
 * The N=10 twin of multiHubStateAnchorWeighted.integration.test.js. Ten hubs
 * over real P2P run the StateCheckpointEngine round (XCHK_SIGN_REQ ->
 * XCHK_SIGN -> finalize) under an EQUAL-weight snapshot (10 sources x 1000 =
 * S=10000). The weighted quorum 3*tally > 2*S needs tally > 6666, i.e. a real
 * >=7-of-10 multi-signer aggregate (3 slack, not the BFT floor), so the round
 * cannot finalize on a single supermajority signer.
 *
 *   POSITIVE: all 10 hubs live -> the identical checkpoint lands in every hub's
 *     state_checkpoints with >=7 verifying co-signatures.
 *   BOUNDARY: only 6 of the 10 snapshot sources are live (4 offline placeholders
 *     sit in the snapshot, counting toward S) -> 6000/10000 is below quorum, so
 *     NO checkpoint finalizes anywhere. Pins 7 as the exact tolerance at N=10.
 *
 * Pure in-process (the indexer view is stubbed to a shared TIP, no coin node).
 * Disposable Docker MariaDB; skips when neither an env DB nor Docker is
 * available. Run on Node 22 (see the C.2 venue recipe in TEST-CAMPAIGN.md).
 *
 ********************************************************************/

'use strict';

// Covers the six-of-ten checkpoint boundary. One part of multiHubStateAnchorN10.integration.test.js.

const dotenv = require('dotenv');
dotenv.config();

const assert = require('assert');
const { MultiValidatorHub, ValidatorIdentity } = require('../../helpers/multiValidatorHubHelper');
const { startDisposableHubDb } = require('../../helpers/disposableHubDb');
const { seedWeightSnapshot }   = require('../../helpers/seededWeightSnapshot');
const { waitForMesh, waitFor } = require('../../helpers/consensusWait');
const eq = require('../../../../xchain-hub/src/consensus/equivocation_header.js');

// A deadline, not a settle: waitForMesh returns on the first fully-peered poll.
const PEER_WAIT_MS = 60_000;    // 10-node mesh (45 connections)
// tickAll is shared by the healthy N=10 case and the 6-of-10 boundary case, so its
// window keeps its measured length and is spent POLLING: the healthy federation
// returns as soon as every hub holds its checkpoint, while the boundary case can
// never satisfy the poll and still watches the whole window.
const SETTLE_MS    = 10000;     // XCHK_SIGN propagation + finalize across 10 hubs
const BLOCK_INDEX  = 100;       // seeded BTC anchor (snapshot + election block); 100 % 4 = 0 -> live leader
const COUNT        = 10;
const QUORUM_SIGS  = 7;         // 3*tally > 2*S with equal weights => >=7 of 10 sources

// Identical stubbed "indexer" tip on every hub (mirrors multiHubStateAnchorWeighted).
const TIP = {
    coin: 'BTC', network: 'regtest', block_index: 500, block_time: 1700000000,
    block_hash: 'c0'.repeat(32), ledger_hash: 'a1'.repeat(32),
    actions_hash: 'b2'.repeat(32), contract_hash: 'c3'.repeat(32),
    // SPV Phase 2 (xchain-hub 08228c8): post-flag-day the checkpoint canonical signs
    // the indexer light-client roots; the engine refuses to finalize without them.
    state_root: 'd4'.repeat(32), state_root_version: 1,
    block_merkle_root: 'e5'.repeat(32), block_merkle_version: 1
};

// Mirror StateCheckpointEngine.checkpointRootSuffix (post-flag-day SPV root suffix).
const ROOT_SUFFIX = '|' + [TIP.state_root.toLowerCase(), String(TIP.state_root_version),
                           TIP.block_merkle_root.toLowerCase(), String(TIP.block_merkle_version)].join('|');

function wireCheckpointEngine(mvh) {
    for (const hub of mvh.hubs) {
        const cps = hub.stateCheckpoints;
        cps.network        = 'regtest';   // engine cached '' at construction (pre-seed)
        cps.chains         = ['BTC'];
        cps.confirmations  = 0;
        cps.indexers.BTC   = { url: 'http://stubbed', key: '' };
        cps.indexerCall   = async () => Object.assign({}, TIP);
    }
}

async function tickAll(mvh) {
    await Promise.all(mvh.hubs.map((h) => h.stateCheckpoints.tick().catch(() => {})));
    await waitFor(async () => {
        let held = 0;
        for (const hub of mvh.hubs) {
            try { if ((await checkpointRows(hub)).length >= 1) held++; }
            catch (_) { /* a hub that cannot be read has not stored it */ }
        }
        return { ok: held === mvh.hubs.length, held: held };
    }, { timeoutMs: SETTLE_MS });
}

async function checkpointRows(hub) {
    return hub.db.doQuery(
        'SELECT * FROM state_checkpoints WHERE chain = ? AND network = ? AND block_index = ?',
        ['BTC', 'regtest', TIP.block_index]);
}

describe('MultiValidatorHub: state-checkpoint signing at N=10 (C.2 matrix cell)', function () {
    this.timeout(300_000);


    describe('a 6-of-10 live minority cannot finalize a checkpoint (boundary)', function () {
        let db, mvh, seed;

        before(async function () {
            db = await startDisposableHubDb();
            if (!db) { console.log('Skipping N=10 checkpoint (boundary): no env DB and Docker unavailable'); this.skip(); }
            // 6 live hubs; 4 offline placeholder sources sit in the snapshot (counting
            // toward S). 6000/10000 is one source below the >=7 quorum.
            mvh = new MultiValidatorHub({ count: 6, basePort: 31200, startCrossChain: true, startAttestation: false });
            await mvh.start();
            await waitForMesh(mvh, { timeoutMs: PEER_WAIT_MS });
            const ids = mvh.identities;
            const offline = ['f0', 'f1', 'f2', 'f3'].map((p) => p.repeat(32));   // distinct, never live
            const validators = ids.map((id, i) => ({ pubkey: id.pubkeyHex, source: 's' + i, weight: '1000' }))
                .concat(offline.map((pk, i) => ({ pubkey: pk, source: 'off' + i, weight: '1000' })));
            seed = seedWeightSnapshot(mvh, { blockIndex: BLOCK_INDEX, validators });
            wireCheckpointEngine(mvh);
        });

        after(async function () {
            if (seed) seed.restore();
            if (mvh) { await mvh.stop(); await mvh.dropDatabases(); }
            if (db)  { await db.stop(); }
        });

        it('6 live of 10 is below quorum: no checkpoint is stored on any hub', async function () {
            await tickAll(mvh);
            for (let i = 0; i < mvh.hubs.length; i++) {
                const rows = await checkpointRows(mvh.hubs[i]);
                assert.strictEqual(rows.length, 0,
                    'hub ' + i + ' finalized a checkpoint a 6-of-10 minority must never carry (got ' + rows.length + ' rows)');
            }
        });
    });
});
