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
const axios = require('axios');
const transactionHelper = require('../transactionHelper');
// Sibling modules: same EQUIV header + SWQ gate the indexer's verifier uses (attest.js).
const eq  = require('../../../xchain-indexer/src/equivocation_header.js');
const swq = require('../../../xchain-indexer/src/stake_weighted_quorum.js');
const mathjs = require('mathjs');

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

// Every attestation validator staked in this mocha process, across every suite.
//
// The action suites share one chain, and the indexer computes a request's responsible
// set over EVERY qualifying staked key on it, so a suite that ranks only its OWN
// validators is mirroring a chain that does not exist. With two staking suites live,
// a redundancy=3 request ranks over six qualifying keys and the hash ranking can
// select keys the running suite cannot sign with; a live-fetched, correctly signed
// response then dies as `invalid: insufficient valid signatures (1/3)`. A per-suite
// slice only mirrors correctly when the suite runs alone against a fresh chain,
// which makes the venue decide the outcome, not the test.
//
// The suites run in ONE process, so the validator objects (private keys included)
// are all reachable: each suite REGISTERS what it stakes, and quorum suites compute
// responsible signers over this process-wide set, signing with whichever registered
// keys the ranking actually selects. Registration is the contract: any test that
// stakes a validator at/above a provider floor without registering it here rebreaks
// the mirror for every suite that runs after it.
const sessionStakedValidators = [];

function registerStakedValidator(v) {
    sessionStakedValidators.push(v);
    return v;
}

function getSessionStakedValidators() {
    return sessionStakedValidators.slice();
}

// Mirror of xchain-indexer attest.js _computeResponsibleSet: picks the request's
// deterministic responsible signer set so the test signs with exactly the keys the
// indexer will accept. Sorts the staked validator pool by SHA256(request_id || pubkey);
// at/above SWQ activation (regtest/testnet → block 0) dedupes by staking source (one
// slot per source, lowest-hash key wins), then takes the top-REDUNDANCY.
//
// PROVIDER STAKE FLOOR: at/above SWQ the indexer ALSO drops staking sources
// whose aggregate stake is below the request provider's min_stake_xchain (http_get
// 10000, llm 25000) before ranking. This helper reproduces that only when the caller
// supplies both a `minStake` and per-validator `weight`s; every e2e suite instead
// stakes each attestation validator ABOVE the relevant floor, which makes the filter a
// no-op and keeps the mirror exact. Stake a validator below the floor without passing
// `minStake` here and this helper will pick a signer the indexer does not consider
// responsible, which surfaces as "insufficient valid signatures" rather than as
// anything pointing at the stake amount.
//
// CONSENSUS-MIRROR: must match attest.js._computeResponsibleSet byte-for-byte, else the
// chosen signers won't be the ones the indexer deems responsible and validSigs falls
// short of REDUNDANCY. `validators` must be the FULL staked attestation set (the indexer
// computes over every staked key at the block, not just the ones a given test tracks).
function computeResponsibleSigners(requestId, redundancy, validators, snapshotBlock, network, minStake) {
    const net = network || process.env.NETWORK || 'regtest';
    const sb  = (snapshotBlock != null) ? Number(snapshotBlock) : 0;
    if (minStake != null && swq.isStakeWeightedQuorumActive(sb, net))
        validators = validators.filter(v => v && v.weight != null &&
            /^\d+(\.\d+)?$/.test(String(v.weight).trim()) &&
            mathjs.bignumber(String(v.weight).trim()).gte(mathjs.bignumber(String(minStake).trim())));
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

// Same contract as computeResponsibleSigners (the ranked validator objects a
// caller can sign with), but asks the hub's getattestationresponsibleset RPC
// first: that method resolves the ranking through the hub's own production
// code, so a hub carrying the fix retires this file's mirror of the rule
// without a call-site change. Falls back to the local derivation whenever the
// hub cannot answer - unreachable, pre-row-47 (method not found), or the
// request is not one it currently tracks - so older hubs still work.
async function resolveResponsibleSigners({ hubUrl, requestId, redundancy, validators, snapshotBlock, network, minStake }) {
    if (hubUrl) {
        try {
            const res = await axios.post(hubUrl, {
                jsonrpc: '2.0', id: Date.now(),
                method: 'getattestationresponsibleset',
                params: { request_id: requestId }
            }, { timeout: 5000, validateStatus: () => true });
            const result = res && res.data && res.data.result;
            if (result && !result.error && Array.isArray(result.responsible)) {
                const byPubkey = new Map(validators.map(v => [String(v.pubkey).toLowerCase(), v]));
                const resolved = result.responsible
                    .map(pk => byPubkey.get(String(pk).toLowerCase()))
                    .filter(Boolean);
                // Trust the hub's answer only when every pubkey it named maps to a
                // validator this process holds a key for; a partial map means the hub's
                // view of the staked set disagrees with this process's (a stale snapshot,
                // a chain not yet staked on here), and signing with a truncated set would
                // just relocate the "insufficient signatures" failure rather than avoid it.
                if (resolved.length === result.responsible.length) return resolved;
            }
        } catch (e) { /* unreachable or pre-row-47 hub: fall through to the local derivation */ }
    }
    return computeResponsibleSigners(requestId, redundancy, validators, snapshotBlock, network, minStake);
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
    registerStakedValidator,
    getSessionStakedValidators,
    computeResponsibleSigners,
    resolveResponsibleSigners,
    buildAttestationResponseAction,
    broadcastAttestationResponse
};
