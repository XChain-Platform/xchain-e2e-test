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

// Helper to seed deterministic validator price snapshots so FIAT dispensers
// (Mode 1) can be exercised end-to-end without a live validator federation.
//
// Where it writes, where it waits, and why those can be two different databases
// is all decided by hubMirrorTopology; read that file first. The one thing worth
// repeating here: seeding does NOT always write where settlement reads. Once the
// indexer has a hubDb, that connection is the read side, and once hub_db_sync is
// filling it the fixture has to seed the hub upstream instead and wait for the
// row to arrive.

const topology = require('./hubMirrorTopology')

// Which database this fixture WRITES to: always the one settlement reads, never
// the hub upstream of it, which is the opposite of what oraclePriceHelper does.
//
// The asymmetry is forced and worth stating plainly. A fixture can only seed
// upstream if the hub has a write path that BROADCASTS, because an out-of-band
// row never replicates (HubDbBroadcaster fires only from the hub's own writers).
// oracle_prices has one, reachable over `pushoracleprice`. price_snapshots does
// not: it is broadcast solely from OracleConsensus, meaning a validator
// federation finalizing rounds, and no regtest stack has a federation. So the
// validator leg is seeded straight into the copy settlement reads.
//
// The cost of that, recorded rather than hidden: with the mirror on, this row
// lives only in the mirror, and price_snapshots is in hub_db_sync's
// FULL_REPAGE_TABLES, so a re-bootstrap (reconnect, indexer restart) re-pages the
// table from the hub and deletes it. Within a run there is no reconnect, so it
// holds; across one it does not. Proving Mode A's replication for real needs a
// regtest federation, which is tracked on  and deliberately not faked here.
const resolveParams = topology.readParams

// Which database the indexer's settlement path READS from. Note this is NOT
// necessarily the indexer's own DB: once HUB_DB_NAME is set the indexer opens a
// separate hubDb connection and every price lookup goes through it, so a wait
// against the local DB would watch a table that never receives the row.
const indexerReadParams = topology.readParams

// This helper's OWN seed-vs-read question, deliberately not the shared
// topology.seedsThroughMirror(). Since resolveParams is readParams above, this is
// false in every topology and the wait below is always a no-op. It is computed
// rather than hard-coded so that pointing the seed somewhere else (a regtest
// federation arriving, say) re-arms the wait instead of silently racing.
function seedsThroughMirror(){
    return !topology.sameTarget(resolveParams(), indexerReadParams())
}

module.exports = {
    seedsThroughMirror,

    // Exposed for tests: which database this helper writes to and which one
    // settlement reads. They must be equal in every topology (see resolveParams).
    seedTarget: resolveParams,
    readTarget: indexerReadParams,

    // . Block until a seeded snapshot has been MIRRORED into the copy
    // reverse-matching actually reads, which is the indexer's hubDb once one is
    // configured and its own DB otherwise. See the twin in oraclePriceHelper for
    // the full reasoning; in short, this is a no-op on the single-host stack
    // (seeding already wrote where the indexer reads) and is what stops a test
    // racing hub_db_sync once the mirror is switched on.
    //
    // Keyed on (round_number, coin_pair), which is the table's own unique key,
    // so this waits for THIS seed rather than any row for the pair: a stale row
    // left by an earlier run would otherwise satisfy the wait immediately and
    // reintroduce exactly the race it exists to remove.
    async waitForMirror({ coinPair, roundNumber, timeoutMs = 30000, pollMs = 500 }){
        topology.assertCoherent()
        if (!seedsThroughMirror()) return { mirrored: true, waitedMs: 0, skipped: true }
        let params = indexerReadParams()
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

    // Returns true if price_snapshots is reachable everywhere the suite needs it:
    // the database it seeds into AND the one settlement reads from. Probing only
    // the seed target would report available on a mirror topology whose read side
    // is unreachable, and every FIAT case would then fail rather than skip.
    async isAvailable(){
        // This helper's own targets only, which collapse to one database. Probing
        // the hub as well would let an unrelated gap there (no price_snapshots on
        // a federation-less hub) skip every Mode A case for no reason.
        let targets = []
        for (let p of [resolveParams(), indexerReadParams()]){
            if (p && !targets.some(q => topology.sameTarget(q, p))) targets.push(p)
        }
        if (!targets.length) return false
        for (let params of targets){
            let conn = null
            try {
                conn = await mariadb.createConnection(params)
                await conn.query("SELECT 1 FROM price_snapshots LIMIT 1")
            } catch (err){
                console.log("priceSnapshotHelper: price_snapshots not available in "
                    + params.database + " -", err.message)
                return false
            } finally {
                if (conn) await conn.end().catch(() => {})
            }
        }
        return true
    },

    // Delete every snapshot for a coin_pair so a freshly seeded row is the
    // only finalized snapshot the indexer can reverse-match against.
    //
    // Scoped deliberately to THIS helper's target (the copy settlement reads),
    // not to every database in the topology. Since seeding never goes upstream
    // (see resolveParams), the hub's own price_snapshots holds nothing this suite
    // put there, and deleting a coin_pair from it would destroy real validator
    // rounds on any venue that has a federation. Clearing the read side is both
    // sufficient and the smaller blast radius.
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
