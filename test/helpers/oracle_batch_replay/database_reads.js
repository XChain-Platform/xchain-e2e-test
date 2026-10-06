'use strict'

// Copyright © 2025–2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const mariadb = require('mariadb')
const { ident } = require('./replay_naming')

// MariaDB rows carry BIGINT as BigInt and DECIMAL as string. Assertions and
// console output both want plain JSON, and a BigInt in either throws.
function plain(rows) {
    return JSON.parse(JSON.stringify(rows, (k, v) => (typeof v === 'bigint' ? Number(v) : v)));
}

// ---------------------------------------------------------------------------
// Reading a node
//
// Every reader below takes a live connection plus a database NAME rather than a
// per-database connection, so one connection to the disposable MariaDB can read
// a node's indexer, hub and mirror databases, and one connection to the stack's
// MariaDB can read the live chain's. That is also what makes a cross-node diff
// a single process's work.
// ---------------------------------------------------------------------------

// `price_snapshots` as AT2 reads it: the five compared columns plus the
// provenance columns a failure message needs to explain itself.
async function readPriceSnapshots(conn, dbName, opts) {
    opts = opts || {};
    const db = ident(dbName, 'database name');
    let sql = 'SELECT round_number, coin_pair, price, block_timestamp, reference_block, reference_chain, ' +
              'validator_count, status, source_chain, source_action_index ' +
              'FROM `' + db + '`.price_snapshots';
    const params = [];
    if (Array.isArray(opts.rounds) && opts.rounds.length > 0) {
        sql += ' WHERE round_number IN (' + opts.rounds.map(() => '?').join(',') + ')';
        params.push(...opts.rounds.map((r) => String(r)));
    }
    sql += ' ORDER BY round_number, coin_pair';
    return plain(await conn.query(sql, params));
}

// Every PRICE action the node decided, with the verdict string it recorded.
// This is the reader that makes the current blocker legible: when reconstruction
// produces nothing, the reason is here and nowhere else.
async function readPriceActions(conn, dbName, opts) {
    opts = opts || {};
    const db = ident(dbName, 'database name');
    let sql = 'SELECT p.action_index, p.version, p.round_number, p.round_timestamp, p.sig_count, ' +
              'a.block_index, a.tx_index, a.tx_vout, s.status ' +
              'FROM `' + db + '`.prices p ' +
              'JOIN `' + db + '`.actions a ON a.action_index = p.action_index ' +
              'JOIN `' + db + '`.index_statuses s ON s.id = p.status_id';
    const where = [];
    const params = [];
    if (opts.minBlock !== undefined) { where.push('a.block_index >= ?'); params.push(opts.minBlock); }
    if (Array.isArray(opts.rounds) && opts.rounds.length > 0) {
        where.push('p.round_number IN (' + opts.rounds.map(() => '?').join(',') + ')');
        params.push(...opts.rounds.map((r) => String(r)));
    }
    if (where.length > 0) sql += ' WHERE ' + where.join(' AND ');
    sql += ' ORDER BY a.block_index, a.tx_index, a.tx_vout';
    return plain(await conn.query(sql, params));
}

// Which tables in a node's schema actually record a verdict for an action.
// Discovered rather than listed: the action set grows, and a hand-maintained map
// would quietly stop covering the newest action type, which is the one most
// likely to replay differently.
async function verdictTables(conn, dbName) {
    const rows = await conn.query(
        'SELECT TABLE_NAME AS t FROM information_schema.COLUMNS ' +
        "WHERE TABLE_SCHEMA = ? AND COLUMN_NAME IN ('action_index', 'status_id') " +
        'GROUP BY TABLE_NAME HAVING COUNT(DISTINCT COLUMN_NAME) = 2 ORDER BY TABLE_NAME',
        [dbName]);
    return rows.map((r) => r.t);
}

/**
 * Every action verdict a node reached, keyed by a CHAIN coordinate.
 *
 * Keyed on (table, block_index, tx_index, tx_vout) and never on action_index.
 * The two happen to agree for a replay that starts at block 0, but action_index
 * is a counter the node assigns, so keying on it would compare each node's
 * bookkeeping to itself and call that agreement. The chain coordinate is the
 * same number on any node that saw the same chain.
 *
 * `feeBearing` comes from the presence of a `fees` row, which is what makes an
 * action fee-bearing in the schema's own terms, and carries the payment mode and
 * the oracle round the fee resolved against so a divergence can be attributed.
 */
