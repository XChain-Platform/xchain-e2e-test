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
 * WHY THERE IS A CATCH-UP PHASE BETWEEN THE REPLAY AND THE OBSERVATION (row 46).
 * The replay targets the decoder tip AS IT WAS WHEN THE REPLAY STARTED, and on
 * this chain that replay runs for over an hour, during which the chain produces
 * a hundred and fifty more blocks. Run 3 (2026-09-09) began observing the moment
 * the node reached that stale target, so the six blocks it graded were already
 * 4,303-4,453 s old when it first saw them: every one carried `waitS: 0`,
 * `escape: "none"` and `deferralCount: 0`, because the barrier had been open on
 * the watermark for over an hour before the node ever got there. A stall that is
 * really block AGE is not the quantity TA5 asks for. So the run now converges on
 * the LIVE tip first (`evaluateCatchUp`), stamps nothing that was already sitting
 * in the decoder when observation opened, and grades only blocks whose age when
 * first seen is inside `AT5_MAX_BLOCK_AGE_S` (`classifyBlockFreshness`). A block
 * that fails that test is still recorded, with its age and the reason, and is
 * counted as UNUSABLE rather than scored: the failure mode this replaces is a
 * backlog silently reported as a barrier measurement.
 *
 * WHAT "CAUGHT UP" MEANS FOR A NODE THE BARRIER HOLDS BACK. It cannot mean "at
 * the tip". D61 says a chain-only node can only leave a tip block on the
 * watermark escape, which fires `PRICE_WATERMARK_GRACE_S` after the block's own
 * time, so at its working point this node is PERMANENTLY about a grace behind
 * the chain and reaching the tip is not something to wait for. What ends the
 * catch-up phase is therefore either of the two conditions that mean the node
 * has stopped burning backlog: it is within `AT5_CATCHUP_SLACK_BLOCKS` of the
 * decoder tip (which is what a node with no barrier in its way looks like), or
 * the block it is working on is no older than the grace plus
 * `AT5_CATCHUP_TOLERANCE_S` (which is what a node held by the barrier looks
 * like). Both are upper bounds, so neither can mistake a node still replaying
 * for one at its working point.
 *
 * HOW THE TWO SIDES ARE LINED UP (row 55). Every verdict comparison needs the
 * two nodes to be talking about the SAME action, and the only coordinate the
 * CHAIN supplies is the transaction hash (with `tx_vout` where an action is
 * vout-scoped). `action_index` and `tx_index` are per-node counters assigned as
 * each node parses, so a chain-only node that started mid-chain is misaligned
 * from origin by construction: run 5 (2026-09-09) graded 290 blocks carrying 20
 * actions, and every single pair was discarded because origin had filed as
 * `tx_index` 666 the transaction this node called 263. Aligning the same 20
 * pairs on tx_hash by hand compared all 20 (7 agreeing, 13 diverging). The
 * alignment is therefore on the hash, the refusals are named in the result, and
 * a pair that genuinely cannot be aligned is still counted neither way.
 *
 * WHY THE ESCAPE IS SAMPLED AND NOT SCRAPED (row 56). Until run 5 the escape was
 * derived from the indexer's "Deferring block N (price time-sync)" log lines,
 * which carry the barrier's two inputs verbatim. Run 5 graded 191 blocks and
 * attributed ONE: 190 read `escape: "none"`, `deferralCount: 0`, and its 843 KB
 * drill log contains not a single line matching /defer/i, on blocks that waited
 * 4,400+ seconds. The cause is not the capture (the rig pipes both child streams
 * and calls `onLog` per line before its ring truncates) and not the regex: the
 * indexer only PRINTS that line when one barrier attempt TIMES OUT.
 * `waitForPriceSyncTime` returns an already-resolved promise when the predicate
 * is satisfied, and `_releasePriceTimeWaiters` resolves a pending waiter silently
 * the moment it opens, so the warn at XChainIndexer.js:1294 is reached only if
 * the block is still held after HUB_PRICE_SYNC_TIMEOUT_MS (60 s by default). At
 * this node's working point every block's residual wait is shorter than that, so
 * the barrier opens hundreds of times and says nothing. Attribution by log line
 * is therefore structurally incomplete, whatever the regex says.
 *
 * WHAT REPLACED IT. The barrier's ONLY inputs besides the block's own time and
 * the grace are `priceSyncMaxTimestamp` and `streamWatermark`
 * (`_priceTimeSyncSatisfied`, hub_db_sync.js:2171), and the indexer already
 * publishes both, unauthenticated, on its own `GET /status`:
 * `hubMirror.streamWatermark` and `hubMirror.tables.price_snapshots` are filled
 * from those two fields by `mirrorStatus()`. So the drill SAMPLES the pair once
 * per observe tick and attributes each block from the samples: the first sampled
 * instant at which either shipped clause is true for that block's time is when
 * the barrier permitted it, and which clause was true is the escape. A block the
 * samples cannot settle reads `escape: "unknown"` WITH the reason, never `none`:
 * conflating "the barrier was open before we looked" with "we do not know" is
 * what made TA5's "never before the barrier permits" half unmeasurable. Deferral
 * lines are still folded in as samples of the same pair (they are readings of
 * exactly those two fields at a moment the barrier was CLOSED), so nothing that
 * worked before was given up.
 *
 * RUNNING IT (plain node, not mocha; hours of wall clock):
 *
 *   node test/drills/oracleBatchBarrierTestnet.drill.js
 *
 * Exit 0 when the observation completed, 2 when the node never reached the
 * chain tip or its working point inside AT5_MAX_MINUTES, 3 when it observed
 * blocks but not one of them arrived live enough to grade (the backlog case
 * above, which must never read as a pass), 1 on any other failure. The JSON
 * result at AT5_RESULT is written either way, so a timed-out run still carries
 * its evidence.
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

// One leg of the catch-up chase. The node is told to reach the tip it can see
// right now; the chain moves while it does, so the leg is bounded and the
// working-point test at the top of the loop, not the leg, is what ends the
// phase. A leg that expires is normal for a node the barrier holds back.
const CATCHUP_LEG_MS = 600_000;

// Defaults for the observe-phase gate; every one is overridable by environment
// so a chain with a different block cadence can be measured without an edit.
//
// MAX_BLOCK_AGE_S is the whole of "did this block arrive live": a block is only
// graded if the drill first saw it within this many seconds of its own block
// time. It has to cover the decoder's own ingest lag plus one POLL_MS, and
// nothing more, because everything above that is what row 46 exists to reject.
const DEFAULT_MAX_BLOCK_AGE_S = 120;

// How near the decoder tip counts as "at the tip" for a node with nothing
// holding it back. Two blocks, as the row asks.
const DEFAULT_CATCHUP_SLACK_BLOCKS = 2;

// How far past the grace the node's working block may be and still count as the
// barrier's steady state rather than leftover backlog. One DOGE block is about
// a minute and the deferral retry cadence is coarse, so ten minutes is slack
// for the mechanics without admitting a node that is still an hour behind.
const DEFAULT_CATCHUP_TOLERANCE_S = 600;

// How many of origin's newest actions one block is aligned against. The explorer
// ignores `block_index` on this endpoint, so the page IS the window. It also
// caps the page: asking for 200 returns 100 today. 200 is asked for anyway, so a
// raised cap is taken automatically, and the 100 rows the cap allows spanned
// 1,416 blocks of this chain when measured, against a node that sits one grace
// (4,800 s, roughly 80 blocks) behind the tip.
const DEFAULT_ORIGIN_ACTION_PAGE = 200;

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

