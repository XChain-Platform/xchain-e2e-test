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
            this.hubs = opts.attachHubs || [{ index: 0, dbName: 'Hub0' }];
            this.hubDb = opts.hubDb || hubDb;
            this.hubExtraEnv = opts.hubExtraEnv || {};
            this.hubEnv = {};
            this.unavailable = null;
            this.stops = 0;
            this.indexers = Array.from({ length: opts.indexerCount }, (_, index) => ({
                index: index,
                followsHub: 0,
                apiUrl: 'http://indexer-' + this.serial + '-' + index,
                indexerDbName: 'Venue_' + opts.label + (opts.freshIndexers ? '_Fresh' : '') + '_Ixr' + index,
                mirrorDbName: 'Venue_' + opts.label + '_Mirror' + index,
            }));
            venues.push(this);
        }

        async start() {
            events.push('start:' + this.opts.coin + '@' + currentRail.code);
            return true;
        }

        async stop() { this.stops += 1; events.push('stop:' + this.opts.coin); }
        async stopHub(index) { events.push('stopHub:' + index); }
        async startHub(index) { events.push('startHub:' + index); }
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
    return { BridgeRailVenue: mod.BridgeRailVenue, events, venues, rpcCalls, dbCalls, hubDb };
}

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
