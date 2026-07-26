// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// Shared database-role resolution for the FIAT price fixtures .
//
// Three databases can be in play when priceSnapshotHelper / oraclePriceHelper
// run, and conflating any two of them produces a failure that reads as a
// consensus bug rather than a fixture one:
//
//   SEED   where a fixture writes its price row
//   READ   where the indexer's settlement path READS price rows from
//   LOCAL  the indexer's own database (blocks, actions, dispensers)
//
// READ is not ours to choose: the indexer resolves it. XChainIndexer.js opens a
// separate `hubDb` connection when BOTH HUB_DB_HOST and HUB_DB_NAME are set, and
// every price lookup then goes through `db.indexer.hubDb ? db.indexer.hubDb : db`
// (utility.js, reversePriceMatch and reverseOraclePriceMatch). With no hub DB
// configured, READ collapses onto LOCAL. A fixture that waits on LOCAL while
// settlement reads `hubDb` waits on a table that never receives the row.
//
// SEED depends on whether hub_db_sync is carrying rows down. When it is, `hubDb`
// is a MIRROR that hub_db_sync owns, and writing a fixture straight into it is
// wrong twice over: it skips the replication leg under test, and the row does not
// survive, because price_snapshots is in hub_db_sync's FULL_REPAGE_TABLES and the
// next bootstrap re-pages that table from the hub. So with the mirror on, the
// fixture must write to the hub's OWN authoritative database and let the mirror
// carry it down. HUB_SOURCE_DB_NAME names that database.
//
// The resulting env contract, and every topology it covers:
//
//   HUB_DB_HOST + HUB_DB_NAME     the indexer's hub-DB connection, i.e. READ.
//                                 Set these to exactly what the indexer has.
//   HUB_SOURCE_DB_NAME            the hub's authoritative database, i.e. SEED,
//                                 used only when the mirror is carrying rows.
//                                 Host/port/user/pass default to the HUB_DB_*
//                                 connection, since the regtest stack runs one
//                                 MariaDB holding both databases.
//
//   neither set        single-host: SEED = READ = LOCAL, mirror leg absent.
//   HUB_DB_* only      shared-DB shortcut: the indexer points hubDb straight at
//                      the hub's MariaDB and no sync runs. SEED = READ = hubDb.
//   both set           true mirror: SEED = hub authoritative, READ = mirror.
//
// In the first two the mirror leg is not in play and every wait below is a strict
// no-op, so this file cannot change how the suite behaves on the stack as it
// stands today.

function localParams(){
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

// Where the indexer's settlement path reads price_snapshots / oracle_prices.
// Mirrors XChainIndexer.js's own condition exactly: BOTH host and name, or the
// hubDb connection is never created and the local DB is used instead.
function readParams(){
    if (process.env.HUB_DB_HOST && process.env.HUB_DB_NAME){
        return {
            host:     process.env.HUB_DB_HOST,
            port:     parseInt(process.env.HUB_DB_PORT) || 3306,
            database: process.env.HUB_DB_NAME,
            user:     process.env.HUB_DB_USER,
            password: process.env.HUB_DB_PASS
        }
    }
    return localParams()
}

// Where a fixture writes. Diverges from readParams() only when the hub's own
// database is named, which is the operator's way of saying "hub_db_sync is
// carrying these tables, so seed upstream of it".
function seedParams(){
    if (process.env.HUB_SOURCE_DB_NAME){
        let idb = global.indexerDatabase
        return {
            host:     process.env.HUB_SOURCE_DB_HOST || process.env.HUB_DB_HOST || (idb && idb.host),
            port:     parseInt(process.env.HUB_SOURCE_DB_PORT || process.env.HUB_DB_PORT) || (idb && idb.port) || 3306,
            database: process.env.HUB_SOURCE_DB_NAME,
            user:     process.env.HUB_SOURCE_DB_USER || process.env.HUB_DB_USER || (idb && idb.user),
            password: process.env.HUB_SOURCE_DB_PASS || process.env.HUB_DB_PASS || (idb && idb.pass)
        }
    }
    return readParams()
}

function sameTarget(a, b){
    if (!a || !b) return false
    return a.host === b.host && a.port === b.port && a.database === b.database
}

// True when a seeded row has to be replicated before settlement can see it.
// Compares SEED against READ. The pre- version compared SEED against LOCAL,
// which is the same comparison only while no hub DB is configured, and reports the
// mirror as "in play" on the shared-DB shortcut where no sync runs at all.
function seedsThroughMirror(){
    let seed = seedParams()
    let read = readParams()
    if (!seed || !read) return false
    return !sameTarget(seed, read)
}

// Guard a combination that can only ever hang. HUB_SOURCE_DB_NAME says "seed
// upstream and wait for the mirror", but with no HUB_DB_NAME the indexer opens no
// hubDb, so it reads its own database and nothing replicates into it. Left
// unchecked this surfaces as every seed timing out after 30s, which is a long way
// from its cause.
function assertCoherent(){
    if (process.env.HUB_SOURCE_DB_NAME && !(process.env.HUB_DB_HOST && process.env.HUB_DB_NAME)){
        throw new Error(
            'hubMirrorTopology: HUB_SOURCE_DB_NAME is set but HUB_DB_HOST/HUB_DB_NAME are not. '
            + 'Seeding would write to the hub while the indexer reads its own database, so no seed '
            + 'could ever become visible. Set HUB_DB_HOST + HUB_DB_NAME to the indexer\'s mirror '
            + 'database, or unset HUB_SOURCE_DB_NAME to seed directly.')
    }
}

// The distinct databases a fixture must clear to make a pair or quote absent
// everywhere it could be matched from. With the mirror on, deleting only the
// hub's copy leaves the mirror's stale row in place and settlement matches it:
// hub_db_sync propagates deletions only as signed reorg retractions, never as a
// consequence of a plain DELETE upstream. Deduped so the single-host stack opens
// one connection, not two.
function clearTargets(){
    let out = []
    for (let p of [seedParams(), readParams()]){
        if (p && !out.some(q => sameTarget(q, p))) out.push(p)
    }
    return out
}

module.exports = {
    localParams,
    readParams,
    seedParams,
    seedsThroughMirror,
    assertCoherent,
    clearTargets,
    sameTarget
}
