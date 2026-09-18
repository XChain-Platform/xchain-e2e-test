// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// Shared database-role resolution for the FIAT price fixtures.
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
//
// THE ENV IS A MODEL, AND THE MODEL CAN BE WRONG. READ is the indexer's decision,
// taken from the env the INDEXER was started with, and this process is a different
// process with a different env. The two disagree the moment a venue sets HUB_DB_NAME
// on the indexer alone (the cross-chain settle recipe does exactly that) or exports it
// to a runner whose indexer does not have it. The failure is silent and total: the
// fixtures seed one database, every price lookup reads the other, and every priced
// action rejects `no current oracle price` while both databases look healthy. It made
// the settle drills and the attestation suites mutually exclusive on one venue, each
// needing a config edit the other broke.
//
// discoverReadParams() closes that by ASKING the indexer (feeschedule discloses
// priceSource) and pinning the answer for the rest of the run. Connection coordinates
// still come from env, because the name the indexer reports is a name inside its own
// network namespace while the host/port/credentials are this process's business.

// Pinned by discoverReadParams(); overrides the env model everywhere below.
let _discovered = null
// What the indexer said about HAVING a hub database, kept apart from where that
// database is: on the ordinary regtest stack the indexer's hub database IS its own
// database (hub_db_sync lands the mirror tables there), so "read equals local" does not
// mean "no mirror", and assertCoherent must key on this flag rather than on equality.
let _discoveredHubDb = null

