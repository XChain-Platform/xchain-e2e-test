/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 ********************************************************************/

'use strict';

const assert = require('assert');
const { ensureOpenIndexerDatabase } = require('../../../helpers/anchor_fold/indexer_pool');

const FIELDS = ['indexer-host', 3306, 'indexer-db', 'indexer-user', 'indexer-pass'];

class FakeDatabase {
    constructor(...args){
        this.args = args;
        this.pool = { getConnection: async () => ({ release: async () => {} }) };
    }
}

function databaseWith(pool){
    const [host, port, dbName, user, pass] = FIELDS;
    return { host, port, dbName, user, pass, pool };
}

async function assertReopened(pool){
    const previous = databaseWith(pool);
    const holder = { indexerDatabase: previous };
    const result = await ensureOpenIndexerDatabase(holder, { Database: FakeDatabase });
    assert.deepStrictEqual(result, { reopened: true });
    assert.notStrictEqual(holder.indexerDatabase, previous);
    assert.deepStrictEqual(holder.indexerDatabase.args, FIELDS);
}

describe('ensureOpenIndexerDatabase', function () {
    it('leaves an open pool in place and releases its probe', async function () {
        let releases = 0;
        const current = databaseWith({
            getConnection: async () => ({ release: async () => { releases++; } })
        });
        const holder = { indexerDatabase: current };
        assert.deepStrictEqual(
            await ensureOpenIndexerDatabase(holder, { Database: FakeDatabase }),
            { reopened: false }
        );
        assert.strictEqual(holder.indexerDatabase, current);
        assert.strictEqual(releases, 1);
    });

    it('reopens a pool reporting closed', async function () {
        await assertReopened({ closed: true });
    });

    it('reopens a database with no pool', async function () {
        await assertReopened(undefined);
    });

    it('reopens a pool whose probe reports that it is closed', async function () {
        await assertReopened({
            getConnection: async () => { throw new Error('cannot acquire: pool is closed'); }
        });
    });

    it('propagates another probe error without replacing the database', async function () {
        const failure = new Error('connection refused');
        const current = databaseWith({ getConnection: async () => { throw failure; } });
        const holder = { indexerDatabase: current };
        await assert.rejects(
            ensureOpenIndexerDatabase(holder, { Database: FakeDatabase }),
            (error) => error === failure
        );
        assert.strictEqual(holder.indexerDatabase, current);
    });

    it('names the missing global database', async function () {
        await assert.rejects(
            ensureOpenIndexerDatabase({}, { Database: FakeDatabase }),
            /global\.indexerDatabase is missing/
        );
    });
});