// A number, or null: anything that is absent, empty or not finite becomes null
// rather than NaN or a coerced zero. The observe-phase gate below compares
// heights and clocks that can each legitimately be unavailable for one poll,
// and an unavailable reading must not be able to look like a satisfied bound.
function finite(v) {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}

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
        minVerdicts:   int('AT5_MIN_VERDICTS', 1),
        maxMinutes:    int('AT5_MAX_MINUTES', 240),
        // The observe-phase gate (row 46). Read here rather than at the point of
        // use so the values a run reasoned about are in its result file.
        maxBlockAgeS:       int('AT5_MAX_BLOCK_AGE_S', DEFAULT_MAX_BLOCK_AGE_S),
        // How many of origin's newest actions each block's alignment is matched
        // against (row 55). The endpoint caps what it returns, and the window each
        // block was ACTUALLY matched against is recorded in the observation, so a
        // window too short for the node's lag is visible rather than silent.
        originActionPage:   int('AT5_ORIGIN_ACTION_PAGE', DEFAULT_ORIGIN_ACTION_PAGE),
        catchUpSlackBlocks: int('AT5_CATCHUP_SLACK_BLOCKS', DEFAULT_CATCHUP_SLACK_BLOCKS),
        catchUpToleranceS:  int('AT5_CATCHUP_TOLERANCE_S', DEFAULT_CATCHUP_TOLERANCE_S),
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

    /**
     * Origin's verdict for ONE OF ORIGIN'S OWN action indexes.
     *
     * `actionIndex` here must be the index `recentActions()` gave back for the
     * transaction hash under comparison, never the node's own `action_index`:
     * the counter is assigned per node, so passing the node's number in reads
     * whichever unrelated action origin happens to have filed under it. That is
     * the defect row 55 records, and it is why the caller aligns first and only
     * then asks this method for a status.
     *
     * The coordinate comes back with the status so the pair can be re-checked at
     * the point of comparison and recorded in the result.
     */
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
     * Origin's most recent actions, newest first, as the raw material for the
     * tx_hash alignment (row 55).
     *
     * WHY THE WHOLE LIST AND NOT THE BLOCK. `/COIN/api/actions?block_index=N`
     * accepts the parameter and ignores it: it answers with the newest actions on
     * the chain whatever block is asked for, so a per-block fetch would look
     * precise and silently compare the wrong block. `?limit=N` is the filter this
     * endpoint honours, up to a cap it applies without saying so: asking for 200
     * returns 100 today. That is not a problem for this comparison but it is a
     * fact the reader needs, because 100 rows is however many blocks the chain's
     * action traffic makes it. Measured on 2026-09-09 it was 1,416 blocks, against
     * a node that sits one grace (about 80 blocks) behind the tip, and `limit`
     * comes back in the record so a run that read fewer rows than it asked for
     * says so.
     *
     * Every numeric field arrives as a STRING from this API, so each is coerced
     * here rather than at the four places that compare them.
     */
    async recentActions(limit) {
        const want = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 200;
        try {
            const res = await axios.get(this.explorer + '/actions?limit=' + want,
                { timeout: 30_000, validateStatus: () => true });
            if (res.status !== 200 || !res.data || res.data.error) {
                return { rows: [], error: 'http ' + res.status, limit: want };
            }
            const raw = (res.data && res.data.data) || [];
            return { rows: raw.map(normalizeOriginRow), error: null, limit: want };
        } catch (e) {
            return { rows: [], error: String(e && e.message), limit: want };
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
// Aligning the two sides on the coordinate the CHAIN supplies (row 55)
// ---------------------------------------------------------------------------

/**
 * WHY NEITHER COUNTER CAN BE USED. `action_index` and `tx_index` are assigned by
 * each node as it parses, from its own starting point. A node that begins its
 * replay mid-chain therefore numbers every transaction differently from a node
 * that has been running since genesis: on run 5 (2026-09-09) origin filed as
 * `tx_index` 666 the transaction this node called 263, for all 20 actions in the
 * 290 blocks it graded, so every pair was discarded and `verdictsCompared` was 0
 * while both sides held a verdict for every one of them.
 *
 * WHAT IS LEFT. `tx_hash` is the transaction's identity on the chain itself, so
 * it is the same string on every node that parsed the same block, and `tx_vout`
 * distinguishes two actions carried by one transaction. Those two, plus the
 * block height and the action's own name, are the whole coordinate.
 *
 * WHAT IS DELIBERATELY NOT CONSULTED. Origin's `tx_index` is not compared, not
 * even when both sides have one: it is the counter that caused the defect, and a
 * row where it is null (a derived action such as ORDER_MATCH, which no
 * transaction of its own carries) must neither be excluded for the null nor
 * silently matched because a null compared equal to something. It is recorded in
 * the result beside the node's, as evidence of the skew, and it decides nothing.
 */
function normalizeHash(h) {
    if (h === null || h === undefined) return null;
    const s = String(h).trim().toLowerCase();
    return s === '' ? null : s;
}

function normalizeName(n) {
    if (n === null || n === undefined) return null;
    const s = String(n).trim().toUpperCase();
    return s === '' ? null : s;
}

/**
 * One row of origin's action list, in either of the two shapes it can arrive in.
 *
 * The explorer sends EVERY number as a string ("action_index":"685"), and a
 * comparison against a Number is then quietly false, so the coercion happens
 * once, here, rather than at each of the places that compare. Accepting both the
 * raw snake_case row and an already-normalized one is what lets a unit test feed
 * the endpoint's own JSON verbatim instead of a hand-tidied copy of it.
 */
function normalizeOriginRow(r) {
    r = r || {};
    const pick = (a, b) => (r[a] !== undefined ? r[a] : r[b]);
    return {
        actionIndex: finite(pick('action_index', 'actionIndex')),
        blockIndex:  finite(pick('block_index', 'blockIndex')),
        // Recorded and never compared: it is the counter row 55 is about.
        txIndex:     finite(pick('tx_index', 'txIndex')),
        // Absent from this endpoint today; read anyway so a vout-scoped action can
        // be told apart the day the field appears.
        txVout:      finite(pick('tx_vout', 'txVout')),
        txHash:      normalizeHash(pick('tx_hash', 'txHash')),
        action:      normalizeName(pick('action', 'action'))
    };
}

/**
 * Origin's recent actions, keyed by the chain coordinate, plus the block span the
 * window actually covers.
 *
 * The span matters as much as the rows: a lookup that misses inside the window is
 * origin genuinely holding no such action, and a lookup that misses outside it is
 * this drill having asked for too few rows. Those are different findings, and
 * collapsing them would report a short window as a divergence in the chain.
 */
function buildOriginActionIndex(rows) {
    const byHash = new Map();
    let oldest = null;
    let newest = null;
    for (const raw of rows || []) {
        const r = normalizeOriginRow(raw);
        if (r.blockIndex !== null) {
            oldest = oldest === null ? r.blockIndex : Math.min(oldest, r.blockIndex);
            newest = newest === null ? r.blockIndex : Math.max(newest, r.blockIndex);
        }
        if (r.txHash === null) continue;
        if (!byHash.has(r.txHash)) byHash.set(r.txHash, []);
        byHash.get(r.txHash).push(r);
    }
    return {
        byHash: byHash,
        rowCount: (rows || []).length,
        hashCount: byHash.size,
        oldestBlock: oldest,
        newestBlock: newest
    };
}

/**
 * One node action against origin's window: the same chain action, or a named
 * reason it is not.
 *
 * Pure, so the predicate that decides every comparison in a four-hour run can be
 * driven in a second. Refusal is a first-class answer here: an unalignable pair
 * is reported with its reason and counted neither as an agreement nor as a
 * divergence, exactly as before. What changes is that a pair the chain says is
 * the same action now aligns.
 */
function alignOnTxHash(nodeAction, index, height) {
    const refuse = (reason, extra) =>
        Object.assign({ aligned: false, origin: null, reason: reason }, extra || {});
    if (!index || !(index.byHash instanceof Map)) return refuse('origin-actions-unavailable');
    const hash = normalizeHash(nodeAction && nodeAction.txHash);
    if (hash === null) return refuse('node-action-has-no-tx-hash');
    const h = finite(height);
    const span = { oldestBlock: index.oldestBlock, newestBlock: index.newestBlock, rows: index.rowCount };

    const onHash = index.byHash.get(hash) || [];
    if (onHash.length === 0) {
        if (index.rowCount === 0) return refuse('origin-actions-unavailable', { originWindow: span });
        // Outside the window is this drill's own short read, not a chain fact.
        if (h !== null && index.oldestBlock !== null && h < index.oldestBlock) {
            return refuse('origin-window-does-not-cover-block', { originWindow: span });
        }
        if (h !== null && index.newestBlock !== null && h > index.newestBlock) {
            return refuse('origin-has-not-reached-this-block', { originWindow: span });
        }
        return refuse('origin-has-no-action-on-this-tx', { originWindow: span });
    }

    // The same transaction filed under a different height is two different
    // parses of the chain, which is a finding rather than a pair to compare.
    const inBlock = h === null ? onHash : onHash.filter((c) => finite(c.blockIndex) === h);
    if (inBlock.length === 0) {
        return refuse('origin-filed-this-tx-in-another-block',
            { originBlocks: [...new Set(onHash.map((c) => finite(c.blockIndex)))] });
    }

    // One transaction can carry more than one action. The name is compared only
    // when both sides carry one, and a mismatch refuses rather than falling back
    // to whatever else is on the transaction.
    let narrowed = inBlock;
    const name  = normalizeName(nodeAction && nodeAction.action);
    const named = inBlock.filter((c) => normalizeName(c.action) !== null);
    if (name !== null && named.length > 0) {
        const same = named.filter((c) => normalizeName(c.action) === name);
        if (same.length === 0) {
            return refuse('origin-has-no-such-action-on-this-tx', {
                nodeActionName: name,
                originActionNames: [...new Set(named.map((c) => normalizeName(c.action)))]
            });
        }
        narrowed = same;
    }

    // Only where it discriminates: this endpoint carries no tx_vout today, and a
    // side that has none must not be excluded by one that has.
    const vout = finite(nodeAction && nodeAction.txVout);
    if (narrowed.length > 1 && vout !== null) {
        const sameVout = narrowed.filter((c) => finite(c.txVout) === vout);
        if (sameVout.length > 0) narrowed = sameVout;
    }

    if (narrowed.length > 1) {
        return refuse('ambiguous-tx-hash-candidates', {
            candidates: narrowed.map((c) => finite(c.actionIndex))
        });
    }
    return { aligned: true, origin: narrowed[0], reason: 'aligned' };
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

/**
 * WHETHER THE PRICE BARRIER APPLIES TO THIS BLOCK AT ALL (row 56).
 *
 * The indexer only enters the time barrier when `blockMayReadPrice` is true, and
 * that predicate is `blockTransactions.length > 0` over the decoder rows for the
 * block (priceReadPredicate.js, reached through `_evaluatePriceBarrier`). A block
 * carrying no transaction is committed without ever consulting the barrier, so
 * "which escape opened it" has no answer for it, and a sampled attribution that
 * did not know this would report every empty block as processed while the barrier
 * was closed: 289 of run 5's 290 blocks, an impossible result manufactured by
 * asking the wrong question rather than by anything the node did.
 *
 * `getDecoderBlockData` joins outward from `transactions`, and the fan-out
 * collapse the indexer applies afterwards only ever shrinks that set, so a count
 * of the decoder's own transaction rows answers `length > 0` exactly.
 */
async function decoderBlockTransactionCount(conn, dbName, height) {
    const db = ident(dbName, 'database name');
    const rows = await conn.query(
        'SELECT COUNT(*) AS n FROM `' + db + '`.transactions WHERE block_index = ?', [height]);
    if (rows.length === 0) return null;
    return num(rows[0].n);
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
 * THE CLOCK THE BARRIER ACTUALLY GATES ON (row 56), which is not the one the
 * decoder's `blocks.block_time` carries.
 *
 * `_priceTimeSyncSatisfied(blockTime)` is called with whatever
 * `decoderDb.getBlockTime()` returned (XChainIndexer.js:1181), and on a network
 * where protocol time is MTP-resolved that is `min(medianTimePast(previous 11
 * raw stamps), raw stamp)`, not the raw stamp (db.js:2470, protocol_time.js).
 * testnet is such a network. MEASURED on run 5: the drill recorded block
 * 67881904's time as 1788982721 while the indexer's own deferral line for that
 * same block says it was "waiting for block time 1788982515", 206 s earlier.
 * Attributing the watermark escape against the raw stamp therefore asks for
 * 1788987521 on a block the node released at 1788987328, which reads as
 * "processed 193 s before the barrier permitted it" for every block on the
 * chain: an impossible result produced by the wrong clock, not by the node.
 * Against the protocol time the same block was permitted at 1788987315 and seen
 * processed 13 s later, inside one poll.
 *
 * The SHIPPED module does the deciding, loaded from the same checkout the rig
 * spawns the indexer out of, so this cannot drift into a second definition. If it
 * cannot be loaded the drill says so and attributes nothing, rather than falling
 * back to a stamp it has just measured to be the wrong one.
 */
// Keyed by checkout, not global: a cache that ignored the root would hand one
// venue's module to a caller asking about another, which is exactly the kind of
// silent substitution this whole path exists to stop.
const _protocolTimeModules = new Map();
function loadProtocolTime(repoRoot) {
    const key = String(repoRoot);
    if (_protocolTimeModules.has(key)) return _protocolTimeModules.get(key);
    // ABSENCE may degrade to an unresolved clock; PRESENT-BUT-BROKEN must be red.
    // Resolving and loading are therefore separate steps: only the resolve is
    // guarded, and the load is unguarded so a module that exists and throws stops
    // the run instead of quietly downgrading every block to "clock unavailable".
    const modulePath = path.join(key, 'xchain-indexer', 'src', 'protocol_time.js');
    let present = true;
    try {
        require.resolve(modulePath);
    } catch (e) {
        present = false;
    }
    const mod = present ? require(modulePath) : null;
    _protocolTimeModules.set(key, mod);
    return mod;
}

// The window `db.getPreviousBlockTimes` reads, with the same ordering and the
// same "a null stamp is not part of the median" filter.
async function previousBlockTimes(conn, dbName, height, span) {
    const db = ident(dbName, 'database name');
    const rows = await conn.query(
        'SELECT block_time FROM `' + db + '`.blocks ' +
        'WHERE block_index < ? AND block_time IS NOT NULL ' +
        'ORDER BY block_index DESC LIMIT ?', [height, span]);
    return rows.map((r) => num(r.block_time));
}

/**
 * The block time the barrier will be asked about, resolved the way the node
 * resolves it. Returns the value AND where it came from, because a drill that
 * silently substituted one clock for another is the defect being fixed.
 */
async function resolveBarrierBlockTime(conn, dbName, height, rawBlockTime, network, repoRoot) {
    const mod = loadProtocolTime(repoRoot);
    if (!mod) {
        return { blockTime: null, source: 'unavailable',
                 note: 'xchain-indexer/src/protocol_time.js could not be loaded from ' + repoRoot +
                       ', so the clock the barrier gates on is unknown' };
    }
    if (!mod.isProtocolTimeMtpActive(network)) {
        return { blockTime: finite(rawBlockTime), source: 'raw',
                 note: 'protocol time is the raw stamp on ' + network };
    }
    const previous = await previousBlockTimes(conn, dbName, height, mod.MEDIAN_TIME_SPAN);
    const resolved = mod.protocolTime(network, rawBlockTime, previous);
    return {
        blockTime: finite(resolved),
        source: finite(resolved) === finite(rawBlockTime) ? 'mtp-equals-raw' : 'mtp',
        note: 'median time past over ' + previous.length + ' preceding stamp(s)'
    };
}

// `priceSyncMaxTimestamp` as the indexer computes it: the query in
// `hub_db_sync._refreshPriceSyncHeight`, verbatim and UNCAPPED. This is the
// content clause's own input, and it is a different quantity from
// `mirrorNewestRound` above, whose `block_timestamp <= blockTime` filter is the
// price SELECTION and can never exceed the block's time.
async function mirrorMaxFinalizedTimestamp(conn, dbName) {
    const db = ident(dbName, 'database name');
    const rows = await conn.query(
        'SELECT MAX(block_timestamp) AS ts FROM `' + db + '`.price_snapshots ' +
        "WHERE status = 'finalized'");
    if (rows.length === 0) return null;
    return num(rows[0].ts);
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
 *
 * THE TRANSACTION HASH IS CARRIED (row 55). `action_index` and `tx_index` are
 * both per-node counters, so neither can name the same action on two nodes: on
 * the run that found this, origin numbered the very transaction this node called
 * `tx_index` 263 as 666. The hash is what the CHAIN supplies, so it is what the
 * comparison has to align on, and it lives one join away: `transactions` carries
 * `tx_hash_id` (there is no `tx_hash` column) into `index_transactions.hash`.
 * Both joins are LEFT, because an action whose transaction row cannot be reached
 * must still be reported, as one that cannot be aligned, rather than dropped.
 */
async function blockActions(conn, indexerDb, tables, height) {
    const db = ident(indexerDb, 'database name');
    const rows = await conn.query(
        'SELECT a.action_index, a.tx_index, a.tx_vout, ia.action AS action, itx.hash AS tx_hash ' +
        'FROM `' + db + '`.actions a JOIN `' + db + '`.index_actions ia ON ia.id = a.action_id ' +
        'LEFT JOIN `' + db + '`.transactions t ON t.tx_index = a.tx_index ' +
        'LEFT JOIN `' + db + '`.index_transactions itx ON itx.id = t.tx_hash_id ' +
        'WHERE a.block_index = ? ORDER BY a.tx_index, a.tx_vout', [height]);
    const byIndex = new Map();
    for (const r of rows) {
        byIndex.set(num(r.action_index), {
            actionIndex: num(r.action_index),
            action: String(r.action),
            txIndex: num(r.tx_index),
            txVout:  num(r.tx_vout),
            txHash:  r.tx_hash === null || r.tx_hash === undefined ? null : String(r.tx_hash),
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
 * SUPERSEDED by attributeEscape (row 56), kept because it is what run 5's result
 * file recorded and a reader comparing two runs needs to be able to reproduce it.
 * Its reading is carried in the record as `escapeEvidence.deferralLineReading`
 * and is NOT what `escape` reports any more. Two defects, both measured:
 *
 *   1. `none` means "no deferral LINE was seen", which is true both when the
 *      barrier was already open and when it opened silently inside one 60 s
 *      attempt. Run 5 returned it for 190 of 191 graded blocks, several of which
 *      had waited over an hour, so TA5's "never before the barrier permits" half
 *      could not be read off it at all.
 *   2. The `content` branch is unreachable against the drill's own input.
 *      `mirrorNewestRound` selects `WHERE block_timestamp <= blockTime`, so its
 *      timestamp is capped at blockTime by construction and `>= blockTime` can
 *      only ever fire on exact equality, while the clause it is standing in for
 *      reads an UNCAPPED `MAX(block_timestamp) WHERE status = 'finalized'`.
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

// A deferral line IS a sample of the barrier's two inputs: the indexer builds
// that message out of `priceSyncMaxTimestamp` and `streamWatermark` themselves
// (hub_db_sync.js:2221), at an instant the predicate was false. Folding it in as
// a sample keeps every reading in one model instead of two.
function barrierSampleFromDeferral(d) {
    if (!d) return null;
    return {
        at: finite(d.at),
        source: 'deferral',
        height: d.height === undefined ? null : d.height,
        // A node that has deferred a block has read its price mirror at least
        // once, which is exactly what priceBootstrapped records.
        bootstrapped: true,
        streamWatermark: finite(d.streamWatermark),
        priceSyncMaxTimestamp: finite(d.mirrorMaxRoundTs),
        error: null
    };
}

// How long the drill waits on one /status read. The endpoint is a local HTTP GET
// against this run's own node, so anything slower than this is the node being
// too busy to answer, and a missed sample must never stall the observe loop.
const STATUS_TIMEOUT_MS = 5_000;

/**
 * The barrier's two inputs, read from the node's own `/status`.
 *
 * `mirrorStatus()` fills `hubMirror.streamWatermark` from `this.streamWatermark`
 * and `hubMirror.tables.price_snapshots` from `this.priceSyncMaxTimestamp`, which
 * are the two fields `_priceTimeSyncSatisfied` reads. Nothing here re-derives the
 * barrier: it reads the barrier's own state and evaluates the shipped clauses.
 *
 * A failed read returns a sample carrying its error rather than throwing, because
 * a sampling gap must be visible in the record and must not end a four-hour run.
 *
 * NOTE ON `bootstrapped`. The predicate's third input is `priceBootstrapped`,
 * which `mirrorStatus()` does NOT publish (it reports `_bootstrapDrained`, a
 * different flag). It is recorded for the reader and gates no clause here:
 * both inputs start at 0, so a false clause cannot be turned true by
 * assuming the flag, and by the observe phase the node has been committing blocks
 * for hours, which it cannot do with `priceBootstrapped` unset.
 */
async function readBarrierState(indexerPort, source) {
    const at = nowS();
    const empty = {
        at: at, source: source || 'status', height: null, bootstrapped: null,
        streamWatermark: null, priceSyncMaxTimestamp: null,
        indexerBlock: null, stallReason: null, error: null
    };
    try {
        const res = await axios.get('http://127.0.0.1:' + indexerPort + '/status',
            { timeout: STATUS_TIMEOUT_MS, validateStatus: () => true });
        const body = (res && res.data) || {};
        const m = body.hubMirror;
        if (!m || m.configured !== true) {
            return Object.assign({}, empty, {
                error: 'no configured hubMirror in /status (HTTP ' + (res && res.status) + ')'
            });
        }
        return Object.assign({}, empty, {
            bootstrapped: m.bootstrapped === undefined ? null : !!m.bootstrapped,
            streamWatermark: finite(m.streamWatermark),
            priceSyncMaxTimestamp: finite(m.tables ? m.tables.price_snapshots : null),
            indexerBlock: finite(body.indexerBlock),
            stallReason: body.stallReason === undefined ? null : body.stallReason
        });
    } catch (e) {
        return Object.assign({}, empty, { error: String((e && e.message) || e).slice(0, 200) });
    }
}

/**
 * The two shipped clauses of `_priceTimeSyncSatisfied`, evaluated against one
 * sample of the barrier's state, for one block time.
 *
 *   content    priceSyncMaxTimestamp >= blockTime
 *   watermark  streamWatermark       >= blockTime + graceS
 *
 * Written once, here, so nothing downstream can invent a second definition of the
 * barrier. A missing reading is not a satisfied clause.
 */
function barrierClauses(sample, blockTime, graceS) {
    const max  = finite(sample && sample.priceSyncMaxTimestamp);
    const mark = finite(sample && sample.streamWatermark);
    const bt   = finite(blockTime);
    const g    = finite(graceS);
    return {
        content:   max  !== null && bt !== null && max  >= bt,
        watermark: mark !== null && bt !== null && g !== null && mark >= bt + g
    };
}

/**
 * WHICH ESCAPE OPENED THE BARRIER FOR ONE BLOCK (row 56).
 *
 * Pure, so it can be driven against a run's real samples without a chain. Walks
 * the samples taken at or before the block was seen processed, in time order, and
 * stops at the first one in which either shipped clause is true for this block's
 * time. That instant is when the barrier PERMITTED the block, and which clause
 * was true is the escape.
 *
 *   content    the node's own mirror held a finalized round at or past the
 *              block's time. D61 says a chain-only node cannot reach this at the
 *              tip, so it is the interesting result rather than the expected one.
 *   watermark  its hub's stream watermark had passed the block's time by the
 *              grace, which is the escape D61 predicts.
 *   both       both clauses were already true in the first open sample; the
 *              sampling cannot say which crossed first, and it says so.
 *   not-applicable  the block carried no transaction, so `blockMayReadPrice` was
 *              false and the indexer never entered the barrier for it. There is
 *              no escape to name, and the TA5 clause does not apply either.
 *   unknown    the samples cannot settle it, WITH the reason. Never `none`: a
 *              block nobody attributed must not read like a block that sailed
 *              through, which is the confusion this function exists to end.
 *
 * TWO RESOLUTIONS BOUND EVERY ANSWER, and both are recorded rather than assumed
 * away. `permittedAt` is an UPPER bound: the barrier opened somewhere in
 * (lastClosedAt, permittedAt], one sample interval wide. `processedAt` is also an
 * upper bound, because it is when the drill's poll DETECTED the node past this
 * height, not when the node committed it. So `beforePermission` is only ever
 * claimed as observed when a sample taken AFTER the block was already detected
 * processed still shows the barrier closed for it; anything narrower than that
 * would be reading the sampling grid rather than the node.
 */
function attributeEscape(s) {
    s = s || {};
    const blockTime   = finite(s.blockTime);
    const processedAt = finite(s.processedAt);
    const graceS      = finite(s.graceS) === null ? PRICE_WATERMARK_GRACE_S : finite(s.graceS);
    const intervalS   = finite(s.sampleIntervalS);
    const stallS      = (processedAt !== null && blockTime !== null) ? processedAt - blockTime : null;

    const samples = (s.samples || [])
        .filter((x) => x && finite(x.at) !== null)
        .slice()
        .sort((a, b) => finite(a.at) - finite(b.at));

    const out = {
        escape: 'unknown',
        corroborated: false,
        graceS: graceS,
        permittedAt: null,
        permittedAtIso: null,
        permittedBy: null,
        permittedAtIsUpperBound: null,
        openedBeforeFirstSample: null,
        lastClosedAt: null,
        lastClosedAtIso: null,
        beforePermission: 'unknown',
        samplesConsidered: 0,
        samplesTotal: samples.length,
        sampleIntervalS: intervalS,
        reason: null
    };

    if (blockTime === null || processedAt === null) {
        out.reason = 'the block time or the moment it was seen processed was not read, ' +
            'so the barrier cannot be evaluated for this block';
        return out;
    }

    // Asked BEFORE the samples, because a barrier the node never entered cannot
    // have held this block and must not be reported as having been closed across
    // it. Only an explicit false counts: an unread transaction count leaves the
    // question open rather than answering it either way.
    if (s.barrierApplies === false) {
        out.escape = 'not-applicable';
        out.beforePermission = 'not-applicable';
        out.reason = 'the block carried no transaction, so blockMayReadPrice was false and the ' +
            'indexer never entered the price time barrier for it: there is no escape to name';
        return out;
    }

    const upTo = samples.filter((x) => finite(x.at) <= processedAt);
    out.samplesConsidered = upTo.length;
    if (upTo.length === 0) {
        out.reason = samples.length === 0
            ? 'the barrier state was never sampled, so no escape can be attributed'
            : 'no barrier sample was taken at or before this block was seen processed (' +
              samples.length + ' later sample(s) only)';
        return out;
    }

    let lastClosedAt = null;
    for (let i = 0; i < upTo.length; i++) {
        const c = barrierClauses(upTo[i], blockTime, graceS);
        if (!c.content && !c.watermark) { lastClosedAt = finite(upTo[i].at); continue; }
        out.escape = (c.content && c.watermark) ? 'both' : (c.content ? 'content' : 'watermark');
        out.permittedAt = finite(upTo[i].at);
        out.permittedAtIso = iso(out.permittedAt);
        out.permittedBy = String(upTo[i].source || 'status');
        out.permittedAtIsUpperBound = true;
        out.openedBeforeFirstSample = (lastClosedAt === null);
        out.lastClosedAt = lastClosedAt;
        out.lastClosedAtIso = lastClosedAt === null ? null : iso(lastClosedAt);
        out.beforePermission = 'no';
        // A watermark escape cannot fire before the grace has elapsed against the
        // block's own time, so a stall shorter than that contradicts the reading
        // and the record says so instead of asserting it away. The content escape
        // has no such bound: a round at or past the block's time can land at any
        // moment, which is precisely what makes it the interesting case.
        out.corroborated = (out.escape === 'content')
            ? true
            : (stallS !== null && stallS >= graceS);
        out.reason = out.escape + ' escape observed open at ' + out.permittedAtIso +
            (out.openedBeforeFirstSample
                ? ', in the FIRST sample taken at or before this block was processed: ' +
                  'it may have opened earlier, so this instant is an upper bound only'
                : ', last observed closed at ' + out.lastClosedAtIso);
        return out;
    }

    out.lastClosedAt = lastClosedAt;
    out.lastClosedAtIso = lastClosedAt === null ? null : iso(lastClosedAt);
    const after = samples.find((x) => finite(x.at) > processedAt);
    const afterClauses = after ? barrierClauses(after, blockTime, graceS) : null;
    const closedAfter = !!afterClauses && !afterClauses.content && !afterClauses.watermark;
    if (closedAfter) {
        out.beforePermission = 'observed-closed-across-processing';
        out.reason = 'the barrier was observed CLOSED for this block at every sample up to ' +
            out.lastClosedAtIso + ' AND at ' + iso(finite(after.at)) + ', after the node was ' +
            'already seen past this height: the block was processed while neither shipped ' +
            'clause was satisfied for it';
        return out;
    }
    out.reason = 'the barrier was observed closed for this block at every sample up to ' +
        out.lastClosedAtIso + ' and ' +
        (after ? 'the next sample already showed it open, after the block was seen processed'
               : 'no sample was taken after the block was seen processed') +
        ', so which escape opened it was never observed';
    return out;
}

/**
 * The record shape for one block's escape, written from an attribution.
 *
 * Shared by the first pass (as the observation is built) and the run's final
 * pass, so the two can never disagree about what a field means. Nothing here
 * decides anything; the deciding is all in attributeEscape.
 */
function escapeRecord(attribution, deferrals, deferralLineEscape) {
    deferrals = deferrals || [];
    return {
        corroborated: attribution.corroborated,
        graceS: attribution.graceS === undefined ? null : attribution.graceS,
        reason: attribution.reason,
        // When the barrier was first OBSERVED open for this block, and when it was
        // last observed closed: the true crossing lies between the two.
        permittedAt: attribution.permittedAtIso,
        permittedBy: attribution.permittedBy,
        permittedAtIsUpperBound: attribution.permittedAtIsUpperBound,
        openedBeforeFirstSample: attribution.openedBeforeFirstSample,
        lastClosedAt: attribution.lastClosedAtIso,
        // 'no' | 'observed-closed-across-processing' | 'unknown'. This is the TA5
        // clause: was the block processed before the shipped predicate permitted
        // it? Only the middle value is a measurement of a violation.
        beforePermission: attribution.beforePermission,
        samplesConsidered: attribution.samplesConsidered,
        samplesTotal: attribution.samplesTotal,
        sampleIntervalS: attribution.sampleIntervalS,
        deferralCount: deferrals.length,
        firstDeferral: deferrals.length > 0 ? deferrals[0] : null,
        lastDeferral:  deferrals.length > 0 ? deferrals[deferrals.length - 1] : null,
        // What the superseded log-scraping attribution says for this same block,
        // so run 5's numbers stay reproducible beside the new ones.
        deferralLineReading: deferralLineEscape === undefined ? null : deferralLineEscape
    };
}

// ---------------------------------------------------------------------------
// The observe phase's own gate (row 46)
// ---------------------------------------------------------------------------

/**
 * Has the node stopped burning BACKLOG?
 *
 * Pure, and the only thing that ends the catch-up phase, so it can be driven
 * with real readings instead of being trusted after a four-hour run.
 *
 * Two ways to be done, and they are deliberately different shapes:
 *
 *   at-tip                 the node is within `slackBlocks` of the decoder tip.
 *                          This is the node whose barrier never held it: nothing
 *                          in the code guarantees a chain-only node reaches it,
 *                          and D61 says it will not, but a run that DID reach it
 *                          has caught up by any reading and must not be made to
 *                          wait for the second condition.
 *   barrier-working-point  the block the node is working on is no older than
 *                          `graceS + toleranceS`. That is the steady state the
 *                          watermark escape imposes: the node sits a grace
 *                          behind the chain and advances at chain rate. A node
 *                          still replaying is further back than that, and the
 *                          gap only closes when the backlog is gone.
 *
 * Both are UPPER bounds on how far back the node is, so neither can be
 * satisfied by a node that is still catching up, and a missing reading returns
 * `caughtUp: false` rather than defaulting to satisfied.
 */
function evaluateCatchUp(s) {
    s = s || {};
    const nodeHeight    = finite(s.nodeHeight);
    const decoderTip    = finite(s.decoderTip);
    const nodeBlockTime = finite(s.nodeBlockTime);
    const nowSec        = finite(s.nowSec);
    const slackBlocks   = finite(s.slackBlocks);
    const graceS        = finite(s.graceS);
    const toleranceS    = finite(s.toleranceS);

    const blocksBehind  = (nodeHeight !== null && decoderTip !== null) ? decoderTip - nodeHeight : null;
    const frontierAgeS  = (nodeBlockTime !== null && nowSec !== null) ? nowSec - nodeBlockTime : null;
    const workingPointS = (graceS !== null && toleranceS !== null) ? graceS + toleranceS : null;
    const base = { blocksBehind: blocksBehind, frontierAgeS: frontierAgeS, workingPointS: workingPointS };

    if (blocksBehind === null) {
        // Neither height could be read this round. Nothing is known, so nothing
        // is concluded.
        return Object.assign({ caughtUp: false, reason: 'unknown' }, base);
    }
    if (slackBlocks !== null && blocksBehind <= slackBlocks) {
        return Object.assign({ caughtUp: true, reason: 'at-tip' }, base);
    }
    if (frontierAgeS !== null && workingPointS !== null && frontierAgeS <= workingPointS) {
        return Object.assign({ caughtUp: true, reason: 'barrier-working-point' }, base);
    }
    return Object.assign({ caughtUp: false, reason: 'replaying-backlog' }, base);
}

/**
 * Did this block arrive LIVE, or was it already sitting in the decoder?
 *
 * `firstSeenAt` is when the drill's poll first found the block in the decoder,
 * so `firstSeenAt - blockTime` is the block's age at that moment: a handful of
 * seconds for a block that was just mined, and however long the node was busy
 * for one that was waiting. Only the first kind can carry a barrier
 * measurement, because the second one's barrier opened before the drill was
 * even looking.
 *
 *   live                        graded.
 *   stale-backlog               older than `maxAgeS` when first seen: the row 46
 *                               defect, recorded and NOT scored.
 *   block-time-ahead-of-clock   the block claims a time further in the future
 *                               than the tolerance allows. Coin headers may run
 *                               slightly ahead, but a large negative age means
 *                               this host's clock and the chain's disagree, and
 *                               every stall measured against that block time
 *                               would be wrong by the same amount.
 *   unknown-arrival             a reading was missing; nothing can be graded.
 */
function classifyBlockFreshness(s) {
    s = s || {};
    const blockTime   = finite(s.blockTime);
    const firstSeenAt = finite(s.firstSeenAt);
    const maxAgeS     = finite(s.maxAgeS);
    if (blockTime === null || firstSeenAt === null || maxAgeS === null) {
        return { ageAtFirstSeenS: null, usable: false, reason: 'unknown-arrival', maxAgeS: maxAgeS };
    }
    const age = firstSeenAt - blockTime;
    if (age > maxAgeS) {
        return { ageAtFirstSeenS: age, usable: false, reason: 'stale-backlog', maxAgeS: maxAgeS };
    }
    if (age < -maxAgeS) {
        return { ageAtFirstSeenS: age, usable: false, reason: 'block-time-ahead-of-clock', maxAgeS: maxAgeS };
    }
    return { ageAtFirstSeenS: age, usable: true, reason: 'live', maxAgeS: maxAgeS };
}

// The observations that may be scored. Written once and used by both the
// observe loop's stopping condition and the summary, so a run can never stop on
// a count the summary then grades differently.
// Verdicts actually COMPARED against origin so far. The parity clause is about
// comparisons, not blocks: six graded blocks carrying no action compare nothing
// and would read green while proving nothing.
function comparedVerdicts(observations) {
    return usableObservations(observations)
        .reduce((n, o) => n + o.actions.filter((a) => a.coordinateAligned).length, 0);
}

function usableObservations(observations) {
    return (observations || []).filter((o) => o && o.usable === true);
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
            priceGraceOverride: null,      // AT5 runs at the frozen value; see the header
            maxBlockAgeS: settings.maxBlockAgeS,
            catchUpSlackBlocks: settings.catchUpSlackBlocks,
            catchUpToleranceS: settings.catchUpToleranceS,
            originActionPage: settings.originActionPage
        },
        node: null,
        replay: null,
        catchUp: null,
        observe: null,
        // Every sample of the barrier's own two inputs taken during the observe
        // phase (row 56). This series IS the escape attribution's evidence: a
        // reader who does not accept the per-block verdict can re-run
        // attributeEscape over it.
        barrier: {
            graceS: PRICE_WATERMARK_GRACE_S,
            sampleIntervalS: POLL_MS / 1000,
            source: "the node's own GET /status: hubMirror.streamWatermark and " +
                    'hubMirror.tables.price_snapshots, which mirrorStatus() fills from ' +
                    'streamWatermark and priceSyncMaxTimestamp, the two inputs of ' +
                    '_priceTimeSyncSatisfied',
            startedAt: null,
            lastAt: null,
            samples: 0,
            failures: 0,
            lastError: null,
            series: []
        },
        observations: [],
        originLagSeries: [],
        summary: null
    };

    // Bounded the same way the deferral ring is: a four-hour run at one sample a
    // poll is about a thousand entries, and a run that overruns keeps its ends,
    // which is where the barrier's crossings are.
    const barrierSamples = [];
    const noteBarrierSample = (sample) => {
        if (!sample) return;
        barrierSamples.push(sample);
        // The working set only has to span one block's whole hold, which the
        // barrier caps at about a grace: two thousand samples is over eight hours
        // of them, so the oldest can go without ever reaching an attribution.
        if (barrierSamples.length > 2000) barrierSamples.shift();
        result.barrier.samples++;
        result.barrier.lastAt = iso(sample.at);
        if (result.barrier.startedAt === null) result.barrier.startedAt = iso(sample.at);
        if (sample.error) {
            result.barrier.failures++;
            result.barrier.lastError = sample.error;
        }
        result.barrier.series.push(sample);
        if (result.barrier.series.length > 5000) {
            result.barrier.series.splice(2500, result.barrier.series.length - 5000);
        }
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

        // --- 1b. converge on the LIVE tip before grading anything (row 46) ---
        //
        // `startTip` is where the chain was when the replay STARTED, and the
        // replay takes long enough that the chain has moved on by a hundred
        // blocks or more. Observing from here grades that movement, which was
        // already hours old and had cleared the barrier long before the node
        // arrived. So the node keeps chasing the tip it can currently see until
        // `evaluateCatchUp` says it has stopped burning backlog.
        const catchUp = {
            slackBlocks: settings.catchUpSlackBlocks,
            toleranceS:  settings.catchUpToleranceS,
            graceS:      PRICE_WATERMARK_GRACE_S,
            startedAt:   iso(nowS()),
            reachedAt:   null,
            durationS:   null,
            converged:   false,
            reason:      null,
            lastLegError: null,
            rounds:      []
        };
        result.catchUp = catchUp;
        const catchUpStartedAt = nowS();
        write();

        while (Date.now() < deadline) {
            const tipNow  = (await node.decoderHeight()).height;
            const atNow   = (await node.chainHeight()).height;
            // The block time of the block the NODE is on, off the decoder: the
            // chain's own clock for that height, never one this process computes.
            const frontier = atNow === null ? null
                : await decoderBlock(decoderConn, liveChain.decoder.name, atNow);
            const verdict = evaluateCatchUp({
                nodeHeight:    atNow,
                nodeBlockTime: frontier ? frontier.blockTime : null,
                decoderTip:    tipNow,
                nowSec:        nowS(),
                slackBlocks:   catchUp.slackBlocks,
                graceS:        PRICE_WATERMARK_GRACE_S,
                toleranceS:    catchUp.toleranceS
            });
            catchUp.rounds.push(Object.assign({ at: iso(nowS()), nodeHeight: atNow, decoderTip: tipNow }, verdict));
            // A long chase writes one round per leg; the first and last carry the
            // trajectory, so the middle is dropped rather than grown unbounded.
            if (catchUp.rounds.length > 200) catchUp.rounds.splice(100, catchUp.rounds.length - 200);
            write();
            console.log('at5: catch-up: node at ' + atNow + ', decoder tip ' + tipNow + ' (' +
                verdict.blocksBehind + ' behind, working block ' + verdict.frontierAgeS + 's old, ' +
                'working point ' + verdict.workingPointS + 's): ' + verdict.reason);
            if (verdict.caughtUp) {
                catchUp.converged = true;
                catchUp.reason = verdict.reason;
                break;
            }
            if (tipNow === null) { await sleep(POLL_MS); continue; }
            const legMs = Math.max(60_000, Math.min(CATCHUP_LEG_MS, deadline - Date.now()));
            try {
                await node.waitForHeight(tipNow, { timeoutMs: legMs, intervalMs: POLL_MS });
            } catch (e) {
                // Expected, and not a failure: under the barrier this node is held
                // about a grace behind the chain and can never reach the tip, so a
                // leg that expires is the normal shape of the working point. The
                // loop re-reads both heights and the test above decides.
                catchUp.lastLegError = String(e && e.message).slice(0, 400);
            }
        }
        if (!catchUp.converged) {
            catchUp.durationS = nowS() - catchUpStartedAt;
            result.status = 'catchup-timeout';
            result.error  = 'the node never reached the live tip or the barrier working point inside the budget' +
                (catchUp.lastLegError ? '; last leg: ' + catchUp.lastLegError : '');
            result.summary = summarize(result);
            console.error('at5: the node never caught up to the live chain inside the budget');
            exitCode = 2;
            return exitCode;
        }
        catchUp.reachedAt = iso(nowS());
        catchUp.durationS = nowS() - catchUpStartedAt;
        write();
        console.log('at5: caught up in ' + catchUp.durationS + 's (' + catchUp.reason + ')');

        // --- 2. observe the tip, block by block ---
        const tables = await verdictTables(conn, node.indexerDbName);
        const pending = new Map();      // height -> {blockTime, firstSeenAt}
        // Observation opens at the tip the decoder holds NOW, never at the one the
        // replay targeted: every height in between was mined while the replay and
        // the catch-up ran, and stamping those as newly arrived is precisely the
        // defect row 46 records. They are skipped, and the count of them is
        // recorded so the result says what was passed over rather than hiding it.
        const observeStartTip = (await node.decoderHeight()).height;
        let lastDecoderSeen = observeStartTip === null ? startTip : observeStartTip;
        result.observe = {
            startedAt: iso(nowS()),
            startTip: lastDecoderSeen,
            replayTargetTip: startTip,
            backlogSkipped: lastDecoderSeen - startTip,
            maxBlockAgeS: settings.maxBlockAgeS,
            wantedBlocks: settings.observeBlocks,
            gradedBlocks: 0,
            unusableBlocks: 0
        };
        write();
        console.log('at5: observing from tip ' + lastDecoderSeen + ' (skipping ' +
            result.observe.backlogSkipped + ' block(s) mined during the replay and catch-up); ' +
            'grading only blocks first seen within ' + settings.maxBlockAgeS + 's of their block time');

        const observeSatisfied = () =>
            usableObservations(result.observations).length >= settings.observeBlocks &&
            comparedVerdicts(result.observations) >= settings.minVerdicts;

        // The barrier's state, sampled once before the first block is even seen, so
        // a block that is processed on the very first tick still has a reading at
        // or before its processing rather than none at all (row 56).
        noteBarrierSample(await readBarrierState(node.indexerPort));
        write();

        while (!observeSatisfied() && Date.now() < deadline) {
            // The barrier's own two inputs, read before anything is declared
            // processed this tick so the sample is at or before every processedAt
            // this iteration stamps.
            noteBarrierSample(await readBarrierState(node.indexerPort));

            // New chain blocks: noted the moment the DECODER has them, which is
            // what makes waitS a measure of the node's own hold rather than of
            // how long the chain took to produce a block.
            const tip = (await node.decoderHeight()).height;
            for (let h = lastDecoderSeen + 1; h <= tip; h++) {
                const blk = await decoderBlock(decoderConn, liveChain.decoder.name, h);
                if (!blk) continue;
                // The clock the barrier will be asked about, resolved once, now:
                // the median window is over blocks the decoder already holds, so
                // it cannot change under this block later (row 56).
                const barrierTime = await resolveBarrierBlockTime(
                    decoderConn, liveChain.decoder.name, h, blk.blockTime, NETWORK, node.repoRoot);
                // And whether the barrier applies to it at all: an empty block
                // never enters it, so it can carry no escape.
                const txCount = await decoderBlockTransactionCount(
                    decoderConn, liveChain.decoder.name, h);
                pending.set(h, {
                    blockTime: blk.blockTime, firstSeenAt: nowS(),
                    barrierBlockTime: barrierTime.blockTime,
                    barrierBlockTimeSource: barrierTime.source,
                    blockTransactionCount: txCount
                });
                console.log('at5: chain block ' + h + ' arrived (block time ' + iso(blk.blockTime) +
                    ', barrier time ' + (barrierTime.blockTime === null ? 'UNKNOWN' : iso(barrierTime.blockTime)) +
                    ' by ' + barrierTime.source + ')');
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
                    barrierBlockTime: seen.barrierBlockTime,
                    barrierBlockTimeSource: seen.barrierBlockTimeSource,
                    blockTransactionCount: seen.blockTransactionCount,
                    deferrals: deferralsByHeight.get(h) || [],
                    // Passed by reference on purpose: the attribution reads the
                    // whole series, and a copy per block would be a thousand
                    // arrays for nothing.
                    barrierSamples: barrierSamples,
                    sampleIntervalS: POLL_MS / 1000,
                    originNow: originNow,
                    maxBlockAgeS: settings.maxBlockAgeS,
                    originActionPage: settings.originActionPage
                });
                result.observations.push(observation);
                const graded = usableObservations(result.observations).length;
                result.observe.gradedBlocks = graded;
                result.observe.unusableBlocks = result.observations.length - graded;
                write();
                console.log('at5: block ' + h + ' processed after ' + observation.stallS + 's of block time (' +
                    observation.escape + '), ' + observation.actions.length + ' action(s), ' +
                    observation.verdictAgreements + ' agreeing / ' + observation.verdictDisagreements.length +
                    ' diverging; ' + (observation.usable
                        ? 'GRADED (' + observation.ageAtFirstSeenS + 's old when first seen)'
                        : 'NOT GRADED: ' + observation.unusableReason + ' (' +
                          observation.ageAtFirstSeenS + 's old when first seen, limit ' +
                          settings.maxBlockAgeS + 's)') +
                    '; graded ' + graded + ' of ' + settings.observeBlocks +
                    ', verdicts compared ' + comparedVerdicts(result.observations) +
                    ' of ' + settings.minVerdicts);
                if (observeSatisfied()) break;
            }
            if (observeSatisfied()) break;
            await sleep(POLL_MS);
        }

        // --- 3. the final escape attribution (row 56) ---
        //
        // A block's escape is first decided the moment the drill sees the node
        // past its height, when no sample taken AFTER that instant exists yet. The
        // TA5 clause ("never processed before the barrier permits") can only be
        // OBSERVED against such a later sample: a barrier still closed for a block
        // the node has already committed is the only reading that proves a
        // violation, and no single-pass reading can supply it. So
        // every observation is re-decided here against the whole series, and the
        // record carries the settled reading.
        //
        // One last sample first, so the newest block observed has an "after" too.
        noteBarrierSample(await readBarrierState(node.indexerPort));
        let reattributed = 0;
        for (const o of result.observations) {
            const samples = barrierSamples.concat(
                (deferralsByHeight.get(o.height) || [])
                    .map(barrierSampleFromDeferral).filter((x) => x !== null));
            const a = attributeEscape({
                // The clock the barrier gates on, resolved when the block was
                // first seen, NOT the chain's raw stamp.
                blockTime: o.barrierBlockTime,
                processedAt: o.processedAtS,
                samples: samples,
                graceS: PRICE_WATERMARK_GRACE_S,
                barrierApplies: o.barrierApplies === null ? undefined : o.barrierApplies,
                sampleIntervalS: POLL_MS / 1000
            });
            const before = o.escape;
            o.escape = a.escape;
            o.escapeEvidence = escapeRecord(a, deferralsByHeight.get(o.height) || [],
                o.escapeEvidence ? o.escapeEvidence.deferralLineReading : null);
            if (before !== o.escape) reattributed++;
        }
        result.barrier.reattributedBlocks = reattributed;
        write();
        console.log('at5: final escape attribution over ' + result.barrier.samples +
            ' barrier sample(s): ' + reattributed + ' of ' + result.observations.length +
            ' observation(s) changed verdict against the first pass');

        const gradedTotal = usableObservations(result.observations).length;
        result.observe.gradedBlocks = gradedTotal;
        result.observe.unusableBlocks = result.observations.length - gradedTotal;
        const comparedTotal = comparedVerdicts(result.observations);
        result.observe.verdictsCompared = comparedTotal;
        result.observe.wantedVerdicts   = settings.minVerdicts;
        if (gradedTotal >= settings.observeBlocks && comparedTotal >= settings.minVerdicts) {
            result.status = 'completed';
            exitCode = 0;
        } else if (gradedTotal >= settings.observeBlocks && comparedTotal < settings.minVerdicts) {
            // The blocks graded fine; the chain simply carried no action to compare.
            // Saying so beats a green run whose parity clause measured nothing.
            result.status = 'insufficient-parity-traffic';
            result.error  = 'graded ' + gradedTotal + ' block(s) but compared only ' + comparedTotal +
                ' verdict(s) against origin, under the ' + settings.minVerdicts + ' this run required';
            console.error('at5: graded enough blocks but the chain carried too few actions to compare verdicts');
            exitCode = 4;
        } else if (gradedTotal === 0) {
            // LOUD, because this is the run 3 shape: blocks were observed and not
            // one of them arrived live, so there is no barrier measurement here at
            // all and a zero exit would report a backlog as a result.
            result.status = 'no-live-blocks-observed';
            result.error  = 'observed ' + result.observations.length + ' block(s), none of which arrived within ' +
                settings.maxBlockAgeS + 's of its block time, so none could be graded';
            console.error('at5: NOTHING was graded: every observed block was already stale when first seen');
            exitCode = 3;
        } else {
            result.status = 'budget-exhausted';
            exitCode = 0;
        }
        result.summary = summarize(result);
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

// Origin's action window, or a named reason there is none. An origin view that
// cannot supply one yields an EMPTY window rather than an exception, so every
// action in the block is refused with `origin-actions-unavailable` and the
// result says so: a missing window must read as nothing compared, never as a
// crashed observation and never as agreement.
async function readOriginWindow(origin, limit) {
    if (!origin || typeof origin.recentActions !== 'function') {
        return { rows: [], error: 'origin view exposes no recentActions()', limit: null };
    }
    return origin.recentActions(limit);
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

    // Whether this block may be SCORED at all, decided before anything is
    // measured about it: a block that was already old when the drill first saw
    // it carries a stall that is mostly its own age, and reporting that number as
    // a barrier wait is the defect row 46 records.
    const freshness = classifyBlockFreshness({
        blockTime: blockTime, firstSeenAt: firstSeenAt, maxAgeS: ctx.maxBlockAgeS
    });

    const mirrorNewest = await mirrorNewestRound(conn, node.mirrorDbName, blockTime);
    const hubNewest    = await mirrorNewestRound(conn, node.hubDbName, blockTime);
    const originNewest = await origin.newestRoundAtOrBefore(blockTime);
    const stallS = processedAt - blockTime;

    // WHICH ESCAPE OPENED THIS BLOCK (row 56). Decided from samples of the
    // barrier's own two inputs, against the clock the barrier gates on, and the
    // deferral lines are folded in as samples of the same pair rather than read
    // as a separate kind of evidence.
    //
    // `barrierBlockTime` is the protocol time (see resolveBarrierBlockTime); it
    // is passed in because it costs a decoder read and is resolved once, when the
    // block is first seen. A caller that does not supply one is taken to be on a
    // venue where protocol time IS the raw stamp, and the record says so rather
    // than leaving the assumption implicit.
    const barrierBlockTime = ctx.barrierBlockTime === undefined || ctx.barrierBlockTime === null
        ? blockTime : finite(ctx.barrierBlockTime);
    const barrierBlockTimeSource = ctx.barrierBlockTimeSource || 'raw-assumed';
    const samples = (ctx.barrierSamples || [])
        .concat((deferrals || []).map(barrierSampleFromDeferral).filter((x) => x !== null));
    // Whether the barrier applied to this block at all. Undefined (a caller that
    // did not read the count) leaves the question open; only a measured zero says
    // the node never entered the barrier.
    const txCount = ctx.blockTransactionCount === undefined ? null : finite(ctx.blockTransactionCount);
    const escape = attributeEscape({
        blockTime: barrierBlockTime, processedAt: processedAt,
        samples: samples, graceS: PRICE_WATERMARK_GRACE_S,
        barrierApplies: txCount === null ? undefined : txCount > 0,
        sampleIntervalS: ctx.sampleIntervalS === undefined ? null : ctx.sampleIntervalS
    });
    // What the superseded log-scraping attribution would have said for this same
    // block, so run 5's numbers stay reproducible beside the new ones.
    const deferralLineReading = classifyEscape(deferrals, mirrorNewest.blockTimestamp, blockTime, stallS);
    // The content clause's OWN input, read the way the indexer reads it
    // (`_refreshPriceSyncHeight`): uncapped, unlike `mirrorNewestRound` above,
    // which is the price SELECTION and caps at blockTime by construction.
    const mirrorMaxFinalizedTs = await mirrorMaxFinalizedTimestamp(conn, node.mirrorDbName);

    const actions = await blockActions(conn, node.indexerDbName, tables, height);
    // Origin's window is read ONCE per block, and only for a block that carries
    // something to align: the per-block filter this endpoint appears to offer is
    // ignored server-side, so asking per action would be N requests for the same
    // answer, and most blocks on this chain carry no action at all.
    const originList  = actions.length > 0
        ? await readOriginWindow(origin, ctx.originActionPage)
        : { rows: [], error: null, limit: null };
    const originIndex = buildOriginActionIndex(originList.rows);
    const rows = [];
    let agreements = 0;
    const disagreements = [];
    for (const a of actions) {
        const statuses = [...new Set(a.verdicts.map((v) => v.status))];
        const nodeStatus = statuses.length === 1 ? statuses[0]
            : (statuses.length === 0 ? null : a.verdicts.map((v) => v.table + '=' + v.status).join(' | '));
        // The same action on the chain, or two nodes' bookkeeping? Decided on
        // tx_hash and tx_vout, which the chain supplies, never on either side's
        // counters (row 55). A pair that cannot be aligned is reported with its
        // reason and counted neither way.
        const match = alignOnTxHash(a, originIndex, height);
        // Only now, and only with ORIGIN's own index, is origin's verdict read.
        const o = match.aligned ? await origin.action(match.origin.actionIndex)
            : { found: false, status: null, blockIndex: null, txIndex: null };
        const aligned = match.aligned && o.found;
        const agree = aligned && nodeStatus !== null && o.status !== null && nodeStatus === o.status;
        if (agree) agreements++;
        else if (aligned) {
            disagreements.push({
                actionIndex: a.actionIndex, action: a.action,
                txHash: a.txHash, originActionIndex: match.origin.actionIndex,
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
            // The chain's own coordinate, and beside it the two counters that
            // cannot align: a reader can see the skew (origin 666 against the
            // node's 263 for one transaction) instead of inferring it.
            txHash: a.txHash,
            originActionIndex: match.aligned ? match.origin.actionIndex : null,
            originTxIndex: match.aligned ? match.origin.txIndex : null,
            alignment: match.reason,
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
        // The same instant as a number, because the run's final attribution pass
        // re-decides the escape from it and must not re-parse its own ISO string.
        processedAtS: processedAt,
        // THE CLOCK THE BARRIER GATES ON, beside the chain's raw stamp (row 56).
        // `stallS` below is kept measured against the RAW stamp so every number a
        // previous run reported still means what it meant; `barrierStallS` is the
        // same wait measured against the time the node actually compared, which is
        // the one the 4,800 s grace is a bound on. Run 5's whole graded set missed
        // that bound by up to 206 s purely because of this difference.
        barrierBlockTime: barrierBlockTime,
        barrierBlockTimeIso: barrierBlockTime === null ? null : iso(barrierBlockTime),
        barrierBlockTimeSource: barrierBlockTimeSource,
        protocolTimeLagS: (barrierBlockTime === null || blockTime === null)
            ? null : blockTime - barrierBlockTime,
        barrierStallS: barrierBlockTime === null ? null : processedAt - barrierBlockTime,
        // The decoder's own transaction count for the block, which IS
        // `blockMayReadPrice`: zero means the node never entered the barrier.
        blockTransactionCount: txCount,
        barrierApplies: txCount === null ? null : txCount > 0,
        stallS: stallS,
        waitS: processedAt - firstSeenAt,
        // The row 46 gate. `usable` says whether `stallS` is a barrier
        // measurement or just this block's age, and the summary scores only the
        // observations where it is true.
        ageAtFirstSeenS: freshness.ageAtFirstSeenS,
        usable: freshness.usable,
        unusableReason: freshness.usable ? null : freshness.reason,
        maxBlockAgeS: freshness.maxAgeS,
        // 'content' | 'watermark' | 'both' | 'unknown'. NEVER 'none': a block the
        // samples could not settle carries its reason in `escapeEvidence.reason`
        // and is counted as unattributed, because reading it as an instant pass is
        // what left TA5's "never before the barrier permits" half unmeasured.
        escape: escape.escape,
        escapeEvidence: escapeRecord(escape, deferrals, deferralLineReading.escape),
        mirrorNewestRound: mirrorNewest.round,
        mirrorNewestRoundTs: mirrorNewest.blockTimestamp,
        // The content clause's input, uncapped, beside the capped selection above:
        // run 5's result carried only the capped one, and comparing it against
        // blockTime is what made the old content branch unreachable.
        mirrorMaxFinalizedTs: mirrorMaxFinalizedTs,
        hubNewestRound: hubNewest.round,
        originNewestRound: originNewest.round,
        originNewestRoundTs: originNewest.blockTimestamp,
        roundGapVsOrigin: (originNewest.round !== null && mirrorNewest.round !== null)
            ? originNewest.round - mirrorNewest.round : null,
        originLagAtProcess: originNow && originNow.lag !== undefined ? originNow.lag : null,
        originTipAtProcess: originNow && originNow.blockIndex !== undefined ? originNow.blockIndex : null,
        holes: await batchCoverage(conn, node.indexerDbName, node.hubDbName, node.mirrorDbName),
        actions: rows,
        // What the alignment had to work with, so a block that compared nothing
        // says WHY: too short a window, origin behind this height, or a chain that
        // genuinely files the transaction elsewhere (row 55).
        originActions: {
            rowsRead: originIndex.rowCount,
            limit: originList.limit,
            error: originList.error,
            oldestBlock: originIndex.oldestBlock,
            newestBlock: originIndex.newestBlock,
            coversThisBlock: originIndex.oldestBlock !== null &&
                height >= originIndex.oldestBlock && height <= originIndex.newestBlock
        },
        alignmentReasons: rows.reduce((h, r) => {
            const k = String(r.alignment || 'unknown');
            h[k] = (h[k] || 0) + 1;
            return h;
        }, {}),
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
    // The row 46 split. Everything above is over EVERY observation, unchanged;
    // everything below is over the ones that arrived live and may therefore
    // carry a barrier number at all.
    const graded = usableObservations(obs);
    const unusable = obs.filter((o) => !(o && o.usable === true));
    const gradedStalls = graded.map((o) => o.stallS).filter((n) => Number.isFinite(n));
    const ages = obs.map((o) => o && o.ageAtFirstSeenS).filter((n) => Number.isFinite(n));
    return {
        blocksObserved: obs.length,
        maxStallS: stalls.length > 0 ? Math.max(...stalls) : null,
        minStallS: stalls.length > 0 ? Math.min(...stalls) : null,
        escapes: escapes,
        // The bound TA5 was reworded to (D62): the watermark escape cannot open
        // before the grace, and nothing observed may claim to have opened earlier.
        stallsWithinGracePlusConfirm: stalls.filter((s) => s >= PRICE_WATERMARK_GRACE_S).length,
        // Whether the run measured the BARRIER at all. A run that graded nothing
        // observed a backlog, whatever the numbers above say, and TA5's bound
        // clause cannot be read off it (row 46).
        barrierMeasured: graded.length > 0,
        blocksGraded: graded.length,
        blocksUnusable: unusable.length,
        unusableReasons: unusable.reduce((h, o) => {
            const k = String((o && o.unusableReason) || 'unknown');
            h[k] = (h[k] || 0) + 1;
            return h;
        }, {}),
        maxAgeAtFirstSeenS: ages.length > 0 ? Math.max(...ages) : null,
        gradedEscapes: graded.reduce((h, o) => { h[o.escape] = (h[o.escape] || 0) + 1; return h; }, {}),
        // THE ROW 56 NUMBERS. `gradedEscapesAttributed` is how many graded blocks
        // the samples could name an escape for; the rest carry their reason. A run
        // whose attribution rate is low has not measured TA5's escape half,
        // whatever its stall numbers say, and this is where that shows.
        // Counted over the blocks the barrier ACTUALLY GATED. A transaction-free
        // block never enters it (blockMayReadPrice), so counting it either way
        // would drown the measurement: on this chain the empty blocks are the
        // overwhelming majority, and run 5's 290 contained exactly one that the
        // barrier ever held.
        gradedBarrierApplied: graded.filter((o) => o.barrierApplies === true).length,
        gradedBarrierNotApplicable: graded.filter((o) => o.escape === 'not-applicable').length,
        gradedBarrierApplicabilityUnread: graded.filter((o) => o.barrierApplies === null ||
            o.barrierApplies === undefined).length,
        gradedEscapesAttributed: graded.filter((o) => o.barrierApplies === true &&
            ['content', 'watermark', 'both'].includes(o.escape)).length,
        gradedEscapesUnattributed: graded.filter((o) => o.barrierApplies === true &&
            (!o.escape || o.escape === 'unknown')).length,
        escapeAttributionMeasured: graded.some((o) => o.barrierApplies === true) &&
            graded.filter((o) => o.barrierApplies === true)
                  .every((o) => ['content', 'watermark', 'both'].includes(o.escape)),
        // Why the unattributed ones could not be settled, so a gap in the sampling
        // and a barrier observed closed across processing are never one number.
        unattributedReasons: graded
            .filter((o) => o.barrierApplies === true && (!o.escape || o.escape === 'unknown'))
            .reduce((h, o) => {
                const k = String((o.escapeEvidence && o.escapeEvidence.beforePermission) || 'unknown');
                h[k] = (h[k] || 0) + 1;
                return h;
            }, {}),
        // TA5's second half, as a count rather than a claim: graded blocks the
        // node was seen past while the shipped predicate was still observed false
        // for them. Anything but 0 is the bound broken, and it is only ever
        // counted from a sample taken AFTER the block was seen processed.
        gradedProcessedBeforePermission: graded.filter((o) =>
            o.escapeEvidence && o.escapeEvidence.beforePermission === 'observed-closed-across-processing').length,
        // A watermark escape claiming to have opened before the grace elapsed.
        gradedEscapesUncorroborated: graded.filter((o) =>
            o.escape && o.escape !== 'unknown' && o.escapeEvidence &&
            o.escapeEvidence.corroborated === false).length,
        barrierSamples: result.barrier ? result.barrier.samples : null,
        barrierSampleFailures: result.barrier ? result.barrier.failures : null,
        // THE GRACE BOUND, MEASURED ON THE CLOCK THE BARRIER USES.
        // `gradedStallsWithinGracePlusConfirm` above is measured against the
        // chain's raw stamp and is kept unchanged so a previous run's number still
        // means what it meant; this one is measured against the protocol time the
        // node actually compared. Run 5 reported 0 of 290 on the raw stamp with a
        // maximum stall of 4,607 s, which is the 4,800 s grace minus the MTP lag,
        // not a barrier that opened early.
        gradedBarrierStallsWithinGrace: graded.filter((o) =>
            Number.isFinite(o.barrierStallS) && o.barrierStallS >= PRICE_WATERMARK_GRACE_S).length,
        gradedMaxBarrierStallS: (() => {
            const v = graded.map((o) => o.barrierStallS).filter((n) => Number.isFinite(n));
            return v.length > 0 ? Math.max(...v) : null;
        })(),
        // How the barrier clock was resolved for each graded block, so a run whose
        // protocol_time module could not be loaded cannot read as a measurement.
        barrierClockSources: graded.reduce((h, o) => {
            const k = String(o.barrierBlockTimeSource || 'unknown');
            h[k] = (h[k] || 0) + 1;
            return h;
        }, {}),
        maxProtocolTimeLagS: (() => {
            const v = graded.map((o) => o.protocolTimeLagS).filter((n) => Number.isFinite(n));
            return v.length > 0 ? Math.max(...v) : null;
        })(),
        gradedMaxStallS: gradedStalls.length > 0 ? Math.max(...gradedStalls) : null,
        gradedMinStallS: gradedStalls.length > 0 ? Math.min(...gradedStalls) : null,
        // The same bound as `stallsWithinGracePlusConfirm`, over the blocks whose
        // stall is a wait rather than an age. This is the number TA5 reads.
        gradedStallsWithinGracePlusConfirm: gradedStalls.filter((s) => s >= PRICE_WATERMARK_GRACE_S).length,
        holesTotal: holes ? (holes.missingFromHub.count + holes.missingFromMirror.count) : null,
        holesInHub: holes ? holes.missingFromHub.count : null,
        holesInMirror: holes ? holes.missingFromMirror.count : null,
        roundsCarriedByParsedBatches: holes ? holes.roundsCarried : null,
        verdictsCompared: obs.reduce((n, o) => n + o.actions.filter((a) => a.coordinateAligned).length, 0),
        // Why the pairs that were NOT compared were refused (row 55). A run that
        // compares nothing must name the reason: run 5 compared 0 of 20 and the
        // result said only `coordinateAligned: false`, which cost a re-measurement
        // by hand to turn into a cause.
        alignmentReasons: obs.reduce((h, o) => {
            for (const [k, n] of Object.entries((o && o.alignmentReasons) || {})) h[k] = (h[k] || 0) + n;
            return h;
        }, {}),
        actionsSeen: obs.reduce((n, o) => n + ((o && o.actions) || []).length, 0),
        verdictsAgreed: obs.reduce((n, o) => n + o.verdictAgreements, 0),
        verdictsDiverged: obs.reduce((n, o) => n + o.verdictDisagreements.length, 0),
        divergences: obs.reduce((all, o) => all.concat(o.verdictDisagreements), []).slice(0, 50),
        // How the observe phase came to be pointed at live blocks, so a reader can
        // see whether the node was at the tip or at the barrier's working point
        // when the grading started, and how much backlog was passed over.
        caughtUpBy: result.catchUp ? result.catchUp.reason : null,
        catchUpS: result.catchUp ? result.catchUp.durationS : null,
        backlogSkipped: result.observe ? result.observe.backlogSkipped : null,
        originLagSamples: lags.length,
        originMaxLag: lags.length > 0 ? Math.max(...lags) : null,
        originIndexerUnavailable: (result.originLagSeries || []).some((s) => s.unavailable)
            ? (result.originLagSeries.find((s) => s.unavailable) || {}).unavailable : null
    };
}

module.exports = {
    composeLiveChainFromEnv, readSettings, classifyEscape, parseDeferral, summarize, main,
    // The observe phase's gate (row 46), exported because it is the whole of the
    // difference between measuring the barrier and measuring a backlog: it is
    // pure, it is driven with real readings by
    // test/unit/oracleBatchBarrierTestnet.observe.test.js, and a run that gets it
    // wrong costs four hours to find out.
    evaluateCatchUp, classifyBlockFreshness, usableObservations, observeBlock,
    // The escape attribution (row 56). `attributeEscape` and `barrierClauses` are
    // pure and are driven against run 5's own readings by
    // test/unit/oracleBatchBarrierEscape.test.js; `readBarrierState` is the one
    // half that reads someone else's HTTP, so it is exported to be driven on its
    // own against a real /status. The version they replace scraped a log line the
    // indexer only prints on a barrier TIMEOUT, and attributed 1 of run 5's 191
    // graded blocks.
    attributeEscape, barrierClauses, barrierSampleFromDeferral, readBarrierState,
    mirrorMaxFinalizedTimestamp, escapeRecord, decoderBlockTransactionCount,
    // The clock the barrier gates on, resolved through the SHIPPED protocol_time
    // module. Exported so a venue can check which clock a run will reason about
    // before spending four hours reasoning about the wrong one.
    loadProtocolTime, previousBlockTimes, resolveBarrierBlockTime,
    // The parity clause's own gate: comparisons, not blocks. A run that grades its
    // block quota while comparing nothing reads green and proves nothing.
    comparedVerdicts,
    // The predicate every comparison in a four-hour run turns on (row 55). It is
    // pure and it is driven with the real shapes both sides return by
    // test/unit/oracleBatchBarrierTestnetAlignment.test.js: the version it
    // replaces compared two per-node counters and discarded 20 of 20 real pairs.
    buildOriginActionIndex, alignOnTxHash,
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
