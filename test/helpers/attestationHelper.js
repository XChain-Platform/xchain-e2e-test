/*********************************************************************
 * E2E test helper — Mock Attestation Validator
 *
 * Generates a real Ed25519 keypair and signs ATTEST v1 (response) bodies
 * using the same canonical message the indexer's verifier expects.
 *
 * This is "mock" only in the sense that the validator runs inside the
 * test process (no hub) — it signs with a real key whose pubkey has been
 * staked via the regular STAKE action, so the indexer's capability check
 * + Ed25519 verification exercise the production code paths end-to-end.
 *
 * Spec: claude/reports/specs/2026-05-24_external-attestation-framework.md
 ********************************************************************/

const crypto = require('crypto');
const transactionHelper = require('../transactionHelper');

class MockAttestationValidator {
    constructor() {
        const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
        this.privateKey = privateKey;
        // SPKI DER for Ed25519 is 12-byte prefix + 32-byte raw pubkey
        let spkiDer = publicKey.export({ format: 'der', type: 'spki' });
        this.pubkey = spkiDer.subarray(12).toString('hex');
    }

    // Canonical message that the indexer's attestation_response.js handler reconstructs.
    // Must match exactly:
    //   request_id || provider_id || sha256(response_payload) || status || meta
    _canonical(requestId, providerId, responsePayload, status, meta) {
        const responseHash = crypto.createHash('sha256').update(String(responsePayload || ''), 'utf8').digest('hex');
        return Buffer.from(
            String(requestId) +
            String(providerId) +
            responseHash +
            String(status) +
            String(meta || ''),
            'utf8'
        );
    }

    sign(requestId, providerId, responsePayload, status, meta) {
        const message = this._canonical(requestId, providerId, responsePayload, status, meta);
        return crypto.sign(null, message, this.privateKey).toString('hex');
    }
}

// Build the pipe-delimited ATTEST v1 (response) wire payload signed by N validators.
// RESPONSE_PAYLOAD travels base64 on the wire (binary-safe, no embedded `|`).
// Sigs hash the decoded bytes, which round-trip-equal the raw utf8 bytes —
// so MockAttestationValidator.sign() is unchanged.
function buildAttestationResponseAction({ requestId, providerId, responsePayload, status, meta, validators }) {
    const sigCount = validators.length;
    const sigPairs = validators
        .map(v => v.pubkey + '|' + v.sign(requestId, providerId, responsePayload, status, meta))
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
    buildAttestationResponseAction,
    broadcastAttestationResponse
};
