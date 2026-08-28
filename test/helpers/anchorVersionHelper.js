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
 * ANCHOR version expectations plus the v7 bundle wire parser.
 *
 * CHECKPOINT LEG: exactly ONE version. The checkpoint bundle (ANCHOR v7, one
 * anchor per network per cycle carrying every checkpointed chain as a section)
 * REPLACED the per-chain wires; v0/v3/v4/v5 were deleted, not deprecated
 * (anchor-bundle-per-network.md D2, following the pre-launch PRICE ruling), and
 * the indexer no longer parses them. So there is no version ladder left to
 * derive here and no roots/reward branch that can move it:
 *
 *   - a section is root-bearing BY CONSTRUCTION (D8): the publisher SKIPS a
 *     checkpoint row with null roots with a log line rather than falling back to
 *     a rootless wire, so `checkpointCarriesRoots` is now a PRE-CONDITION on
 *     whether a row rides a bundle at all, not a version selector;
 *   - the publisher attestation is still liveness-safe, but a degraded round now
 *     falls back WITHIN v7 to `ATTEST_SIG_COUNT 0` (§2.5) rather than to an
 *     older version. The anchor lands either way; only the reward is lost. So
 *     `rewardActive` still says whether to expect an `anchor_bundle` reward,
 *     while `accepted` stays [7].
 *
 * ARCHIVE LEG is untouched (already one head per network per cycle):
 *   v1 legacy, v6 v1 + publisher attestation (archive-reward derivation), with
 *   the legacy version as the liveness fallback. Callers assert membership in
 *   `accepted`, never equality.
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

