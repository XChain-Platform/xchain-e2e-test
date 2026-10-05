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
 * Transport-integrity cross-check on the hub-served coin_consensus_hashes.
 *
 * The hub publishes the sha256 of its own consensus-critical coin subset per
 * (network, coin) on getallconfigs. This suite never APPLIES those values (it
 * derives consensus from the vendored src/coins bundle), so the only thing the
 * check can do is speak: a hub built from a divergent bundle must name itself
 * at the first config fetch instead of surfacing hours later as an unexplained
 * action-level failure in the middle of a run.
 *
 ********************************************************************/

const assert = require('assert');
const nock   = require('nock');

const XChainHubConnector = require('../../src/XChainHubConnector.js');
const coins              = require('../../src/coins');

const HUB_BASE = 'http://hub.test:10000';

const CONFIGS = {
    bitcoin: {
        regtest: {
            'xchain-encoder': { host: 'encoder.test', port: '3000' }
        }
    }
};

// The hashes a hub built from the SAME coin files serves.
function matchingHashes(){
    const served = {};
    for(const network of coins.NETWORKS) served[network] = coins.consensusHashes(network);
    return served;
}

// Capture console.error around an async call; the check's whole observable
// effect is the line it writes.
async function withCapturedError(fn){
    const lines = [];
    const original = console.error;
    console.error = (...args) => { lines.push(args.join(' ')); };
    try { await fn(); } finally { console.error = original; }
    return lines;
}

function stubHub(hashes){
    nock(HUB_BASE).post('/').reply(200, {
        jsonrpc: '2.0',
        id: 1,
        result: { configs: CONFIGS, seq: 7, watermark: 1000, coin_consensus_hashes: hashes }
    });
}

describe('XChainHubConnector hub-served consensus-hash cross-check', function(){

    afterEach(function(){
        nock.cleanAll();
    });

    it('stays silent when the hub serves the hashes this suite vendors', async function(){
        const hub = new XChainHubConnector([HUB_BASE]);
        stubHub(matchingHashes());
        const lines = await withCapturedError(async () => {
            assert.deepStrictEqual(await hub.getAllConfig(), CONFIGS);
        });
        assert.deepStrictEqual(lines, []);
    });

    it('reports the drifted coin and network when a served hash differs', async function(){
        const hub = new XChainHubConnector([HUB_BASE]);
        const vendored = coins.consensusHashes('regtest').BTC;
        const served = matchingHashes();
        served.regtest = Object.assign({}, served.regtest, { BTC: 'f'.repeat(64) });

        stubHub(served);
        const lines = await withCapturedError(async () => {
            // The config tree is still returned: the check never fails the fetch.
            assert.deepStrictEqual(await hub.getAllConfig(), CONFIGS);
        });

        assert.strictEqual(lines.length, 1, 'expected exactly one mismatch report');
        assert.match(lines[0], /CONSENSUS HASH MISMATCH/);
        assert.ok(lines[0].includes('BTC/regtest'), 'names the drifted coin and network');
        assert.ok(lines[0].includes('f'.repeat(64)), 'quotes the hash the hub served');
        assert.ok(lines[0].includes(vendored), 'quotes the vendored hash it was compared against');
        assert.ok(!lines[0].includes('LTC/regtest'), 'does not report coins that match');
    });
});

describe('XChainHubConnector hub-served consensus-hash cross-check', function(){

    afterEach(function(){
        nock.cleanAll();
    });

    it('is silent against an older hub that serves no hashes at all', async function(){
        const hub = new XChainHubConnector([HUB_BASE]);
        nock(HUB_BASE).post('/').reply(200, { jsonrpc: '2.0', id: 1, result: CONFIGS });
        const lines = await withCapturedError(async () => { await hub.getAllConfig(); });
        assert.deepStrictEqual(lines, []);
    });

    it('treats a coin the hub does not serve as version skew, not drift', async function(){
        const hub = new XChainHubConnector([HUB_BASE]);
        const served = matchingHashes();
        delete served.regtest.DOGE;
        delete served.testnet;

        stubHub(served);
        const lines = await withCapturedError(async () => { await hub.getAllConfig(); });
        assert.deepStrictEqual(lines, []);
    });

    it('logs a standing divergence once, then again only when the set changes', async function(){
        const hub = new XChainHubConnector([HUB_BASE]);
        const drifted = matchingHashes();
        drifted.regtest = Object.assign({}, drifted.regtest, { BTC: 'a'.repeat(64) });

        stubHub(drifted);
        const first = await withCapturedError(async () => { await hub.getAllConfig(); });
        assert.strictEqual(first.length, 1);

        stubHub(drifted);
        const second = await withCapturedError(async () => { await hub.getAllConfig(); });
        assert.deepStrictEqual(second, [], 'a standing divergence must not flood the run output');

        const wider = matchingHashes();
        wider.regtest = Object.assign({}, wider.regtest, { BTC: 'a'.repeat(64), LTC: 'b'.repeat(64) });
        stubHub(wider);
        const third = await withCapturedError(async () => { await hub.getAllConfig(); });
        assert.strictEqual(third.length, 1, 'a widened drift must report');
        assert.ok(third[0].includes('LTC/regtest'));

        stubHub(matchingHashes());
        const fourth = await withCapturedError(async () => { await hub.getAllConfig(); });
        assert.deepStrictEqual(fourth, []);

        stubHub(drifted);
        const fifth = await withCapturedError(async () => { await hub.getAllConfig(); });
        assert.strictEqual(fifth.length, 1, 'a re-opened drift must report again');
    });
});
