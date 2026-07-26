// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const mariadb = require('mariadb')

// Helper to seed deterministic validator price snapshots into the hub DB so
// FIAT dispensers (Mode 1) can be exercised end-to-end without a live oracle.
//
// Slice 1 reads price_snapshots through the indexer's HUB_DB_* connection
// (the "shared-DB shortcut"). This helper writes to that same table. It
// resolves the connection from HUB_DB_* env vars, falling back to the same
// MariaDB the e2e suite already uses (global.indexerDatabase) with the
// database name overridden to the hub DB, which is exactly the shared-DB
// shortcut topology.

function resolveParams(){
    // Mirror the INDEXER's own resolution exactly: it reads hub-owned price
    // tables from the hub DB only when BOTH HUB_DB_HOST and HUB_DB_NAME are
    // configured, otherwise from its LOCAL indexer DB (it logs a warning to
    // that effect at boot). Seeding must write wherever the indexer reads:
    // HUB_DB_HOST alone is injected into the e2e container for the federation
    // suites, so keying on it seeded XChain_Hub while the indexer matched
    // against its local table: deterministic "no matching price snapshot".
    if (process.env.HUB_DB_HOST && process.env.HUB_DB_NAME){
        return {
            host:     process.env.HUB_DB_HOST,
            port:     parseInt(process.env.HUB_DB_PORT) || 3306,
            database: process.env.HUB_DB_NAME,
            user:     process.env.HUB_DB_USER,
            password: process.env.HUB_DB_PASS
        }
    }
    // Single-host topology: the indexer reads its own DB; seed there.
    let idb = global.indexerDatabase
    if (!idb) return null
    return {
        host:     idb.host,
        port:     idb.port,
        database: idb.dbName,
        user:     idb.user,
        password: idb.pass
    }
}

// Where the INDEXER keeps its own copy, which is what settlement reads once
// hub_db_sync is mirroring. Distinct from resolveParams() above, which is where
// seeding WRITES: the same DB on the single-host stack, different DBs as soon as
// HUB_DB_* is configured.
function indexerLocalParams(){
    let idb = global.indexerDatabase
    if (!idb) return null
    return {
        host:     idb.host,
        port:     idb.port,
        database: idb.dbName,
        user:     idb.user,
        password: idb.pass
    }
}

// True when seeding writes somewhere OTHER than the indexer's own DB, so a
// seeded row must be replicated down before the indexer can price against it.
function seedsThroughMirror(){
    let seed  = resolveParams()
    let local = indexerLocalParams()
    if (!seed || !local) return false
    return seed.host !== local.host
        || seed.port !== local.port
        || seed.database !== local.database
}

