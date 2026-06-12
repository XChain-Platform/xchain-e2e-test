/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available —
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * P3(b) — LIVE multi-chain parity: indexer-DB digest capture.
 *
 * Dumps the WHOLE live indexer database (every table, every row) plus the
 * resolved consensus hash chain to a JSON artifact on disk. This is the
 * EXPENSIVE half of the parity harness — it runs once per chain against a
 * live regtest stack (encoder → broadcast → coin node → decoder → indexer).
 *
 * All comparison logic (canonicalisation, column/normalisation policy,
 * hash-chain equality) lives in compare.js — a PURE function over these
 * artifacts. The split is deliberate: the 3-chain live sweep is slow and
 * fragile, so we capture raw fidelity once and iterate the comparison
 * offline, exactly the way scenario 14's normalisation set was calibrated.
 *
 * Capture is therefore UNFILTERED: every column of every row is kept (only
 * type-canonicalised to JSON-safe primitives). compare.js decides what is
 * chain-native residue (txids, block hashes) vs. a real chain-dependence bug.
 *
 * The resolved hash chain is read here (not in compare) because it requires
 * the live JOIN into index_transactions — readHashChain mirrors the indexer's
 * own getBlockHashes provenance (xchain-indexer/src/db.js:1019) and the
 * cross-node oracle (xchain-indexer/.../setup/equivalence.js).
 *********************************************************************/

'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Run one SQL statement against a mariadb pool, releasing the connection.
 * The live indexer DB (global.indexerDatabase.pool) exposes no generic query
 * method, so we drive the pool directly.
 */
async function poolQuery(pool, sql, params = []) {
    let conn;
    try {
        conn = await pool.getConnection();
        return await conn.query(sql, params);
    } finally {
        if (conn) await conn.release();
    }
}

// Make one DB value JSON-safe WITHOUT dropping information: Buffer -> 0x-hex,
// BigInt -> decimal string, Date -> ISO. DECIMAL/NUMERIC already arrive as
// strings from the mariadb driver. Mirrors equivalence.canonicalRow's value
// coercion, but keeps EVERY column (exclusion is compare.js's job).
function jsonSafe(v) {
    if (Buffer.isBuffer(v)) return '0x' + v.toString('hex');
    if (typeof v === 'bigint') return v.toString();
    if (v instanceof Date) return v.toISOString();
    return v;
}

function jsonSafeRow(row) {
    const out = {};
    for (const k of Object.keys(row)) out[k] = jsonSafe(row[k]);
    return out;
}

async function listTables(pool) {
    const rows = await poolQuery(pool, 'SHOW TABLES');
    // mariadb may tag array results with a `meta` property — Object.values on
    // each row yields the single column value regardless of its key name.
    return rows.map(r => String(Object.values(r)[0])).filter(Boolean).sort();
}

/**
 * Read the node's chained consensus-hash triple per block, RESOLVED to the
 * hash strings (id-independent), ordered by height. Identical query to the
 * cross-node oracle's readHashChain — the consensus commitment that must hold
 * across chains even though every chain's index_transactions id-space differs
 * (it interleaves chain-native txids + block hashes).
 */
async function readHashChain(pool) {
    const rows = await poolQuery(pool,
        `SELECT b.block_index,
                t1.hash AS ledger,
                t2.hash AS actions,
                t3.hash AS contracts
         FROM blocks b
         LEFT JOIN index_transactions t1 ON t1.id = b.ledger_hash_id
         LEFT JOIN index_transactions t2 ON t2.id = b.actions_hash_id
         LEFT JOIN index_transactions t3 ON t3.id = b.contract_hash_id
         ORDER BY b.block_index ASC`);
    return rows.map(r => ({
        block_index: Number(r.block_index),
        ledger: r.ledger, actions: r.actions, contracts: r.contracts,
    }));
}

/**
 * Capture the whole live indexer DB as JSON-safe rows + the resolved hash
 * chain. Returns the digest object (also writable to disk via writeDigest).
 *
 * @param {object} pool  mariadb pool (global.indexerDatabase.pool)
 * @param {object} meta  free-form provenance ({ coin, network, baselineHeight, ... })
 */
async function captureLiveDigest(pool, meta = {}) {
    const tables = {};
    for (const table of await listTables(pool)) {
        const rows = await poolQuery(pool, 'SELECT * FROM `' + table + '`');
        tables[table] = rows.map(jsonSafeRow);
    }
    return {
        meta,
        tables,
        hashChain: await readHashChain(pool),
    };
}

function writeDigest(digest, filePath) {
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(digest, null, 2));
    return filePath;
}

function loadDigest(filePath) {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

module.exports = {
    poolQuery,
    jsonSafe,
    jsonSafeRow,
    listTables,
    readHashChain,
    captureLiveDigest,
    writeDigest,
    loadDigest,
};
