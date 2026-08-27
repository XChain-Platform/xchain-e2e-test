'use strict';

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
 **********************************************************************
 * AT2 REPLAY RIG: a whole XChain node, built from nothing, that knows only the
 * chain.
 *
 * WHY THIS EXISTS. `oracleBatchVenue.js` proves a federation can PUT price
 * history on a chain. AT2 is the other direction and it is the claim the whole
 * PRICE v0 spec rests on (section 2, section 5's "Replay property"): that the
 * chain ALONE is enough to get that history back. Nothing in this repo could
 * ask that question, because every drill runs against the one long-lived stack
 * whose databases already hold the answer. A node that inherits a populated
 * `price_snapshots` cannot demonstrate it rebuilt one.
 *
 * So this file builds real nodes: for each one a fresh empty indexer database,
 * a fresh empty hub with its own fresh empty database, and the two real
 * processes (`xchain-hub/src/api.js`, `xchain-indexer/src/api.js`) wired to each
 * other and to nothing else. The only populated thing a node is given is the
 * DECODER database, which is the chain itself in parsed form: blocks and
 * transactions, no verdicts, no ledger, no prices.
 *
 * WHY A HUB AND NOT "NO HUB" (decision D33). `price_snapshots` is hub-mirrored:
 * `XChainIndexer.js` only opens `hubDb` when HUB_DB_HOST and HUB_DB_NAME are
 * both set, and `actions/price.js` reconstructs history by pushing
 * `price_round` / `price_batch` onto the durable outbox, which delivers to a HUB
 * over JSON-RPC. A hub-less indexer is therefore not a configuration that can
 * rebuild anything; it is not a configuration at all. The replaying node has a
 * hub. That hub simply starts empty and knows no peers, so everything it ends up
 * holding must have arrived up the push path from a block.
 *
 * "NO PEERS" IS EXACT, NOT APPROXIMATE. `xchain-hub/src/api.js` builds
 * `p2pConfig` only when P2P_VALIDATOR_ADDR is set, and `startP2P`,
 * `startConsensus` and `startOracle` all return immediately without it. A node
 * here therefore runs a hub with no PeerManager, no PBFT, and critically no
 * OracleRound: it cannot fetch a price off the internet and it cannot finalize a
 * round of its own. `PriceAggregator` is nonetheless live, because
 * `XChainHub.start()` constructs it outside `startP2P` for exactly this reason
 * ("receiving on-chain PRICE actions needs no consensus, so a standalone hub
 * still aggregates"). That is the D33 configuration precisely.
 *
 * A KNOWN CONSEQUENCE OF STANDALONE MODE, worth naming because it is a real
 * property of the code and not of this rig: `XChainHub.js:81` derives
 * `this.network` from `p2pConfig.HUB_NETWORK`, so a hub with no
 * P2P_VALIDATOR_ADDR has `network === ''` no matter what HUB_NETWORK says.
 * Every network-keyed activation `PriceAggregator` consults (the pair-name gate,
 * STAKE_WEIGHTED_QUORUM) therefore resolves against '' rather than 'regtest' on
 * a config-oracle hub. It does not change any verdict this rig currently
 * observes, and it is recorded here rather than worked around, because working
 * around it would mean running a validator hub, which would finalize rounds of
 * its own and destroy the very claim AT2 makes.
 *
 * THE TWO NODES THE DRILL BUILDS, and why one is not enough. AT2 compares a
 * replaying node against "the live node". The comparison is only meaningful if
 * both sides reconstruct through the same path, and the ONLY path that writes a
 * chain-derived `price_snapshots` row is `PriceAggregator.receiveValidatedRound`
 * / `receiveValidatedBatch`, whose `reference_block` is the block the PRICE
 * landed in. A federation hub's own `OracleConsensus` rows carry the BTC anchor
 * height in that column instead, so they are not comparable on the key AT2
 * names. The drill therefore stands up a LIVE node before the publish and a
 * REPLAY node after it, both built by this class, and compares those.
 *
 * WHAT IS REAL AND WHAT IS BORROWED:
 *   REAL   - both node processes, their databases, their schema bootstrap and
 *            migrations, the block loop, every action handler, the fee
 *            validation, the durable hub push outbox, the hub's JSON-RPC
 *            surface, PriceAggregator's signature re-verification, the
 *            hub_db_sync REST bootstrap and WebSocket mirror.
 *   BORROWED - the decoder database (the chain, parsed) and the coin node's RPC.
 *            Both are read-only here and neither carries a verdict.
 *
 * SERIAL, LIKE THE VENUE. A node pair costs two processes and three databases,
 * and the disposable MariaDB it puts them on is the venue's fixed-port
 * container. Run drills that use this rig one at a time.
 ********************************************************************/

const fs    = require('fs');
const net   = require('net');
const os    = require('os');
const path  = require('path');
const { spawn } = require('child_process');
const mariadb   = require('mariadb');

const { startDisposableHubDb } = require('./disposableHubDb');
const { waitFor }              = require('./consensusWait');
const XChainHubConnector       = require('../../src/XChainHubConnector.js');
const {
    applyPriceCapabilityRows,
    removePriceCapabilityRows,
    registerPriceCapabilityTarget,
    unregisterPriceCapabilityTarget
} = require('./oracleBatchVenue');

// The five columns AT2 compares a replayed snapshot against. `consensus_proof`
// is deliberately absent: on a live node it holds COMMIT ADDRESSES rather than
// signatures, and under a weighted quorum a hub can store only its own address
// there while holding every signature, so it is not a cross-node invariant.
const SNAPSHOT_COMPARE_KEYS = ['round_number', 'coin_pair', 'price', 'block_timestamp', 'reference_block'];

// Guards every identifier this file interpolates into SQL. Database and table
// names cannot be parameterized, so the only safe posture is to refuse anything
// that is not a plain identifier rather than to escape it.
const SAFE_IDENT = /^[A-Za-z0-9_]+$/;

// Coin name to the three-letter code every per-chain env var and database name
// is keyed on. Same map chainRail carries; kept local so this rig can build a
// node without entering a rail.
const COIN_CODE_MAP = { bitcoin: 'BTC', litecoin: 'LTC', dogecoin: 'DOGE' };
function coinCode(coin) {
    return COIN_CODE_MAP[coin] || String(coin).toUpperCase().slice(0, 3);
}

// How long a node has to boot far enough to answer. Covers the hub's schema
// bootstrap plus the indexer's verifyTables/runMigrations on an empty database,
// which is where most of it goes.
const BOOT_WAIT_MS = 180_000;

// How long a node has to replay to a requested height. The DOGE regtest chain
// is small, but a replay runs every action handler including the contract VM.
const REPLAY_WAIT_MS = 30 * 60 * 1000;

// Child stdout/stderr kept for a failure message. A node that dies during boot
// says why on its own output and nowhere else, so losing it turns every startup
// failure into "the node did not come up".
const LOG_TAIL_LINES = 200;

function ident(name, what) {
    if (!SAFE_IDENT.test(String(name || ''))) {
        throw new Error('oracleBatchReplay: refusing to interpolate an unsafe ' + what + ': ' + name);
    }
    return String(name);
}

function portFree(port) {
    return new Promise((resolve) => {
        const srv = net.createServer();
        srv.once('error', () => resolve(false));
        srv.once('listening', () => srv.close(() => resolve(true)));
        srv.listen(port, '127.0.0.1');
    });
}

// The kernel's OUTBOUND port range. A port inside it is free when probed and
// taken a moment later by some other socket the run opens, and the child then
// dies on listen EADDRINUSE; multiValidatorHubHelper documents the same lottery
// at length. Linux publishes the range; elsewhere use the common default.
function ephemeralRange() {
    try {
        const [lo, hi] = fs.readFileSync('/proc/sys/net/ipv4/ip_local_port_range', 'utf8')
            .trim().split(/\s+/).map(Number);
        if (Number.isInteger(lo) && Number.isInteger(hi) && lo < hi) return { lo, hi };
    } catch (_) { /* not Linux, or a locked-down /proc */ }
    return { lo: 32768, hi: 60999 };
}

// Probe upward from `base` for `count` free ports, never handing back one inside
// the ephemeral range. A base inside the range jumps ABOVE it rather than below,
// because below is where the other suites' hand-assigned bases live.
async function pickFreePorts(count, base) {
    const eph = ephemeralRange();
    let p = (base >= eph.lo && base <= eph.hi) ? eph.hi + 1 : base;
    const picked = [];
    for (let tries = 0; picked.length < count && tries < 2000 && p < 65535; tries++) {
        if (p >= eph.lo && p <= eph.hi) { p = eph.hi + 1; continue; }
        if (await portFree(p)) picked.push(p);
        p++;
    }
    if (picked.length < count) throw new Error('oracleBatchReplay: not enough free ports near ' + base);
    return picked;
}

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

// ---------------------------------------------------------------------------
// Comparing two nodes
// ---------------------------------------------------------------------------

function snapshotKey(row) {
    return String(row.round_number) + '|' + String(row.coin_pair);
}

/**
 * Compare two `price_snapshots` sets on exactly SNAPSHOT_COMPARE_KEYS.
 *
 * Returns { matched, missing, extra, mismatched }, where `missing` is a row the
 * live node holds and the replaying node does not (the failure AT2 is really
 * about) and `mismatched` names the column that differs rather than dumping two
 * rows for a reader to diff by eye.
 */
function diffSnapshots(live, replay) {
    const liveByKey   = new Map(live.map((r) => [snapshotKey(r), r]));
    const replayByKey = new Map(replay.map((r) => [snapshotKey(r), r]));
    const out = { matched: [], missing: [], extra: [], mismatched: [] };
    for (const [key, l] of liveByKey) {
        const r = replayByKey.get(key);
        if (!r) { out.missing.push(l); continue; }
        const differing = SNAPSHOT_COMPARE_KEYS.filter((c) => String(l[c]) !== String(r[c]));
        if (differing.length > 0) out.mismatched.push({ key: key, columns: differing, live: l, replay: r });
        else out.matched.push(key);
    }
    for (const [key, r] of replayByKey) if (!liveByKey.has(key)) out.extra.push(r);
    return out;
}

// The chain coordinate inside a verdict key ('table@block:tx:vout').
function coordOf(key) { return String(key).slice(String(key).indexOf('@') + 1); }

/**
 * Compare two verdict maps.
 *
 * `feeCoordinates` narrows the comparison to the half AT2 names, the one that
 * proves fee validation is chain-time rather than arrival-time. Pass the set
 * readFeeCoordinates returned from a node with a complete price history;
 * `onlyFeeBearing` is the weaker local form, useful only when both sides are
 * known to have charged their fees.
 */
function diffVerdicts(live, replay, opts) {
    opts = opts || {};
    const keep = (key, v) => {
        if (opts.feeCoordinates) return opts.feeCoordinates.has(coordOf(key));
        if (opts.onlyFeeBearing) return !!v.feeBearing;
        return true;
    };
    const out = { compared: 0, agreed: 0, disagreed: [], missing: [], extra: [] };
    for (const [key, l] of live) {
        if (!keep(key, l)) continue;
        out.compared++;
        const r = replay.get(key);
        if (!r) { out.missing.push({ key: key, live: l }); continue; }
        if (r.status === l.status) out.agreed++;
        else out.disagreed.push({ key: key, action: l.action, blockIndex: l.blockIndex, live: l.status, replay: r.status });
    }
    for (const [key, r] of replay) {
        if (!keep(key, r)) continue;
        if (!live.has(key)) out.extra.push({ key: key, replay: r });
    }
    return out;
}

// ---------------------------------------------------------------------------
// The node
// ---------------------------------------------------------------------------

class OracleBatchReplayNode {

    /**
     * @param opts.label          short name used in database names and log lines
     * @param opts.coin/network   chain to index (default dogecoin/regtest)
     * @param opts.basePort       port probe base for the node's hub API and indexer API
     * @param opts.hubDb          an already-started disposableHubDb handle to share.
     *                            Pass one when several nodes (and the publish venue)
     *                            run in the same drill, so the fixed-port container is
     *                            started and removed exactly once.
     * @param opts.repoRoot       monorepo root; defaults to the checkout this file is in
     * @param opts.priceGraceS    HUB_SYNC_PRICE_GRACE_S for this node, or null (default)
     *                            to leave the frozen protocol constant in force. The
     *                            indexer honours this override on regtest only and
     *                            documents it as test tunability; see the note on
     *                            `_startIndexer` for what setting it trades away, and
     *                            NEVER give two nodes in one comparison different values.
     */
    constructor(opts) {
        opts = opts || {};
        this.label    = String(opts.label || 'replay').replace(/[^A-Za-z0-9]/g, '');
        this.coin     = opts.coin    || 'dogecoin';
        this.network  = opts.network || 'regtest';
        this.basePort = opts.basePort || 61000;
        this.repoRoot = opts.repoRoot || path.resolve(__dirname, '../../..');
        this.priceGraceS = opts.priceGraceS === undefined ? null : opts.priceGraceS;

        // Why the node could not be built, when it could not be. Non-null means the
        // caller should SKIP: a node that never booted proves nothing either way.
        this.unavailable = null;

        this.hubDb        = opts.hubDb || null;
        this._ownsHubDb   = false;
        this.hubDbName    = null;   // the fresh hub's OWN authoritative database
        this.indexerDbName = null;  // the fresh indexer's own database
        this.mirrorDbName = null;   // what hub_db_sync writes the hub's tables down into

        this.hubPort     = null;
        this.indexerPort = null;

        this._hubProc     = null;
        this._indexerProc = null;
        this._logs        = { hub: [], indexer: [] };
        this._conn        = null;   // to the disposable MariaDB (this node's three databases)
        this._cwd         = null;   // neutral working directory for the children
        this._hubSnapshotsAtBoot = null;
        this._live = null;          // resolved live-chain endpoints (decoder, node, tracker)
        // This node's registration on the `price` capability precondition list, and
        // the rows it last took. See _registerPriceCapability.
        this._capabilityTarget = null;
        this._capabilityRows   = [];
        this._decoderConn = null;
        this._liveIndexerConn = null;
    }

    // ---- bring-up -------------------------------------------------------

    // Build the node. Returns true when it is usable, false with `unavailable`
    // set when a dependency this rig does not own is missing.
    async up() {
        const live = await this._resolveLiveChain();
        if (!live) return false;

        if (!this.hubDb) {
            this.hubDb = await startDisposableHubDb();
            this._ownsHubDb = true;
            if (!this.hubDb) { this.unavailable = 'no env hub DB and Docker unavailable'; return false; }
        }

        const stamp = process.pid + '_' + Date.now().toString(36);
        this.hubDbName     = 'XChain_AT2_' + this.label + '_' + stamp + '_Hub';
        this.indexerDbName = 'XChain_AT2_' + this.label + '_' + stamp + '_Indexer';
        this.mirrorDbName  = 'XChain_AT2_' + this.label + '_' + stamp + '_HubMirror';

        this._conn = await mariadb.createConnection({
            host: this.hubDb.host, port: parseInt(this.hubDb.port, 10),
            user: this.hubDb.user, password: this.hubDb.pass, connectTimeout: 10_000
        });
        // The mirror database is the one neither process creates for itself: the hub
        // makes its own, the indexer makes its own, and hub_db_sync only ever writes
        // into a database that is already there.
        await this._conn.query('CREATE DATABASE IF NOT EXISTS `' + ident(this.mirrorDbName, 'database name') + '`');
        await this._provisionMirrorSchema();

        // A neutral working directory. Both `src/api.js` files call dotenv.config(),
        // which reads `<cwd>/.env`; run from the checkout, the indexer would silently
        // inherit the standing stack's settings for every variable this rig does not
        // set, which is exactly the class of contamination AT2 exists to rule out.
        this._cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'xchain-at2-' + this.label + '-'));

        const [hubPort, indexerPort] = await pickFreePorts(2, this.basePort);
        this.hubPort     = hubPort;
        this.indexerPort = indexerPort;

        this._live = live;
        await this._startHub();
        await this._startIndexer(live);
        await this._registerPriceCapability();
        return true;
    }

    /**
     * Put this node's own hub-mirror database on the list of landing chains that
     * must carry the `price` capability snapshot, and take whatever set a venue in
     * this process has already published for.
     *
     * WHY A NODE NEEDS THIS AT ALL. Judging a PRICE batch means resolving the
     * qualifying signer set at the batch's signed BTC anchor, and off BTC that set
     * comes only from mirrored `capability_snapshots` (capability staking is
     * BTC-only). This node reads that table through its HUB_DB_* connection, which
     * is the MIRROR database, so that is where the rows have to be.
     *
     * WHY THE ROWS CANNOT ARRIVE THE PRODUCTION WAY HERE. In production the rows
     * are the hub's own persist at finalization, carried down by hub_db_sync. This
     * node's hub is empty by construction: no peers, no oracle round, nothing to
     * persist, so the mirror it re-pages is empty of them too. That is the point of
     * the rig, not a defect of it, and it is exactly why the precondition has to be
     * supplied as SETUP. The definition, and the full statement of what it stands in
     * for, live once in oracleBatchVenue; this only names the database.
     *
     * NOTHING ABOUT THE REPLAY CLAIM IS WEAKENED. The rows are a validator set, not
     * a price and not a verdict: every price_snapshots row this node holds is still
     * rebuilt from the chain by its own hub, and every action verdict is still
     * reached by its own indexer running the full parse, signature and quorum path.
     * Both nodes in a comparison register the same way, so neither is given an
     * advantage the other lacks.
     */
    async _registerPriceCapability() {
        const table = '`' + ident(this.mirrorDbName, 'database name') + '`.capability_snapshots';
        const query = (sql, args) => this._conn.query(sql, args);
        this._capabilityRows = [];
        this._capabilityTarget = {
            label: 'AT2 node ' + this.label + ' hub mirror',
            apply: async (rows) => {
                await applyPriceCapabilityRows(query, rows, table);
                this._capabilityRows = rows.slice();
            },
            remove: async (rows) => removePriceCapabilityRows(query, rows, table)
        };
        const applied = await registerPriceCapabilityTarget(this._capabilityTarget);
        if (applied > 0) {
            console.log('oracleBatchReplay[' + this.label + ']: applied ' + applied + ' `price` ' +
                'capability_snapshots row(s) to this node\'s hub mirror (setup standing in for the hub\'s own ' +
                'persist at finalization; see _registerPriceCapability).');
        }
    }

    // The fee destination this node was launched with, for the run's evidence.
    feeDestination() { return this._live ? this._live.feeDestination : null; }

    // Which actions the STANDING chain charged a fee for, as chain coordinates.
    // See readFeeCoordinates for why the set has to come from a node with a
    // complete price history rather than from either side of the comparison.
    async liveChainFeeCoordinates(opts) {
        if (!this._liveIndexerConn) this._liveIndexerConn = await connectTo(this._live.liveIndexer);
        return readFeeCoordinates(this._liveIndexerConn, this._live.liveIndexer.name, opts);
    }

    // The chain's own height, read from the decoder the node reads. This is the
    // number a caller needs to say "caught up", and it is deliberately not the
    // node's own progress: a node that is caught up and one that has stopped both
    // report a height that stops moving.
    async decoderHeight() {
        if (!this._decoderConn) this._decoderConn = await connectTo(this._live.decoder);
        return readChainHeight(this._decoderConn, this._live.decoder.name);
    }

    /**
     * Give the mirror database its schema.
     *
     * NOBODY ELSE DOES THIS, and that is a real property of the code rather than
     * an oversight of this rig. `XChainIndexer.start()` calls verifyTables() on
     * `indexerDb` only, so the hub-mirror tables it creates land in the INDEXER's
     * database; the mirror `hubDb` is never touched. Left empty, HubDbSync's
     * bootstrap probes SHOW COLUMNS on each table, gets 1146, logs
     * "not ready for bootstrap ... will retry" forever, and the price barrier
     * never opens on mirror content. `hubDbWsMirror.integration.test.js` sets its
     * own replica up from the shipped DDL for exactly this reason, and this is
     * the same move.
     *
     * The WHOLE indexer schema is applied rather than only the seven mirrored
     * tables, because `hubDb` is not just hub_db_sync's target: the settlement
     * path reads stakes, delegations and validator_rewards through the same
     * connection (`db.js`'s `(indexer.hubDb || this)` idiom). In the single-host
     * topology that connection is a full schema, so making it one here is
     * matching production rather than padding.
     */
    async _provisionMirrorSchema() {
        const dir = path.join(this.repoRoot, 'xchain-indexer', 'src', 'sql');
        const db  = ident(this.mirrorDbName, 'database name');
        await this._conn.query('USE `' + db + '`');
        let created = 0;
        for (const file of fs.readdirSync(dir)) {
            if (!file.endsWith('.sql')) continue;
            // Strip the license block and every `--` comment before splitting: a
            // trailing comment can carry a ';' and would otherwise cut a CREATE TABLE
            // in half. Same reduction hubDbWsMirror's readDDL performs.
            const sql = fs.readFileSync(path.join(dir, file), 'utf8')
                .replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n\r]*/g, '');
            for (const stmt of sql.split(';').map((s) => s.trim()).filter(Boolean)) {
                try { await this._conn.query(stmt); created++; }
                catch (e) { /* a DDL this schema version cannot apply is not this rig's to fix */ }
            }
        }
        this._mirrorStatements = created;
    }

    // Discover the live chain's decoder database and node RPC, the only two
    // populated things a node here is given. Both are read-only and neither
    // carries a verdict: the decoder holds blocks and transactions, the node
    // holds the chain.
    //
    // Endpoints come from the hub the standing stack already serves, exactly as
    // chainRail does, so no credential is written to a file or a command line.
    async _resolveLiveChain() {
        let cfg = null;
        try {
            const hub = new XChainHubConnector(XChainHubConnector.parseEndpoints());
            if (!(await hub.ping())) {
                this.unavailable = 'stack hub unreachable, cannot discover the ' + this.coin + ' decoder database';
                return null;
            }
            cfg = await hub.getAllConfig();
        } catch (e) {
            this.unavailable = 'stack hub config lookup failed: ' + (e && e.message);
            return null;
        }
        const svc = cfg && cfg[this.coin] && cfg[this.coin][this.network];
        if (!svc) { this.unavailable = 'stack hub has no config for ' + this.coin + '/' + this.network; return null; }

        const code = coinCode(this.coin);
        const dec  = svc['xchain-decoder'] || {};
        const ixr  = svc['xchain-indexer'] || {};
        if (!dec.name) { this.unavailable = 'stack hub config carries no decoder database for ' + this.coin; return null; }

        // The hub stores the CONTAINER-internal database host; a host-side process
        // must use the published one, which is the same substitution chainRail makes.
        const dbHost = process.env.DATABASE_URL || '127.0.0.1';
        const dbPort = parseInt(process.env.DATABASE_PORT, 10) || 13306;
        const liveIndexer = { host: dbHost, port: dbPort, name: ixr.name, user: ixr.user, pass: ixr.pass };
        return {
            feeDestination: await this._resolveFeeDestination(code, ixr),
            decoder: { host: dbHost, port: dbPort, name: dec.name, user: dec.user, pass: dec.pass },
            liveIndexer: liveIndexer,
            node: svc['node'] || {},
            tracker: svc['xchain-utxo-tracker'] || {}
        };
    }

    /**
     * The fee destination the chain's own fee-bearing actions are paid to.
     *
     * CONFIGURATION, NOT CHAIN STATE, and handing it to a chain-only node is not
     * a shortcut. `FEE_DESTINATION` is a consensus-pinned per-coin address with a
     * regtest-only env override (`resolveFeeDestination`, xchain-indexer
     * src/coins/index.js), so every node on one network MUST hold the same value
     * or their fee verdicts diverge by configuration rather than by replay. A node
     * launched without it uses the pinned default, and MEASURED 2026-08-26 that
     * left this rig with no `fees` row at all on either node: they agreed, but
     * about a chain neither of them was replaying.
     *
     * Taken from the standing node's `feeschedule` RPC, which nativeFeeHelper
     * already names as the source of truth ("the indexer reads its destination
     * from config.ADDRESS.FEE_DESTINATION, NOT from any env the e2e runner happens
     * to export"). The `fees` table is NOT usable for this: MEASURED on the same
     * day, all 235 of its rows carry a NULL destination_id.
     */
    async _resolveFeeDestination(code, cfgIndexer) {
        try {
            const host = process.env[code + '_SERVICE_HOST'] || 'localhost';
            let port = process.env[code + '_INDEXER_API_PORT'];
            if (!port) {
                // Same lift the publish venue performs: the port convention in
                // chainRail.DEFAULT_PORTS is not what this stack actually publishes,
                // and the suite's own per-chain env file is.
                const file = path.resolve(__dirname, '../../.env.' + String(code).toLowerCase());
                if (fs.existsSync(file)) {
                    try { port = require('dotenv').parse(fs.readFileSync(file)).INDEXER_API_PORT; }
                    catch (_) { /* fall through to the hub's own value */ }
                }
            }
            if (!port) port = cfgIndexer && cfgIndexer.port;
            if (!port) return null;
            const XChainIndexerConnector = require('../../src/XChainIndexerConnector.js');
            const conn = new XChainIndexerConnector(host, port,
                process.env[code + '_INDEXER_API_KEY'] || process.env.INDEXER_API_KEY || null);
            const sched = await conn.call('feeschedule', {});
            if (!sched || sched.error || !sched.feeDestination) return null;
            return String(sched.feeDestination);
        } catch (e) {
            return null;
        }
    }

    // A hub with no validator address: no PeerManager, no PBFT, no OracleRound,
    // and therefore nothing that can put a price in its database except a push
    // arriving from a block. HUB_NETWORK is passed even though a standalone hub
    // reads it only through p2pConfig (see the header): a later version that fixes
    // that should find the right value already here.
    async _startHub() {
        const env = {
            PATH: process.env.PATH,
            HOME: process.env.HOME,
            HUB_DB_HOST:   this.hubDb.host,
            HUB_DB_PORT:   String(this.hubDb.port),
            HUB_DB_NAME:   this.hubDbName,
            HUB_DB_USER:   this.hubDb.user,
            HUB_DB_SECRET: this.hubDb.pass,
            HUB_PORT:      String(this.hubPort),
            HUB_HOST:      '127.0.0.1',
            HUB_NETWORK:   this.network,
            HUB_ALLOW_UNAUTHENTICATED: 'true',
            TELEMETRY_ENABLED: 'false',
            CORS_ORIGIN:   'http://localhost'
        };
        this._hubProc = this._spawn('hub', path.join(this.repoRoot, 'xchain-hub', 'src', 'api.js'), [], env);

        const connector = new XChainHubConnector(['http://127.0.0.1:' + this.hubPort]);
        const up = await waitFor(async () => {
            if (this._hubProc.exitCode !== null) return { ok: false, dead: true };
            try { return { ok: await connector.ping() }; } catch (_) { return { ok: false }; }
        }, { timeoutMs: BOOT_WAIT_MS, intervalMs: 500 });
        if (!up.ok) {
            throw new Error('oracleBatchReplay[' + this.label + ']: the fresh hub did not answer on 127.0.0.1:' +
                this.hubPort + ' within ' + up.waitedMs + 'ms.\n' + this._tail('hub'));
        }
        this.hubConnector = connector;

        // The zero this rig's whole claim rests on, measured rather than assumed:
        // how many price snapshots the fresh hub held BEFORE any block reached it.
        try {
            const rows = await this._conn.query(
                'SELECT COUNT(*) AS c FROM `' + ident(this.hubDbName, 'database name') + '`.price_snapshots');
            this._hubSnapshotsAtBoot = Number(rows[0].c);
        } catch (_) { this._hubSnapshotsAtBoot = null; }
    }

    // The indexer, pointed at the live decoder (the chain) and at NOTHING else
    // that holds state. Three separate databases, and the distinction between the
    // last two is load-bearing: HUB_DB_* is the indexer's local MIRROR, which
    // hub_db_sync owns and re-pages from the hub on every bootstrap. Pointing it
    // at the hub's own authoritative database instead would put the hub's rows
    // under a replication client that deletes and repages them.
    async _startIndexer(live) {
        const env = {
            PATH: process.env.PATH,
            HOME: process.env.HOME,
            INDEXER_COIN:    coinCode(this.coin),
            INDEXER_NETWORK: this.network,
            INDEXER_API_PORT: String(this.indexerPort),
            INDEXER_ALLOW_UNAUTHENTICATED: 'true',

            DECODER_DB_HOST: String(live.decoder.host),
            DECODER_DB_PORT: String(live.decoder.port),
            DECODER_DB_NAME: String(live.decoder.name),
            DECODER_DB_USER: String(live.decoder.user),
            DECODER_DB_PASS: String(live.decoder.pass),

            INDEXER_DB_HOST: this.hubDb.host,
            INDEXER_DB_PORT: String(this.hubDb.port),
            INDEXER_DB_NAME: this.indexerDbName,
            INDEXER_DB_USER: this.hubDb.user,
            INDEXER_DB_PASS: this.hubDb.pass,

            HUB_DB_HOST: this.hubDb.host,
            HUB_DB_PORT: String(this.hubDb.port),
            HUB_DB_NAME: this.mirrorDbName,
            HUB_DB_USER: this.hubDb.user,
            HUB_DB_PASS: this.hubDb.pass,
            HUB_DB_SYNC_ENABLED: 'true',
            HUB_API_URL: 'http://127.0.0.1:' + this.hubPort,

            NODE_URL:      String(live.node.host || '127.0.0.1'),
            NODE_PORT:     String(live.node.port || ''),
            NODE_USER:     String(live.node.user || ''),
            NODE_PASSWORD: String(live.node.pass || ''),

            UTXO_TRACKER_URL:      String(live.tracker.host || ''),
            UTXO_TRACKER_API_PORT: String(live.tracker.port || ''),

            // The push outbox retries on a 30s cadence by default. A replay pushes
            // a round the moment it parses one and then keeps walking blocks, so a
            // half-minute floor on the first retry is the difference between a
            // mirror that keeps up with the block loop and one that does not.
            HUB_PUSH_RETRY_INTERVAL_MS: '2000',
            HUB_PUSH_RETRY_BASE_MS:     '2000',
            HUB_DB_SYNC_POLL_INTERVAL:  '5000',

            CORS_ORIGIN: 'http://localhost'
        };

        // The chain's own fee destination, under both names the stack uses. See
        // _resolveFeeDestination: this is node configuration every node on one
        // network must share, and a node that replays with the pinned default
        // rejects every fee the chain accepted.
        if (live.feeDestination) {
            env['XCHAIN_FEE_DESTINATION_' + env.INDEXER_COIN + '_' + this.network.toUpperCase()] = live.feeDestination;
            env.FEE_DESTINATION = live.feeDestination;
        }

        // THE PRICE BARRIER, and why a caller may want to move it.
        //
        // MEASURED 2026-08-26 on DOGE regtest: with HUB_SYNC_WATERMARK_GRACE_S.price
        // at its new 4800, a chain-only node walks the whole history in minutes and
        // then STOPS dead at the first block younger than 4800 seconds, repeating
        // "Deferring block N (price time-sync) ... mirror max round timestamp 0,
        // stream watermark at <hub wall clock>" once a minute. The barrier's two
        // escapes are "the mirror holds a round at/past this block's time" (never,
        // for a node whose hub is empty) and "watermark >= blockTime + grace", and
        // the watermark is the hub's clock, so the node cannot reach a freshly mined
        // tip until 80 minutes of WALL time have passed. That is the documented
        // trade of raising the grace, now observed rather than predicted, and it
        // means a drill that publishes and then replays cannot finish inside a
        // sensible budget at the frozen value.
        //
        // The indexer sanctions a regtest-only override for exactly this
        // (`resolveWatermarkGrace`: "operator override honored ONLY on regtest (test
        // tunability)"), and it is IGNORED with a loud warning off regtest, so it can
        // never travel to a real network. Setting it lowers how much mirror coverage
        // a node insists on before processing a block, which is a real property, so
        // any comparison must give BOTH nodes the same value and a drill about the
        // barrier itself (AT5) must not set it at all.
        if (this.priceGraceS !== null) env.HUB_SYNC_PRICE_GRACE_S = String(this.priceGraceS);

        // --no-node-snapshot mirrors the package's own `api` script: the contract VM
        // binding will not load under a Node snapshot, and a replay of this chain
        // runs DEPLOY and EXECUTE.
        this._indexerProc = this._spawn('indexer', path.join(this.repoRoot, 'xchain-indexer', 'src', 'api.js'),
            ['--no-node-snapshot'], env);

        // Ready when the node has written its own schema and started walking the
        // chain, which is the first moment `blocks` can be read at all.
        const up = await waitFor(async () => {
            if (this._indexerProc.exitCode !== null) return { ok: false, dead: true };
            try {
                const rows = await this._conn.query(
                    'SELECT COUNT(*) AS c FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?', [this.indexerDbName]);
                return { ok: Number(rows[0].c) > 0, tables: Number(rows[0].c) };
            } catch (_) { return { ok: false }; }
        }, { timeoutMs: BOOT_WAIT_MS, intervalMs: 1000 });
        if (!up.ok) {
            throw new Error('oracleBatchReplay[' + this.label + ']: the fresh indexer never created its schema in ' +
                this.indexerDbName + ' within ' + up.waitedMs + 'ms.\n' + this._tail('indexer'));
        }
    }

    _spawn(which, script, nodeArgs, env) {
        const proc = spawn(process.execPath, [...nodeArgs, script], {
            cwd: this._cwd, env: env, stdio: ['ignore', 'pipe', 'pipe']
        });
        const keep = (buf) => {
            const lines = String(buf).split('\n').filter((l) => l.length > 0);
            const log = this._logs[which];
            log.push(...lines);
            if (log.length > LOG_TAIL_LINES) log.splice(0, log.length - LOG_TAIL_LINES);
        };
        proc.stdout.on('data', keep);
        proc.stderr.on('data', keep);
        proc.on('error', (e) => keep('spawn error: ' + (e && e.message)));
        return proc;
    }

    _tail(which) {
        const log = this._logs[which] || [];
        return '  last ' + log.length + ' line(s) from the ' + which + ':\n    ' + log.join('\n    ');
    }

    // ---- driving --------------------------------------------------------

    /**
     * Block until the node has processed up to `height`.
     *
     * Deliberately watches its OWN `blocks` table rather than an API: the claim
     * AT2 makes is about what the node's database ends up holding, and a health
     * endpoint can report progress the block transaction later rolls back.
     */
    async waitForHeight(height, opts) {
        opts = opts || {};
        const target = Number(height);
        const result = await waitFor(async () => {
            if (this._indexerProc && this._indexerProc.exitCode !== null) return { ok: false, dead: true };
            try {
                const at = await readChainHeight(this._conn, this.indexerDbName);
                return { ok: at.height !== null && at.height >= target, at: at.height };
            } catch (_) { return { ok: false, at: null }; }
        }, { timeoutMs: opts.timeoutMs || REPLAY_WAIT_MS, intervalMs: opts.intervalMs || 2000 });

        if (!result.ok) {
            const at = result.last && result.last.at;
            const dead = result.last && result.last.dead;
            throw new Error('oracleBatchReplay[' + this.label + ']: ' +
                (dead ? 'the indexer process exited' : 'the node reached block ' + at + ' of ' + target) +
                ' after ' + result.waitedMs + 'ms.\n' + this._tail('indexer'));
        }
        return result;
    }

    // ---- reading --------------------------------------------------------

    // What the node's own hub holds. This is the authoritative reconstruction:
    // rows here arrived through PriceAggregator from a block and from nowhere
    // else, because this hub has no peers and no oracle round.
    async hubPriceSnapshots(opts)    { return readPriceSnapshots(this._conn, this.hubDbName, opts); }
    // What the indexer's settlement path actually reads, once hub_db_sync has
    // carried the hub's rows back down. The full loop is only closed when both
    // agree.
    async mirrorPriceSnapshots(opts) { return readPriceSnapshots(this._conn, this.mirrorDbName, opts); }
    async priceActions(opts)         { return readPriceActions(this._conn, this.indexerDbName, opts); }
    async actionVerdicts(opts)       { return readActionVerdicts(this._conn, this.indexerDbName, opts); }
    async chainHeight()              { return readChainHeight(this._conn, this.indexerDbName); }

    // The node's own outbox, for a failure that needs to say whether a push was
    // never made, or was made and refused. Delivered rows are DELETED by design,
    // so an empty queue means either "nothing to push" or "everything landed";
    // the snapshot counts settle which.
    async hubPushQueue() {
        const db = ident(this.indexerDbName, 'database name');
        try {
            return plain(await this._conn.query(
                'SELECT push_type, status, attempts, last_error, COUNT(*) AS c FROM `' + db + '`.pending_hub_pushes ' +
                'GROUP BY push_type, status, attempts, last_error ORDER BY c DESC LIMIT 20'));
        } catch (e) { return [{ error: 'pending_hub_pushes unreadable: ' + (e && e.message) }]; }
    }

    // Evidence that the node really was isolated, rather than an assurance that
    // it was. Three independent facts: it was launched with no P2P identity and
    // no seed nodes (so `xchain-hub/src/api.js` builds no p2pConfig and
    // startP2P/startConsensus/startOracle all return immediately), its hub knew
    // no validators, and its hub held no price snapshot before a block was
    // replayed into it.
    async isolationEvidence() {
        const out = {
            p2pValidatorAddrSet: false,
            seedNodesSet:        false,
            hubSnapshotsAtBoot:  this._hubSnapshotsAtBoot,
            hubValidators:       null
        };
        try {
            const rows = await this._conn.query(
                'SELECT COUNT(*) AS c FROM `' + ident(this.hubDbName, 'database name') + '`.validators');
            out.hubValidators = Number(rows[0].c);
        } catch (_) { out.hubValidators = null; }
        return out;
    }

    logTail(which) { return this._tail(which || 'indexer'); }

    // ---- teardown -------------------------------------------------------

    // Give everything back, in reverse order, never letting one failure skip the
    // rest. Both processes die, all three databases are dropped, the neutral
    // working directory goes, and the shared MariaDB handle is only stopped by
    // the node that started it.
    async down() {
        const problems = [];
        const attempt = async (label, fn) => {
            try { await fn(); } catch (e) { problems.push(label + ': ' + (e && e.message)); }
        };

        // Off the capability-target list first, so a venue still coming up cannot
        // push rows into databases this teardown is about to drop.
        if (this._capabilityTarget) {
            await attempt('capability target unregister', async () => unregisterPriceCapabilityTarget(this._capabilityTarget));
            this._capabilityTarget = null;
        }
        // The rows themselves need no DELETE: all three of this node's databases are
        // dropped below, which takes them with it.

        await attempt('indexer stop', async () => this._kill(this._indexerProc));
        await attempt('hub stop',     async () => this._kill(this._hubProc));
        this._indexerProc = this._hubProc = null;

        if (this._conn) {
            for (const name of [this.mirrorDbName, this.indexerDbName, this.hubDbName]) {
                if (!name) continue;
                await attempt('drop ' + name, async () =>
                    this._conn.query('DROP DATABASE IF EXISTS `' + ident(name, 'database name') + '`'));
            }
            await attempt('conn close', async () => this._conn.end());
            this._conn = null;
        }
        if (this._decoderConn) {
            await attempt('decoder conn close', async () => this._decoderConn.end());
            this._decoderConn = null;
        }
        if (this._liveIndexerConn) {
            await attempt('live indexer conn close', async () => this._liveIndexerConn.end());
            this._liveIndexerConn = null;
        }

        if (this._cwd) {
            await attempt('cwd', async () => fs.rmSync(this._cwd, { recursive: true, force: true }));
            this._cwd = null;
        }
        if (this.hubDb && this._ownsHubDb) {
            await attempt('hub db stop', async () => this.hubDb.stop());
            this.hubDb = null;
        }

        if (problems.length > 0) console.warn('oracleBatchReplay[' + this.label + ']: teardown problems: ' + problems.join(' | '));
        return problems;
    }

    async _kill(proc) {
        if (!proc || proc.exitCode !== null) return;
        const ended = new Promise((resolve) => proc.once('exit', resolve));
        proc.kill('SIGTERM');
        const settled = await Promise.race([ended.then(() => true), new Promise((r) => setTimeout(() => r(false), 15_000))]);
        if (!settled) { proc.kill('SIGKILL'); await ended; }
    }
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
    OracleBatchReplayNode,
    SNAPSHOT_COMPARE_KEYS,
    readPriceSnapshots,
    readPriceActions,
    readActionVerdicts,
    readFeeCoordinates,
    readChainHeight,
    verdictTables,
    diffSnapshots,
    diffVerdicts,
    connectTo,
    pickFreePorts
};