module.exports = {
    seedsThroughMirror,

    // . Block until a seeded snapshot has been MIRRORED into the indexer's
    // own price_snapshots, the copy reverse-matching reads. See the twin in
    // oraclePriceHelper for the full reasoning; in short, this is a no-op on the
    // single-host stack (seeding already wrote where the indexer reads) and is
    // what stops a test racing hub_db_sync once the mirror is switched on.
    //
    // Keyed on (round_number, coin_pair), which is the table's own unique key,
    // so this waits for THIS seed rather than any row for the pair: a stale row
    // left by an earlier run would otherwise satisfy the wait immediately and
    // reintroduce exactly the race it exists to remove.
    async waitForMirror({ coinPair, roundNumber, timeoutMs = 30000, pollMs = 500 }){
        if (!seedsThroughMirror()) return { mirrored: true, waitedMs: 0, skipped: true }
        let params = indexerLocalParams()
        if (!params) throw new Error('priceSnapshotHelper.waitForMirror: no indexer database configured')
        let started = Date.now()
        let conn = null
        try {
            conn = await mariadb.createConnection(params)
            for (;;){
                let rows = await conn.query(
                    "SELECT 1 FROM price_snapshots WHERE coin_pair = ? AND round_number = ? AND status = 'finalized' LIMIT 1",
                    [coinPair, roundNumber])
                if (rows && rows.length) return { mirrored: true, waitedMs: Date.now() - started, skipped: false }
                if (Date.now() - started > timeoutMs){
                    throw new Error(
                        `priceSnapshotHelper.waitForMirror: round ${roundNumber} for ${coinPair} did not reach `
                        + `the indexer's price_snapshots within ${timeoutMs}ms. hub_db_sync is behind or not `
                        + `running (check HUB_API_URL + HUB_DB_SYNC_ENABLED).`)
                }
                await new Promise(r => setTimeout(r, pollMs))
            }
        } finally {
            if (conn) await conn.end().catch(() => {})
        }
    },

    // Returns true if the hub DB (price_snapshots table) is reachable.
    // Used to skip the FIAT dispenser test when no hub DB is configured.
    async isAvailable(){
        let params = resolveParams()
        if (!params) return false
        let conn = null
        try {
            conn = await mariadb.createConnection(params)
            await conn.query("SELECT 1 FROM price_snapshots LIMIT 1")
            return true
        } catch (err){
            console.log("priceSnapshotHelper: hub DB not available -", err.message)
            return false
        } finally {
            if (conn) await conn.end().catch(() => {})
        }
    },

    // Delete every snapshot for a coin_pair so a freshly seeded row is the
    // only finalized snapshot the indexer can reverse-match against.
    async clearPair(coinPair){
        let params = resolveParams()
        let conn = await mariadb.createConnection(params)
        try {
            await conn.query("DELETE FROM price_snapshots WHERE coin_pair = ?", [coinPair])
        } finally {
            await conn.end().catch(() => {})
        }
    },

    // Latest indexed block_time (the CHAIN's clock, which is what the indexer
    // compares snapshots against (reversePriceMatch bounds on the payment tx's
    // BLOCK_TIME, and the staleness cap measures age vs the block being
    // processed). Anchor seeds to this, not Date.now(): wall-clock seeds raced
    // both ways: too old trips ORACLE_MAX_PRICE_AGE_SECONDS (1800s), too new
    // lands in the chain's future when regtest block timestamps lag wall time.
    async latestBlockTime(){
        // Always read blocks from the INDEXER DB (the hub DB has no blocks
        // table), via the suite's existing pool.
        let conn = await global.indexerDatabase.getConnection()
        try {
            let rows = await conn.query("SELECT block_time FROM blocks ORDER BY block_index DESC LIMIT 1")
            return rows.length ? Number(rows[0].block_time) : Math.floor(Date.now() / 1000)
        } finally {
            await conn.release().catch(() => {})
        }
    },

    // Insert (or upsert) a single finalized price snapshot.
    //   coinPair       e.g. "BTC/USD"
    //   price          decimal string, 8dp e.g. "50000.00000000"
    //   blockTimestamp unix seconds; must be <= the payment tx block_time and
    //                  within the indexer's 24h reverse-match window
    //   roundNumber    synthetic sentinel; UNIQUE (round_number, coin_pair)
    //   referenceBlock optional; the VM's getSnapshotAge() is computed as
    //                  (current block - MAX(reference_block) of finalized
    //                  snapshots), and 0/NULL makes that age infinite. Pass
    //                  the current tip when the contract under test checks
    //                  oracle freshness (getPrice consumers); getPriceAtRound
    //                  consumers can leave it 0 (no staleness filter there).
    async seedSnapshot({ coinPair, price, blockTimestamp, roundNumber, referenceBlock }){
        let params = resolveParams()
        let conn = await mariadb.createConnection(params)
        try {
            let query = `INSERT INTO price_snapshots
                (round_number, coin_pair, price, reference_block, reference_chain,
                 block_timestamp, validator_count, consensus_round, consensus_proof, status)
                VALUES (?, ?, ?, ?, 'BTC', ?, 1, 1, '[]', 'finalized')
                ON DUPLICATE KEY UPDATE
                 price = VALUES(price),
                 reference_block = VALUES(reference_block),
                 block_timestamp = VALUES(block_timestamp),
                 status = 'finalized'`
            await conn.query(query, [roundNumber, coinPair, price, referenceBlock || 0, blockTimestamp])
        } finally {
            await conn.end().catch(() => {})
        }
        // : the seed is not usable until the indexer can SEE it. On the
        // single-host stack that is already true and this returns at once; with
        // the mirror on it waits for hub_db_sync to carry the row down. Done
        // here rather than at the ~13 call sites so every existing and future
        // caller gets it, and so the helper's contract is the one callers
        // already assume: when seeding returns, settlement can match it.
        await module.exports.waitForMirror({ coinPair, roundNumber })
    }
}
