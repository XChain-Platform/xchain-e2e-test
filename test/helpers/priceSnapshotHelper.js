const mariadb = require('mariadb')

// Helper to seed deterministic validator price snapshots into the hub DB so
// FIAT dispensers (Mode 1) can be exercised end-to-end without a live oracle.
//
// Slice 1 reads price_snapshots through the indexer's HUB_DB_* connection
// (the "shared-DB shortcut"). This helper writes to that same table. It
// resolves the connection from HUB_DB_* env vars, falling back to the same
// MariaDB the e2e suite already uses (global.indexerDatabase) with the
// database name overridden to the hub DB — which is exactly the shared-DB
// shortcut topology.

function resolveParams(){
    if (process.env.HUB_DB_HOST){
        return {
            host:     process.env.HUB_DB_HOST,
            port:     parseInt(process.env.HUB_DB_PORT) || 3306,
            database: process.env.HUB_DB_NAME || 'XChain_Hub',
            user:     process.env.HUB_DB_USER,
            password: process.env.HUB_DB_PASS
        }
    }
    // Fallback: reuse the e2e MariaDB connection, point at the hub database.
    let idb = global.indexerDatabase
    if (!idb) return null
    return {
        host:     idb.host,
        port:     idb.port,
        database: process.env.HUB_DB_NAME || 'XChain_Hub',
        user:     idb.user,
        password: idb.pass
    }
}

module.exports = {
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

    // Insert (or upsert) a single finalized price snapshot.
    //   coinPair       e.g. "BTC/USD"
    //   price          decimal string, 8dp e.g. "50000.00000000"
    //   blockTimestamp unix seconds; must be <= the payment tx block_time and
    //                  within the indexer's 24h reverse-match window
    //   roundNumber    synthetic sentinel; UNIQUE (round_number, coin_pair)
    async seedSnapshot({ coinPair, price, blockTimestamp, roundNumber }){
        let params = resolveParams()
        let conn = await mariadb.createConnection(params)
        try {
            let query = `INSERT INTO price_snapshots
                (round_number, coin_pair, price, reference_block, reference_chain,
                 block_timestamp, validator_count, consensus_round, consensus_proof, status)
                VALUES (?, ?, ?, 0, 'BTC', ?, 1, 1, '[]', 'finalized')
                ON DUPLICATE KEY UPDATE
                 price = VALUES(price),
                 block_timestamp = VALUES(block_timestamp),
                 status = 'finalized'`
            await conn.query(query, [roundNumber, coinPair, price, blockTimestamp])
        } finally {
            await conn.end().catch(() => {})
        }
    }
}
