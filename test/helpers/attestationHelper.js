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
 ********************************************************************/

const crypto = require('crypto');
const transactionHelper = require('../transactionHelper');
// Sibling modules: same EQUIV header + SWQ gate the indexer's verifier uses (attest.js).
const eq  = require('../../../xchain-indexer/src/equivocation_header.js');
const swq = require('../../../xchain-indexer/src/stake_weighted_quorum.js');

class MockAttestationValidator {
    constructor() {
        const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
        this.privateKey = privateKey;
        // SPKI DER for Ed25519 is 12-byte prefix + 32-byte raw pubkey
        let spkiDer = publicKey.export({ format: 'der', type: 'spki' });
        this.pubkey = spkiDer.subarray(12).toString('hex');
        // The staking source address this validator was staked from. SWQ source-dedup
        // (active on regtest/testnet at block 0) keeps only ONE key per source in a
        // request's responsible set, so each validator must be staked from a DISTINCT
        // source to all survive into the set. Set by the test after staking.
        this.source = null;
    }

    // Canonical message that the indexer's attest.js v1 handler reconstructs:
    //   request_id || provider_id || sha256(response_payload) || status || meta
    // At/above the EQUIV flag-day the indexer wraps that raw string in the uniform
    // header (TAG=XATTEST, ROUND_ID=request_id, VIEW=0); we must wrap identically or
    // ed25519 verification fails. regtest/testnet activate at block 0, so the e2e is
    // always wrapped; the wrapped bytes don't depend on the block value (only the
    // activation gate does), so a default snapshotBlock of 0 reproduces it byte-for-byte.
    _canonical(requestId, providerId, responsePayload, status, meta, snapshotBlock, network) {
        const responseHash = crypto.createHash('sha256').update(String(responsePayload || ''), 'utf8').digest('hex');
        let canonRaw = String(requestId) + String(providerId) + responseHash + String(status) + String(meta || '');
        if (eq.isEquivHeaderActive(snapshotBlock, network))
            canonRaw = eq.buildEquivCanonical(eq.ENGINE_TAGS.ATTEST, requestId, 0, canonRaw);
        return Buffer.from(canonRaw, 'utf8');
    }

    sign(requestId, providerId, responsePayload, status, meta, snapshotBlock, network) {
        const message = this._canonical(requestId, providerId, responsePayload, status, meta, snapshotBlock, network);
        return crypto.sign(null, message, this.privateKey).toString('hex');
    }
}

// Mirror of xchain-indexer attest.js _computeResponsibleSet: picks the request's
// deterministic responsible signer set so the test signs with exactly the keys the
// indexer will accept. Sorts the staked validator pool by SHA256(request_id || pubkey);
// at/above SWQ activation (regtest/testnet → block 0) dedupes by staking source (one
// slot per source, lowest-hash key wins), then takes the top-REDUNDANCY.
//
// CONSENSUS-MIRROR: must match attest.js._computeResponsibleSet byte-for-byte, else the
// chosen signers won't be the ones the indexer deems responsible and validSigs falls
// short of REDUNDANCY. `validators` must be the FULL staked attestation set (the indexer
// computes over every staked key at the block, not just the ones a given test tracks).
function computeResponsibleSigners(requestId, redundancy, validators, snapshotBlock, network) {
    const net = network || process.env.NETWORK || 'regtest';
    const sb  = (snapshotBlock != null) ? Number(snapshotBlock) : 0;
    let withHash = validators.map(v => {
        let pk = String(v.pubkey).toLowerCase();
        let h  = crypto.createHash('sha256').update(String(requestId), 'utf8').update(pk, 'utf8').digest('hex');
        return { v, pubkey: pk, source: (v.source != null ? String(v.source) : null), hash: h };
    });
    withHash.sort((a, b) => (a.hash < b.hash) ? -1 : (a.hash > b.hash ? 1 : 0));
    if (swq.isStakeWeightedQuorumActive(sb, net)) {
        let seen = new Set();
        withHash = withHash.filter(e => {
            if (e.source === null) return true;
            if (seen.has(e.source)) return false;
            seen.add(e.source);
            return true;
        });
    }
    return withHash.slice(0, Math.max(1, Number(redundancy) || 1)).map(e => e.v);
}

// Build the pipe-delimited ATTEST v1 (response) wire payload signed by N validators.
// RESPONSE_PAYLOAD travels base64 on the wire (binary-safe, no embedded `|`).
// Sigs hash the decoded bytes, which round-trip-equal the raw utf8 bytes,
// so MockAttestationValidator.sign() is unchanged.
function buildAttestationResponseAction({ requestId, providerId, responsePayload, status, meta, validators, snapshotBlock, network }) {
    // EQUIV gating mirrors the indexer: the request's block + run network. Callers may
    // pass the v0 request's block_index explicitly; otherwise default to the run network
    // (regtest/testnet → always active) at block 0, byte-identical on those networks.
    const net = network || process.env.NETWORK || 'regtest';
    const sb  = (snapshotBlock != null) ? Number(snapshotBlock) : 0;
    const sigCount = validators.length;
    const sigPairs = validators
        .map(v => v.pubkey + '|' + v.sign(requestId, providerId, responsePayload, status, meta, sb, net))
        .join('|');
    const responsePayloadB64 = Buffer.from(String(responsePayload || ''), 'utf8').toString('base64');
    return [
        'ATTEST',
        '1',
        requestId,
        providerId,
        responsePayloadB64,
        status,
        meta || '',
        String(sigCount),
        sigPairs
    ].join('|');
}

// Broadcast a signed ATTEST v1 (response) action from a funded address
async function broadcastAttestationResponse(broadcasterAddressInfo, payload) {
    const wireData = buildAttestationResponseAction(payload);
    console.log('Broadcasting ATTEST v1 (response) for request ' + String(payload.requestId).substring(0, 16) + '...');
    return await transactionHelper.createAndSendTransaction(broadcasterAddressInfo, wireData);
}

module.exports = {
    MockAttestationValidator,
    computeResponsibleSigners,
    buildAttestationResponseAction,
    broadcastAttestationResponse
};
