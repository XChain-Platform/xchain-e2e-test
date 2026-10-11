'use strict';

const assert = require('assert');
const proxyquire = require('proxyquire');
const {
    databaseNames,
    dropStaleReplay,
    dropStaleReplayBeforeVenue,
} = require('../../integration/bridge_rail_token.test/support/stale_replay');

function stubConnection(options) {
    const opts = options || {};
    const queries = [];
    return {
        queries,
        ended: false,
        async query(sql, params) {
            queries.push({ sql, params: params || [] });
            if (sql.includes('information_schema.SCHEMATA')) {
                return opts.absent ? [] : [{ SCHEMA_NAME: params[0] }, { SCHEMA_NAME: opts.foreign }];
            }
            if (sql.includes('information_schema.TABLES')) {
                return [{ TABLE_NAME: 'tokens' }, { TABLE_NAME: 'index_tickers' }];
            }
            if (sql.startsWith('SELECT ti.tick')) return opts.rows || [];
            return [];
        },
        async end() { this.ended = true; },
    };
}

const STALE_REPLAY_MODULE = '../../integration/bridge_rail_token.test/support/stale_replay';

function droppedSql(connection) {
    return connection.queries.map((entry) => entry.sql)
        .filter((sql) => sql.startsWith('DROP DATABASE'));
}

function loadReplayWith(startDisposableHubDb, createConnection) {
    return proxyquire.noCallThru().noPreserveCache()(STALE_REPLAY_MODULE, {
        '../../../helpers/disposableHubDb': { startDisposableHubDb },
        mariadb: { createConnection },
    });
}

async function withoutHubDbCredentials(run) {
    const previousUser = process.env.HUB_DB_USER;
    const previousPass = process.env.HUB_DB_PASS;
    delete process.env.HUB_DB_USER;
    delete process.env.HUB_DB_PASS;

    try {
        return await run();
    } finally {
        if (previousUser === undefined) delete process.env.HUB_DB_USER;
        else process.env.HUB_DB_USER = previousUser;
        if (previousPass === undefined) delete process.env.HUB_DB_PASS;
        else process.env.HUB_DB_PASS = previousPass;
    }
}

function registerStaleRootTest(ctx) {
    const { label, dbPrefix, names } = ctx;

    it('a stale root row drops exactly the two named databases', async function () {
        const connection = stubConnection({ rows: [{ tick: 'btc' }] });
        const logs = [];

        const dropped = await dropStaleReplay(connection, label, {
            dbPrefix,
            log: (line) => logs.push(line),
        });

        assert.deepStrictEqual(dropped, [names.indexer, names.mirror]);
        assert.deepStrictEqual(droppedSql(connection), [
            'DROP DATABASE IF EXISTS `' + names.indexer + '`',
            'DROP DATABASE IF EXISTS `' + names.mirror + '`',
        ]);
        const staleQuery = connection.queries.find((entry) => entry.sql.startsWith('SELECT ti.tick'));
        assert.deepStrictEqual(staleQuery.params, ['BTC', 'BTC.%']);
        assert.strictEqual(logs.length, 1);
        assert.ok(logs[0].includes(names.indexer));
        assert.ok(logs[0].includes(names.mirror));
    });
}

function registerDefaultConnectorTest(ctx) {
    const { label, dbPrefix } = ctx;

    it('the default connector uses the disposable database coordinates', async function () {
        const connection = stubConnection({ absent: true });
        const venueDb = {
            host: 'default-host', port: '3311', user: 'default-user', pass: 'default-pass',
            stopped: false,
            async stop() { this.stopped = true; },
        };
        const calls = [];
        let connectionOptions = null;
        const replay = loadReplayWith(async () => {
            calls.push('startDisposableHubDb');
            return venueDb;
        }, async (options) => {
            calls.push('mariadb.createConnection');
            connectionOptions = options;
            return connection;
        });

        assert.deepStrictEqual(await withoutHubDbCredentials(
            () => replay.dropStaleReplayBeforeVenue(label, { dbPrefix })), []);

        assert.deepStrictEqual(calls, ['startDisposableHubDb', 'mariadb.createConnection']);
        assert.deepStrictEqual(connectionOptions, {
            host: venueDb.host,
            port: 3311,
            user: venueDb.user,
            password: venueDb.pass,
            connectTimeout: 10000,
        });
        assert.strictEqual(connection.ended, true);
        assert.strictEqual(venueDb.stopped, true);
    });
}

function registerUnreachableDatabaseTest(ctx) {
    const { label, dbPrefix } = ctx;

    it('logs once and drops nothing when no disposable database is reachable', async function () {
        const calls = [];
        const logs = [];
        const replay = loadReplayWith(async () => {
            calls.push('startDisposableHubDb');
            return null;
        }, async () => {
            calls.push('mariadb.createConnection');
            return stubConnection();
        });

        assert.deepStrictEqual(await withoutHubDbCredentials(
            () => replay.dropStaleReplayBeforeVenue(label, {
                dbPrefix,
                log: (line) => logs.push(line),
            })), []);

        assert.deepStrictEqual(calls, ['startDisposableHubDb']);
        assert.deepStrictEqual(logs, [
            'token rail: no disposable database is reachable, so the venue cannot be built',
        ]);
    });
}

function registerNoDropTests(ctx) {
    const { label, dbPrefix } = ctx;

    it('a clean ledger drops none', async function () {
        const connection = stubConnection({ rows: [] });

        assert.deepStrictEqual(await dropStaleReplay(connection, label, { dbPrefix }), []);
        assert.deepStrictEqual(droppedSql(connection), []);
    });

    it('an absent database drops none', async function () {
        const connection = stubConnection({ absent: true });

        assert.deepStrictEqual(await dropStaleReplay(connection, label, { dbPrefix }), []);
        assert.deepStrictEqual(droppedSql(connection), []);
    });

    it('a name outside the replay pair is never dropped', async function () {
        const foreign = dbPrefix + 'foreign_Rpl_Ixr0';
        const connection = stubConnection({ rows: [{ tick: 'BTC.CHILD' }], foreign });

        await dropStaleReplay(connection, label, { dbPrefix, log: () => {} });

        assert.ok(connection.queries.every((entry) => !entry.sql.includes(foreign)));
        assert.strictEqual(droppedSql(connection).length, 2);
    });
}

describe('token stale replay cleanup', function () {
    const label = 'unit-token';
    const dbPrefix = 'Unit_MVH_';
    const ctx = { label, dbPrefix, names: databaseNames(label, dbPrefix) };

    registerStaleRootTest(ctx);
    registerDefaultConnectorTest(ctx);
    registerUnreachableDatabaseTest(ctx);
    registerNoDropTests(ctx);
});
