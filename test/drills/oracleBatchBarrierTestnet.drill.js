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
 * AT5 BARRIER DRILL, on the PUBLIC TESTNET chain.
 *
 * WHAT IT MEASURES. One chain-only TDOGE node (the AT2 rig: a fresh indexer, its
 * OWN empty hub, no peers, a real Bitcoin view) is built next to the live chain
 * and left running at the tip. For every block that arrives after it has caught
 * up the drill records how long the node held the block, which of the price
 * barrier's two escapes let it through, what its own mirror held at that moment
 * against what origin holds, whether its hub and mirror carry every round of
 * every batch it has parsed, and its verdict for every action in the block
 * against origin's. That set is the whole of TA5.
 *
 * WHY IT IS AN OBSERVATION AND NOT AN ASSERTION. The barrier
 * (`hub_db_sync._priceTimeSyncSatisfied`) opens on either
 * `priceSyncMaxTimestamp >= blockTime` (the mirror already holds a round at or
 * past the block's time) or `streamWatermark >= blockTime + 4800` (its own hub's
 * clock has passed the block by the grace). A round at or past block B's time is
 * finalized AFTER B and lands in a batch mined in a LATER block, which a
 * chain-only node cannot have parsed while it is holding B. So the content
 * escape is structurally unreachable at the tip for this node (decision D61) and
 * the stall is the grace, by design rather than by defect. Asserting a bound the
 * code cannot meet would only encode the misreading; the deliverable is the
 * measurement, and a verdict divergence found here opens spec row 43 rather than
 * failing this run (D62).
 *
 * WHY THE NODE IS BUILT WITH AN EXPLICIT LIVE-CHAIN OVERRIDE. The rig normally
 * discovers the decoder database, node RPC, tracker and Bitcoin oracle through
 * the standing hub's config oracle, which is an auth-gated sensitive read. The
 * host this runs on has no key for its own hub, so the endpoints arrive from the
 * process environment instead (`composeLiveChainFromEnv`), by NAME, never
 * printed and never written to the result file.
 *
 * NO `priceGraceS`. AT2's regtest suites lower the grace so a publish-then-
 * replay comparison fits in a sensible budget. This drill is ABOUT the barrier,
 * so it runs at the frozen protocol value and the wait it measures is the real
 * one.
 *
 * RUNNING IT (plain node, not mocha; hours of wall clock):
 *
 *   node test/drills/oracleBatchBarrierTestnet.drill.js
 *
 * Exit 0 when the observation completed, 2 when the node never reached the
 * chain tip inside AT5_MAX_MINUTES, 1 on any other failure. The JSON result at
 * AT5_RESULT is written either way, so a timed-out run still carries its
 * evidence.
 ********************************************************************/

const fs   = require('fs');
const path = require('path');
const axios = require('axios');

const { OracleBatchReplayNode, connectTo, verdictTables } = require('../helpers/oracleBatchReplay');

// The price barrier's watermark grace, in seconds, as
// xchain-indexer/src/hub_db_sync.js freezes it (HUB_SYNC_WATERMARK_GRACE_S.price
// = 4800). Copied rather than imported so this drill does not pull the whole
// indexer module into its process, and recorded in the result so a reader can
// see which value the run reasoned about if the constant ever moves.
const PRICE_WATERMARK_GRACE_S = 4800;

// How often the chain, the node and origin are asked where they are. A DOGE
// block is about a minute, and every wait here is a poll that exits on its
// condition, so this only bounds the resolution of firstSeenAt/processedAt.
const POLL_MS = 15_000;

// The explorer's coin path for the chain under observation. TDOGE is Dogecoin
// testnet, which is the only chain this drill is written for: the barrier is
// generic, but the origin comparison below is bound to this chain's public API.
const EXPLORER_COIN = 'TDOGE';
const COIN    = 'dogecoin';
const NETWORK = 'testnet';

// Guards every identifier interpolated into SQL, same posture as the rig: a
// database or table name cannot be parameterized, so anything that is not a
// plain identifier is refused rather than escaped.
const SAFE_IDENT = /^[A-Za-z0-9_]+$/;

