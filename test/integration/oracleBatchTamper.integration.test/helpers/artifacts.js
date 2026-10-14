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
 ********************************************************************/

const { eq, ed25519 } = require('./indexer_modules');
const {
    stripEquivHeader, identityFor, findObservedDualSigner, signDualWithVenueIdentity
} = require('./signers');
const { slashHarness, runSlashProof } = require('./slash_harness');
const s = require('./state');

// AT4's second half: the artifacts, captured before the federation is torn down.
function captureArtifacts() {
    const proposal = s.signerSet.proposals.find((p) => p.met === true);
    s.batchCanonical = (proposal && proposal.canonical) || null;
    // The indexer's OWN builder over the wire's own rounds. Compared with the
    // hub's below: producer and verifier agreeing on real bytes is what makes
    // everything after this a statement about the platform and not about a
    // canonical this file invented.
    s.rebuiltCanonical = ed25519.buildPriceBatchPayload(
        s.parsed.firstRound, s.parsed.lastRound, s.parsed.anchor, s.parsed.rounds);
    s.canonicalFromSigningRound = !!s.batchCanonical;
    if (!s.batchCanonical) s.batchCanonical = s.rebuiltCanonical;

    s.dual = findObservedDualSigner(s.venue, s.rounds, s.parsed, s.batchCanonical) ||
             signDualWithVenueIdentity(s.venue, s.parsed, s.batchCanonical);
    if (!s.dual) return;

    const id = identityFor(s.venue, s.dual.pubkey);
    // The counterfactual: the SAME two raw contents, re-wrapped under ONE
    // shared XORACLE key at the same anchor and re-signed by the same real
    // validator. This is the world before ENGINE_TAGS.ORACLE_BATCH existed.
    const rawRound = stripEquivHeader(s.dual.roundCanonical);
    const rawBatch = stripEquivHeader(s.dual.batchCanonical);
    const sharedA  = eq.buildEquivCanonical(eq.ENGINE_TAGS.ORACLE, s.parsed.anchor, 0, rawRound);
    const sharedB  = eq.buildEquivCanonical(eq.ENGINE_TAGS.ORACLE, s.parsed.anchor, 0, rawBatch);
    s.counterfactual = id ? {
        pubkey: String(id.getPubkeyHex()).toLowerCase(),
        msgA: sharedA, sigA: id.sign(sharedA),
        msgB: sharedB, sigB: id.sign(sharedB)
    } : null;
}

// AT4's second half, driven: the honest pair, the same pair swapped, and the
// shared-tag counterfactual, each through the real Slash handler.
async function driveSlashProofs() {
    if (!s.dual) return;
    const { dual, counterfactual, parsed } = s;
    const proofBlock = parsed.anchor + 50;   // any height at/after the slot
    let h = slashHarness(dual.pubkey);
    s.honestProof = { status: await runSlashProof(h, 'price', dual.pubkey,
        dual.roundCanonical, dual.roundSig, dual.batchCanonical, dual.batchSig, proofBlock),
        calls: h.calls };

    // The same pair with the messages swapped: neither ordering may pair them.
    h = slashHarness(dual.pubkey);
    s.swappedProof = { status: await runSlashProof(h, 'price', dual.pubkey,
        dual.batchCanonical, dual.batchSig, dual.roundCanonical, dual.roundSig, proofBlock),
        calls: h.calls };

    if (counterfactual) {
        h = slashHarness(counterfactual.pubkey);
        s.sharedTagProof = { status: await runSlashProof(h, 'price', counterfactual.pubkey,
            counterfactual.msgA, counterfactual.sigA,
            counterfactual.msgB, counterfactual.sigB, proofBlock),
            calls: h.calls };
    }
}

module.exports = { captureArtifacts, driveSlashProofs };
