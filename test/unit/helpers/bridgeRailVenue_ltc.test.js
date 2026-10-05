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
 ********************************************************************/

'use strict';

const assert = require('assert');
const proxyquire = require('proxyquire').noCallThru().noPreserveCache();

const IDENTITY = [{ pubkeyHex: 'a'.repeat(64), privkeyHex: 'b'.repeat(64) }];

async function withMirrorAdmission(value, fn) {
    const key = 'XC_MIRROR_ADMISSION_ACTIVATION';
    const hadValue = Object.prototype.hasOwnProperty.call(process.env, key);
    const saved = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
    try { return await fn(); }
    finally {
        if (hadValue) process.env[key] = saved;
        else delete process.env[key];
    }
}

function harness() {
    const events = [];
    const venues = [];
    const rpcCalls = [];
    const dbCalls = [];
    const hubDb = { host: 'db', port: 3306, user: 'venue', pass: 'secret' };
    let currentRail = { code: 'BTC' };
    let venueSerial = 0;

    class FakeAttestMirrorVenue {
        constructor(opts) {
            this.opts = opts;
            this.serial = ++venueSerial;
            this.hubs = opts.attachHubs || Array.from({ length: opts.hubCount || 1 }, (internal, index) => ({
                index: index, dbName: 'Hub' + index,
            }));
            this.hubDb = opts.hubDb || hubDb;
            this.hubExtraEnv = opts.hubExtraEnv || {};
            this.hubEnv = {};
            this.unavailable = null;
            this.stops = 0;
            this.indexers = Array.from({ length: opts.indexerCount }, (internal, index) => ({
                index: index,
                followsHub: 0,
                apiUrl: 'http://indexer-' + this.serial + '-' + index,
                indexerDbName: 'Venue_' + opts.label + (opts.freshIndexers ? '_Fresh' : '') + '_Ixr' + index,
                mirrorDbName: 'Venue_' + opts.label + '_Mirror' + index,
                proc: { index: index },
            }));
            this.indexerExtraEnv = opts.indexerExtraEnv || null;
            venues.push(this);
        }

        async start() {
            events.push('start:' + this.opts.coin + '@' + currentRail.code);
            return true;
        }

        async stop() { this.stops += 1; events.push('stop:' + this.opts.coin); }
        async stopHub(index) { events.push('stopHub:' + index); }
        async startHub(index) { events.push('startHub:' + index); }
        async ['_kill'](proc) { events.push('stopIndexer:' + proc.index); }
        async ['_spawnIndexer'](index) {
            this.indexers[index].proc = { index: index };
            events.push('startIndexer:' + index);
        }
        logTail() { return ''; }
    }

    const rails = {
        BTC: { code: 'BTC' },
        DOGE: { code: 'DOGE' },
        LTC: { code: 'LTC' },
    };
    const chainRail = {
        captureCurrentRail: () => rails.BTC,
        createRail: async (coin) => {
            const code = coin === 'dogecoin' ? 'DOGE' : 'LTC';
            events.push('create:' + code);
            return rails[code];
        },
        withRail: async (rail, fn) => {
            const saved = currentRail;
            currentRail = rail;
            events.push('enter:' + rail.code);
            try { return await fn(); }
            finally { events.push('exit:' + rail.code); currentRail = saved; }
        },
    };
    const axios = {
        post: async (url, body) => {
            rpcCalls.push({ url: url, method: body.method });
            const owner = venues.find((v) => v.indexers.some((ix) => ix.apiUrl === url));
            if (body.method === 'getblockhashes' && owner && owner.opts.freshIndexers) {
                owner.tipReads = (owner.tipReads || 0) + 1;
                return { data: { result: { block_index: owner.tipReads === 1 ? 41 : 42 } } };
            }
            return { data: { result: body.method === 'getblockhashes' ? { block_index: 42 } : {} } };
        },
    };
    const mariadb = {
        createConnection: async (opts) => ({
            query: async (sql, params) => {
                dbCalls.push({ database: opts.database, sql: sql, params: params });
                return [{ ok: 1 }];
            },
            end: async () => {},
        }),
    };
    const mod = proxyquire('../../helpers/bridgeRailVenue', {
        './attestMirrorVenue': { AttestMirrorVenue: FakeAttestMirrorVenue },
        './chainRail': chainRail,
        axios: axios,
        mariadb: mariadb,
    });
    return {
        BridgeRailVenue: mod.BridgeRailVenue,
        bridgeVenueIndexerEnv: mod.bridgeVenueIndexerEnv,
        events, venues, rpcCalls, dbCalls, hubDb,
    };
}

