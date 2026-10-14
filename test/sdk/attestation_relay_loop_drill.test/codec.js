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
 *
 * Hub canonical/wire codec, the federation signer and responsible-key grinding.
 ********************************************************************/

'use strict';

const crypto = require('crypto');
const internalPath = require('path');
const attestationHelper = require('../../helpers/attestationHelper');
const { HUB_BASE } = require('./config');

// ── production canonical/wire codec, borrowed from the hub ────────────────────
// The relay's canonical + wire builders depend on nothing but `this.sha256`, so
// binding them onto a bare object runs the SHIPPED hub implementation without
// booting a hub. If these ever stop being pure, this throws here rather than
// producing signatures the indexer silently drops as unquorate.
function relayCodec() {
    if (!HUB_BASE) throw new Error('xchain-hub checkout not found; the drill signs with the hub\'s own canonical builders');
    const AttestationRelay = require(internalPath.join(HUB_BASE, 'src/attestation/relay.js'));
    const p = AttestationRelay.prototype;
    const codec = {
        sha256: p.sha256,
        requestCanonical:  function (r) { return p.relayRequestCanonical.call(codec, r); },
        responseCanonical: function (r) { return p.relayResponseCanonical.call(codec, r); },
        requestWire:       function (r, sigs) { return p.buildRequestWire.call(codec, r, sigs); },
        responseWire:      function (r, sigs) { return p.buildResponseWire.call(codec, r, sigs); },
    };
    return codec;
}

// An Ed25519 federation key that signs relay canonicals. Same shape as
// attestationHelper.MockAttestationValidator (raw 32-byte pubkey hex), but the
// message is a full canonical string rather than the v1 field tuple.
class RelaySigner {
    constructor() {
        const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
        this.privateKey = privateKey;
        this.pubkey = publicKey.export({ format: 'der', type: 'spki' }).subarray(12).toString('hex');
        this.source = null;
    }
    sign(canonical) {
        return crypto.sign(null, Buffer.from(String(canonical), 'utf8'), this.privateKey).toString('hex');
    }
}

// Rank a pubkey the way computeResponsibleSet does: SHA256(request_id || pubkey).
function responsibleRank(requestId, pubkey) {
    return crypto.createHash('sha256')
        .update(String(requestId), 'utf8')
        .update(String(pubkey).toLowerCase(), 'utf8')
        .digest('hex');
}

// Generate `count` attestation keys that outrank EVERY key already staked for the
// capability, so the request's responsible set is exactly ours. This is what lets
// the drill run on a venue with a pre-existing validator set instead of demanding
// the freshly-reset chain realUrlAttestation needs; the selection rule is
// untouched, we simply bring keys that win it.
function grindResponsibleKeys(requestId, count, existingPubkeys) {
    let ceiling = null;
    for (const pk of existingPubkeys) {
        const h = responsibleRank(requestId, pk);
        if (ceiling === null || h < ceiling) ceiling = h;
    }
    const winners = [];
    for (let tries = 0; winners.length < count; tries++) {
        if (tries > 200000) throw new Error('could not grind ' + count + ' top-ranked attestation keys');
        const v = new attestationHelper.MockAttestationValidator();
        if (ceiling !== null && responsibleRank(requestId, v.pubkey) >= ceiling) continue;
        winners.push(v);
    }
    // Ours must also be the top `count` AMONG THEMSELVES in a stable way; sorting
    // here only makes the log readable, the indexer re-derives the order.
    winners.sort((a, b) => (responsibleRank(requestId, a.pubkey) < responsibleRank(requestId, b.pubkey) ? -1 : 1));
    return winners;
}

module.exports = { relayCodec, RelaySigner, grindResponsibleKeys };
