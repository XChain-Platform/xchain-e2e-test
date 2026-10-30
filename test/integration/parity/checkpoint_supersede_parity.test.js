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
 * Cross-service parity for the checkpoint supersession segment.
 *
 * Above the CHECKPOINT_SUPERSEDE flag day a checkpoint carrying supersedes_from and
 * rules_digest signs '|SUPERSEDE|<from>|<lowercase digest>' after the SPV root suffix
 * and before the EQUIV wrap. Five services build that segment from their own copy of
 * the suffix module, so this suite holds every copy and every checkpoint builder that
 * appends it to one byte string, pinned against a literal written from the spec parts.
 *
 ********************************************************************/

'use strict';

const assert = require('assert');
const path   = require('path');

const ROOT = path.resolve(__dirname, '../../../..');
const load = (rel) => require(path.join(ROOT, rel));

const StateCheckpointEngine = load('xchain-hub/src/anchor/checkpoint_engine.js');
const sdkCheckpoint         = load('xchain-sdk/src/checkpoint.js');
const syncCheckpoint        = load('xchain-sync/src/checkpoint.js');
const explorerProofs        = load('xchain-explorer/src/explorer/proofs.js');
const checkpointSource      = load('xchain-indexer/src/consensus/bridge_proof_client/checkpoint_source.js');
const AnchorRecovery        = load('xchain-indexer/bin/recovery.js');
const idxRegistry           = load('xchain-indexer/src/consensus/gate_registry.js');
const eqHeader              = load('xchain-indexer/src/consensus/equivocation_header.js');

const SUPERSEDE_KEY = 'checkpoint_supersede_activation.CHECKPOINT_SUPERSEDE_ACTIVATION';
const COMMITMENT_KEY = 'checkpoint_commitment_activation.CHECKPOINT_COMMITMENT_ACTIVATION';

// Every copy of the suffix module, keyed by the service that signs or verifies with it.
const SUFFIX_COPIES = {
    hub:      load('xchain-hub/src/anchor/checkpoint_engine/supersede_suffix.js').supersedeSuffix,
    sdk:      load('xchain-sdk/src/protocol/light_client/supersede_suffix.js').supersedeSuffix,
    sync:     load('xchain-sync/src/client/supersede_suffix.js').supersedeSuffix,
    explorer: load('xchain-explorer/src/explorer/supersede_suffix.js').supersedeSuffix,
    indexer:  load('xchain-indexer/src/consensus/retroactive/checkpoint_supersede.js').supersedeSuffix
};

const DIGEST = 'ab'.repeat(32);
const SUFFIX_VECTORS = [
    ['both fields absent', {}, ''],
    ['numeric supersedes_from, uppercase digest', { supersedes_from: 400, rules_digest: DIGEST.toUpperCase() }, '|SUPERSEDE|400|' + DIGEST],
    ['string supersedes_from', { supersedes_from: '400', rules_digest: DIGEST }, '|SUPERSEDE|400|' + DIGEST],
    ['zero supersedes_from', { supersedes_from: 0, rules_digest: DIGEST }, '|SUPERSEDE|0|' + DIGEST],
    ['largest safe supersedes_from', { supersedes_from: Number.MAX_SAFE_INTEGER, rules_digest: DIGEST },
        '|SUPERSEDE|' + Number.MAX_SAFE_INTEGER + '|' + DIGEST],
    ['only supersedes_from', { supersedes_from: 400 }, null],
    ['only rules_digest', { rules_digest: DIGEST }, null],
    ['negative supersedes_from', { supersedes_from: -1, rules_digest: DIGEST }, null],
    ['fractional supersedes_from', { supersedes_from: 1.5, rules_digest: DIGEST }, null],
    ['unsafe supersedes_from', { supersedes_from: 2 ** 53, rules_digest: DIGEST }, null],
    ['short rules_digest', { supersedes_from: 4, rules_digest: 'ab' }, null],
    ['non-hex rules_digest', { supersedes_from: 4, rules_digest: 'g'.repeat(64) }, null]
];

