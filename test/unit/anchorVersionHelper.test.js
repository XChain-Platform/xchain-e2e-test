/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 **********************************************************************
 *
 * : the ANCHOR acceptance suite must key its expected version off the
 * flag-days active at the resolved snapshot_block, never a hardcoded v0. These
 * exercise the derivation table with injected predicates, so no hub checkout,
 * no DB and no chain are needed.
 *
 ********************************************************************/

'use strict';

const assert = require('assert');
const av     = require('../helpers/anchorVersionHelper');

// Flag-day predicate triple with each gate independently switchable.
function flags({ roots = false, anchorReward = false, archiveReward = false } = {}){
    return {
        isCheckpointCommitmentActive: () => roots,
        isAnchorRewardActive:         () => anchorReward,
        isArchiveRewardActive:        () => archiveReward
    };
}

const ROOTLESS_CP = { network: 'regtest', snapshot_block: 100 };
const ROOTED_CP   = {
    network: 'regtest', snapshot_block: 218,
    state_root: 'a'.repeat(64), state_root_version: 1,
    block_merkle_root: 'b'.repeat(64), block_merkle_version: 1
};

describe('anchorVersionHelper ', function () {

    describe('anchorPayloadVersion', function () {
        it('reads the version byte off an ANCHOR payload', function () {
            assert.strictEqual(av.anchorPayloadVersion('ANCHOR|0|DOGE|regtest|136'), 0);
            assert.strictEqual(av.anchorPayloadVersion('ANCHOR|5|DOGE|regtest|136'), 5);
            assert.strictEqual(av.anchorPayloadVersion('ANCHOR|6|DOGE|regtest|136'), 6);
        });
        it('returns null for anything that is not an ANCHOR payload', function () {
            assert.strictEqual(av.anchorPayloadVersion('SEND|1|DOGE'), null);
            assert.strictEqual(av.anchorPayloadVersion('ANCHOR|x|DOGE'), null);
            assert.strictEqual(av.anchorPayloadVersion(null), null);
            assert.strictEqual(av.anchorPayloadVersion(undefined), null);
        });
    });

    describe('checkpointCarriesRoots', function () {
        it('requires every root AND its scheme version', function () {
            assert.strictEqual(av.checkpointCarriesRoots(ROOTED_CP), true);
            assert.strictEqual(av.checkpointCarriesRoots(ROOTLESS_CP), false);
            // A root present without its version byte stays rootless: the row was
            // signed over the rootless canonical, so its signatures only verify there.
            assert.strictEqual(av.checkpointCarriesRoots(
                Object.assign({}, ROOTED_CP, { state_root_version: null })), false);
            assert.strictEqual(av.checkpointCarriesRoots(
                Object.assign({}, ROOTED_CP, { block_merkle_root: null })), false);
        });
    });

    describe('expectedCheckpointAnchor', function () {
        it('pre-flag-day: v0 only', function () {
            let e = av.expectedCheckpointAnchor(ROOTLESS_CP, { flagDays: flags({}) });
            assert.deepStrictEqual(e.accepted, [0]);
            assert.strictEqual(e.preferred, 0);
            assert.strictEqual(e.fallback, null);
        });

        it('checkpoint-commitment active with roots present: v3 only', function () {
            let e = av.expectedCheckpointAnchor(ROOTED_CP, { flagDays: flags({ roots: true }) });
            assert.deepStrictEqual(e.accepted, [3]);
            assert.strictEqual(e.rootBearing, true);
        });

        it('checkpoint-commitment active but the row carries no roots: still v0', function () {
            let e = av.expectedCheckpointAnchor(ROOTLESS_CP, { flagDays: flags({ roots: true }) });
            assert.deepStrictEqual(e.accepted, [0]);
            assert.strictEqual(e.rootBearing, false);
        });

        it('anchor-reward active, rootless: v4 preferred with the v0 liveness fallback', function () {
            let e = av.expectedCheckpointAnchor(ROOTLESS_CP,
                { flagDays: flags({ anchorReward: true }) });
            assert.deepStrictEqual(e.accepted, [4, 0]);
            assert.strictEqual(e.preferred, 4);
            assert.strictEqual(e.fallback, 0);
        });

        it('both flag-days active with roots: v5 preferred with the v3 liveness fallback', function () {
            // This is the  A2 drill shape: the hardcoded v0 assert
            // false-failed here while the on-chain v5 anchor was valid.
            let e = av.expectedCheckpointAnchor(ROOTED_CP,
                { flagDays: flags({ roots: true, anchorReward: true }) });
            assert.deepStrictEqual(e.accepted, [5, 3]);
            assert.strictEqual(e.preferred, 5);
            assert.strictEqual(e.fallback, 3);
        });

        it('an identity-less hub never attests, so only the legacy version is legal', function () {
            let e = av.expectedCheckpointAnchor(ROOTED_CP,
                { flagDays: flags({ roots: true, anchorReward: true }), hasIdentity: false });
            assert.deepStrictEqual(e.accepted, [3]);
        });
    });

    describe('expectedArchiveAnchor', function () {
        it('pre-flag-day: v1 only', function () {
            let e = av.expectedArchiveAnchor(ROOTLESS_CP, { flagDays: flags({}) });
            assert.deepStrictEqual(e.accepted, [1]);
        });
        it('archive-reward active: v6 preferred with the v1 liveness fallback', function () {
            let e = av.expectedArchiveAnchor(ROOTED_CP, { flagDays: flags({ archiveReward: true }) });
            assert.deepStrictEqual(e.accepted, [6, 1]);
            assert.strictEqual(e.fallback, 1);
        });
        it('the archive leg does not follow the checkpoint roots gate', function () {
            let e = av.expectedArchiveAnchor(ROOTED_CP,
                { flagDays: flags({ roots: true, anchorReward: true }) });
            assert.deepStrictEqual(e.accepted, [1]);
        });
    });

    describe('findAnchorBroadcast / findAnchorRow', function () {
        const broadcasts = [
            { payload: 'ANCHOR|5|DOGE|regtest|136', txid: 'aa' },
            { payload: 'ANCHOR|6|DOGE|regtest|136', txid: 'bb' }
        ];

        it('matches a post-flag-day publish against the derived version set', function () {
            let cpE  = av.expectedCheckpointAnchor(ROOTED_CP,
                { flagDays: flags({ roots: true, anchorReward: true }) });
            let arcE = av.expectedArchiveAnchor(ROOTED_CP, { flagDays: flags({ archiveReward: true }) });
            assert.strictEqual(av.findAnchorBroadcast(broadcasts, cpE.accepted).txid,  'aa');
            assert.strictEqual(av.findAnchorBroadcast(broadcasts, arcE.accepted).txid, 'bb');
        });

        it('the OLD hardcoded v0/v1 expectation is exactly what missed those', function () {
            assert.strictEqual(av.findAnchorBroadcast(broadcasts, [0]), null);
            assert.strictEqual(av.findAnchorBroadcast(broadcasts, [1]), null);
        });

        it('rows are narrowed by ledger_hash so a dirty chain cannot satisfy the assert', function () {
            const rows = [
                { version: 5, ledger_hash: 'old', status: 'valid' },
                { version: 5, ledger_hash: 'ours', status: 'valid' }
            ];
            assert.strictEqual(av.findAnchorRow(rows, [5], 'ours').ledger_hash, 'ours');
            assert.strictEqual(av.findAnchorRow(rows, [5], 'absent'), null);
            assert.strictEqual(av.findAnchorRow(rows, [6], 'ours'), null);
        });
    });

    describe('hubFlagDays (live wiring)', function () {
        it('reads the hub\'s own frozen predicates when a checkout is resolvable', function () {
            let fd;
            try { fd = av.hubFlagDays(); }
            catch (e) { return this.skip(); }          // no xchain-hub checkout on this box
            assert.strictEqual(typeof fd.isCheckpointCommitmentActive, 'function');
            assert.strictEqual(typeof fd.isAnchorRewardActive, 'function');
            assert.strictEqual(typeof fd.isArchiveRewardActive, 'function');
            // regtest arms every one of these from genesis, which is precisely why
            // an isolated venue at a high snapshot_block emits v5/v6.
            assert.strictEqual(fd.isAnchorRewardActive(218, 'regtest'), true);
            assert.strictEqual(fd.isArchiveRewardActive(218, 'regtest'), true);
        });

        it('reproduces the  A2 drill verdict off the REAL flag-days', function () {
            // No injected predicates: the same modules the publisher branches on,
            // the drill's row (regtest, snapshot_block 218, roots present). The
            // suite must expect v5/v6 here, which is exactly what landed on chain
            // while the old hardcoded v0 assert reported "1 failing".
            try { av.hubFlagDays(); }
            catch (e) { return this.skip(); }
            let cp = av.expectedCheckpointAnchor(ROOTED_CP);
            let ar = av.expectedArchiveAnchor(ROOTED_CP);
            assert.strictEqual(cp.preferred, 5, 'checkpoint leg must expect v5 on this venue');
            assert.strictEqual(ar.preferred, 6, 'archive leg must expect v6 on this venue');
            assert.ok(cp.accepted.includes(3), 'the liveness fallback stays legal');
            assert.ok(ar.accepted.includes(1), 'the liveness fallback stays legal');
        });
    });
});
