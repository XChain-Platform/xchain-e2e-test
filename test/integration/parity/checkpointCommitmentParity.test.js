/*********************************************************************
 *
 * Copyright (c) 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 * SPV light-client Phase 2: cross-service CHECKPOINT-COMMITMENT parity.
 *
 * Phase 2 makes the quorum-signed checkpoint canonical (and every ANCHOR v0 bundle
 * SECTION) additively commit the light-client roots `STATE_ROOT|STATE_ROOT_VERSION|
 * BLOCK_MERKLE_ROOT|BLOCK_MERKLE_VERSION`, gated on the BTC `snapshot_block` by the
 * CHECKPOINT_COMMITMENT flag-day. The signed string is built INLINE in four places
 * (hub engine, SDK verifier, indexer ANCHOR verifier, explorer verify endpoint) plus
 * the activation map is one registry row (checkpoint_commitment_activation
 * .CHECKPOINT_COMMITMENT_ACTIVATION) carried by the byte-twin registry parts of FIVE
 * services (hub, indexer, sdk, explorer, and xchain-sync, which reads it at
 * checkpoint.js to decide whether the follower's checkpoint canonical carries the
 * root suffix) and read through each one's activeAt. A single
 * byte of drift between any two of these silently breaks federation quorum
 * verification (a signer set whose canonical differs produces zero valid
 * signatures), so this guards:
 *
 *   1. The CHECKPOINT_COMMITMENT_ACTIVATION row is value-equal across all five
 *      registries (hub/indexer/sdk/explorer/sync) AND the canonical
 *      xchain-documentation/protocol/constants.js, and every registry's activeAt
 *      agrees on the verdict.
 *   2. The post-flag-day checkpoint canonical (with the root suffix) is byte-identical
 *      across the hub engine, the SDK verifier, and the indexer's v0 SECTION verifier.
 *   3. The pre-flag-day canonical (no suffix) is likewise byte-identical, and the
 *      suffix is genuinely absent.
 *   4. A null-root row (legacy / pre-Phase-1) stays on the rootless canonical even
 *      post-flag-day (the presence-aware gate), so old signatures still verify.
 *
 * The explorer's inline copy is exercised against the SDK in the explorer's own unit
 * suite (explorer_checkpoints.test.js); here we cover the three callable builders.
 *
 * Spec: SPV light-client spec s6; Phase 2 handover.
 ********************************************************************/

'use strict';

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const ROOT = path.resolve(__dirname, '../../../..');

const protocolConstants = require(path.join(ROOT, 'xchain-documentation/protocol/constants.js'));
// Each service's activation registry (the same entry tail in every repo; the
// indexer's is the consumer-shaped entry over its protocol_changes parts). The
// flag-day map is the row below, and the predicate is activeAt over the BTC
// snapshot_block, which is what every consumer calls since W5.
const CKPT_KEY = 'checkpoint_commitment_activation.CHECKPOINT_COMMITMENT_ACTIVATION';
const REGISTRY_ENTRY = 'src/consensus/gate_registry.js';
const hubCkpt  = require(path.join(ROOT, 'xchain-hub', REGISTRY_ENTRY));
const idxCkpt  = require(path.join(ROOT, 'xchain-indexer', REGISTRY_ENTRY));
const sdkCkpt  = require(path.join(ROOT, 'xchain-sdk', REGISTRY_ENTRY));
const expCkpt  = require(path.join(ROOT, 'xchain-explorer', REGISTRY_ENTRY));
// Fifth registry: xchain-sync reads the row at checkpoint.js
// (isCheckpointCommitmentActive), now guarded by this parity loop too
// (uuid 77/229/326).
const syncCkpt = require(path.join(ROOT, 'xchain-sync', REGISTRY_ENTRY));

const StateCheckpointEngine = require(path.join(ROOT, 'xchain-hub/src/anchor/checkpoint_engine.js'));
const sdkCheckpoint         = require(path.join(ROOT, 'xchain-sdk/src/checkpoint.js'));
const Anchor                = require(path.join(ROOT, 'xchain-indexer/src/actions/anchor/index.js'));

// The indexer ANCHOR canonical is a plain method that reads only its `d` argument
// (no `this`), so invoke it directly off the prototype. `d` is ONE v0 bundle section,
// already rebuilt with the header NETWORK and carrying its own SECTION_SNAPSHOT_BLOCK
// as SNAPSHOT_BLOCK, which is the shape the parser hands it.
function anchorSectionCanonical(d) {
    return Anchor.prototype.canonical.call({}, d);
}

