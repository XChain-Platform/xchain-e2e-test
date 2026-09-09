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
 * The AT2 rig's EXPLICIT live-chain override, and the barrier drill's env
 * contract, pinned without a chain, a database or a hub.
 *
 * WHY THIS EXISTS. The override's whole reason for being is a host whose
 * standing hub cannot be asked: `_resolveLiveChain` normally dials
 * XChainHubConnector and calls `getAllConfig`, an auth-gated read, and on such a
 * host that call fails and no node can be built at all. An override that
 * "worked" but still dialled the hub would pass every integration run on a
 * machine that HAS a hub and fail only on the one machine it was written for, so
 * the assertion here is not "the shape came back" but "the connector was never
 * constructed".
 *
 * The second half is the launcher's contract. Every endpoint the drill needs
 * arrives by environment-variable NAME, is read once, and is then invisible
 * inside a child process: a variable exported under the wrong name degrades into
 * a node that indexes nothing, hours later, which is indistinguishable from the
 * barrier result the drill exists to measure. So the composition is pure and
 * pinned here, and a missing variable is named rather than defaulted.
 ********************************************************************/

const assert     = require('assert');
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
    const mod = proxyquire('../helpers/oracleBatchReplay.js', {
        '../../src/XChainHubConnector.js': CountingHubConnector
    });
    return { mod: mod, seen: seen };
}

describe('oracleBatchReplay: the explicit live-chain override (AT5 venue, row 41)', function () {
    this.timeout(20000);

    it('resolves the caller\'s endpoints and never constructs the hub connector', async function () {
        const { mod, seen } = rigWithCountedConnector();
        const override = fullOverride();
        const node = new mod.OracleBatchReplayNode({
            label: 'at5unit', coin: 'dogecoin', network: 'testnet', liveChain: override });

        const live = await node._resolveLiveChain();

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
        const live = await node._resolveLiveChain();
        assert.deepStrictEqual(live.liveIndexer, override.liveIndexer);
    });

    describe('a malformed override is refused by the FIELD that is missing', function () {
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
                await assert.rejects(() => node._resolveLiveChain(), (err) => {
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
            await assert.rejects(() => node._resolveLiveChain(), /feeDestination/);
        });

        it('accepts an explicitly null feeDestination, which means the pinned default', async function () {
            const { mod } = rigWithCountedConnector();
            const override = fullOverride();
            override.feeDestination = null;
            const node = new mod.OracleBatchReplayNode({ label: 'at5unit', liveChain: override });
            const live = await node._resolveLiveChain();
            assert.strictEqual(live.feeDestination, null);
        });
    });

    it('refuses to read the standing chain\'s fee coordinates when the override names no liveIndexer', async function () {
        // The one reader of `liveIndexer`. AT2's cross-node comparison needs it;
        // the barrier drill does not, and the difference has to be legible rather
        // than surfacing as a null host inside the MariaDB driver.
        const { mod } = rigWithCountedConnector();
        const node = new mod.OracleBatchReplayNode({ label: 'at5unit', liveChain: fullOverride() });
        node._live = await node._resolveLiveChain();
        await assert.rejects(() => node.liveChainFeeCoordinates({}), /liveIndexer/);
    });
});

