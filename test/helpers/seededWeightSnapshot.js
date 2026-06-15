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
 * Seeded SOURCE-KEYED weight snapshot fixture — the STAKE_WEIGHTED_QUORUM (WI-1)
 * twin of seedStakeSnapshot.
 *
 * Above the activation height the federation tally is stake-weighted
 * (3·Σ distinct-source signer weight > 2·S), and the engines resolve the
 * SOURCE-keyed snapshot (getActiveWeightSnapshot / getWeightSnapshot →
 * [{pubkey, source, weight}]) — NOT the count snapshot that seedStakeSnapshot
 * stubs. In an in-process MultiValidatorHub there is no indexer, so this injects
 * a deterministic source-keyed snapshot onto every hub so the weighted path runs
 * with no indexer and no chain.
 *
 * It also sets hub.network so isStakeWeightedQuorumActive(block, network) is TRUE
 * (regtest/testnet activate at genesis). MultiValidatorHub does not thread
 * HUB_NETWORK, so without this the hubs default to network '' and fall back to the
 * legacy COUNT path — and the weighted tally would never be exercised.
 *
 * Pass `validators` as [{pubkey, source, weight}] to model UNEVEN stake (distinct
 * sources, a whale + smalls). A validator whose pubkey is NOT one of the booted
 * hub identities models an offline staker that is in the snapshot (counts toward S)
 * but casts no vote — the way to prove a stake-minority/count-majority of live
 * hubs cannot finalize. Default: one source per booted identity, equal weight.
 *
 * Quorum semantics: weighted, so use UNEVEN weights to make the test meaningful.
 * Call AFTER mvh.start(). Returns { snapshot, blockIndex, restore() }; call
 * restore() in teardown (or just let the hubs stop()).
 ********************************************************************/

function seedWeightSnapshot(mvh, opts = {}) {
    const blockIndex = opts.blockIndex || 100;
    const network    = opts.network || 'regtest';   // activates weighting at genesis
    // Default: every booted hub is its own source with equal weight.
    const validators = opts.validators
        || mvh.identities.map((id, i) => ({ pubkey: id.pubkeyHex, source: 'src' + i, weight: '1000' }));
    const sources = new Set(validators.map((v) => String(v.source)));
    const base = { validators, count: validators.length, sourceCount: sources.size, blockIndex };

    // Fresh copy per call so a caller mutating one hub's snapshot can't bleed into
    // another's (and so the hub's own cache can't be aliased).
    const fresh = (extra) => Object.assign({}, base, extra, { validators: validators.slice() });

    const restores = [];
    for (const hub of mvh.hubs) {
        const cs          = hub.capabilitySnapshot;
        const origActiveW = cs.getActiveWeightSnapshot;
        const origWeight  = cs.getWeightSnapshot;
        const origBlock   = hub._resolveBtcLatestBlock;
        const origNet     = hub.network;

        cs.getActiveWeightSnapshot = async () => fresh({ capability: '*' });
        cs.getWeightSnapshot       = async (capability) => fresh({ capability });
        hub._resolveBtcLatestBlock = async () => blockIndex;
        hub.network                = network;

        restores.push(() => {
            cs.getActiveWeightSnapshot = origActiveW;
            cs.getWeightSnapshot       = origWeight;
            hub._resolveBtcLatestBlock = origBlock;
            hub.network                = origNet;
        });
    }

    return {
        snapshot: fresh({ capability: '*' }),
        blockIndex,
        restore() { restores.forEach((r) => r()); restores.length = 0; }
    };
}

module.exports = { seedWeightSnapshot };