function ident(name, what) {
    if (!SAFE_IDENT.test(String(name || ''))) {
        throw new Error('oracleBatchBarrierTestnet: refusing to interpolate an unsafe ' + what + ': ' + name);
    }
    return String(name);
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function nowS()    { return Math.floor(Date.now() / 1000); }
function iso(sec)  { return new Date(sec * 1000).toISOString(); }

// MariaDB hands back BIGINT as BigInt, which neither JSON.stringify nor
// arithmetic with a Number tolerates.
function num(v) { return v === null || v === undefined ? null : Number(v); }

// ---------------------------------------------------------------------------
// The environment contract
// ---------------------------------------------------------------------------

function required(env, name, why) {
    const v = env[name];
    if (v === undefined || v === null || String(v).trim() === '') {
        throw new Error('oracleBatchBarrierTestnet: ' + name + ' is required (' + why + ')');
    }
    return String(v).trim();
}

/**
 * The live chain, assembled from this process's environment in exactly the shape
 * `OracleBatchReplayNode._resolveLiveChain` would have discovered.
 *
 * Pure, and exported, so the shape can be pinned by a unit test without a venue:
 * a launcher that exports one variable under the wrong name otherwise costs a
 * multi-hour run to find out.
 *
 * NOTHING IS OPTIONAL EXCEPT `liveIndexer`. Every field below is read once,
 * inside a child process, and a missing one degrades silently into the result
 * this drill exists to measure: no decoder password is a node stuck at height
 * zero, no Bitcoin oracle key is a hub that resolves no signer set and refuses
 * every batch, and a missing fee destination is a node that rejects every fee
 * the chain accepted. `liveIndexer` is genuinely absent here: it exists for
 * AT2's cross-node comparison, and this drill compares against ORIGIN's public
 * API rather than against a second database.
 */
function composeLiveChainFromEnv(env) {
    env = env || {};
    // Read in the order the environment contract documents, so the FIRST thing a
    // launcher forgot is the first thing the error names.
    const decoder = {
        host: required(env, 'AT5_DECODER_DB_HOST', 'the decoder database is the chain in parsed form'),
        port: required(env, 'AT5_DECODER_DB_PORT', 'the decoder database port'),
        name: required(env, 'AT5_DECODER_DB_NAME', 'the decoder database name'),
        user: required(env, 'AT5_DECODER_DB_USER', 'the decoder database user'),
        pass: required(env, 'AT5_DECODER_DB_PASS', 'the decoder database password')
    };
    const coinNode = {
        host: required(env, 'AT5_NODE_HOST', 'the coin node RPC host'),
        port: required(env, 'AT5_NODE_PORT', 'the coin node RPC port'),
        user: required(env, 'AT5_NODE_USER', 'the coin node RPC user'),
        pass: required(env, 'AT5_NODE_PASS', 'the coin node RPC password')
    };
    const tracker = {
        host: required(env, 'AT5_TRACKER_HOST', 'the utxo tracker host'),
        port: required(env, 'AT5_TRACKER_PORT', 'the utxo tracker API port')
    };
    // Consensus-pinned per coin, and every node on one network must hold the same
    // value or its fee verdicts diverge by configuration rather than by replay,
    // which would silently poison the parity half of this drill.
    const feeDestination = required(env, 'AT5_FEE_DESTINATION',
        'a node replaying with the wrong fee destination rejects every fee the chain accepted');
    const btcHost = required(env, 'BTC_SERVICE_HOST',
        'the host publishing the Bitcoin indexer this node resolves signer sets from');
    const btcPort = required(env, 'BTC_INDEXER_API_PORT', 'the PUBLISHED JSON-RPC port of that Bitcoin indexer');
    const btcKey  = required(env, 'BTC_INDEXER_API_KEY',
        'the Bitcoin indexer is authenticated; without the key the hub resolves no signer set at all');
    return {
        decoder: decoder,
        node: coinNode,
        tracker: tracker,
        btcOracle: {
            host: btcHost,
            port: btcPort,
            url:  'http://' + btcHost + ':' + btcPort,
            apiKey: btcKey,
            db: null   // no venue publishes here, so nothing is ever seeded into the oracle
        },
        feeDestination: feeDestination,
        liveIndexer: null
    };
}

// Everything that is not a credential: budgets, endpoints and output path.
function readSettings(env) {
    env = env || {};
    const int = (name, dflt) => {
        const v = parseInt(env[name], 10);
        return Number.isFinite(v) && v > 0 ? v : dflt;
    };
    return {
        label:         String(env.AT5_LABEL || 'at5').replace(/[^A-Za-z0-9]/g, '') || 'at5',
        basePort:      int('AT5_BASE_PORT', 61000),
        observeBlocks: int('AT5_OBSERVE_BLOCKS', 6),
        maxMinutes:    int('AT5_MAX_MINUTES', 240),
        resultPath:    String(env.AT5_RESULT || './at5-result.json'),
        // The hub-connected node this run is compared against. Its getlatestblock
        // lag is the control: a stall on BOTH sides is the chain, a stall on the
        // chain-only side alone is the barrier. No default: the origin indexer is
        // deployment-specific, and an unset value takes the explorer fallback below
        // rather than quietly dialling a host this file would have to name.
        originIndexerUrl: String(env.AT5_ORIGIN_INDEXER_URL || ''),
        explorerUrl:      String(env.AT5_EXPLORER_URL || 'https://explorer.xchain.io').replace(/\/+$/, '')
    };
}

// ---------------------------------------------------------------------------
// Origin: the hub-connected side of every comparison
// ---------------------------------------------------------------------------

/**
 * What the live platform says, read two ways.
 *
 * The origin INDEXER's `getlatestblock` is the control for the barrier: it
 * reports a hub-connected node's own tip and its lag behind the decoder. It is
 * also authenticated, and this drill may not hold its key, so an Unauthorized
 * (-32001) is recorded as UNAVAILABLE and the public explorer answers the tip
 * instead. Silently reporting a missing control as "no lag" would turn a dead
 * endpoint into evidence.
 *
 * The EXPLORER is the verdict source: `/COIN/api/action/<index>` carries
 * origin's status for one action, and `/COIN/api/price_snapshots` its finalized
 * rounds newest first, which is what the "which round did each side price
 * against" question needs.
 */
class OriginView {

    constructor(settings) {
        this.indexerUrl = settings.originIndexerUrl;
        this.explorer   = settings.explorerUrl + '/' + EXPLORER_COIN + '/api';
        this.indexerUnavailable = null;    // why, once it has answered once
    }

    async _rpc(method, params) {
        if (!this.indexerUrl) {
            const e = new Error('AT5_ORIGIN_INDEXER_URL not set');
            e.code = 'NOT_CONFIGURED';
            throw e;
        }
        const res = await axios.post(this.indexerUrl,
            { jsonrpc: '2.0', id: 1, method: method, params: params || {} },
            { timeout: 20_000, validateStatus: () => true });
        const body = res.data || {};
        if (body.error) {
            const e = new Error(String(body.error.message || body.error));
            e.code = body.error.code;
            throw e;
        }
        return body.result;
    }

    // Origin's own tip and its lag behind the decoder, or a reason it could not
    // be read. `fallbackTip` is the explorer's newest action height, which is a
    // floor on the tip rather than the tip itself, so it is labelled as such.
    async latestBlock() {
        try {
            const r = await this._rpc('getlatestblock', {});
            this.indexerUnavailable = null;
            return {
                source: 'origin-indexer',
                blockIndex: num(r && r.block_index),
                decoderBlock: num(r && r.decoder_block),
                lag: num(r && r.lag)
            };
        } catch (e) {
            this.indexerUnavailable = (e && e.code === -32001 ? 'unauthorized (-32001)' : String(e && e.message));
            try {
                const res = await axios.get(this.explorer + '/actions?limit=1', { timeout: 20_000 });
                const row = res.data && res.data.data && res.data.data[0];
                return {
                    source: 'explorer-actions',
                    unavailable: this.indexerUnavailable,
                    newestActionBlock: num(row && row.block_index),
                    blockIndex: null, decoderBlock: null, lag: null
                };
            } catch (e2) {
                return { source: 'none', unavailable: this.indexerUnavailable,
                    explorerError: String(e2 && e2.message), blockIndex: null, lag: null };
            }
        }
    }

    // Origin's verdict for one action, plus enough of its coordinate to prove the
    // two sides are talking about the SAME action: action_index is a per-node
    // counter, and comparing two nodes' counters without checking the block and
    // transaction they land on would compare each node's bookkeeping to itself.
    async action(actionIndex) {
        try {
            const res = await axios.get(this.explorer + '/action/' + encodeURIComponent(String(actionIndex)),
                { timeout: 20_000, validateStatus: () => true });
            if (res.status === 404) return { found: false, status: null };
            if (res.status !== 200 || !res.data || res.data.error) {
                return { found: false, status: null, error: 'http ' + res.status };
            }
            const d = res.data;
            return {
                found: true,
                status: d.status === undefined || d.status === null ? null : String(d.status),
                action: d.action === undefined ? null : d.action,
                blockIndex: num(d.block_index),
                txIndex: num(d.tx_index)
            };
        } catch (e) {
            return { found: false, status: null, error: String(e && e.message) };
        }
    }

    /**
     * The newest finalized round origin holds whose `block_timestamp` is at or
     * before `blockTime`: exactly the row `getLatestPrice` would select on a node
     * whose mirror holds every finalized round.
     *
     * Pages newest-first and stops at the first page carrying an eligible row,
     * which for a tip block is the first page. `pages` bounds the walk so a
     * chain whose rounds all post-date the block cannot turn into an unbounded
     * crawl; a null answer then says "not found within N rows" rather than
     * "origin holds nothing", and the result records the bound.
     */
    async newestRoundAtOrBefore(blockTime, pages, perPage) {
        pages   = pages   || 5;
        perPage = perPage || 100;
        let scanned = 0;
        for (let page = 1; page <= pages; page++) {
            let rows;
            try {
                const res = await axios.get(this.explorer + '/price_snapshots?limit=' + perPage + '&page=' + page,
                    { timeout: 30_000 });
                rows = (res.data && res.data.data) || [];
            } catch (e) {
                return { round: null, blockTimestamp: null, error: String(e && e.message), rowsScanned: scanned };
            }
            if (rows.length === 0) break;
            scanned += rows.length;
            let best = null;
            for (const r of rows) {
                const ts = num(r.block_timestamp);
                const rn = num(r.round_number);
                if (ts === null || rn === null || ts > blockTime) continue;
                if (!best || rn > best.round) best = { round: rn, blockTimestamp: ts };
            }
            if (best) return Object.assign(best, { rowsScanned: scanned });
        }
        return { round: null, blockTimestamp: null, rowsScanned: scanned, note: 'no eligible row in ' + scanned + ' rows' };
    }
}

// ---------------------------------------------------------------------------
// The node, read directly
// ---------------------------------------------------------------------------

// A block's time as the CHAIN records it, from the decoder. The barrier is
// keyed on this number and on nothing the node computes for itself.
async function decoderBlock(conn, dbName, height) {
    const db = ident(dbName, 'database name');
    const rows = await conn.query(
        'SELECT block_index, block_time FROM `' + db + '`.blocks WHERE block_index = ?', [height]);
    if (rows.length === 0) return null;
    return { height: num(rows[0].block_index), blockTime: num(rows[0].block_time) };
}

async function decoderRange(conn, dbName) {
    const db = ident(dbName, 'database name');
    const rows = await conn.query(
        'SELECT MIN(block_index) AS lo, MAX(block_index) AS hi FROM `' + db + '`.blocks');
    return { first: num(rows[0].lo), last: num(rows[0].hi) };
}

// The newest finalized round the node itself would price a block at `blockTime`
// against: `getLatestPrice`'s selection (block_timestamp <= blockTime, newest
// round first), asked of the node's OWN mirror, which is the copy its settlement
// path reads.
async function mirrorNewestRound(conn, dbName, blockTime) {
    const db = ident(dbName, 'database name');
    const rows = await conn.query(
        'SELECT round_number, block_timestamp FROM `' + db + '`.price_snapshots ' +
        "WHERE status = 'finalized' AND block_timestamp <= ? ORDER BY round_number DESC LIMIT 1", [blockTime]);
    if (rows.length === 0) return { round: null, blockTimestamp: null };
    return { round: num(rows[0].round_number), blockTimestamp: num(rows[0].block_timestamp) };
}

/**
 * Every round the node has PARSED off the chain, and every round it actually
 * HOLDS: the difference is a hole.
 *
 * A valid v0 batch row carries the window it covers (batch_first_round ..
 * batch_last_round), so the rounds the node is committed to are derivable from
 * its own `prices` table without asking anyone. A round inside a parsed window
 * that is absent from the node's hub, or present in the hub and absent from the
 * mirror, is the reconstruction dropping something it read: the first is an
 * ingest refusal, the second a hub_db_sync gap, and the result keeps them apart
 * because they have different causes.
 */
async function batchCoverage(conn, indexerDb, hubDb, mirrorDb) {
    const ixr = ident(indexerDb, 'database name');
    const batches = await conn.query(
        'SELECT action_index, batch_first_round, batch_last_round, round_count, validation_status ' +
        'FROM `' + ixr + '`.prices WHERE version = 0 AND batch_first_round IS NOT NULL ' +
        'ORDER BY batch_first_round ASC');
    const valid = batches.filter((b) => String(b.validation_status) === 'valid');
    const wanted = new Set();
    for (const b of valid) {
        const lo = num(b.batch_first_round);
        const hi = num(b.batch_last_round);
        if (lo === null || hi === null || hi < lo) continue;
        for (let r = lo; r <= hi; r++) wanted.add(r);
    }
    const held = async (dbName) => {
        const db = ident(dbName, 'database name');
        const rows = await conn.query(
            'SELECT DISTINCT round_number FROM `' + db + '`.price_snapshots');
        return new Set(rows.map((r) => num(r.round_number)));
    };
    const inHub    = await held(hubDb);
    const inMirror = await held(mirrorDb);
    const missingFromHub    = [...wanted].filter((r) => !inHub.has(r)).sort((a, b) => a - b);
    const missingFromMirror = [...wanted].filter((r) => !inMirror.has(r)).sort((a, b) => a - b);
    return {
        batchesParsed: batches.length,
        batchesValid:  valid.length,
        batchStatuses: batches.reduce((h, b) => {
            const k = String(b.validation_status);
            h[k] = (h[k] || 0) + 1;
            return h;
        }, {}),
        roundsCarried: wanted.size,
        roundsInHub:    inHub.size,
        roundsInMirror: inMirror.size,
        // Capped in the record because a node that rebuilt nothing would otherwise
        // write every round it ever read into the result file; the COUNT is the
        // measurement and the sample is for the reader.
        missingFromHub:    { count: missingFromHub.length,    sample: missingFromHub.slice(0, 25) },
        missingFromMirror: { count: missingFromMirror.length, sample: missingFromMirror.slice(0, 25) }
    };
}

/**
 * Every action in one block, with the node's own verdict for it.
 *
 * Driven from the `actions` table so an action with no verdict row anywhere is
 * still reported (as a null status) rather than quietly dropped, and joined
 * against every table the schema records verdicts in, discovered the way the rig
 * discovers them. One action can be recorded in more than one such table, so the
 * statuses are collected rather than assumed unique, and the record says so.
 */
async function blockActions(conn, indexerDb, tables, height) {
    const db = ident(indexerDb, 'database name');
    const rows = await conn.query(
        'SELECT a.action_index, a.tx_index, a.tx_vout, ia.action AS action ' +
        'FROM `' + db + '`.actions a JOIN `' + db + '`.index_actions ia ON ia.id = a.action_id ' +
        'WHERE a.block_index = ? ORDER BY a.tx_index, a.tx_vout', [height]);
    const byIndex = new Map();
    for (const r of rows) {
        byIndex.set(num(r.action_index), {
            actionIndex: num(r.action_index),
            action: String(r.action),
            txIndex: num(r.tx_index),
            txVout:  num(r.tx_vout),
            verdicts: []
        });
    }
    for (const table of tables) {
        const t = ident(table, 'table name');
        let vrows;
        try {
            vrows = await conn.query(
                'SELECT d.action_index, s.status FROM `' + db + '`.`' + t + '` d ' +
                'JOIN `' + db + '`.actions a ON a.action_index = d.action_index ' +
                'JOIN `' + db + '`.index_statuses s ON s.id = d.status_id ' +
                'WHERE a.block_index = ?', [height]);
        } catch (e) {
            continue;   // a table this schema version cannot join is not a divergence
        }
        for (const v of vrows) {
            const entry = byIndex.get(num(v.action_index));
            if (entry) entry.verdicts.push({ table: t, status: String(v.status) });
        }
    }
    return [...byIndex.values()];
}

// ---------------------------------------------------------------------------
// The barrier's own evidence
// ---------------------------------------------------------------------------

/**
 * Which escape opened the barrier for a block, decided from what the node held
 * rather than from a log line that says so (there is none: the indexer logs the
 * DEFERRALS, and proceeding is silent).
 *
 *   none      the block was never deferred, so the barrier was already satisfied
 *             when it arrived.
 *   content   it was deferred and, by the time it was processed, the node's own
 *             mirror held a finalized round at or past the block's time. That is
 *             the case D61 says a chain-only node cannot reach at the tip, so a
 *             'content' here is the interesting result, not the expected one.
 *   watermark it was deferred and the mirror still held no such round, which
 *             leaves the hub's stream watermark as the only escape the code has.
 *             Corroborated by the stall against the frozen grace.
 *
 * The deferral lines are kept verbatim in the record either way, so the
 * derivation can be re-judged by a reader who does not accept it.
 */
function classifyEscape(deferrals, mirrorNewestTs, blockTime, stallS) {
    if (!deferrals || deferrals.length === 0) return { escape: 'none', corroborated: true };
    if (mirrorNewestTs !== null && mirrorNewestTs >= blockTime) return { escape: 'content', corroborated: true };
    return {
        escape: 'watermark',
        // A watermark escape cannot fire before the grace has elapsed against the
        // block's own time, so a stall shorter than that contradicts the reading.
        corroborated: stallS !== null && stallS >= PRICE_WATERMARK_GRACE_S,
        graceS: PRICE_WATERMARK_GRACE_S
    };
}

// "Deferring block N (price time-sync): Error: price time-sync barrier timed out
// after Xms waiting for block time T (mirror max round timestamp M, stream
// watermark at W)". Both numbers are the barrier's own state at that instant,
// which is what makes a deferral line evidence rather than noise.
const DEFERRAL_RE = /Deferring block (\d+) \(price time-sync\)/;
const DEFERRAL_STATE_RE = /mirror max round timestamp (-?\d+), stream watermark at (-?\d+)/;

function parseDeferral(line) {
    const m = DEFERRAL_RE.exec(line);
    if (!m) return null;
    const state = DEFERRAL_STATE_RE.exec(line);
    return {
        at: nowS(),
        height: Number(m[1]),
        mirrorMaxRoundTs: state ? Number(state[1]) : null,
        streamWatermark:  state ? Number(state[2]) : null,
        line: line.slice(0, 400)
    };
}

// ---------------------------------------------------------------------------
// The drill
// ---------------------------------------------------------------------------

async function main(env) {
    env = env || process.env;
    const settings  = readSettings(env);
    const liveChain = composeLiveChainFromEnv(env);
    const origin    = new OriginView(settings);
    const deadline  = Date.now() + settings.maxMinutes * 60_000;

    const result = {
        drill: 'oracleBatchBarrierTestnet',
        coin: COIN,
        network: NETWORK,
        startedAt: iso(nowS()),
        finishedAt: null,
        status: 'incomplete',
        error: null,
        settings: {
            label: settings.label,
            basePort: settings.basePort,
            observeBlocks: settings.observeBlocks,
            maxMinutes: settings.maxMinutes,
            originIndexerUrl: settings.originIndexerUrl,
            explorerUrl: settings.explorerUrl,
            priceWatermarkGraceS: PRICE_WATERMARK_GRACE_S,
            priceGraceOverride: null       // AT5 runs at the frozen value; see the header
        },
        node: null,
        replay: null,
        observations: [],
        originLagSeries: [],
        summary: null
    };

    // Deferral lines, kept whole for the run's whole length. The rig's own ring
    // holds 200 lines, and a run measured in hours overruns that many times over.
    const deferralsByHeight = new Map();
    const onLog = (which, line) => {
        if (which !== 'indexer') return;
        const d = parseDeferral(line);
        if (!d) return;
        if (!deferralsByHeight.has(d.height)) deferralsByHeight.set(d.height, []);
        const kept = deferralsByHeight.get(d.height);
        // One block can be deferred for eighty minutes at a one-minute cadence;
        // the first and the last carry the whole story, so the middle is counted
        // rather than stored.
        kept.push(d);
        if (kept.length > 40) kept.splice(20, kept.length - 40);
    };

    const write = () => {
        const out = path.resolve(settings.resultPath);
        fs.writeFileSync(out, JSON.stringify(result, null, 2));
        return out;
    };

    let node = null;
    let conn = null;
    let decoderConn = null;
    let exitCode = 0;

    try {
        node = new OracleBatchReplayNode({
            label:    settings.label,
            coin:     COIN,
            network:  NETWORK,
            basePort: settings.basePort,
            liveChain: liveChain,
            onLog:    onLog
            // priceGraceS deliberately unset: this drill measures the frozen barrier.
        });

        console.log('at5: building a chain-only ' + COIN + '/' + NETWORK + ' node (label ' + settings.label + ')...');
        const up = await node.up();
        if (!up) throw new Error('the node could not be built: ' + node.unavailable);

        // One connection to the disposable MariaDB reads all three of this node's
        // databases (indexer, hub, mirror), which is what lets a single record
        // hold "what the node parsed" and "what it holds" side by side.
        conn = await connectTo({ host: node.hubDb.host, port: node.hubDb.port,
            user: node.hubDb.user, pass: node.hubDb.pass });
        decoderConn = await connectTo(liveChain.decoder);

        result.node = {
            hubDbDisposable: !!node.hubDb.disposable,
            hubDbName: node.hubDbName,
            indexerDbName: node.indexerDbName,
            mirrorDbName: node.mirrorDbName,
            hubPort: node.hubPort,
            indexerPort: node.indexerPort,
            feeDestinationSet: !!node.feeDestination(),
            btcOracle: node.btcOracleEvidence(),
            isolation: await node.isolationEvidence()
        };
        console.log('at5: node up (hub ' + node.hubPort + ', indexer ' + node.indexerPort + '), ' +
            'isolation ' + JSON.stringify(result.node.isolation));

        // --- 1. the replay, from the chain's first block to the tip at start ---
        const range = await decoderRange(decoderConn, liveChain.decoder.name);
        const startTip = range.last;
        const replayStartedAt = nowS();
        result.replay = {
            firstBlock: range.first,
            targetHeight: startTip,
            startedAt: iso(replayStartedAt),
            reachedAt: null,
            durationS: null,
            blocksIndexed: null,
            coverage: null
        };
        write();

        console.log('at5: replaying ' + range.first + '..' + startTip + ' (decoder tip at start)...');
        const replayBudgetMs = Math.max(60_000, deadline - Date.now());
        try {
            await node.waitForHeight(startTip, { timeoutMs: replayBudgetMs, intervalMs: POLL_MS });
        } catch (e) {
            result.status = 'replay-timeout';
            result.error  = String(e && e.message).slice(0, 4000);
            console.error('at5: the node never reached block ' + startTip + ' inside the budget');
            exitCode = 2;
            return exitCode;
        }
        const reachedAt = nowS();
        result.replay.reachedAt = iso(reachedAt);
        result.replay.durationS = reachedAt - replayStartedAt;
        result.replay.blocksIndexed = (await node.chainHeight()).blocks;
        result.replay.coverage = await batchCoverage(conn, node.indexerDbName, node.hubDbName, node.mirrorDbName);
        write();
        console.log('at5: reached the start tip in ' + result.replay.durationS + 's; parsed ' +
            result.replay.coverage.batchesValid + ' valid batch(es) carrying ' +
            result.replay.coverage.roundsCarried + ' round(s), hub holds ' + result.replay.coverage.roundsInHub +
            ', mirror ' + result.replay.coverage.roundsInMirror);

        // --- 2. observe the tip, block by block ---
        const tables = await verdictTables(conn, node.indexerDbName);
        const pending = new Map();      // height -> {blockTime, firstSeenAt}
        let lastDecoderSeen = startTip;

        while (result.observations.length < settings.observeBlocks && Date.now() < deadline) {
            // New chain blocks: noted the moment the DECODER has them, which is
            // what makes waitS a measure of the node's own hold rather than of
            // how long the chain took to produce a block.
            const tip = (await node.decoderHeight()).height;
            for (let h = lastDecoderSeen + 1; h <= tip; h++) {
                const blk = await decoderBlock(decoderConn, liveChain.decoder.name, h);
                if (!blk) continue;
                pending.set(h, { blockTime: blk.blockTime, firstSeenAt: nowS() });
                console.log('at5: chain block ' + h + ' arrived (block time ' + iso(blk.blockTime) + ')');
            }
            lastDecoderSeen = tip === null ? lastDecoderSeen : tip;

            const originNow = await origin.latestBlock();
            result.originLagSeries.push(Object.assign({ at: iso(nowS()), decoderTip: tip }, originNow));

            const at = (await node.chainHeight()).height;
            const ready = [...pending.keys()].filter((h) => at !== null && h <= at).sort((a, b) => a - b);
            for (const h of ready) {
                const seen = pending.get(h);
                pending.delete(h);
                const processedAt = nowS();
                const observation = await observeBlock({
                    node, conn, origin, tables, height: h,
                    blockTime: seen.blockTime, firstSeenAt: seen.firstSeenAt, processedAt,
                    deferrals: deferralsByHeight.get(h) || [],
                    originNow: originNow
                });
                result.observations.push(observation);
                write();
                console.log('at5: block ' + h + ' processed after ' + observation.stallS + 's of block time (' +
                    observation.escape + '), ' + observation.actions.length + ' action(s), ' +
                    observation.verdictAgreements + ' agreeing / ' + observation.verdictDisagreements.length +
                    ' diverging; observed ' + result.observations.length + ' of ' + settings.observeBlocks);
                if (result.observations.length >= settings.observeBlocks) break;
            }
            if (result.observations.length >= settings.observeBlocks) break;
            await sleep(POLL_MS);
        }

        result.status = result.observations.length >= settings.observeBlocks ? 'completed' : 'budget-exhausted';
        result.summary = summarize(result);
        exitCode = 0;
    } catch (e) {
        result.status = 'error';
        result.error = String((e && e.stack) || e).slice(0, 8000);
        console.error('at5: ' + String(e && e.message));
        exitCode = 1;
    } finally {
        // The node's three databases, its two processes and the disposable MariaDB
        // it started all go back, whatever happened above. A drill that leaves a
        // container and a schema behind poisons the next run of itself.
        for (const c of [conn, decoderConn]) {
            if (c) { try { await c.end(); } catch (_) { /* the run is over either way */ } }
        }
        if (node) { try { await node.down(); } catch (e) { console.error('at5: teardown: ' + (e && e.message)); } }
        result.finishedAt = iso(nowS());
        if (!result.summary) result.summary = summarize(result);
        const out = write();
        console.log('at5: ' + result.status + '; result written to ' + out);
    }
    return exitCode;
}

/**
 * One tip block, measured on every axis TA5 names.
 *
 * The two clocks are kept apart deliberately. `stallS` is measured against the
 * BLOCK's own time, which is what the barrier gates on and therefore what the
 * "4800 s + confirm" bound is about; `waitS` is measured from the moment the
 * decoder had the block, which is what an operator watching the node sees. They
 * differ by however long the block took to reach this host, and conflating them
 * would either flatter or slander the node depending on the venue.
 */
async function observeBlock(ctx) {
    const { node, conn, origin, tables, height, blockTime, firstSeenAt, processedAt, deferrals, originNow } = ctx;

    const mirrorNewest = await mirrorNewestRound(conn, node.mirrorDbName, blockTime);
    const hubNewest    = await mirrorNewestRound(conn, node.hubDbName, blockTime);
    const originNewest = await origin.newestRoundAtOrBefore(blockTime);
    const stallS = processedAt - blockTime;
    const escape = classifyEscape(deferrals, mirrorNewest.blockTimestamp, blockTime, stallS);

    const actions = await blockActions(conn, node.indexerDbName, tables, height);
    const rows = [];
    let agreements = 0;
    const disagreements = [];
    for (const a of actions) {
        const statuses = [...new Set(a.verdicts.map((v) => v.status))];
        const nodeStatus = statuses.length === 1 ? statuses[0]
            : (statuses.length === 0 ? null : a.verdicts.map((v) => v.table + '=' + v.status).join(' | '));
        const o = await origin.action(a.actionIndex);
        // Same action, or the same COUNTER pointing at two different actions? The
        // index is assigned per node, so a coordinate check is what makes the
        // comparison about the chain. A misaligned pair is reported as such and
        // counted neither way.
        const aligned = o.found && o.blockIndex === height && (o.txIndex === null || o.txIndex === a.txIndex);
        const agree = aligned && nodeStatus !== null && o.status !== null && nodeStatus === o.status;
        if (agree) agreements++;
        else if (aligned) {
            disagreements.push({
                actionIndex: a.actionIndex, action: a.action,
                nodeStatus: nodeStatus, originStatus: o.status,
                // WHICH ROUND EACH SIDE PRICED AGAINST, which is the whole point of
                // recording a divergence: D61's claim is that the two node types
                // select different rounds for the same block, so a divergence with
                // the two selections beside it is the measurement, not an anecdote.
                nodePricedAgainstRound:   mirrorNewest.round,
                originPricedAgainstRound: originNewest.round
            });
        }
        rows.push({
            actionIndex: a.actionIndex, action: a.action, txIndex: a.txIndex, txVout: a.txVout,
            nodeStatus: nodeStatus, originStatus: o.status,
            originFound: !!o.found, coordinateAligned: !!aligned, agree: agree
        });
    }

    return {
        height: height,
        blockTime: blockTime,
        blockTimeIso: iso(blockTime),
        firstSeenAt: iso(firstSeenAt),
        processedAt: iso(processedAt),
        stallS: stallS,
        waitS: processedAt - firstSeenAt,
        escape: escape.escape,
        escapeEvidence: {
            corroborated: escape.corroborated,
            graceS: escape.graceS === undefined ? null : escape.graceS,
            deferralCount: deferrals.length,
            firstDeferral: deferrals.length > 0 ? deferrals[0] : null,
            lastDeferral:  deferrals.length > 0 ? deferrals[deferrals.length - 1] : null
        },
        mirrorNewestRound: mirrorNewest.round,
        mirrorNewestRoundTs: mirrorNewest.blockTimestamp,
        hubNewestRound: hubNewest.round,
        originNewestRound: originNewest.round,
        originNewestRoundTs: originNewest.blockTimestamp,
        roundGapVsOrigin: (originNewest.round !== null && mirrorNewest.round !== null)
            ? originNewest.round - mirrorNewest.round : null,
        originLagAtProcess: originNow && originNow.lag !== undefined ? originNow.lag : null,
        originTipAtProcess: originNow && originNow.blockIndex !== undefined ? originNow.blockIndex : null,
        holes: await batchCoverage(conn, node.indexerDbName, node.hubDbName, node.mirrorDbName),
        actions: rows,
        verdictAgreements: agreements,
        verdictDisagreements: disagreements
    };
}

// The run in numbers. Every field here is derived from `observations`, so the
// summary can never claim something the per-block records do not carry.
function summarize(result) {
    const obs = result.observations || [];
    const stalls = obs.map((o) => o.stallS).filter((n) => Number.isFinite(n));
    const escapes = obs.reduce((h, o) => { h[o.escape] = (h[o.escape] || 0) + 1; return h; }, {});
    const holes = obs.length > 0 ? obs[obs.length - 1].holes : (result.replay && result.replay.coverage) || null;
    const lags = (result.originLagSeries || []).map((s) => s.lag).filter((n) => Number.isFinite(n));
    return {
        blocksObserved: obs.length,
        maxStallS: stalls.length > 0 ? Math.max(...stalls) : null,
        minStallS: stalls.length > 0 ? Math.min(...stalls) : null,
        escapes: escapes,
        // The bound TA5 was reworded to (D62): the watermark escape cannot open
        // before the grace, and nothing observed may claim to have opened earlier.
        stallsWithinGracePlusConfirm: stalls.filter((s) => s >= PRICE_WATERMARK_GRACE_S).length,
        holesTotal: holes ? (holes.missingFromHub.count + holes.missingFromMirror.count) : null,
        holesInHub: holes ? holes.missingFromHub.count : null,
        holesInMirror: holes ? holes.missingFromMirror.count : null,
        roundsCarriedByParsedBatches: holes ? holes.roundsCarried : null,
        verdictsCompared: obs.reduce((n, o) => n + o.actions.filter((a) => a.coordinateAligned).length, 0),
        verdictsAgreed: obs.reduce((n, o) => n + o.verdictAgreements, 0),
        verdictsDiverged: obs.reduce((n, o) => n + o.verdictDisagreements.length, 0),
        divergences: obs.reduce((all, o) => all.concat(o.verdictDisagreements), []).slice(0, 50),
        originLagSamples: lags.length,
        originMaxLag: lags.length > 0 ? Math.max(...lags) : null,
        originIndexerUnavailable: (result.originLagSeries || []).some((s) => s.unavailable)
            ? (result.originLagSeries.find((s) => s.unavailable) || {}).unavailable : null
    };
}

module.exports = {
    composeLiveChainFromEnv, readSettings, classifyEscape, parseDeferral, summarize, main,
    // Exported so the origin side of every comparison can be driven on its own,
    // against the real public API, without building a node or spending the run's
    // wall clock. It is the half most likely to rot: it reads someone else's HTTP.
    OriginView
};

// Only when this file IS the process, so the exports above stay importable by a
// unit test without a chain, a database or four hours of wall clock.
if (require.main === module) {
    main(process.env)
        .then((code) => process.exit(code))
        .catch((e) => { console.error('at5: ' + String((e && e.stack) || e)); process.exit(1); });
}