// One logical checkpoint, expressed in BOTH the hub/SDK row shape and the indexer
// wire-parse `d` shape, so a single fixture drives all three builders.
function fixtures(net, snapshotBlock, withRoots) {
    const STATE_ROOT    = 'd4'.repeat(32);
    const BLOCK_MERKLE  = 'e5'.repeat(32);
    const cp = {
        chain: 'BTC', network: net, block_index: 500, block_hash: 'c0'.repeat(32),
        ledger_hash: 'a1'.repeat(32), actions_hash: 'b2'.repeat(32), contract_hash: 'c3'.repeat(32),
        checkpoint_seq: 7, snapshot_block: snapshotBlock,
        state_root:           withRoots ? STATE_ROOT : null,
        state_root_version:   withRoots ? 1 : null,
        block_merkle_root:    withRoots ? BLOCK_MERKLE : null,
        block_merkle_version: withRoots ? 1 : null
    };
    const d = {
        // A v0 SECTION is root-bearing by construction: the publisher skips a null-root
        // row rather than emitting a rootless section (D8), so the rootless shape has no
        // FORMAT on the checkpoint leg at all and exercises _canonical's shared base.
        FORMAT: withRoots ? 0 : undefined,
        CHAIN: 'BTC', NETWORK: net, BLOCK_INDEX_CHECKPOINTED: 500, BLOCK_HASH: 'c0'.repeat(32),
        LEDGER_HASH: 'a1'.repeat(32), ACTIONS_HASH: 'b2'.repeat(32), CONTRACT_HASH: 'c3'.repeat(32),
        CHECKPOINT_SEQ: 7, SNAPSHOT_BLOCK: snapshotBlock,
        STATE_ROOT: withRoots ? STATE_ROOT : undefined,
        STATE_ROOT_VERSION: withRoots ? 1 : undefined,
        BLOCK_MERKLE_ROOT: withRoots ? BLOCK_MERKLE : undefined,
        BLOCK_MERKLE_VERSION: withRoots ? 1 : undefined
    };
    return { cp, d, STATE_ROOT, BLOCK_MERKLE };
}

