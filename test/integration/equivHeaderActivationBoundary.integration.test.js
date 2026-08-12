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
 * L2 integration: EQUIV_HEADER (WI-2 bump 2) ACTIVATION BOUNDARY.
 *
 * Phase A step A4 (the live flag-day no-fork drill) of the EQUIV signed-header
 * work. The WI-2 twin of multiHubActivationBoundary.integration.test.js: proves the
 * headerless→header-wrapped transition is a clean, fork-free flag-day across a real
 * P2P federation, and that pre-gate (headerless) signatures can never be promoted
 * into a SLASH equivocation proof.
 *
 * Driver: the state-checkpoint round (StateCheckpointEngine: XCHK_SIGN_REQ →
 * XCHK_SIGN → XCHK_FINALIZED), the same engine proven in
 * multiHubStateAnchorWeighted.integration.test.js. The signed canonical lands
 * durably in state_checkpoints.validator_signatures, so we can inspect the exact
 * bytes each hub signed.
 *
 * The seam that makes this a TIGHT no-fork test: the checkpoint's block_index comes
 * from the (identical, stubbed) indexer TIP, while the EQUIV gate keys on the
 * snapshot_block (the seeded anchor/election block). So we drive the SAME
 * fixture at snapshot_block ACT-1 (below → headerless) vs ACT+1 (above → wrapped),
 * and the RAW canonical is byte-identical on both sides (same block_index, ledger
 * content, checkpoint_seq=1 on a fresh DB). The header is the ONLY delta at the
 * flag-day:
 *
 *   - BELOW (ACT-1): every hub signs the bare raw canonical; the stored sigs verify
 *     against the raw bytes, NOT against the wrapped bytes; the canonical does NOT
 *     begin with `EQUIV|` → it carries no equivocation key → it can never be one of
 *     the two messages in a SLASH proof.
 *   - ABOVE (ACT+1): every hub signs `EQUIV|XCHECKPOINT|<round id>|0||<raw>`; the
 *     stored sigs verify against the wrapped bytes, NOT against the bare raw; the
 *     canonical begins with the exact equivocation prefix.
 *   - Across the boundary the checkpointed LEDGER (ledger_hash + checkpoint_seq) is
 *     identical (only the signature preimage changes). No ledger-hash divergence.
 *
 * Both sides run on SEPARATE fresh federations (fresh disposable DB, fresh seq),
 * mirroring multiHubActivationBoundary B1a/B1b: the no-fork property is asserted
 * across EVERY hub of each side, and the cross-side synthesis (raw-bytes-identical,
 * header-is-only-delta) is asserted once both have captured.
 *
 * REQUIRES a non-zero regtest EQUIV_HEADER_ACTIVATION in
 * xchain-hub/src/equivocation_header.js (regtest is 0 by default = always wrapped,
 * so the headerless side cannot be reached). Set regtest to e.g. 120 in ALL FIVE
 * copies (xchain-documentation/protocol/constants.js + hub + indexer + sdk +
 * explorer; the parity test enforces equality) for the run, then revert. The suite
 * SKIPS with a clear message when the height is still 0 so it never silently passes
 * as a wrapped-only test.
 *
 * Spec: the cross-chain quorum security spec §4.1.1, §5, §9.1; Phase A / A4 of
 * the EQUIV rollout plan.
 ********************************************************************/

'use strict';

const dotenv = require('dotenv');
dotenv.config();

const assert = require('assert');
const { MultiValidatorHub, ValidatorIdentity } = require('../helpers/multiValidatorHubHelper');
const { startDisposableHubDb } = require('../helpers/disposableHubDb');
const { seedWeightSnapshot }   = require('../helpers/seededWeightSnapshot');
const eq = require('../../../xchain-hub/src/equivocation_header.js');

const ACT = parseInt(eq.EQUIV_HEADER_ACTIVATION.regtest);

const PEER_WAIT_MS = 8000;
const SETTLE_MS    = 6000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Identical stubbed "indexer" tip on every hub: the checkpoint's block_index +
// ledger content. Held constant across the boundary so only the snapshot_block
// (the gate input) varies, and the raw canonical stays byte-identical.
const TIP = {
    coin: 'BTC', network: 'regtest', block_index: 500, block_time: 1700000000,
    block_hash: 'c0'.repeat(32), ledger_hash: 'a1'.repeat(32),
    actions_hash: 'b2'.repeat(32), contract_hash: 'c3'.repeat(32)
};

// Healthy uneven weights that clear the (always-on in regtest) weighted quorum so a
// checkpoint finalizes on every hub. S = 10000; any 2f+1 of the four clears
// 3·Σ > 2·S. All four hubs are live so the cadence leader (pubkeys[block % N]) is
// always a live hub regardless of which side of ACT the snapshot_block sits on.
const WEIGHTS = ['4000', '3000', '2000', '1000'];

