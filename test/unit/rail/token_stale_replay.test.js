'use strict';

const assert = require('assert');
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

describe('token stale replay cleanup', function () {
    const label = 'unit-token';
    const dbPrefix = 'Unit_MVH_';
    const names = databaseNames(label, dbPrefix);

    it('a stale root row drops exactly the two named databases', async function () {
        const connection = stubConnection({ rows: [{ tick: 'btc' }] });
        const logs = [];
        const venueDb = {
            host: 'stable-host', port: '3310', user: 'venue-user', pass: 'venue-pass',
            stopped: false,
            async stop() { this.stopped = true; },
        };
        let connectionOptions = null;

        const dropped = await dropStaleReplayBeforeVenue(label, {
            dbPrefix,
            log: (line) => logs.push(line),
            startVenueDb: async () => venueDb,
            createConnection: async (options) => {
                connectionOptions = options;
                return connection;
            },
        });

        assert.deepStrictEqual(dropped, [names.indexer, names.mirror]);
        assert.deepStrictEqual(connectionOptions, {
            host: venueDb.host,
            port: 3310,
            user: venueDb.user,
            password: venueDb.pass,
            connectTimeout: 10000,
        });
        assert.deepStrictEqual(connection.queries.map((entry) => entry.sql)
            .filter((sql) => sql.startsWith('DROP DATABASE')), [
            'DROP DATABASE IF EXISTS `' + names.indexer + '`',
            'DROP DATABASE IF EXISTS `' + names.mirror + '`',
        ]);
        const staleQuery = connection.queries.find((entry) => entry.sql.startsWith('SELECT ti.tick'));
        assert.deepStrictEqual(staleQuery.params, ['BTC', 'BTC.%']);
        assert.strictEqual(logs.length, 1);
        assert.ok(logs[0].includes(names.indexer));
        assert.ok(logs[0].includes(names.mirror));
        assert.strictEqual(connection.ended, true);
        assert.strictEqual(venueDb.stopped, true);
    });

    it('a clean ledger drops none', async function () {
        const connection = stubConnection({ rows: [] });

        assert.deepStrictEqual(await dropStaleReplay(connection, label, { dbPrefix }), []);
        assert.deepStrictEqual(connection.queries.map((entry) => entry.sql)
            .filter((sql) => sql.startsWith('DROP DATABASE')), []);
    });

    it('an absent database drops none', async function () {
        const connection = stubConnection({ absent: true });

        assert.deepStrictEqual(await dropStaleReplay(connection, label, { dbPrefix }), []);
        assert.deepStrictEqual(connection.queries.map((entry) => entry.sql)
            .filter((sql) => sql.startsWith('DROP DATABASE')), []);
    });

    it('a name outside the replay pair is never dropped', async function () {
        const foreign = dbPrefix + 'foreign_Rpl_Ixr0';
        const connection = stubConnection({ rows: [{ tick: 'BTC.CHILD' }], foreign });

        await dropStaleReplay(connection, label, { dbPrefix, log: () => {} });

        assert.ok(connection.queries.every((entry) => !entry.sql.includes(foreign)));
        assert.strictEqual(connection.queries.map((entry) => entry.sql)
            .filter((sql) => sql.startsWith('DROP DATABASE')).length, 2);
    });
});
