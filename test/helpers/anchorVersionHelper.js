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
 *
 * ANCHOR version expectations, derived from the flag-days active at a
 * checkpoint's resolved snapshot_block.
 *
 * An acceptance test cannot hardcode "v0 + v1": StateAnchorPublisher picks the
 * ANCHOR version from the BTC-anchored snapshot_block the hub resolved at tick
 * time, against two frozen flag-day maps:
 *
 *   checkpoint leg   v0  legacy rootless
 *                    v3  SPV roots (checkpoint_commitment active AND the
 *                        checkpoint row actually carries the roots)
 *                    v4  v0 + publisher attestation (anchor-reward derivation)
 *                    v5  v3 + publisher attestation
 *   archive leg      v1  legacy archive
 *                    v6  v1 + publisher attestation (archive-reward derivation)
 *
 * On regtest both reward flag-days are live from genesis, so the SAME suite
 * legitimately emits v0/v1 on one venue and v5/v6 on another purely because the
 * hub resolved a different snapshot_block: a hardcoded v0 assert false-fails on
 * a venue whose BTC tip sits past the thresholds (as observed in one drill,
 * where the on-chain anchor was proven valid while the assert said otherwise).
 *
 * The attestation legs are LIVENESS-SAFE in the publisher: a degraded round
 * (short quorum, timeout, or a hub that is not in the snapshot's oracle_publish
 * set) FALLS BACK to the legacy version so the anchor still lands. That is a
 * legal outcome, not a defect, so `accepted` carries both the attested version
 * and its legacy fallback and callers assert membership, never equality.
 *
 * Flag-day predicates are read from the HUB's own frozen modules (the same code
 * the publisher branches on), never re-implemented here, so an armed threshold
 * moves the test and the publisher together. `opts.flagDays` overrides them for
 * unit tests only.
 *
 ********************************************************************/

'use strict';

const { loadHubModule } = require('./multiValidatorHubHelper');

let _hubFlagDays = null;

// The hub's frozen flag-day predicates. Loaded lazily so a unit test that
// injects its own flagDays never needs an xchain-hub checkout on disk.
function hubFlagDays(){
    if(!_hubFlagDays){
        const ckpt = loadHubModule('src/checkpoint_commitment_activation.js');
        const ar   = loadHubModule('src/anchor_reward_activation.js');
        _hubFlagDays = {
            isCheckpointCommitmentActive: ckpt.isCheckpointCommitmentActive,
            isAnchorRewardActive:         ar.isAnchorRewardActive,
            isArchiveRewardActive:        ar.isArchiveRewardActive
        };
    }
    return _hubFlagDays;
}

// Version byte of an ANCHOR wire payload ('ANCHOR|<version>|...'), or null when
// the payload is not an ANCHOR at all.
function anchorPayloadVersion(payload){
    if(typeof payload !== 'string') return null;
    let parts = payload.split('|');
    if(parts[0] !== 'ANCHOR') return null;
    let v = Number(parts[1]);
    return Number.isInteger(v) ? v : null;
}

// Mirrors the publisher's `useV3` root check: the roots AND their scheme
// versions must all be present. A legacy/null-root row was signed over the
// rootless canonical, so it stays on the rootless version even past the
// checkpoint_commitment flag-day, or its signatures would not verify.
function checkpointCarriesRoots(cp){
    if(!cp) return false;
    return cp.state_root != null && cp.block_merkle_root != null &&
           cp.state_root_version != null && cp.block_merkle_version != null;
}

function _resolve(cp, opts){
    let flagDays      = (opts && opts.flagDays) || hubFlagDays();
    let network       = String((opts && opts.network) || (cp && cp.network) || '');
    let snapshotBlock = Number(cp && cp.snapshot_block);
    // The publisher only runs an attestation round when the hub has an identity
    // to name as the earner (`me`); without one it always takes the legacy leg.
    let hasIdentity   = !opts || opts.hasIdentity !== false;
    return { flagDays, network, snapshotBlock, hasIdentity };
}

// Legal CHECKPOINT-anchor versions for a state_checkpoints row.
// Returns { rootBearing, rewardActive, preferred, fallback, accepted, describe }.
function expectedCheckpointAnchor(cp, opts = {}){
    let { flagDays, network, snapshotBlock, hasIdentity } = _resolve(cp, opts);
    let rootBearing  = flagDays.isCheckpointCommitmentActive(snapshotBlock, network) &&
                       checkpointCarriesRoots(cp);
    let rewardActive = hasIdentity && flagDays.isAnchorRewardActive(snapshotBlock, network);
    let legacy   = rootBearing ? 3 : 0;
    let attested = rootBearing ? 5 : 4;
    let accepted = rewardActive ? [attested, legacy] : [legacy];
    return {
        rootBearing, rewardActive,
        preferred: accepted[0],
        fallback:  rewardActive ? legacy : null,
        accepted,
        describe: 'checkpoint anchor v' + accepted.join(' or v') +
                  ' (snapshot_block ' + snapshotBlock + '/' + network +
                  ', roots ' + (rootBearing ? 'on' : 'off') +
                  ', reward-derivation ' + (rewardActive ? 'on' : 'off') + ')'
    };
}

// Legal ARCHIVE-anchor versions for the same checkpoint row.
function expectedArchiveAnchor(cp, opts = {}){
    let { flagDays, network, snapshotBlock, hasIdentity } = _resolve(cp, opts);
    let rewardActive = hasIdentity && flagDays.isArchiveRewardActive(snapshotBlock, network);
    let accepted = rewardActive ? [6, 1] : [1];
    return {
        rewardActive,
        preferred: accepted[0],
        fallback:  rewardActive ? 1 : null,
        accepted,
        describe: 'archive anchor v' + accepted.join(' or v') +
                  ' (snapshot_block ' + snapshotBlock + '/' + network +
                  ', reward-derivation ' + (rewardActive ? 'on' : 'off') + ')'
    };
}

// First broadcast whose payload version is one of `accepted`. Broadcast entries
// are { payload, txid, phase1_txid } as recorded by the acceptance suite's hook.
function findAnchorBroadcast(broadcasts, accepted){
    let want = new Set(accepted || []);
    return (broadcasts || []).find(b => want.has(anchorPayloadVersion(b && b.payload))) || null;
}

// First anchor_actions row (as read back from the indexer DB) whose version is
// one of `accepted`, optionally narrowed to one ledger_hash so a dirty regtest
// chain carrying a previous run's anchors cannot satisfy the assert.
function findAnchorRow(rows, accepted, ledgerHash){
    let want = new Set(accepted || []);
    return (rows || []).find(r =>
        want.has(Number(r && r.version)) &&
        (ledgerHash === undefined || String(r.ledger_hash) === String(ledgerHash))) || null;
}

module.exports = {
    hubFlagDays,
    anchorPayloadVersion,
    checkpointCarriesRoots,
    expectedCheckpointAnchor,
    expectedArchiveAnchor,
    findAnchorBroadcast,
    findAnchorRow
};