// The CHECKPOINT-anchor expectation for a state_checkpoints row: always the v7
// bundle. `rootBearing` reports whether this row is ELIGIBLE to ride one (the
// publisher skips a rootless row, D8) and `rewardActive` whether an
// `anchor_bundle` reward should follow; neither moves the version.
// Returns { rootBearing, rewardActive, preferred, fallback, accepted, describe }.
function expectedCheckpointAnchor(cp, opts = {}){
    let { flagDays, network, snapshotBlock, hasIdentity } = _resolve(cp, opts);
    let rootBearing  = flagDays.isCheckpointCommitmentActive(snapshotBlock, network) &&
                       checkpointCarriesRoots(cp);
    let rewardActive = hasIdentity && flagDays.isAnchorRewardActive(snapshotBlock, network);
    return {
        rootBearing, rewardActive,
        preferred: 7,
        // No cross-version fallback exists any more; the degraded attestation
        // path stays on v7 with a zero-signature tail.
        fallback:  null,
        accepted:  [7],
        describe: 'checkpoint bundle v7 (snapshot_block ' + snapshotBlock + '/' + network +
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

// Fixed fields a v7 section carries before its (PUBKEY, SIG) pair list:
// CHAIN, BLOCK_INDEX, BLOCK_HASH, LEDGER_HASH, ACTIONS_HASH, CONTRACT_HASH,
// CHECKPOINT_SEQ, SECTION_SNAPSHOT_BLOCK, STATE_ROOT, STATE_ROOT_VERSION,
// BLOCK_MERKLE_ROOT, BLOCK_MERKLE_VERSION, SIG_COUNT.
const V7_SECTION_FIXED_FIELDS = 13;

// Parse an ANCHOR v7 bundle payload into its header, sections and publisher
// tail. Written as a walk over the pipe-split fields (the sections are
// variable-width: SIG_COUNT decides how many pairs follow), so it fails loudly
// on a truncated wire rather than reading a signature as the next section's
// chain. Returns null for anything that is not an ANCHOR v7.
//
// This exists so the venue suites can assert the CARDINALITY properties AT1 and
// AT3 are about (one bundle, N sections, one action) off the bytes that actually
// went to the chain, without re-implementing the builder's field order in three
// different tests.
function parseAnchorV7(payload){
    if(typeof payload !== 'string') return null;
    let f = payload.split('|');
    if(f[0] !== 'ANCHOR' || f[1] !== '7') return null;
    let sectionCount = Number(f[4]);
    if(!Number.isInteger(sectionCount) || sectionCount < 1) return null;

    let i = 5, sections = [];
    for(let n = 0; n < sectionCount; n++){
        if(i + V7_SECTION_FIXED_FIELDS > f.length)
            throw new Error('ANCHOR v7 truncated in section ' + n + ' of ' + sectionCount);
        let sigCount = Number(f[i + 12]);
        if(!Number.isInteger(sigCount) || sigCount < 0)
            throw new Error('ANCHOR v7 section ' + n + ' has a non-numeric SIG_COUNT');
        let sigBase = i + V7_SECTION_FIXED_FIELDS;
        if(sigBase + (sigCount * 2) > f.length)
            throw new Error('ANCHOR v7 section ' + n + ' declares ' + sigCount + ' signature(s) the wire does not carry');
        let sigs = [];
        for(let s = 0; s < sigCount; s++)
            sigs.push({ pubkey: f[sigBase + (s * 2)], sig: f[sigBase + (s * 2) + 1] });
        sections.push({
            chain: f[i], block_index: Number(f[i + 1]), block_hash: f[i + 2],
            ledger_hash: f[i + 3], actions_hash: f[i + 4], contract_hash: f[i + 5],
            checkpoint_seq: Number(f[i + 6]), section_snapshot_block: Number(f[i + 7]),
            state_root: f[i + 8], state_root_version: Number(f[i + 9]),
            block_merkle_root: f[i + 10], block_merkle_version: Number(f[i + 11]),
            sigs
        });
        i = sigBase + (sigCount * 2);
    }

    if(i + 2 > f.length) throw new Error('ANCHOR v7 carries no publisher tail');
    let publisher      = f[i];
    let attestSigCount = Number(f[i + 1]);
    if(!Number.isInteger(attestSigCount) || attestSigCount < 0)
        throw new Error('ANCHOR v7 has a non-numeric ATTEST_SIG_COUNT');
    let attestSigs = [];
    for(let s = 0; s < attestSigCount; s++)
        attestSigs.push({ pubkey: f[i + 2 + (s * 2)], sig: f[i + 3 + (s * 2)] });

    return {
        version: 7, network: f[2], snapshot_block: Number(f[3]),
        section_count: sectionCount, sections,
        chains: sections.map(s => String(s.chain)),
        publisher, attest_sig_count: attestSigCount, attestSigs
    };
}

// Every v7 bundle among a run's recorded broadcasts, parsed. The archive leg
// (v1/v6) and any prior run's wires are filtered out.
function bundleBroadcasts(broadcasts){
    let out = [];
    for(let b of (broadcasts || [])){
        let parsed = null;
        try { parsed = parseAnchorV7(b && b.payload); } catch(e){ parsed = null; }
        if(parsed) out.push(Object.assign({}, b, { bundle: parsed }));
    }
    return out;
}

// The anchor_actions section rows of ONE bundle: every row sharing an
// action_index, in section_index order. The bundle is identified by any one of
// its sections' ledger_hash, which is what a caller has after a flush and what
// keeps a dirty regtest chain's earlier bundles from satisfying an assert.
function findBundleSectionRows(rows, ledgerHash){
    let seed = (rows || []).find(r => Number(r && r.version) === 7 &&
                                      String(r.ledger_hash) === String(ledgerHash));
    if(!seed) return [];
    return (rows || [])
        .filter(r => Number(r.version) === 7 && String(r.action_index) === String(seed.action_index))
        .sort((a, b) => Number(a.section_index) - Number(b.section_index));
}

module.exports = {
    hubFlagDays,
    anchorPayloadVersion,
    checkpointCarriesRoots,
    expectedCheckpointAnchor,
    expectedArchiveAnchor,
    findAnchorBroadcast,
    findAnchorRow,
    parseAnchorV7,
    bundleBroadcasts,
    findBundleSectionRows
};