async function readActionVerdicts(conn, dbName, opts) {
    opts = opts || {};
    const db = ident(dbName, 'database name');
    const tables = opts.tables || await verdictTables(conn, dbName);
    const out = new Map();
    for (const table of tables) {
        const t = ident(table, 'table name');
        let sql = 'SELECT a.block_index, a.tx_index, a.tx_vout, s.status, ' +
                  'ia.action AS action, (f.action_index IS NOT NULL) AS fee_bearing, ' +
                  'f.payment_mode, f.oracle_round ' +
                  'FROM `' + db + '`.`' + t + '` d ' +
                  'JOIN `' + db + '`.actions a ON a.action_index = d.action_index ' +
                  'JOIN `' + db + '`.index_actions ia ON ia.id = a.action_id ' +
                  'JOIN `' + db + '`.index_statuses s ON s.id = d.status_id ' +
                  'LEFT JOIN `' + db + '`.fees f ON f.action_index = d.action_index';
        const params = [];
        if (opts.maxBlock !== undefined) { sql += ' WHERE a.block_index <= ?'; params.push(opts.maxBlock); }
        let rows;
        // A schema can carry a table the node never created rows in, or one whose
        // shape a migration has moved; neither is a replay divergence, so skip it
        // rather than failing the whole read.
        try { rows = plain(await conn.query(sql, params)); }
        catch (e) { continue; }
        for (const r of rows) {
            out.set(t + '@' + r.block_index + ':' + r.tx_index + ':' + r.tx_vout, {
                table:       t,
                action:      r.action,
                blockIndex:  Number(r.block_index),
                status:      String(r.status),
                feeBearing:  !!Number(r.fee_bearing),
                paymentMode: r.payment_mode === null ? null : Number(r.payment_mode),
                oracleRound: r.oracle_round === null ? null : Number(r.oracle_round)
            });
        }
    }
    return out;
}

/**
 * The chain coordinates of every action a node charged a fee for.
 *
 * WHY THIS IS READ FROM ONE NODE AND APPLIED TO ANOTHER. A `fees` row is written
 * when a fee is ACCEPTED, so "actions this node has a fees row for" is not a
 * property of the chain, it is a property of that node's verdicts. Asking a node
 * which of its own actions were fee-bearing therefore cannot find an action
 * whose fee it rejected, which is precisely the case a replay comparison must
 * not lose. The set is taken from a node with a complete price history and
 * applied to both sides of the comparison, so both are judged on the same
 * actions.
 */
async function readFeeCoordinates(conn, dbName, opts) {
    opts = opts || {};
    const db = ident(dbName, 'database name');
    let sql = 'SELECT a.block_index, a.tx_index, a.tx_vout FROM `' + db + '`.fees f ' +
              'JOIN `' + db + '`.actions a ON a.action_index = f.action_index';
    const params = [];
    if (opts.maxBlock !== undefined) { sql += ' WHERE a.block_index <= ?'; params.push(opts.maxBlock); }
    const rows = plain(await conn.query(sql, params));
    return new Set(rows.map((r) => r.block_index + ':' + r.tx_index + ':' + r.tx_vout));
}

async function readChainHeight(conn, dbName) {
    const db = ident(dbName, 'database name');
    const rows = await conn.query('SELECT MAX(block_index) AS h, COUNT(*) AS c FROM `' + db + '`.blocks');
    return { height: rows[0].h === null ? null : Number(rows[0].h), blocks: Number(rows[0].c) };
}

// A connection to whatever MariaDB the caller names, for reading a node this rig
// did not build (the standing stack's live indexer). Kept here so a drill never
// has to assemble credentials of its own.
async function connectTo(params) {
    return mariadb.createConnection({
        host: params.host, port: parseInt(params.port, 10),
        user: params.user, password: params.pass, connectTimeout: 10_000
    });
}

module.exports = {
    plain, readPriceSnapshots, readPriceActions, verdictTables, readActionVerdicts,
    readFeeCoordinates, readChainHeight, connectTo
}