describe('bridgeRailVenue BTC indexer environment', function () {

    it('composes admission and DOGE proof wiring in the one BTC venue option', function () {
        const h = harness();
        const btcOptions = {
            indexerExtraEnv: h.bridgeVenueIndexerEnv({
                admission: { XC_MIRROR_ADMISSION_ACTIVATION: '7' },
                indexerUrls: { DOGE: 'http://127.0.0.1:41201' },
            }),
        };
        assert.deepStrictEqual(btcOptions.indexerExtraEnv, {
            DOGE_INDEXER_URL: 'http://127.0.0.1:41201',
            XC_MIRROR_ADMISSION_ACTIVATION: '7',
        });
    });
});

describe('bridgeRailVenue optional LTC venue', function () {

    it('does not build an LTC phase unless withLtc is true', async function () {
        const h = harness();
        const venue = new h.BridgeRailVenue({
            label: 'unit', identities: IDENTITY, deferBridgeWiring: true,
        });

        assert.strictEqual(venue.withLtc, false);
        assert.strictEqual(await venue.start(), true);
        assert.strictEqual(venue.ltcIndexer(), null);
        assert.strictEqual(venue.ltcIndexerUrl(), '');
        assert.ok(!h.events.includes('create:LTC'));
        assert.deepStrictEqual(h.venues.map((v) => v.opts.coin), ['bitcoin', 'dogecoin']);
    });

    it('builds LTC after DOGE inside the Litecoin rail on the shared hubs and database', async function () {
        const h = harness();
        const venue = new h.BridgeRailVenue({
            label: 'unit', identities: IDENTITY, withLtc: true, deferBridgeWiring: true,
        });

        assert.strictEqual(await venue.start(), true);
        assert.deepStrictEqual(h.events.filter((e) => e.startsWith('start:')), [
            'start:bitcoin@BTC', 'start:dogecoin@DOGE', 'start:litecoin@LTC',
        ]);
        const ltc = h.venues.find((v) => v.opts.coin === 'litecoin');
        assert.strictEqual(ltc.opts.attachHubs, venue.hubs);
        assert.strictEqual(ltc.opts.hubDb, venue.hubDb);
        assert.strictEqual(venue.ltcIndexer(), ltc.indexers[0]);
        assert.strictEqual(venue.ltcIndexerUrl(), ltc.indexers[0].apiUrl);

        const overlay = await venue.rewireHubs();
        assert.strictEqual(overlay.LTC_INDEXER_URL, venue.ltcIndexerUrl());
        assert.strictEqual(overlay.XCHAIN_CONFIRMATIONS_LTC, '1');

        await venue.indexerRpc('LTC', 'getblockhashes', {});
        assert.strictEqual(h.rpcCalls.at(-1).url, venue.ltcIndexerUrl());
        await venue.queryIndexerDb('LTC', 'SELECT ?', [7]);
        assert.strictEqual(h.dbCalls.at(-1).database, venue.ltcIndexer().indexerDbName);
    });

    it('replays into a fresh database, catches the live tip, and returns an owned handle', async function () {
        const h = harness();
        const venue = new h.BridgeRailVenue({
            label: 'unit', identities: IDENTITY, withLtc: true, deferBridgeWiring: true,
        });
        await venue.start();
        const liveDb = venue.ltcIndexer().indexerDbName;
        let waitedFor = null;
        venue.waitUntil = async (what, predicate) => {
            waitedFor = what;
            assert.strictEqual(await predicate(), false);
            assert.strictEqual(await predicate(), true);
            return true;
        };

        const handle = await venue.replayIndexer('LTC');
        const replay = h.venues.at(-1);
        assert.strictEqual(replay.opts.coin, 'litecoin');
        assert.strictEqual(replay.opts.attachHubs, venue.hubs);
        assert.strictEqual(replay.opts.hubDb, venue.hubDb);
        assert.strictEqual(replay.opts.freshIndexers, true);
        assert.strictEqual(replay.opts.replayChain, true);
        assert.notStrictEqual(handle.databaseName, liveDb);
        assert.strictEqual(waitedFor, 'the replay LTC indexer to reach live venue block 42');
        assert.deepStrictEqual(h.rpcCalls.slice(-3), [
            { url: venue.ltcIndexerUrl(), method: 'getblockhashes' },
            { url: handle.indexer.apiUrl, method: 'getblockhashes' },
            { url: handle.indexer.apiUrl, method: 'getblockhashes' },
        ]);

        assert.deepStrictEqual(await handle.queryDb('SELECT replay', [1]), [{ ok: 1 }]);
        assert.strictEqual(h.dbCalls.at(-1).database, handle.databaseName);
        await handle.stop();
        await handle.stop();
        assert.strictEqual(replay.stops, 1);
    });

    it('stops LTC before the hub-owning BTC venue', async function () {
        const h = harness();
        const venue = new h.BridgeRailVenue({
            label: 'unit', identities: IDENTITY, withLtc: true, deferBridgeWiring: true,
        });
        await venue.start();
        await venue.stop();
        const stops = h.events.filter((e) => e.startsWith('stop:'));
        assert.deepStrictEqual(stops, ['stop:litecoin', 'stop:dogecoin', 'stop:bitcoin']);
    });
});