// Run one copy on one input; a null result means it threw (the error type may differ).
function suffixOf(fn, input) {
    try { return fn(Object.assign({}, input)); } catch (_e) { return null; }
}

// Call recovery's canonical off the prototype, as the commitment parity suite does.
function recoveryCheckpointCanonical(cp) {
    return AnchorRecovery.prototype.checkpointCanonical.call(AnchorRecovery.prototype, cp);
}

// Every checkpoint builder that appends the supersession segment, over the row shape.
function supersedingCanonicals(cp) {
    return {
        hub:         StateCheckpointEngine.canonicalCheckpoint(cp),
        sdk:         sdkCheckpoint.canonicalCheckpoint(cp),
        sync:        syncCheckpoint.canonicalCheckpoint(cp),
        explorer:    explorerProofs.canonicalCheckpointString(cp),
        recovery:    recoveryCheckpointCanonical(cp),
        mirroredRow: checkpointSource.checkpointCanonical(cp)
    };
}

// A root-bearing regtest row; the root versions differ so a swapped field changes bytes.
function row(over) {
    return Object.assign({
        chain: 'BTC', network: 'regtest', block_index: 500, block_hash: 'c0'.repeat(32),
        ledger_hash: 'a1'.repeat(32), actions_hash: 'b2'.repeat(32), contract_hash: 'c3'.repeat(32),
        checkpoint_seq: 7, snapshot_block: 100, state_root: 'd4'.repeat(32), state_root_version: 2,
        block_merkle_root: 'e5'.repeat(32), block_merkle_version: 3
    }, over || {});
}

const RAW = ['XCHECKPOINT', 'BTC', 'regtest', '500', 'c0'.repeat(32), 'a1'.repeat(32), 'b2'.repeat(32),
    'c3'.repeat(32), '7', '100', 'd4'.repeat(32), '2', 'e5'.repeat(32), '3'].join('|');
const WRAP = 'EQUIV|XCHECKPOINT|BTC|regtest|500|7|0||';

describe('checkpoint supersession segment: every suffix copy agrees', function () {
    for (const [name, input, expected] of SUFFIX_VECTORS) {
        it('emits one result for ' + name, function () {
            for (const [service, fn] of Object.entries(SUFFIX_COPIES))
                assert.strictEqual(suffixOf(fn, input), expected,
                    service + ' supersede suffix ' + (expected === null ? 'must throw' : 'drifted') + ' for ' + name);
        });
    }
});

describe('checkpoint supersession segment: every checkpoint builder agrees', function () {
    it('regtest arms the supersede, commitment and EQUIV gates at the fixture height', function () {
        assert.strictEqual(idxRegistry.activeAt(SUPERSEDE_KEY, 'regtest', 'BTC', 100, null), true,
            'premise: the supersede gate must be active at regtest@100 or the segment cases pin nothing');
        assert.strictEqual(idxRegistry.activeAt(COMMITMENT_KEY, 'regtest', null, 100, null), true,
            'premise: the commitment gate must be active at regtest@100 so the roots precede the segment');
        assert.strictEqual(eqHeader.isEquivHeaderActive(100, 'regtest'), true,
            'premise: regtest@100 must carry the EQUIV wrap');
    });

    it('a superseding row signs the segment after the roots and inside the EQUIV wrap', function () {
        const expected = WRAP + RAW + '|SUPERSEDE|400|' + DIGEST;
        const all = supersedingCanonicals(row({ supersedes_from: 400, rules_digest: DIGEST.toUpperCase() }));
        for (const [name, s] of Object.entries(all))
            assert.strictEqual(s, expected, name + ' drifted from the spec bytes for a superseding checkpoint');
    });

    it('a plain row carries no segment in any builder', function () {
        const all = supersedingCanonicals(row());
        for (const [name, s] of Object.entries(all))
            assert.strictEqual(s, WRAP + RAW, name + ' drifted from the spec bytes for a plain checkpoint');
    });
});