describe('SPV Phase 2: CHECKPOINT_COMMITMENT cross-service parity', function () {

    it('the activation map is byte-equal across all five local copies and the canonical SoT', function () {
        const canonical = protocolConstants.CHECKPOINT_COMMITMENT_ACTIVATION;
        assert.ok(canonical, 'documentation/protocol/constants.js must export CHECKPOINT_COMMITMENT_ACTIVATION');
        for (const [name, mod] of [['hub', hubCkpt], ['indexer', idxCkpt], ['sdk', sdkCkpt], ['explorer', expCkpt], ['sync', syncCkpt]]) {
            assert.deepStrictEqual(mod.copy(CKPT_KEY), canonical,
                name + ' CHECKPOINT_COMMITMENT_ACTIVATION drifted from the canonical protocol constant');
        }
    });

    it('every local isCheckpointCommitmentActive agrees on the verdict for the same input', function () {
        for (const net of ['mainnet', 'testnet', 'regtest']) {
            for (const sb of [0, 100, 1000, 999999998, 999999999, 1000000000]) {
                const verdicts = [hubCkpt, idxCkpt, sdkCkpt, expCkpt, syncCkpt].map(m => m.activeAt(CKPT_KEY, net, null, sb, null));
                assert.ok(verdicts.every(v => v === verdicts[0]),
                    'gate verdict disagreement for ' + net + '@' + sb + ': ' + JSON.stringify(verdicts));
            }
        }
    });

    it('post-flag-day: hub == SDK == indexer ANCHOR v0 section canonical (root suffix present)', function () {
        // regtest flag-day is 0, so snapshot_block 100 is active; roots present. This is
        // the string a section's stored validator signatures were produced over, and the
        // one the indexer rebuilds from the wire before checking quorum: three services,
        // three inline builders, one byte string.
        const { cp, d, STATE_ROOT, BLOCK_MERKLE } = fixtures('regtest', 100, true);
        const hubC = StateCheckpointEngine.canonicalCheckpoint(cp);
        const sdkC = sdkCheckpoint.canonicalCheckpoint(cp);
        const idxC = anchorSectionCanonical(d);
        assert.strictEqual(hubC, sdkC, 'hub vs SDK checkpoint canonical drift');
        assert.strictEqual(hubC, idxC, 'hub vs indexer ANCHOR v0 section canonical drift');
        assert.ok(hubC.includes('|' + STATE_ROOT + '|1|' + BLOCK_MERKLE + '|1'),
            'post-flag-day canonical must commit the root suffix; got ' + hubC);
    });

    it('pre-flag-day: hub == SDK == indexer canonical, and the root suffix is absent', function () {
        // mainnet flag-day is the far-future placeholder, so snapshot_block 1000 is inactive
        // and the row carries null roots. No v0 section is ever cut here (a rootless row is
        // skipped, D8), so the indexer side is canonical's shared rootless base, which the
        // archive leg still signs and which the v0 branch extends.
        const { cp, d, STATE_ROOT, BLOCK_MERKLE } = fixtures('mainnet', 1000, false);
        const hubC = StateCheckpointEngine.canonicalCheckpoint(cp);
        const sdkC = sdkCheckpoint.canonicalCheckpoint(cp);
        const idxC = anchorSectionCanonical(d);
        assert.strictEqual(hubC, sdkC, 'hub vs SDK pre-flag-day canonical drift');
        assert.strictEqual(hubC, idxC, 'hub vs indexer rootless base canonical drift');
        assert.ok(!hubC.includes(STATE_ROOT) && !hubC.includes(BLOCK_MERKLE),
            'pre-flag-day canonical must NOT contain any root');
    });

    it('explorer merkle.js is a byte-identical twin of the indexer merkle.js (Phase 3 proof server)', function () {
        // The Phase 3 proof server builds SMT/block proofs with an explorer-local copy
        // of merkle.js; a client recomputes with the SDK's merkle logic and binds to the
        // indexer-committed root. A single byte of drift makes server proofs unverifiable.
        //
        // The explorer carries this twin at src/consensus/merkle.js, its layout-pass home,
        // and at src/merkle.js before that move lands. Either spelling is read so the
        // guard holds on both sides of the move; a checkout with neither fails naming
        // both paths rather than skipping, because a skipped twin guard is how a copy
        // drifts without a red run.
        const idx = fs.readFileSync(path.join(ROOT, 'xchain-indexer/src/consensus/merkle.js'), 'utf8');
        const candidates = ['xchain-explorer/src/consensus/merkle.js', 'xchain-explorer/src/merkle.js'];
        const rel = candidates.find((p) => fs.existsSync(path.join(ROOT, p)));
        assert.ok(rel, 'the explorer merkle.js twin resolved at neither '
            + candidates.map((p) => path.join(ROOT, p)).join(' nor '));
        const exp = fs.readFileSync(path.join(ROOT, rel), 'utf8');
        assert.strictEqual(exp, idx, rel + ' drifted from the indexer merkle.js');
    });

    it('sdk merkle.js is a byte-identical twin of the indexer merkle.js (Phase 4 light client)', function () {
        // The Phase 4 sdk.light client recomputes balances_root / block_merkle_root
        // and the state-root sub-path with an sdk-local copy of merkle.js, binding to
        // the indexer-committed root. A single byte of drift makes a valid server proof
        // fail to verify (or, worse, lets a forged one pass), so it must match exactly.
        const idx = fs.readFileSync(path.join(ROOT, 'xchain-indexer/src/consensus/merkle.js'), 'utf8');
        const sdk = fs.readFileSync(path.join(ROOT, 'xchain-sdk/src/merkle.js'), 'utf8');
        assert.strictEqual(sdk, idx, 'xchain-sdk/src/merkle.js drifted from the indexer merkle.js');
    });

    it('checkpoint_commitment_activation.js executable code is byte-identical across all five copies', function () {
        // The predicate-only module is gone since W5: the map is the registry row
        // and the predicate is the registry's own activeAt, so this compares the
        // registry core every consumer carries as a byte twin of the indexer's
        // (the platform twin reconcile holds those). The row itself is what can
        // still drift: the value case above holds its values, and this case pins
        // its SHAPE (every network the canonical map names, and no other) in
        // every registry, so a slot added on one side only is caught even when
        // the probed heights read the same verdict.
        const canonical = Object.keys(protocolConstants.CHECKPOINT_COMMITMENT_ACTIVATION).sort();
        for (const [name, mod] of [['hub', hubCkpt], ['sdk', sdkCkpt], ['explorer', expCkpt], ['sync', syncCkpt]]) {
            assert.deepStrictEqual(Object.keys(mod.copy(CKPT_KEY)).sort(), Object.keys(idxCkpt.copy(CKPT_KEY)).sort(),
                name + ' checkpoint_commitment_activation row names a different network set from the indexer row');
            assert.deepStrictEqual(Object.keys(mod.copy(CKPT_KEY)).sort(), canonical,
                name + ' checkpoint_commitment_activation row names a different network set from the canonical map');
        }
    });

    it('post-flag-day but null roots (legacy row): hub/SDK keep the rootless canonical', function () {
        // A pre-Phase-1 / legacy row carries null roots even though its snapshot_block is
        // post-flag-day. The presence-aware gate keeps it on the rootless canonical so its
        // original (rootless) signatures still verify.
        const withRoots    = fixtures('regtest', 100, true);
        const withoutRoots = fixtures('regtest', 100, false);   // same fields, null roots
        const hubNull = StateCheckpointEngine.canonicalCheckpoint(withoutRoots.cp);
        const sdkNull = sdkCheckpoint.canonicalCheckpoint(withoutRoots.cp);
        assert.strictEqual(hubNull, sdkNull, 'hub vs SDK null-root canonical drift');
        assert.ok(!hubNull.includes(withRoots.STATE_ROOT) && !hubNull.includes(withRoots.BLOCK_MERKLE),
            'null-root canonical must not append a root suffix');
        assert.notStrictEqual(hubNull, StateCheckpointEngine.canonicalCheckpoint(withRoots.cp),
            'a null-root and a rooted checkpoint must not share a canonical');
    });
});
