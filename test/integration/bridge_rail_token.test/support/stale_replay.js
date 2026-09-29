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
 *********************************************************************/

'use strict';

const mariadb = require('mariadb');

const { DB_PREFIX } = require('../../../helpers/attestMirrorVenue');
const { startDisposableHubDb } = require('../../../helpers/disposableHubDb');

function databaseNames(label, prefix) {
    const venueLabel = String(label || 'bridgerail').replace(/[^A-Za-z0-9]/g, '') + 'doge';
    const base = String(prefix === undefined ? DB_PREFIX : prefix) + venueLabel;
    return {
        indexer: base + '_Rpl_Ixr0',
        mirror: base + '_Mirror0',
    };
}

function ident(name) {
    if (!/^[A-Za-z0-9_]+$/.test(String(name || ''))) {
        throw new Error('token stale replay: refusing an unsafe database name: ' + name);
    }
    return String(name);
}

async function dropStaleReplay(connection, label, options) {
    if (!connection) return [];
    const opts = options || {};
    const names = databaseNames(label, opts.dbPrefix);
    const indexer = ident(names.indexer);
    const mirror = ident(names.mirror);
    const schemas = await connection.query(
        'SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME=?', [indexer]);
    if (!schemas.length) return [];

    const tables = await connection.query(
        'SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=? ' +
        'AND TABLE_NAME IN (?, ?)', [indexer, 'tokens', 'index_tickers']);
    if (tables.length < 2) return [];

    const stale = await connection.query(
        'SELECT ti.tick AS tick FROM `' + indexer + '`.tokens tk ' +
        'INNER JOIN `' + indexer + '`.index_tickers ti ON (ti.id=tk.tick_id) ' +
        'WHERE UPPER(ti.tick)=? OR UPPER(ti.tick) LIKE ? LIMIT 1', ['BTC', 'BTC.%']);
    if (!stale.length) return [];

    await connection.query('DROP DATABASE IF EXISTS `' + indexer + '`');
    await connection.query('DROP DATABASE IF EXISTS `' + mirror + '`');
    const dropped = [names.indexer, names.mirror];
    const log = opts.log || console.log;
    log('token rail: dropped stale replay databases ' + dropped.join(', ') +
        ' because the replayed indexer held bridged token rows');
    return dropped;
}

async function connectVenueDatabase(venueDb, createConnection) {
    const open = createConnection || mariadb.createConnection;
    return open({
        host: venueDb.host,
        port: parseInt(venueDb.port, 10),
        user: venueDb.user,
        password: venueDb.pass,
        connectTimeout: 10000,
    });
}

async function dropStaleReplayBeforeVenue(label, options) {
    const opts = options || {};
    if (!opts.startVenueDb && (!process.env.HUB_DB_USER || !process.env.HUB_DB_PASS)) return [];
    const venueDb = await (opts.startVenueDb || startDisposableHubDb)();
    if (!venueDb) return [];
    let connection = null;
    try {
        connection = await connectVenueDatabase(venueDb, opts.createConnection);
        return await dropStaleReplay(connection, label, opts);
    } finally {
        if (connection) await connection.end().catch(() => {});
        await venueDb.stop();
    }
}

module.exports = {
    connectVenueDatabase,
    databaseNames,
    dropStaleReplay,
    dropStaleReplayBeforeVenue,
};
