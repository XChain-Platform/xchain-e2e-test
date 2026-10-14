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
 * Relay-loop drill config: env knobs, constants and the origin contract.
 ********************************************************************/

'use strict';

const internalPath = require('path');
const internalFs   = require('fs');

// Resolve the bundled hub (in-image) first, then the monorepo sibling - the same
// loader test/actions/realUrlAttestation.test.js uses for the provider.
const HUB_BASE = (function () {
    const candidates = [
        process.env.XCHAIN_HUB_PATH,
        internalPath.resolve(__dirname, '../../xchain-hub'),
        internalPath.resolve(__dirname, '../../../xchain-hub'),
    ].filter(Boolean);
    for (const c of candidates) {
        if (internalFs.existsSync(internalPath.join(c, 'src/attestation/relay.js'))) return c;
    }
    return null;
})();

const ORIGIN_COIN = process.env.XC974_ORIGIN_COIN || 'litecoin';
const ATTEST_URL  = process.env.XC974_ATTEST_URL  || 'https://jsonplaceholder.typicode.com/todos/1';
const REDUNDANCY  = parseInt(process.env.XC974_REDUNDANCY || '3', 10);
// http_get's registry entry: deadline_window_blocks = 100, so this is the
// longest deadline the origin request may name.
const DEADLINE_BLOCKS = 100;
// XCHAIN carries a 100000 per-action MAX_MINT on these venues, so a large stake
// is assembled from repeated mints rather than one.
const MINT_CHUNK = 100000;
// Clears BOTH the attestation capability min_stake (1000) and the http_get
// PROVIDER floor (10000), which the responsible-set derivation enforces at/above
// STAKE_WEIGHTED_QUORUM (armed at genesis on regtest).
const ATTESTATION_MIN_STAKE = '15000.00000000';
const ACTIVATION_DELAY_BLOCKS = 6;

// The origin contract. Deliberately the realUrlAttestation shape: one method
// that requests, one that records every callback argument, so the assertions can
// prove the relayed callback is INDISTINGUISHABLE from a local one.
const ORIGIN_CONTRACT = `
module.exports = {
    meta: { name: 'Relay Loop Origin', description: 'Requests an attestation across chains for the relay-loop drill.', version: '1.0.0' },
    askAcrossChains: function(xchain) {
        var url = xchain.getInputParam(0);
        var requestId = xchain.attestation.request(
            'http_get',
            url,
            'handleResponse',
            ['ctx-xc974'],
            { redundancy: ${REDUNDANCY}, deadlineBlocks: ${DEADLINE_BLOCKS} }
        );
        xchain.state.set('relay_request_id', requestId);
        return requestId;
    },
    handleResponse: function(xchain) {
        xchain.state.set('callback_request_id',  xchain.getInputParam(0));
        xchain.state.set('callback_provider_id', xchain.getInputParam(1));
        xchain.state.set('callback_status',      xchain.getInputParam(2));
        xchain.state.set('callback_payload',     xchain.getInputParam(3));
        xchain.state.set('callback_context',     xchain.getInputParam(4));
    }
};
`;

module.exports = {
    HUB_BASE, ORIGIN_COIN, ATTEST_URL, REDUNDANCY, DEADLINE_BLOCKS, MINT_CHUNK,
    ATTESTATION_MIN_STAKE, ACTIVATION_DELAY_BLOCKS, ORIGIN_CONTRACT
};