// `override` lets a caller that is NOT the mocha harness supply the indexer's own
// connection directly. The three DOGE setup drivers are plain node scripts with no
// initialCheck bootstrap, so `global.indexerDatabase` is never populated for them,
// and without this every discovery path below would resolve to null and silently
// fall back to the env model that mis-seeds a mirror-topology venue.
function localParams(override){
    let idb = override || global.indexerDatabase
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
// The discovered answer wins whenever there is one; the env branch below is the
// model used until discovery has run (and on any venue whose indexer is too old to
// disclose priceSource). That model mirrors XChainIndexer.js's own condition exactly:
// BOTH host and name, or the hubDb connection is never created and the local DB is
// used instead.
function readParams(){
    if (_discovered) return _discovered
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

// Ask the indexer where its price reads actually land, and pin the answer for the
// rest of the process. Returns the pinned params, or null when the indexer said
// nothing usable (in which case the env model above stays in force).
//
// Deliberately best-effort and never throwing. This runs in the suite bootstrap, and a
// venue whose indexer predates the priceSource disclosure must keep behaving exactly as
// it did, not fail to start.
//
// Three outcomes, and the second is the one this was built for:
//   - the indexer reads its own DB      -> pin LOCAL, even if the runner env names a
//                                          hub DB. A half-filled or leftover HUB_DB_*
//                                          export is the mirror image of the same bug.
//   - the indexer reads a hub DB        -> pin that DATABASE, on the first set of
//                                          coordinates that can actually reach it (see
//                                          hubCandidates).
//   - no disclosure / unreachable       -> pin nothing.
//
// `opts.probe` replaces the reachability probe; the tests use it to keep this unit-pure.
// `opts.local` supplies the indexer's own connection for a caller outside the mocha
// harness (see localParams).
async function discoverReadParams(connector, opts){
    let probe = (opts && opts.probe) || probeTarget
    let local = (opts && opts.local) || null
    let c = connector || global.indexerConnector
    if (!c || typeof c.call !== 'function') return null

    let sched = null
    try {
        sched = await c.call('feeschedule', {})
    } catch (e){
        console.log('hubMirrorTopology: could not ask the indexer where it reads prices ('
            + ((e && e.message) ? e.message : e) + '); using the HUB_DB_* env model')
        return null
    }
    let src = sched && !sched.error ? sched.priceSource : null
    if (!src || typeof src.hubDb !== 'boolean'){
        // An indexer that answers feeschedule without priceSource is older than this
        // disclosure. Say so once: on a venue that sets HUB_DB_NAME this is exactly the
        // case where the seed can go to the wrong database undetected.
        console.log('hubMirrorTopology: indexer does not disclose priceSource; falling back to '
            + 'the HUB_DB_* env model (upgrade the indexer to have the price seed follow it)')
        return null
    }

    if (!src.hubDb){
        let own = localParams(local)
        if (!own) return null
        _discovered = own
        _discoveredHubDb = false
        console.log('hubMirrorTopology: indexer reads prices from its OWN database ('
            + own.database + '); price fixtures pinned there')
        return _discovered
    }

    // The indexer named a hub DB. Only the NAME is authoritative: the indexer's host and
    // credentials live in its own network namespace ('mariadb:3306' inside compose is not
    // a thing this process can necessarily dial), so the coordinates stay ours.
    let database = src.database || process.env.HUB_DB_NAME || null
    if (!database){
        console.log('hubMirrorTopology: WARN the indexer reads prices from a hub DB but named '
            + 'no database (mainnet withholds the name) and HUB_DB_NAME is unset, so the price '
            + 'seed cannot follow it. Set HUB_DB_NAME to the indexer\'s hub database.')
        return null
    }

    let candidates = hubCandidates(database, local)
    if (!candidates.length) return null
    for (let cand of candidates){
        let ok = false
        try { ok = await probe(cand) } catch (e){ ok = false }
        if (!ok) continue
        _discovered = cand
        _discoveredHubDb = true
        console.log('hubMirrorTopology: indexer reads prices from hub database ' + database
            + '; price fixtures pinned there (' + cand.host + ':' + cand.port
            + ' as ' + (cand.user || 'no user') + ')')
        return _discovered
    }

    // Nothing reachable. Pin the first candidate anyway: the seed will fail, and it must
    // fail while NAMING the database the indexer reads, because a silent fall-back to the
    // indexer's own database is exactly the bug this function exists to remove.
    _discovered = candidates[0]
    _discoveredHubDb = true
    console.log('hubMirrorTopology: WARN the indexer reads prices from hub database ' + database
        + ' but none of the ' + candidates.length + ' candidate connection(s) could read '
        + 'price_snapshots there. Pinning it regardless so the failure names the right '
        + 'database; set HUB_DB_HOST/HUB_DB_PORT/HUB_DB_USER/HUB_DB_PASS to credentials that '
        + 'can reach it.')
    return _discovered
}

// Coordinate sets to try for a hub database the indexer named, most explicit first.
// Deduped, since on the ordinary regtest stack all three collapse to one.
//
//   1. the HUB_DB_* env, which is the operator saying where the hub DB is (and the only
//      form that reaches a separate relay DB, e.g. the 3-hub venue's own host and port);
//   2. that env's credentials on the indexer's OWN host/port, for the common case where
//      HUB_DB_HOST holds a compose service name this process cannot resolve;
//   3. the indexer connection outright, for a stack where one MariaDB holds both
//      databases and one grant covers them.
function hubCandidates(database, local){
    let idb = local || global.indexerDatabase
    let localHost = idb && idb.host
    let localPort = (idb && idb.port) || 3306
    let out = []
    let add = (host, port, user, password) => {
        if (!host) return
        let p = { host: host, port: port || 3306, database: database, user: user, password: password }
        if (!out.some(q => sameTarget(q, p) && q.user === p.user)) out.push(p)
    }
    let envUser = process.env.HUB_DB_USER || (idb && idb.user)
    let envPass = process.env.HUB_DB_PASS || (idb && idb.pass)
    add(process.env.HUB_DB_HOST || localHost, parseInt(process.env.HUB_DB_PORT) || localPort, envUser, envPass)
    add(localHost, localPort, envUser, envPass)
    add(localHost, localPort, idb && idb.user, idb && idb.pass)
    return out
}

// Can this connection read price_snapshots in that database? The same question
// priceSnapshotHelper.isAvailable asks, kept here so discovery pins a target it has
// actually reached rather than one it merely constructed.
async function probeTarget(params){
    let mariadb = require('mariadb')
    let conn = null
    try {
        conn = await mariadb.createConnection(Object.assign({ connectTimeout: 5000 }, params))
        await conn.query('SELECT 1 FROM price_snapshots LIMIT 1')
        return true
    } catch (e){
        return false
    } finally {
        if (conn) await conn.end().catch(() => {})
    }
}

// The pinned answer, or null when discovery has not run or found nothing. Exposed so a
// caller can report which database the fixtures are actually writing to.
function discoveredReadParams(){ return _discovered }

// Drop the pinned answer. For tests, and for a suite that reconfigures a venue mid-run.
function resetDiscovery(){ _discovered = null; _discoveredHubDb = null }

function sameTarget(a, b){
    if (!a || !b) return false
    return a.host === b.host && a.port === b.port && a.database === b.database
}

// True when a seeded row has to be replicated before settlement can see it.
// Compares SEED against READ. The previous version compared SEED against LOCAL,
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
    if (!process.env.HUB_SOURCE_DB_NAME) return
    // Keyed on what the indexer DISCLOSED when discovery ran, else on the raw env; never
    // on whether the read target equals the local database. A discovery that pinned the
    // indexer's own database because the indexer said it has NO hub database is the hang
    // this guards against; a hub database that happens to BE the indexer's own database
    // (the ordinary regtest stack, where hub_db_sync lands the mirror tables in the indexer
    // DB) is a mirror all the same, and seeding upstream of it is exactly what the
    // replay-safe fee seed does. Measured 2026-09-08 on that stack: the guard as first
    // written refused every seed there.
    let hubRead = (_discovered)
        ? _discoveredHubDb === true
        : !!(process.env.HUB_DB_HOST && process.env.HUB_DB_NAME)
    if (!hubRead){
        throw new Error(
            'hubMirrorTopology: HUB_SOURCE_DB_NAME is set but HUB_DB_HOST/HUB_DB_NAME are not. '
            + 'Seeding would write to the hub while the indexer reads its own database, so no seed '
            + 'could ever become visible. Set HUB_DB_HOST + HUB_DB_NAME to the indexer\'s mirror '
            + 'database, or unset HUB_SOURCE_DB_NAME to seed directly. (If the env does name '
            + 'them, the indexer itself reported reading its OWN database, which is the same '
            + 'topology by a different route.)')
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

// ── The RELAY hub's own database, which is a FOURTH role ─────────────────────
//
// The three roles above all answer "where do price rows live". This one answers
// "where does the relay hub keep the cross-chain state the settle drills assert
// on" (cross_chain_matches, xcall rows): the hub's own tables, written by
// CrossChainDex on a validator-mode hub, never mirrored anywhere the indexer
// reads.
//
// It needs its own name because HUB_DB_NAME already has a meaning that collides
// with it. HUB_DB_NAME is defined above as the database the INDEXER reads prices
// from, and on the ordinary regtest stack that database is the indexer's own
// (hub_db_sync lands the mirror tables there), so the one-config contract sets
// HUB_DB_NAME=XChain_BTC_Regtest_Indexer. Resolving the relay hub through that
// same variable would query the indexer's database for match rows that only
// ever exist on the hub, and re-pointing HUB_DB_NAME at the hub to reach them
// would send the price fixtures to a database the indexer does not read: the
// settle drills and the price-seed contract cannot share one variable, so this
// function resolves the relay hub through its own name instead, closing the
// second half of that gap (discoverReadParams above closes the first, the price
// seed).
//
// Resolution order:
//   RELAY_HUB_DB_NAME            the operator naming the relay hub outright, and
//                                the only form that reaches a disposable relay DB
//                                on its own host/port.
//   HUB_SOURCE_DB_NAME           the hub's OWN authoritative database, which is by
//                                definition where the hub writes, so it is where the
//                                relay rows are. See below.
//   HUB_DB_NAME                  honoured ONLY when it is not the indexer's own
//                                database. That keeps every venue whose HUB_DB_*
//                                really did name the hub working unchanged, and
//                                refuses the one reading that is provably wrong.
//   DEFAULT_RELAY_DB             the stack default, which is what these drills
//                                assumed before HUB_DB_NAME was ever exported.
//
// HUB_SOURCE_DB_NAME sits above HUB_DB_NAME because the "not the indexer's own
// database" rule only catches the mirror belonging to THIS process's indexer. On a
// mirror-topology venue HUB_DB_NAME routinely names a DIFFERENT indexer's mirror
// (the cross-settle recipe runs the BTC harness while HUB_DB_NAME points at the DOGE
// indexer's mirror), which passes that rule and is still not the hub: the mirror
// carries no cross_chain_matches the hub has not already replicated, and the hub
// credentials cannot even open it. Measured on the regtest venue 2026-09-08: the
// drills died with `Access denied for user 'xchain_hub' to database
// 'XChain_..._Indexer'`, and the standing workaround was to re-export HUB_DB_NAME for
// the drill step alone, which then mis-seeded the price fixtures. HUB_SOURCE_DB_NAME
// is unambiguous where HUB_DB_NAME is not, so when the operator has named it there is
// nothing left to guess.
//
// `defaults` carries the caller's own host/port fallback (the drills default to
// their XCALL_DB_* stack connection), so this cannot change where a venue that
// sets no hub env at all connects.
const DEFAULT_RELAY_DB = 'XChain_Hub'

function relayHubParams(defaults){
    let d = defaults || {}
    let idb = global.indexerDatabase
    let localName = idb && idb.dbName
    let envName = process.env.RELAY_HUB_DB_NAME || null
    let sourceName = process.env.HUB_SOURCE_DB_NAME || null
    let database = envName
    let source = 'RELAY_HUB_DB_NAME'
    // True once the name came from HUB_SOURCE_DB_NAME: the hub's own coordinates then
    // take precedence over the HUB_DB_* ones, which describe the MIRROR connection and
    // on a split venue are a different host and a user with no grant on the hub.
    let fromHubSource = false
    if (!database && sourceName){
        database = sourceName
        source = 'HUB_SOURCE_DB_NAME'
        fromHubSource = true
    }
    if (!database){
        let hubName = process.env.HUB_DB_NAME || null
        if (hubName && !(localName && hubName === localName)){
            database = hubName
            source = 'HUB_DB_NAME'
        } else {
            database = DEFAULT_RELAY_DB
            source = hubName
                ? 'default (HUB_DB_NAME names the indexer\'s own database, which holds no relay rows)'
                : 'default'
        }
    }
    let srcHost = fromHubSource ? process.env.HUB_SOURCE_DB_HOST : null
    let srcPort = fromHubSource ? process.env.HUB_SOURCE_DB_PORT : null
    let srcUser = fromHubSource ? process.env.HUB_SOURCE_DB_USER : null
    let srcPass = fromHubSource ? process.env.HUB_SOURCE_DB_PASS : null
    return {
        host:     process.env.RELAY_HUB_DB_HOST || srcHost || process.env.HUB_DB_HOST || d.host || '127.0.0.1',
        port:     parseInt(process.env.RELAY_HUB_DB_PORT || srcPort || process.env.HUB_DB_PORT, 10) || d.port || 3306,
        database: database,
        user:     process.env.RELAY_HUB_DB_USER || srcUser || process.env.HUB_DB_USER,
        password: process.env.RELAY_HUB_DB_PASS || srcPass || process.env.HUB_DB_PASS,
        source:   source
    }
}

// ── The standalone drivers' entry point ──────────────────────────────────────
//
// The three DOGE setup drivers (dexDogeSetup, swapCrossDogeSetup, xcallDogeSetup)
// are plain node scripts against the DOGE stack, with no initialCheck bootstrap and
// so none of the globals every function above reads. They modelled their price-seed
// target as `HUB_DB_NAME || 'XChain_Hub'` and never asked the DOGE indexer where it
// actually reads, which is the same defect discoverReadParams closed for the harness.
//
// On a mirror-topology DOGE indexer (HUB_DB_SYNC_ENABLED, hub tables landed in the
// indexer's OWN schema) the seed then went to the hub while every price lookup read
// the mirror, and the seed's shape made the divergence permanent rather than merely
// slow: it is an in-place upsert on four fixed rounds plus a DELETE of the shadowing
// rounds, and hub_db_sync's cursor is insert-shaped, so neither an UPDATE of an
// existing row nor a DELETE ever crosses it. Measured on the regtest venue 2026-09-08: the
// mirror still served a DOGE/USD row stamped five days earlier, so every DOGE ISSUE
// indexed `invalid: no current oracle price for DOGE/USD` while the hub's own table
// held a fresh one.
//
// So: ask the indexer, pin the answer, and fall back to the caller's env model only
// when the indexer says nothing usable (an older indexer, or an unreachable one).
// Never throws, for the same reason discoverReadParams does not.
//
// opts:
//   indexerUrl   the coin indexer's JSON-RPC base, e.g. 'http://127.0.0.1:3124'
//   local        the indexer's OWN db connection {host, port, dbName, user, pass}
//   envTarget    the driver's existing model {host, port, database, user, password}
//   call/probe   test seams, replacing the RPC and the reachability probe
//
// Returns { host, port, database, user, password, source } - always a usable target.
async function resolveDriverPriceTarget(opts){
    let o = opts || {}
    let envTarget = o.envTarget || null
    let connector = (typeof o.call === 'function')
        ? { call: o.call }
        : rpcConnector(o.indexerUrl)
    let pinned = null
    if (connector)
        pinned = await discoverReadParams(connector, { probe: o.probe, local: o.local })
    if (pinned)
        return Object.assign({}, pinned, { source: 'indexer-disclosed' })
    if (!envTarget) return null
    return Object.assign({}, envTarget, { source: 'env model (HUB_DB_NAME)' })
}

// A connector shaped like XChainIndexerConnector for a driver that has only a URL.
// Returns null rather than throwing on a missing URL, so a driver that cannot reach
// its indexer keeps the env model instead of failing to start.
function rpcConnector(url){
    if (!url) return null
    let axios = require('axios')
    return { call: async (method, params) => {
        let res = await axios.post(url.replace(/\/+$/, '') + '/api',
            { jsonrpc: '2.0', method: method, params: params || {}, id: 1 }, { timeout: 8000 })
        if (res.data && res.data.error)
            return { error: (res.data.error.message || JSON.stringify(res.data.error)) }
        return res.data ? res.data.result : null
    } }
}

module.exports = {
    localParams,
    resolveDriverPriceTarget,
    readParams,
    seedParams,
    relayHubParams,
    seedsThroughMirror,
    assertCoherent,
    clearTargets,
    sameTarget,
    discoverReadParams,
    discoveredReadParams,
    resetDiscovery
}