function wireCheckpointEngine(mvh) {
    for (const hub of mvh.hubs) {
        const cps = hub.stateCheckpoints;
        cps.network       = 'regtest';   // engine caches '' at construction (pre-seed)
        cps.chains        = ['BTC'];
        cps.confirmations = 0;
        cps.indexers.BTC  = { url: 'http://stubbed', key: '' };
        cps._indexerCall  = async () => Object.assign({}, TIP);
    }
}

async function tickAll(mvh) {
    await Promise.all(mvh.hubs.map((h) => h.stateCheckpoints._tick().catch(() => {})));
    await sleep(SETTLE_MS);
}

function checkpointRows(hub) {
    return hub.db.doQuery(
        'SELECT * FROM state_checkpoints WHERE chain = ? AND network = ? AND block_index = ?',
        ['BTC', 'regtest', TIP.block_index]);
}

// Byte-for-byte mirror of StateCheckpointEngine._rawCanonicalCheckpoint.
function rawCanonical(row, snapshotBlock) {
    return ['XCHECKPOINT', 'BTC', 'regtest', String(TIP.block_index), TIP.block_hash,
            TIP.ledger_hash, TIP.actions_hash, TIP.contract_hash,
            String(row.checkpoint_seq), String(snapshotBlock)].join('|');
}

// VIEW is always 0 for checkpoints (no view change).
function v0RoundId(row) {
    return 'BTC|regtest|' + TIP.block_index + '|' + row.checkpoint_seq;
}

async function finalizeOnEveryHub(mvh) {
    await tickAll(mvh);
    const rows = [];
    for (let i = 0; i < mvh.hubs.length; i++) {
        const r = await checkpointRows(mvh.hubs[i]);
        assert.strictEqual(r.length, 1, 'hub ' + i + ' must hold exactly one finalized checkpoint (got ' + r.length + ')');
        rows.push(r[0]);
    }
    const distinct = new Set(rows.map((r) => r.ledger_hash + '|' + r.checkpoint_seq));
    assert.strictEqual(distinct.size, 1, 'all hubs must hold the identical checkpoint ledger');
    return rows;
}

function verifyingCount(row, canonical) {
    const sigs = JSON.parse(row.validator_signatures);
    const ok = new Set();
    for (const s of sigs)
        if (ValidatorIdentity.verify(canonical, s.sig, s.pubkey)) ok.add(s.pubkey);
    return ok.size;
}

