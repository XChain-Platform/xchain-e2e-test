'use strict';

/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available —
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * Seeded validator-stake snapshot fixture (validator-test-spec §5.4 / harness #4).
 *
 * Federation consensus (config-PBFT, and any snapshot-quorum path) derives its
 * quorum N from the on-chain ACTIVE-VALIDATOR snapshot the hub fetches from the
 * indexer at a BTC block boundary — NOT from the peer-registered set. In an
 * in-process MultiValidatorHub there is no indexer, so the snapshot resolves
 * empty and the federation quorum collapses to a single node: PBFT can't carry
 * a change across followers.
 *
 * This fixture injects a deterministic snapshot onto every booted hub so the
 * federation computes a real BFT quorum and reaches consensus, with no indexer
 * and no chain. It overrides, per hub:
 *   - capabilitySnapshot.getActiveValidatorSnapshot(blockIndex)  (federation set)
 *   - capabilitySnapshot.getSnapshot(capability, blockIndex)     (per-capability set)
 *   - hub._resolveBtcLatestBlock()                               (the block to snapshot at)
 *
 * Quorum is 2·⌊(N−1)/3⌋+1, so for a meaningful (fault-tolerant) quorum use
 * N ≥ 4 hubs: N=3 → quorum 1 (degenerate), N=4 → quorum 3 (tolerates 1 fault).
 *
 * Call AFTER mvh.start(). Returns { snapshot, blockIndex, restore() }; call
 * restore() in teardown (or just let the hubs stop()).
 */

function seedStakeSnapshot(mvh, opts = {}) {
    const amount     = opts.amount || '1000.00000000';
    const blockIndex = opts.blockIndex || 100;
    // Every harness validator is a staker, so PBFT participants (registered by
    // addr) all correspond to a pubkey present in the snapshot.
    const validators = mvh.identities.map((id) => ({ pubkey: id.pubkeyHex, amount }));
    const base = { validators, count: validators.length, blockIndex };

    // Fresh copy per call so a caller mutating one hub's snapshot can't bleed
    // into another's (and so the hub's own cache can't be aliased).
    const fresh = (extra) => Object.assign({}, base, extra, { validators: validators.slice() });

    const restores = [];
    for (const hub of mvh.hubs) {
        const cs        = hub.capabilitySnapshot;
        const origActive = cs.getActiveValidatorSnapshot;
        const origPerCap = cs.getSnapshot;
        const origBlock  = hub._resolveBtcLatestBlock;

        cs.getActiveValidatorSnapshot = async () => fresh({ capability: null });
        cs.getSnapshot                = async (capability) => fresh({ capability });
        hub._resolveBtcLatestBlock    = async () => blockIndex;

        restores.push(() => {
            cs.getActiveValidatorSnapshot = origActive;
            cs.getSnapshot                = origPerCap;
            hub._resolveBtcLatestBlock    = origBlock;
        });
    }

    return {
        snapshot: fresh({ capability: null }),
        blockIndex,
        restore() { restores.forEach((r) => r()); restores.length = 0; }
    };
}

module.exports = { seedStakeSnapshot };
