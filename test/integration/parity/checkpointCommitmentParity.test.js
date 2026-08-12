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
 * Phase 2 makes the quorum-signed checkpoint canonical (and the on-chain ANCHOR v3)
 * additively commit the light-client roots `STATE_ROOT|STATE_ROOT_VERSION|
 * BLOCK_MERKLE_ROOT|BLOCK_MERKLE_VERSION`, gated on the BTC `snapshot_block` by the
 * CHECKPOINT_COMMITMENT flag-day. The signed string is built INLINE in four places
 * (hub engine, SDK verifier, indexer ANCHOR verifier, explorer verify endpoint) plus
 * the activation map lives as a LOCAL COPY in FIVE services (hub, indexer, sdk,
 * explorer, and xchain-sync, which consumes it at checkpoint.js:53 to decide
 * whether the follower's checkpoint canonical carries the root suffix). A single
 * byte of drift between any two of these silently breaks federation quorum
 * verification (a signer set whose canonical differs produces zero valid
 * signatures), so this guards:
 *
 *   1. The CHECKPOINT_COMMITMENT_ACTIVATION map is byte-equal across all five local
 *      copies (hub/indexer/sdk/explorer/sync) AND the canonical
 *      xchain-documentation/protocol/constants.js.
 *   2. The post-flag-day checkpoint canonical (with the root suffix) is byte-identical
 *      across the hub engine, the SDK verifier, and the indexer ANCHOR v3 verifier.
 *   3. The pre-flag-day canonical (no suffix) is likewise byte-identical, and the
 *      suffix is genuinely absent.
 *   4. A null-root row (legacy / pre-Phase-1) stays on the rootless canonical even
 *      post-flag-day (the presence-aware gate), so old signatures still verify.
 *
 * The explorer's inline copy is exercised against the SDK in the explorer's own unit
 * suite (explorer.checkpoints.test.js); here we cover the three callable builders.
 *
 * Spec: SPV light-client spec s6; Phase 2 handover.
 ********************************************************************/

'use strict';

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const ROOT = path.resolve(__dirname, '../../../..');

const protocolConstants = require(path.join(ROOT, 'xchain-documentation/protocol/constants.js'));
const hubCkpt  = require(path.join(ROOT, 'xchain-hub/src/checkpoint_commitment_activation.js'));
const idxCkpt  = require(path.join(ROOT, 'xchain-indexer/src/checkpoint_commitment_activation.js'));
const sdkCkpt  = require(path.join(ROOT, 'xchain-sdk/src/checkpoint_commitment_activation.js'));
const expCkpt  = require(path.join(ROOT, 'xchain-explorer/src/checkpoint_commitment_activation.js'));
// Fifth vendored copy: xchain-sync consumes this at checkpoint.js:53
// (isCheckpointCommitmentActive) and was previously unguarded by this parity
// loop (uuid 77/229/326).
const syncCkpt = require(path.join(ROOT, 'xchain-sync/src/checkpoint_commitment_activation.js'));

const StateCheckpointEngine = require(path.join(ROOT, 'xchain-hub/src/StateCheckpointEngine.js'));
const sdkCheckpoint         = require(path.join(ROOT, 'xchain-sdk/src/checkpoint.js'));
const Anchor                = require(path.join(ROOT, 'xchain-indexer/src/actions/anchor.js'));

// The indexer ANCHOR _canonical is a plain method that reads only its `d` argument
// (no `this`), so invoke it directly off the prototype with a representative v3 `d`.
function anchorCanonicalV3(d) {
    return Anchor.prototype._canonical.call({}, d);
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
        FORMAT: withRoots ? 3 : 0,
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
            assert.deepStrictEqual(mod.CHECKPOINT_COMMITMENT_ACTIVATION, canonical,
                name + ' CHECKPOINT_COMMITMENT_ACTIVATION drifted from the canonical protocol constant');
        }
    });

    it('every local isCheckpointCommitmentActive agrees on the verdict for the same input', function () {
        for (const net of ['mainnet', 'testnet', 'regtest']) {
            for (const sb of [0, 100, 1000, 999999998, 999999999, 1000000000]) {
                const verdicts = [hubCkpt, idxCkpt, sdkCkpt, expCkpt, syncCkpt].map(m => m.isCheckpointCommitmentActive(sb, net));
                assert.ok(verdicts.every(v => v === verdicts[0]),
                    'gate verdict disagreement for ' + net + '@' + sb + ': ' + JSON.stringify(verdicts));
            }
        }
    });

    it('post-flag-day: hub == SDK == indexer ANCHOR v3 canonical (root suffix present)', function () {
        // regtest flag-day is 0, so snapshot_block 100 is active; roots present.
        const { cp, d, STATE_ROOT, BLOCK_MERKLE } = fixtures('regtest', 100, true);
        const hubC = StateCheckpointEngine.canonicalCheckpoint(cp);
        const sdkC = sdkCheckpoint.canonicalCheckpoint(cp);
        const idxC = anchorCanonicalV3(d);
        assert.strictEqual(hubC, sdkC, 'hub vs SDK checkpoint canonical drift');
        assert.strictEqual(hubC, idxC, 'hub vs indexer ANCHOR v3 canonical drift');
        assert.ok(hubC.includes('|' + STATE_ROOT + '|1|' + BLOCK_MERKLE + '|1'),
            'post-flag-day canonical must commit the root suffix; got ' + hubC);
    });

    it('pre-flag-day: hub == SDK == indexer canonical, and the root suffix is absent', function () {
        // mainnet flag-day is the far-future placeholder, so snapshot_block 1000 is inactive.
        const { cp, d, STATE_ROOT, BLOCK_MERKLE } = fixtures('mainnet', 1000, false);
        const hubC = StateCheckpointEngine.canonicalCheckpoint(cp);
        const sdkC = sdkCheckpoint.canonicalCheckpoint(cp);
        const idxC = anchorCanonicalV3({ ...d, FORMAT: 0 });   // v0 pre-flag-day
        assert.strictEqual(hubC, sdkC, 'hub vs SDK pre-flag-day canonical drift');
        assert.strictEqual(hubC, idxC, 'hub vs indexer v0 pre-flag-day canonical drift');
        assert.ok(!hubC.includes(STATE_ROOT) && !hubC.includes(BLOCK_MERKLE),
            'pre-flag-day canonical must NOT contain any root');
    });

    it('explorer merkle.js is a byte-identical twin of the indexer merkle.js (Phase 3 proof server)', function () {
        // The Phase 3 proof server builds SMT/block proofs with an explorer-local copy
        // of merkle.js; a client recomputes with the SDK's merkle logic and binds to the
        // indexer-committed root. A single byte of drift makes server proofs unverifiable.
        const idx = fs.readFileSync(path.join(ROOT, 'xchain-indexer/src/merkle.js'), 'utf8');
        const exp = fs.readFileSync(path.join(ROOT, 'xchain-explorer/src/merkle.js'), 'utf8');
        assert.strictEqual(exp, idx, 'xchain-explorer/src/merkle.js drifted from the indexer merkle.js');
    });

    it('sdk merkle.js is a byte-identical twin of the indexer merkle.js (Phase 4 light client)', function () {
        // The Phase 4 sdk.light client recomputes balances_root / block_merkle_root
        // and the state-root sub-path with an sdk-local copy of merkle.js, binding to
        // the indexer-committed root. A single byte of drift makes a valid server proof
        // fail to verify (or, worse, lets a forged one pass), so it must match exactly.
        const idx = fs.readFileSync(path.join(ROOT, 'xchain-indexer/src/merkle.js'), 'utf8');
        const sdk = fs.readFileSync(path.join(ROOT, 'xchain-sdk/src/merkle.js'), 'utf8');
        assert.strictEqual(sdk, idx, 'xchain-sdk/src/merkle.js drifted from the indexer merkle.js');
    });

    it('checkpoint_commitment_activation.js executable code is byte-identical across all five copies', function () {
        // Of the six flag-day twins in this repo family, four (stake_weighted_quorum,
        // equivocation_header, cross_chain_royalty_activation, state_commitment_activation)
        // are byte-checked somewhere in-repo; this file's own header claims "Byte-identical
        // twins live in ..." but nothing enforced it (uuid:38212dff). The map + verdict
        // checks above are a real net, but they don't catch a change that preserves the map
        // and the six probed heights while altering unprobed code.
        //
        // Each copy's header comment names the OTHER four repos reciprocally, so the header
        // itself is not byte-identical across copies by construction; compare the executable
        // region only (from the activation map down), same convention as
        // equivGateInputParity.test.js's codeOnly() helper.
        const codeOnly = (s) => s.slice(s.indexOf('const CHECKPOINT_COMMITMENT_ACTIVATION'));
        const paths = {
            hub:      'xchain-hub/src/checkpoint_commitment_activation.js',
            indexer:  'xchain-indexer/src/checkpoint_commitment_activation.js',
            sdk:      'xchain-sdk/src/checkpoint_commitment_activation.js',
            explorer: 'xchain-explorer/src/checkpoint_commitment_activation.js',
            sync:     'xchain-sync/src/checkpoint_commitment_activation.js'
        };
        const indexerCode = codeOnly(fs.readFileSync(path.join(ROOT, paths.indexer), 'utf8'));
        for (const [name, rel] of Object.entries(paths)) {
            if (name === 'indexer') continue;
            const code = codeOnly(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
            assert.strictEqual(code, indexerCode,
                name + '/checkpoint_commitment_activation.js executable code drifted from the indexer copy');
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