describe('MultiValidatorHub: EQUIV_HEADER activation boundary (WI-2 bump 2 / A4, L2)', function () {
    this.timeout(300_000);

    let rawBelow = null;
    let rawAbove = null;

    before(function () {
        if (!Number.isFinite(ACT) || ACT < 2) {
            console.log(
'Skipping EQUIV_HEADER activation-boundary suite: regtest ' +
                'EQUIV_HEADER_ACTIVATION is ' + ACT + ' (must be >=2 to reach the headerless ' +
                'side). Set regtest to e.g. 120 in ALL FIVE EQUIV copies (constants.js + hub + ' +
                'indexer + sdk + explorer) for this run, then revert (plan A4).');
            this.skip();
        }
    });

    describe('BELOW the height every hub signs the bare headerless canonical', function () {
        let db, mvh, seed;
        before(async function () {
            db = await startDisposableHubDb();
            if (!db) { console.log('Skipping EQUIV boundary (below): no env DB and Docker unavailable'); this.skip(); }
            mvh = new MultiValidatorHub({ count: 4, basePort: 34200, startCrossChain: true, startAttestation: false });
            await mvh.start();
            await sleep(PEER_WAIT_MS);
            seed = seedWeightSnapshot(mvh, {
                blockIndex: ACT - 1,
                validators: mvh.identities.map((id, i) => ({ pubkey: id.pubkeyHex, source: 's' + i, weight: WEIGHTS[i] })),
            });
            wireCheckpointEngine(mvh);
        });
        after(async function () {
            if (seed) seed.restore();
            if (mvh) { await mvh.stop(); await mvh.dropDatabases(); }
            if (db)  { await db.stop(); }
        });

        it('the gate is OFF, sigs verify against RAW only, and the canonical carries NO equivocation key', async function () {
            assert.ok(!eq.isEquivHeaderActive(ACT - 1, 'regtest'),
                'block ' + (ACT - 1) + ' should be BELOW the EQUIV activation height');

            const rows = await finalizeOnEveryHub(mvh);
            const raw     = rawCanonical(rows[0], ACT - 1);
            const wrapped = eq.buildEquivCanonical(eq.ENGINE_TAGS.CHECKPOINT, v0RoundId(rows[0]), 0, raw);

            // Count-INDEPENDENT invariant: the weighted quorum can finalize with as few as
            // 2 of the 4 signers (4000+3000 > 2·S/3), so assert that EVERY stored sig (not
            // some fixed count) verifies against the raw form and none against the wrapped.
            for (let i = 0; i < rows.length; i++) {
                const total = JSON.parse(rows[i].validator_signatures).length;
                assert.strictEqual(rows[i].ledger_hash, TIP.ledger_hash, 'hub ' + i + ' diverged on ledger_hash');
                assert.ok(total >= 1, 'hub ' + i + ' must carry at least one quorum signature');
                assert.strictEqual(verifyingCount(rows[i], raw), total,
                    'hub ' + i + ': EVERY below-gate sig must verify against the bare raw canonical');
                assert.strictEqual(verifyingCount(rows[i], wrapped), 0,
                    'hub ' + i + ' below-gate sigs must NOT verify against the wrapped canonical (no header was signed)');
            }

            // SLASH-proof negative: a headerless canonical carries no EQUIV key, so a
            // SLASH verifier (which matches the literal `EQUIV|<key>||` prefix) can
            // never accept it as one of the two proof messages.
            assert.ok(!raw.startsWith('EQUIV|'),
                'a pre-gate canonical must not begin with the EQUIV header');
            assert.ok(!raw.startsWith(eq.equivPrefix(eq.equivKey(eq.ENGINE_TAGS.CHECKPOINT, v0RoundId(rows[0]), 0))),
                'a pre-gate canonical must not carry the equivocation prefix');

            rawBelow = raw;
        });
    });

    describe('ABOVE the height every hub signs the EQUIV-wrapped canonical', function () {
        let db, mvh, seed;
        before(async function () {
            db = await startDisposableHubDb();
            if (!db) { console.log('Skipping EQUIV boundary (above): no env DB and Docker unavailable'); this.skip(); }
            mvh = new MultiValidatorHub({ count: 4, basePort: 34300, startCrossChain: true, startAttestation: false });
            await mvh.start();
            await sleep(PEER_WAIT_MS);
            seed = seedWeightSnapshot(mvh, {
                blockIndex: ACT + 1,
                validators: mvh.identities.map((id, i) => ({ pubkey: id.pubkeyHex, source: 's' + i, weight: WEIGHTS[i] })),
            });
            wireCheckpointEngine(mvh);
        });
        after(async function () {
            if (seed) seed.restore();
            if (mvh) { await mvh.stop(); await mvh.dropDatabases(); }
            if (db)  { await db.stop(); }
        });

        it('the gate is ON, sigs verify against the WRAPPED canonical only, and the header prefix is exact', async function () {
            assert.ok(eq.isEquivHeaderActive(ACT + 1, 'regtest'),
                'block ' + (ACT + 1) + ' should be AT/ABOVE the EQUIV activation height');

            const rows = await finalizeOnEveryHub(mvh);
            const raw     = rawCanonical(rows[0], ACT + 1);
            const wrapped = eq.buildEquivCanonical(eq.ENGINE_TAGS.CHECKPOINT, v0RoundId(rows[0]), 0, raw);
            const prefix  = eq.equivPrefix(eq.equivKey(eq.ENGINE_TAGS.CHECKPOINT, v0RoundId(rows[0]), 0));

            assert.ok(wrapped.startsWith(prefix), 'wrapped canonical must begin with the exact equivocation prefix');

            for (let i = 0; i < rows.length; i++) {
                const total = JSON.parse(rows[i].validator_signatures).length;
                assert.strictEqual(rows[i].ledger_hash, TIP.ledger_hash, 'hub ' + i + ' diverged on ledger_hash');
                assert.ok(total >= 1, 'hub ' + i + ' must carry at least one quorum signature');
                assert.strictEqual(verifyingCount(rows[i], wrapped), total,
                    'hub ' + i + ': EVERY above-gate sig must verify against the EQUIV-wrapped canonical');
                assert.strictEqual(verifyingCount(rows[i], raw), 0,
                    'hub ' + i + ' above-gate sigs must NOT verify against the bare raw canonical (the header IS signed)');
            }

            rawAbove = raw;
        });
    });

    describe('the flag-day is fork-free: identical ledger, header is the only delta', function () {
        it('the raw ledger bytes are byte-identical across the boundary; only the EQUIV header differs', function () {
            if (rawBelow === null || rawAbove === null) {
                console.log('Skipping EQUIV boundary synthesis: one side did not capture (DB/Docker unavailable)');
                this.skip();
            }
            // snapshot_block is the LAST field of the raw canonical and is the only
            // thing that differs (ACT-1 vs ACT+1); strip it to compare the ledger.
            const ledgerOf = (raw) => raw.slice(0, raw.lastIndexOf('|'));
            assert.strictEqual(ledgerOf(rawBelow), ledgerOf(rawAbove),
                'the checkpointed ledger must be byte-identical across the activation boundary');

            // Below carries no header; above's signed preimage is exactly the wrapped
            // form of the same ledger content, so the transition adds the header and
            // nothing else (no ledger-hash divergence, no fork).
            assert.ok(!rawBelow.startsWith('EQUIV|'), 'below-gate canonical must be headerless');
            const wrappedAbove = eq.buildEquivCanonical(
                eq.ENGINE_TAGS.CHECKPOINT, 'BTC|regtest|' + TIP.block_index + '|1', 0, rawAbove);
            assert.ok(wrappedAbove.startsWith('EQUIV|XCHECKPOINT|'),
                'above-gate signed preimage must be the EQUIV-wrapped form of the same ledger');
        });
    });
});
