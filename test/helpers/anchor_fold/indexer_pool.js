/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 ********************************************************************/

'use strict';

function reopenIndexerDatabase(holder, current, Database){
    holder.indexerDatabase = new Database(
        current.host, current.port, current.dbName, current.user, current.pass
    );
    return { reopened: true };
}

async function ensureOpenIndexerDatabase(
    holder = global,
    { Database = require('../../../src/db.js') } = {}
){
    const current = holder.indexerDatabase;
    if(!current) throw new Error('global.indexerDatabase is missing');
    if(!current.pool || current.pool.closed === true)
        return reopenIndexerDatabase(holder, current, Database);

    let connection;
    try {
        connection = await current.pool.getConnection();
    } catch(error){
        if(error && String(error.message).includes('pool is closed'))
            return reopenIndexerDatabase(holder, current, Database);
        throw error;
    }
    await connection.release();
    return { reopened: false };
}

module.exports = { ensureOpenIndexerDatabase };