describe('bridgeRailVenue mirror admission armed venue', function () {

    it('arms every child and wires admission tips without releasing bridge depths', async function () {
        await withMirrorAdmission('7', async () => {
            const h = harness();
            const identities = IDENTITY.concat([
                { pubkeyHex: 'c'.repeat(64), privkeyHex: 'd'.repeat(64) },
            ]);
            const venue = new h.BridgeRailVenue({
                label: 'armed', identities: identities, withLtc: true, deferBridgeWiring: true,
            });
            assert.strictEqual(await venue.start(), true);
            const hubKeys = {
                XC_MIRROR_ADMISSION_ACTIVATION: '7', ORACLE_ROUND_INTERVAL: '60000',
                ORACLE_SUBMISSION_WINDOW: '20000', ADMISSION_WATERMARK_SAMPLE_MS: '5000',
                XDEX_ROUND_TIMEOUT_MS: '15000', XDEX_ROUND_MAX_LIFETIME_MS: '60000',
            };
            const btc = h.venues[0];
            for (const [key, value] of Object.entries(hubKeys)) {
                assert.strictEqual(btc.opts.hubExtraEnv[key], value);
            }
            assert.strictEqual(btc.opts.hubExtraEnv.XCHAIN_CONFIRMATIONS_DOGE, '1000000');
            assert.strictEqual(btc.indexerExtraEnv.XC_MIRROR_ADMISSION_ACTIVATION, '7');
            assert.strictEqual(btc.indexerExtraEnv.DOGE_INDEXER_URL, venue.dogeIndexerUrl());
            assert.strictEqual(btc.indexerExtraEnv.LTC_INDEXER_URL, venue.ltcIndexerUrl());
            assert.strictEqual(btc.hubExtraEnv.DOGE_INDEXER_URL, venue.dogeIndexerUrl());
            assert.strictEqual(btc.hubExtraEnv.LTC_INDEXER_URL, venue.ltcIndexerUrl());
            assert.deepStrictEqual(h.events.filter((event) => /^(stop|start)Indexer:/.test(event)), [
                'stopIndexer:0', 'startIndexer:0', 'stopIndexer:1', 'startIndexer:1',
            ]);
            assert.deepStrictEqual(h.events.filter((event) => /^(stop|start)Hub:/.test(event)), [
                'stopHub:0', 'startHub:0', 'stopHub:1', 'startHub:1',
            ]);
            venue.waitUntil = async (what, predicate) => Boolean(await predicate()) || predicate();
            const handle = await venue.replayIndexer('DOGE');
            for (const built of h.venues) {
                assert.strictEqual(built.opts.indexerExtraEnv.XC_MIRROR_ADMISSION_ACTIVATION, '7');
            }
            await handle.stop();
        });
    });
});

describe('bridgeRailVenue mirror admission inert venue', function () {

    it('keeps empty, unset, and inert activations out of child environments', async function () {
        for (const activation of ['', undefined, 'off', 'inert', 'false', 'no', 'none']) {
            await withMirrorAdmission(activation, async () => {
                const h = harness();
                const venue = new h.BridgeRailVenue({
                    label: 'inert', identities: IDENTITY, withLtc: true, deferBridgeWiring: true,
                });
                assert.strictEqual(await venue.start(), true);
                const forbidden = [
                    'XC_MIRROR_ADMISSION_ACTIVATION', 'ORACLE_ROUND_INTERVAL',
                    'ORACLE_SUBMISSION_WINDOW', 'ADMISSION_WATERMARK_SAMPLE_MS',
                    'XDEX_ROUND_TIMEOUT_MS', 'XDEX_ROUND_MAX_LIFETIME_MS',
                ];
                assert.strictEqual(h.venues[0].opts.indexerExtraEnv, null);
                for (const built of h.venues) {
                    for (const key of forbidden) {
                        assert.ok(!Object.prototype.hasOwnProperty.call(built.opts.hubExtraEnv || {}, key));
                        assert.ok(!Object.prototype.hasOwnProperty.call(built.opts.indexerExtraEnv || {}, key));
                    }
                }
                assert.deepStrictEqual(h.events.filter((event) => /^(stop|start)Hub:/.test(event)), []);
            });
        }
    });
});
