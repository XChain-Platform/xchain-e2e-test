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
 * Shared fixtures for the live-chain override and launcher-contract suites.
 ********************************************************************/

const proxyquire = require('proxyquire');

// A full, well-formed override, in the shape `_resolveLiveChain` returns. The
// values are obvious fakes: nothing in this file opens a socket.
function fullOverride() {
    return {
        decoder: { host: '127.0.0.1', port: 13306, name: 'Decoder_Db', user: 'reader', pass: 'decoder-pass' },
        node:    { host: '127.0.0.1', port: 44555, user: 'rpcuser', pass: 'rpc-pass' },
        tracker: { host: '127.0.0.1', port: 3033 },
        btcOracle: { host: '10.0.0.9', port: 3014, url: 'http://10.0.0.9:3014', apiKey: 'btc-key' },
        feeDestination: 'nsFeeDestinationAddressForTheChain'
    };
}

// The rig with its hub connector replaced by a counter. `parseEndpoints` and
// `ping` are present so that a rig which IGNORED the override would take the
// discovery path to its normal end (unavailable, null) instead of dying on a
// missing static, which would make the falsification pass for the wrong reason.
function rigWithCountedConnector() {
    const seen = { constructed: 0, pinged: 0, configRead: 0 };
    class CountingHubConnector {
        constructor() { seen.constructed++; }
        static parseEndpoints() { return ['http://127.0.0.1:1']; }
        async ping() { seen.pinged++; return false; }
        async getAllConfig() { seen.configRead++; return {}; }
    }
    const mod = proxyquire('../../../helpers/oracleBatchReplay.js', {
        '../../src/XChainHubConnector.js': CountingHubConnector
    });
    return { mod: mod, seen: seen };
}

module.exports = { fullOverride, rigWithCountedConnector };
