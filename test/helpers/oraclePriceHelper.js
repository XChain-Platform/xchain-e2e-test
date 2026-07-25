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

// Helper to seed deterministic PRICE v1 user-oracle rows into the table the
// indexer reverse-matches against, so Mode 2 FIAT dispensers (ORACLE_ADDRESS
// set) can be exercised end-to-end. Sibling of priceSnapshotHelper, which does
// the same job for the validator PRICE v0 snapshots Mode 1 consumes.
//
// WHY SEED RATHER THAN PUBLISH ON-CHAIN: a PRICE v1 tx is recorded by the
// indexer into its local `prices` table and pushed to the hub, which aggregates
// it into `oracle_prices`; hub_db_sync then mirrors that table back. Both legs
// need HUB_API_URL, which the single-host regtest stack does not set, so a
// published v1 quote never reaches `oracle_prices` here. price.test.js proves
// the on-chain record + validation contract; this helper covers the consumption
// half. A stack with the hub round trip wired can drop the seed and publish for
// real, which is the fuller test.

function resolveParams(){
    // Mirror the indexer's own resolution exactly (see priceSnapshotHelper):
    // hub-owned tables come from the hub DB only when BOTH HUB_DB_HOST and
    // HUB_DB_NAME are set, otherwise from the indexer's own DB. Seeding must
    // write wherever the indexer reads.
    if (process.env.HUB_DB_HOST && process.env.HUB_DB_NAME){
        return {
            host:     process.env.HUB_DB_HOST,
            port:     parseInt(process.env.HUB_DB_PORT) || 3306,
            database: process.env.HUB_DB_NAME,
            user:     process.env.HUB_DB_USER,
            password: process.env.HUB_DB_PASS
        }
    }
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

module.exports = {
    // True when the oracle_prices table is reachable where the indexer reads it.
    async isAvailable(){
        let params = resolveParams()
        if (!params) return false
        let conn = null
        try {
            conn = await mariadb.createConnection(params)
            await conn.query("SELECT 1 FROM oracle_prices LIMIT 1")
            return true
        } catch (err){
            console.log("oraclePriceHelper: oracle_prices not available -", err.message)
            return false
        } finally {
            if (conn) await conn.end().catch(() => {})
        }
    },

    // Drop every quote for one (source_address, coin, tick, fiat) so a freshly
    // seeded row is the only one the reverse-match can select.
    async clearQuotes({ sourceAddress, coin, tick, fiat }){
        let params = resolveParams()
        let conn = await mariadb.createConnection(params)
        try {
            await conn.query(
                "DELETE FROM oracle_prices WHERE source_address = ? AND coin = ? AND tick = ? AND fiat = ?",
                [sourceAddress, coin, tick, fiat])
        } finally {
            await conn.end().catch(() => {})
        }
    },

    // Insert one user-oracle quote.
    //   value        token price in `fiat`, decimal string (8dp max, matching
    //                what PRICE v1 accepts on-chain)
    //   effectiveAt  unix seconds; must be <= the payment tx block_time and
    //                inside FIAT_DISPENSER_PRICE_WINDOW (24h). Anchor to the
    //                CHAIN clock via priceSnapshotHelper.latestBlockTime(), not
    //                wall time: regtest block timestamps drift from both.
    //   actionIndex  synthetic sentinel; UNIQUE (source_chain, action_index).
    //                Reused across runs on purpose, so the upsert below MUST
    //                refresh every identifying column: a partial update kept the
    //                first run's source_address/tick and every later run then
    //                reverse-matched against a quote for a stale dispenser and
    //                settled 'invalid: no matching oracle price'.
    async seedQuote({ sourceAddress, sourceChain, coin, tick, fiat, value, fee, effectiveAt, actionIndex, memo }){
        let params = resolveParams()
        let conn = await mariadb.createConnection(params)
        try {
            let query = `INSERT INTO oracle_prices
                (source_address, source_chain, coin, tick, fiat, value, fee, memo,
                 block_time, effective_at, action_index, push_generation)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
                ON DUPLICATE KEY UPDATE
                 source_address = VALUES(source_address),
                 coin = VALUES(coin),
                 tick = VALUES(tick),
                 fiat = VALUES(fiat),
                 value = VALUES(value),
                 fee = VALUES(fee),
                 memo = VALUES(memo),
                 block_time = VALUES(block_time),
                 effective_at = VALUES(effective_at)`
            await conn.query(query, [
                sourceAddress, sourceChain || 'BTC', coin, tick, fiat,
                value, fee || '0', memo || 'e2e seeded oracle quote',
                effectiveAt, effectiveAt, actionIndex
            ])
        } finally {
            await conn.end().catch(() => {})
        }
    }
}
