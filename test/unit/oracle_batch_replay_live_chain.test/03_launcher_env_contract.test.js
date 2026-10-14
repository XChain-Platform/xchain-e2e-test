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
 * The barrier drill's launcher environment contract.
 ********************************************************************/

const assert     = require('assert');
const { rigWithCountedConnector } = require('./helpers/fixtures.js');

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

// The launcher env composes the override shape, and a gap is named.
function registerLauncherEnvCompositionTests(drill) {
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
        return node['_resolveLiveChain']();
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
}

// Settings defaults and the deferral line the indexer prints.
function registerSettingsAndDeferralTests(drill) {
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
}

// Which escape opened the barrier, and what the summary may claim.
function registerEscapeAndSummaryTests(drill) {
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
}

describe('oracleBatchBarrierTestnet: the launcher environment contract (row 41)', function () {

    const drill = require('../../drills/lib/oracle_batch_barrier_testnet.js');

    registerLauncherEnvCompositionTests(drill);

    registerSettingsAndDeferralTests(drill);

    registerEscapeAndSummaryTests(drill);
});
