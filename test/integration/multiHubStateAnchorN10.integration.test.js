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
 **********************************************************************
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

const dotenv = require('dotenv');
dotenv.config();

const assert = require('assert');
const { MultiValidatorHub, ValidatorIdentity } = require('../helpers/multiValidatorHubHelper');
const { startDisposableHubDb } = require('../helpers/disposableHubDb');
const { seedWeightSnapshot }   = require('../helpers/seededWeightSnapshot');
const eq = require('../../../xchain-hub/src/equivocation_header.js');

const PEER_WAIT_MS = 12000;     // 10-node mesh (45 connections) needs time to form
const SETTLE_MS    = 10000;     // XCHK_SIGN propagation + finalize across 10 hubs
const BLOCK_INDEX  = 100;       // seeded BTC anchor (snapshot + election block); 100 % 4 = 0 -> live leader
const COUNT        = 10;
const QUORUM_SIGS  = 7;         // 3*tally > 2*S with equal weights => >=7 of 10 sources

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

// Mirror StateCheckpointEngine._checkpointRootSuffix (post-flag-day SPV root suffix).
const ROOT_SUFFIX = '|' + [TIP.state_root.toLowerCase(), String(TIP.state_root_version),
                           TIP.block_merkle_root.toLowerCase(), String(TIP.block_merkle_version)].join('|');

function wireCheckpointEngine(mvh) {
    for (const hub of mvh.hubs) {
        const cps = hub.stateCheckpoints;
        cps.network        = 'regtest';   // engine cached '' at construction (pre-seed)
        cps.chains         = ['BTC'];
        cps.confirmations  = 0;
        cps.indexers.BTC   = { url: 'http://stubbed', key: '' };
        cps._indexerCall   = async () => Object.assign({}, TIP);
    }
}

async function tickAll(mvh) {
    await Promise.all(mvh.hubs.map((h) => h.stateCheckpoints._tick().catch(() => {})));
    await sleep(SETTLE_MS);
}

async function checkpointRows(hub) {
    return hub.db.doQuery(
        'SELECT * FROM state_checkpoints WHERE chain = ? AND network = ? AND block_index = ?',
        ['BTC', 'regtest', TIP.block_index]);
}

describe('MultiValidatorHub: state-checkpoint signing at N=10 (C.2 matrix cell)', function () {
    this.timeout(300_000);

    describe('a healthy N=10 weighted federation finalizes on every hub (needs >=7 of 10)', function () {
        let db, mvh, seed;

        before(async function () {
            db = await startDisposableHubDb();
            if (!db) { console.log('Skipping N=10 checkpoint (positive): no env DB and Docker unavailable'); this.skip(); }
            mvh = new MultiValidatorHub({ count: COUNT, basePort: 31000, startCrossChain: true, startAttestation: false });
            await mvh.start();
            await sleep(PEER_WAIT_MS);
            const ids = mvh.identities;
            // Equal weights: S = 10*1000 = 10000; no source clears 2/3 alone, so the
            // round needs a genuine >=7-signer aggregate to pass 3*tally > 2*S.
            seed = seedWeightSnapshot(mvh, {
                blockIndex: BLOCK_INDEX,
                validators: ids.map((id, i) => ({ pubkey: id.pubkeyHex, source: 's' + i, weight: '1000' })),
            });
            wireCheckpointEngine(mvh);
        });

        after(async function () {
            if (seed) seed.restore();
            if (mvh) { await mvh.stop(); await mvh.dropDatabases(); }
            if (db)  { await db.stop(); }
        });

        it('the identical checkpoint lands on EVERY hub with a >=7-of-10 quorum', async function () {
            await tickAll(mvh);

            const rows = [];
            for (let i = 0; i < mvh.hubs.length; i++) {
                const r = await checkpointRows(mvh.hubs[i]);
                assert.strictEqual(r.length, 1, 'hub ' + i + ' must hold exactly one finalized checkpoint (got ' + r.length + ')');
                rows.push(r[0]);
            }

            const raw = ['XCHECKPOINT', 'BTC', 'regtest', String(TIP.block_index), TIP.block_hash,
                         TIP.ledger_hash, TIP.actions_hash, TIP.contract_hash,
                         String(rows[0].checkpoint_seq), String(BLOCK_INDEX)].join('|') + ROOT_SUFFIX;
            const canonical = eq.isEquivHeaderActive(BLOCK_INDEX, 'regtest')
                ? eq.buildEquivCanonical(eq.ENGINE_TAGS.CHECKPOINT,
                    'BTC|regtest|' + TIP.block_index + '|' + rows[0].checkpoint_seq, 0, raw)
                : raw;

            for (let i = 0; i < rows.length; i++) {
                assert.strictEqual(rows[i].ledger_hash, TIP.ledger_hash, 'hub ' + i + ' diverged on ledger_hash');
                const sigs = JSON.parse(rows[i].validator_signatures);
                const verifying = new Set();
                for (const s of sigs)
                    if (ValidatorIdentity.verify(canonical, s.sig, s.pubkey)) verifying.add(s.pubkey);
                assert.strictEqual(verifying.size, sigs.length,
                    'hub ' + i + ': every stored sig must verify over the canonical (got ' + verifying.size + '/' + sigs.length + ')');
                assert.ok(verifying.size >= QUORUM_SIGS,
                    'hub ' + i + ': N=10 equal-weight quorum needs >=' + QUORUM_SIGS + ' co-signers (got ' + verifying.size + ')');
            }
            const distinct = new Set(rows.map((r) => r.ledger_hash + '|' + r.checkpoint_seq));
            assert.strictEqual(distinct.size, 1, 'all hubs must hold the identical checkpoint');
        });
    });

    describe('a 6-of-10 live minority cannot finalize a checkpoint (boundary)', function () {
        let db, mvh, seed;

        before(async function () {
            db = await startDisposableHubDb();
            if (!db) { console.log('Skipping N=10 checkpoint (boundary): no env DB and Docker unavailable'); this.skip(); }
            // 6 live hubs; 4 offline placeholder sources sit in the snapshot (counting
            // toward S). 6000/10000 is one source below the >=7 quorum.
            mvh = new MultiValidatorHub({ count: 6, basePort: 31200, startCrossChain: true, startAttestation: false });
            await mvh.start();
            await sleep(PEER_WAIT_MS);
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
