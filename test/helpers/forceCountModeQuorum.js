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
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * Force LEGACY COUNT quorum for an in-process MultiValidatorHub run.
 *
 * regtest (and testnet) default STAKE_WEIGHTED_QUORUM_ACTIVATION to 0, i.e.
 * stake-weighted quorum is active from genesis. A suite that seeds only the
 * COUNT snapshot (seedStakeSnapshot, no weight snapshot) therefore hits the
 * weighted tally with no weight data and stalls at a 1-sig leader self-sign, so
 * nothing finalizes. These suites are written to exercise the LEGACY COUNT
 * quorum (still a live runtime path: pre-flag-day mainnet history replays in
 * count mode), so lift the activation height above the round's snapshot block
 * for the duration of the run.
 *
 * Runtime-only, no hub-source edit: mutate the SAME exported activation map the
 * in-process hubs read per round. The map is resolved via the helper's
 * loadHubModule (identical resolution to MultiValidatorHub's own hub require, so
 * Node returns the one cached module instance the hubs use, not a second copy).
 * This is the in-process counterpart to multiHubActivationBoundary's source-edit
 * recipe: that suite needs the cross-service source copies to agree for a
 * full-stack run; an in-process hub-only federation reads only the hub's copy.
 *
 * Call once before the rounds run (any time after the hub modules are required;
 * before mvh.start() is safest, so no engine can read the gate at construction).
 * Returns { height, restore() }; call restore() in the after hook.
 *********************************************************************/

const { loadHubModule } = require('./multiValidatorHubHelper');

function forceCountModeQuorum(opts = {}) {
    const swq = loadHubModule('src/stake_weighted_quorum.js');
    const networks = opts.networks || ['regtest', 'testnet'];
    const height = Number.isFinite(opts.height) ? opts.height : Number.MAX_SAFE_INTEGER;
    const saved = {};
    for (const n of networks) {
        saved[n] = swq.STAKE_WEIGHTED_QUORUM_ACTIVATION[n];
        swq.STAKE_WEIGHTED_QUORUM_ACTIVATION[n] = height;
    }
    return {
        height,
        restore() {
            for (const n of networks) swq.STAKE_WEIGHTED_QUORUM_ACTIVATION[n] = saved[n];
        }
    };
}

module.exports = { forceCountModeQuorum };