describe('oracleBatchBarrierTestnet: the launcher environment contract (row 41)', function () {

    const drill = require('../drills/oracleBatchBarrierTestnet.drill.js');

    // The complete set the launcher exports, by name.
    function fullEnv() {
        return {
            AT5_DECODER_DB_HOST: 'db.internal', AT5_DECODER_DB_PORT: '3306',
            AT5_DECODER_DB_NAME: 'XChain_TDOGE_Decoder', AT5_DECODER_DB_USER: 'decoder_reader',
            AT5_DECODER_DB_PASS: 'decoder-secret',
            AT5_NODE_HOST: 'node.internal', AT5_NODE_PORT: '44555',
            AT5_NODE_USER: 'rpc', AT5_NODE_PASS: 'rpc-secret',
            AT5_TRACKER_HOST: 'tracker.internal', AT5_TRACKER_PORT: '3033',
            AT5_FEE_DESTINATION: 'nsFeeDestinationAddress',
            BTC_SERVICE_HOST: 'btc.internal', BTC_INDEXER_API_PORT: '3014',
            BTC_INDEXER_API_KEY: 'btc-secret'
        };
    }

    it('composes exactly the shape the rig\'s override validator accepts', function () {
        const live = drill.composeLiveChainFromEnv(fullEnv());
        assert.deepStrictEqual(live, {
            decoder: { host: 'db.internal', port: '3306', name: 'XChain_TDOGE_Decoder',
                user: 'decoder_reader', pass: 'decoder-secret' },
            node: { host: 'node.internal', port: '44555', user: 'rpc', pass: 'rpc-secret' },
            tracker: { host: 'tracker.internal', port: '3033' },
            btcOracle: { host: 'btc.internal', port: '3014', url: 'http://btc.internal:3014',
                apiKey: 'btc-secret', db: null },
            feeDestination: 'nsFeeDestinationAddress',
            liveIndexer: null
        });

        // The two halves must agree, which is the only thing that makes the
        // launcher's contract and the rig's contract one contract: what the drill
        // composes is what the rig accepts, checked by the rig itself.
        const { mod } = rigWithCountedConnector();
        const node = new mod.OracleBatchReplayNode({ label: 'at5unit', network: 'testnet', liveChain: live });
        return node._resolveLiveChain();
    });

    it('throws naming the FIRST variable the launcher failed to export', function () {
        // Read order is the documented contract order, so the message points at
        // the first gap rather than at whichever field the code happened to touch.
        const order = ['AT5_DECODER_DB_HOST', 'AT5_DECODER_DB_PORT', 'AT5_DECODER_DB_NAME',
            'AT5_DECODER_DB_USER', 'AT5_DECODER_DB_PASS', 'AT5_NODE_HOST', 'AT5_NODE_PORT',
            'AT5_NODE_USER', 'AT5_NODE_PASS', 'AT5_TRACKER_HOST', 'AT5_TRACKER_PORT',
            'AT5_FEE_DESTINATION', 'BTC_SERVICE_HOST', 'BTC_INDEXER_API_PORT', 'BTC_INDEXER_API_KEY'];
        for (const name of order) {
            const env = fullEnv();
            delete env[name];
            assert.throws(() => drill.composeLiveChainFromEnv(env), (err) => {
                assert.ok(err.message.indexOf(name) !== -1,
                    'dropping ' + name + ' must be reported by name; it said: ' + err.message);
                return true;
            }, 'dropping ' + name + ' was accepted silently');
        }
        // An empty value is a missing value: an exported-but-blank variable is the
        // commonest launcher failure and the one a truthiness test lets through.
        const blank = fullEnv();
        blank.AT5_NODE_PASS = '   ';
        assert.throws(() => drill.composeLiveChainFromEnv(blank), /AT5_NODE_PASS/);
    });

    it('defaults the observation budget, the origin control and the explorer', function () {
        const s = drill.readSettings({});
        assert.strictEqual(s.observeBlocks, 6);
        assert.strictEqual(s.maxMinutes, 240);
        assert.strictEqual(s.basePort, 61000);
        assert.strictEqual(s.label, 'at5');
        assert.strictEqual(s.resultPath, './at5-result.json');
        // No built-in origin host: the control endpoint is deployment-specific and
        // an unset value must take the explorer fallback, never a hard-coded dial.
        assert.strictEqual(s.originIndexerUrl, '');
        assert.strictEqual(s.explorerUrl, 'https://explorer.xchain.io');
        const over = drill.readSettings({ AT5_OBSERVE_BLOCKS: '2', AT5_MAX_MINUTES: '30',
            AT5_EXPLORER_URL: 'https://explorer.xchain.io/', AT5_LABEL: 'at5-b',
            AT5_ORIGIN_INDEXER_URL: 'http://origin.example.invalid:3114' });
        assert.strictEqual(over.observeBlocks, 2);
        assert.strictEqual(over.maxMinutes, 30);
        assert.strictEqual(over.originIndexerUrl, 'http://origin.example.invalid:3114');
        assert.strictEqual(over.label, 'at5b', 'the label lands in database names, so it must be an identifier');
        assert.strictEqual(over.explorerUrl, 'https://explorer.xchain.io', 'a trailing slash must not double up');
    });

    it('reads the barrier deferral line the indexer actually prints', function () {
        // Verbatim shape from xchain-indexer: XChainIndexer.js logs the defer and
        // hub_db_sync's waitForPriceSyncTime supplies the state in the message.
        const line = 'Deferring block 67879480 (price time-sync):  Error: price time-sync barrier timed out ' +
            'after 60000ms waiting for block time 1788914673 (mirror max round timestamp 1788910800, ' +
            'stream watermark at 1788914000)';
        const d = drill.parseDeferral(line);
        assert.ok(d, 'the price time-sync deferral line was not recognized at all');
        assert.strictEqual(d.height, 67879480);
        assert.strictEqual(d.mirrorMaxRoundTs, 1788910800);
        assert.strictEqual(d.streamWatermark, 1788914000);
        // A different barrier's deferral must not be counted as this one's: the
        // indexer defers blocks on nine separate barriers with the same prefix.
        assert.strictEqual(drill.parseDeferral('Deferring block 12 (oracle sync):  Error: x'), null);
        assert.strictEqual(drill.parseDeferral('Parsed block 67879480'), null);
    });

    it('classifies which escape opened the barrier, from what the node held', function () {
        const blockTime = 1_788_914_673;
        const deferral = [{ height: 1, mirrorMaxRoundTs: 0, streamWatermark: 0, line: 'x' }];
        // Never deferred: the barrier was satisfied on arrival.
        assert.strictEqual(drill.classifyEscape([], null, blockTime, 12).escape, 'none');
        // Deferred, and the mirror ended up holding a round at or past the block's
        // time: the CONTENT escape, which D61 says a chain-only node cannot reach
        // at the tip, so seeing it is a finding rather than a pass.
        assert.strictEqual(drill.classifyEscape(deferral, blockTime, blockTime, 4900).escape, 'content');
        assert.strictEqual(drill.classifyEscape(deferral, blockTime + 1, blockTime, 4900).escape, 'content');
        // Deferred and the mirror never caught up: the watermark is the only
        // escape the code has left.
        const w = drill.classifyEscape(deferral, blockTime - 600, blockTime, 4900);
        assert.strictEqual(w.escape, 'watermark');
        assert.strictEqual(w.corroborated, true, 'a 4900s stall is consistent with a 4800s grace');
        // A watermark escape that fired before the grace could have elapsed is not
        // consistent with the code, and the record must say so rather than smooth
        // it over.
        assert.strictEqual(drill.classifyEscape(deferral, null, blockTime, 90).corroborated, false);
    });

    it('summarizes only what the per-block records actually carry', function () {
        const summary = drill.summarize({
            observations: [
                { height: 10, stallS: 4801, escape: 'watermark', verdictAgreements: 3, verdictDisagreements: [],
                  actions: [{ coordinateAligned: true }, { coordinateAligned: true }, { coordinateAligned: true }],
                  holes: { missingFromHub: { count: 0 }, missingFromMirror: { count: 0 }, roundsCarried: 40 } },
                { height: 11, stallS: 4900, escape: 'watermark', verdictAgreements: 1,
                  verdictDisagreements: [{ actionIndex: 7, nodePricedAgainstRound: 1730, originPricedAgainstRound: 1732 }],
                  actions: [{ coordinateAligned: true }, { coordinateAligned: true }, { coordinateAligned: false }],
                  holes: { missingFromHub: { count: 0 }, missingFromMirror: { count: 2 }, roundsCarried: 42 } }
            ],
            originLagSeries: [{ lag: 0 }, { lag: 3 }, { unavailable: 'unauthorized (-32001)' }]
        });
        assert.strictEqual(summary.blocksObserved, 2);
        assert.strictEqual(summary.maxStallS, 4900);
        assert.strictEqual(summary.minStallS, 4801);
        assert.deepStrictEqual(summary.escapes, { watermark: 2 });
        assert.strictEqual(summary.stallsWithinGracePlusConfirm, 2, 'both stalls are at or past the 4800s grace');
        // The hole count comes from the LATEST observation, since coverage is
        // cumulative and an earlier clean read does not survive a later gap.
        assert.strictEqual(summary.holesTotal, 2);
        assert.strictEqual(summary.holesInMirror, 2);
        assert.strictEqual(summary.verdictsCompared, 5, 'only coordinate-aligned actions are comparable');
        assert.strictEqual(summary.verdictsAgreed, 4);
        assert.strictEqual(summary.verdictsDiverged, 1);
        assert.strictEqual(summary.divergences[0].originPricedAgainstRound, 1732,
            'a divergence must carry the round each side priced against (D61), or it is an anecdote');
        assert.strictEqual(summary.originMaxLag, 3);
        assert.strictEqual(summary.originIndexerUnavailable, 'unauthorized (-32001)',
            'an unreadable control must be reported, never smoothed into "no lag"');
    });
});
