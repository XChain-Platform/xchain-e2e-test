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
 * The AT2 rig's explicit live-chain override: it never dials the hub.
 ********************************************************************/

const assert     = require('assert');
const { fullOverride, rigWithCountedConnector } = require('./helpers/fixtures.js');

// The override resolves the caller's endpoints, with or without a liveIndexer.
function registerOverrideResolutionTests() {
    it('resolves the caller\'s endpoints and never constructs the hub connector', async function () {
        const { mod, seen } = rigWithCountedConnector();
        const override = fullOverride();
        const node = new mod.OracleBatchReplayNode({
            label: 'at5unit', coin: 'dogecoin', network: 'testnet', liveChain: override });

        const live = await node['_resolveLiveChain']();

        assert.strictEqual(seen.constructed, 0,
            'the rig constructed the hub connector ' + seen.constructed + ' time(s) despite being given an ' +
            'explicit live chain. The override exists precisely for a host whose standing hub carries no key ' +
            'and cannot answer getAllConfig, so any dial at all defeats it.');
        assert.strictEqual(seen.pinged, 0, 'the rig pinged the standing hub despite an explicit live chain');
        assert.strictEqual(seen.configRead, 0,
            'the rig read the standing hub\'s config oracle despite an explicit live chain');
        assert.strictEqual(node.unavailable, null, 'the node reported itself unavailable: ' + node.unavailable);

        assert.deepStrictEqual(live.decoder, override.decoder, 'the decoder endpoints were not passed through');
        assert.deepStrictEqual(live.node, override.node, 'the coin node endpoints were not passed through');
        assert.deepStrictEqual(live.tracker, override.tracker, 'the tracker endpoints were not passed through');
        assert.strictEqual(live.feeDestination, override.feeDestination, 'the fee destination was not passed through');
        assert.strictEqual(live.btcOracle.url, override.btcOracle.url, 'the Bitcoin oracle URL was not passed through');
        assert.strictEqual(live.btcOracle.apiKey, override.btcOracle.apiKey, 'the Bitcoin oracle key was not passed through');
        // Both optional halves are normalized rather than left undefined: the one
        // reader of each has to be able to test them.
        assert.strictEqual(live.liveIndexer, null, 'an omitted liveIndexer must normalize to null, not undefined');
        assert.strictEqual(live.btcOracle.db, null, 'an omitted Bitcoin oracle database must normalize to null');
    });

    it('carries an explicit liveIndexer through when one is given', async function () {
        const { mod } = rigWithCountedConnector();
        const override = fullOverride();
        override.liveIndexer = { host: '127.0.0.1', port: 13306, name: 'Live_Indexer', user: 'r', pass: 'p' };
        const node = new mod.OracleBatchReplayNode({ label: 'at5unit', liveChain: override });
        const live = await node['_resolveLiveChain']();
        assert.deepStrictEqual(live.liveIndexer, override.liveIndexer);
    });
}

// Each malformed override is refused, and the refusal names the missing field.
function registerMalformedOverrideTests() {
    // Each case drops exactly one field, so a message that names the wrong one
    // is a real defect: this error is the only signal a launcher gets before
    // the node spends hours indexing nothing.
    const cases = [
        ['decoder.pass',      (o) => { delete o.decoder.pass; }],
        ['decoder.name',      (o) => { o.decoder.name = ''; }],
        ['node.port',         (o) => { delete o.node.port; }],
        ['tracker.host',      (o) => { delete o.tracker.host; }],
        ['btcOracle.apiKey',  (o) => { o.btcOracle.apiKey = null; }],
        ['btcOracle',         (o) => { delete o.btcOracle; }],
        ['feeDestination',    (o) => { delete o.feeDestination; }],
        ['liveIndexer.name',  (o) => { o.liveIndexer = { host: 'h', port: 1, user: 'u', pass: 'p' }; }]
    ];
    for (const [field, breakIt] of cases) {
        it('names `' + field + '`', async function () {
            const { mod, seen } = rigWithCountedConnector();
            const override = fullOverride();
            breakIt(override);
            const node = new mod.OracleBatchReplayNode({ label: 'at5unit', liveChain: override });
            await assert.rejects(() => node['_resolveLiveChain'](), (err) => {
                assert.ok(err instanceof Error, 'a malformed override must reject with an Error');
                assert.ok(err.message.indexOf(field) !== -1,
                    'the refusal must name the missing field `' + field + '`; it said: ' + err.message);
                return true;
            });
            assert.strictEqual(seen.constructed, 0,
                'a malformed override must be refused outright, never fall back to dialling the standing hub');
        });
    }

    it('refuses a feeDestination that is neither an address nor null', async function () {
        const { mod } = rigWithCountedConnector();
        const override = fullOverride();
        override.feeDestination = 12345;
        const node = new mod.OracleBatchReplayNode({ label: 'at5unit', liveChain: override });
        await assert.rejects(() => node['_resolveLiveChain'](), /feeDestination/);
    });

    it('accepts an explicitly null feeDestination, which means the pinned default', async function () {
        const { mod } = rigWithCountedConnector();
        const override = fullOverride();
        override.feeDestination = null;
        const node = new mod.OracleBatchReplayNode({ label: 'at5unit', liveChain: override });
        const live = await node['_resolveLiveChain']();
        assert.strictEqual(live.feeDestination, null);
    });
}

// The one reader of `liveIndexer` refuses when the override names none.
function registerLiveIndexerRefusalTest() {
    it('refuses to read the standing chain\'s fee coordinates when the override names no liveIndexer', async function () {
        // The one reader of `liveIndexer`. AT2's cross-node comparison needs it;
        // the barrier drill does not, and the difference has to be legible rather
        // than surfacing as a null host inside the MariaDB driver.
        const { mod } = rigWithCountedConnector();
        const node = new mod.OracleBatchReplayNode({ label: 'at5unit', liveChain: fullOverride() });
        node['_live'] = await node['_resolveLiveChain']();
        await assert.rejects(() => node.liveChainFeeCoordinates({}), /liveIndexer/);
    });
}

describe('oracleBatchReplay: the explicit live-chain override (AT5 venue, row 41)', function () {
    this.timeout(20000);

    registerOverrideResolutionTests();

    describe('a malformed override is refused by the FIELD that is missing', registerMalformedOverrideTests);

    registerLiveIndexerRefusalTest();
});
