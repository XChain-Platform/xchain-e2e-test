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
// LIMIT OF THIS APPROACH: a seeded row is written already-effective, which
// bypasses the 24-hour activation delay every real PRICE v1 publish carries
// (xchain-hub PriceAggregator applies block_time + 86400 unconditionally, first
// publish included; verified live). So these tests exercise SETTLEMENT
// faithfully but say nothing about activation timing. A test that published for
// real would have to advance 24h of chain time (mock-time driver territory).
//
// WHY SEED RATHER THAN PUBLISH ON-CHAIN: a PRICE v1 tx is recorded by the
// indexer into its local `prices` table and pushed to the hub, which aggregates
// it into `oracle_prices`; hub_db_sync then mirrors that table back. Both legs
// need HUB_API_URL, which the single-host regtest stack does not set, so a
// published v1 quote never reaches `oracle_prices` here. price.test.js proves
// the on-chain record + validation contract; this helper covers the consumption
// half. A stack with the hub round trip wired can drop the seed and publish for
// real, which is the fuller test.

const topology = require('./hubMirrorTopology')

// See hubMirrorTopology for the three database roles. The short version: seeding
// and reading are the same database only while no mirror is carrying rows, and
// the read side is the indexer's hubDb rather than its own DB whenever one is
// configured.
const resolveParams = topology.seedParams

const indexerReadParams = topology.readParams

const seedsThroughMirror = topology.seedsThroughMirror

module.exports = {
    seedsThroughMirror,

    // Exposed for tests: where this helper writes (the hub, once a mirror is in
    // play) versus where settlement reads (the mirror).
    seedTarget: resolveParams,
    readTarget: indexerReadParams,

    // . Block until a seeded quote has been MIRRORED into the copy
    // reverse-matching actually reads, which is the indexer's hubDb once one is
    // configured and its own DB otherwise.
    //
    // On the single-host stack this returns immediately: seeding wrote straight
    // into the indexer's DB, so there is nothing to replicate and the check is a
    // no-op. It earns its keep only once HUB_DB_NAME + HUB_DB_SYNC_ENABLED are
    // set, where the seed lands in the HUB's table and hub_db_sync carries it
    // down on its own schedule. Without this wait a test would broadcast its
    // payment the instant the seed returned and race the sync, settling
    // 'invalid: no matching oracle price' intermittently: the exact flake the
    //  recipe warns about, and one that would look like a product bug
    // rather than a harness one.
    //
    // Polls rather than sleeps a fixed interval, so it costs nothing when the
    // mirror is prompt and still reports honestly when it is not.
    async waitForMirror({ sourceAddress, coin, tick, fiat, actionIndex, timeoutMs = 30000, pollMs = 500 }){
        topology.assertCoherent()
        if (!seedsThroughMirror()) return { mirrored: true, waitedMs: 0, skipped: true }
        let params = indexerReadParams()
        if (!params) throw new Error('oraclePriceHelper.waitForMirror: no indexer database configured')
        let started = Date.now()
        let conn = null
        try {
            conn = await mariadb.createConnection(params)
            for (;;){
                let rows = await conn.query(
                    "SELECT 1 FROM oracle_prices WHERE source_address = ? AND coin = ? AND tick = ? AND fiat = ?"
                    + (actionIndex === undefined ? "" : " AND action_index = ?") + " LIMIT 1",
                    actionIndex === undefined
                        ? [sourceAddress, coin, tick, fiat]
                        : [sourceAddress, coin, tick, fiat, actionIndex])
                if (rows && rows.length) return { mirrored: true, waitedMs: Date.now() - started, skipped: false }
                if (Date.now() - started > timeoutMs){
                    // Fail loud and specific. A silent give-up here would surface
                    // downstream as a dispense settling 'invalid', which reads as
                    // a consensus bug rather than an un-replicated fixture.
                    throw new Error(
                        `oraclePriceHelper.waitForMirror: quote ${coin}/${tick}/${fiat} for ${sourceAddress} `
                        + `did not reach the indexer's oracle_prices within ${timeoutMs}ms. `
                        + `hub_db_sync is behind or not running (check HUB_API_URL + HUB_DB_SYNC_ENABLED).`)
                }
                await new Promise(r => setTimeout(r, pollMs))
            }
        } finally {
            if (conn) await conn.end().catch(() => {})
        }
    },

    // True when oracle_prices is reachable everywhere the suite needs it: the
    // database it seeds into AND the one settlement reads from. Probing only the
    // seed target would report available on a mirror topology whose read side is
    // unreachable, and every Mode B case would then fail rather than skip.
    async isAvailable(){
        let targets = topology.clearTargets()
        if (!targets.length) return false
        for (let params of targets){
            let conn = null
            try {
                conn = await mariadb.createConnection(params)
                await conn.query("SELECT 1 FROM oracle_prices LIMIT 1")
            } catch (err){
                console.log("oraclePriceHelper: oracle_prices not available in "
                    + params.database + " -", err.message)
                return false
            } finally {
                if (conn) await conn.end().catch(() => {})
            }
        }
        return true
    },

    // Drop every quote for one (source_address, coin, tick, fiat) so a freshly
    // seeded row is the only one the reverse-match can select.
    //
    // Clears the seed AND read databases, for the reason spelled out on
    // priceSnapshotHelper.clearPair: a plain DELETE upstream is not replicated,
    // so clearing only the hub's copy leaves a stale mirrored quote that
    // settlement will happily match.
    async clearQuotes({ sourceAddress, coin, tick, fiat }){
        for (let params of topology.clearTargets()){
            let conn = await mariadb.createConnection(params)
            try {
                await conn.query(
                    "DELETE FROM oracle_prices WHERE source_address = ? AND coin = ? AND tick = ? AND fiat = ?",
                    [sourceAddress, coin, tick, fiat])
            } finally {
                await conn.end().catch(() => {})
            }
        }
    },

    // . Publish a quote through the HUB'S OWN write path instead of writing
    // a row, which is the only way a fixture can reach a mirror.
    //
    // A raw INSERT into the hub's database does not replicate: HubDbBroadcaster
    // fires only from the hub's own write paths, and the consumer's gap-detection
    // catch-up reads `_readyMaxIds`, set only on the WebSocket `ready` handshake
    // and consumed inside `_bootstrapTable`. So an out-of-band row lands in a
    // mirror at the next reconnect and not before. `pushoracleprice` goes through
    // PriceAggregator, which upserts and then emits `row:inserted`
    // (XChainHub.js:126 forwards it to the broadcaster), so a quote pushed here
    // streams to every subscribed indexer exactly as a real one does.
    //
    // blockTime is the SOURCE action's block time, and the hub derives
    // effective_at from it as blockTime + 86400, unconditionally (§5.4). Passing a
    // back-dated blockTime is therefore how a test gets an ALREADY-EFFECTIVE quote
    // without a mock-time driver: 25h back yields a quote that became effective an
    // hour ago. This is faithful rather than a cheat, since reverse matching walks
    // back from the payment block's own time and cannot tell how the row aged.
    async pushQuoteViaHub({ sourceAddress, sourceChain, coin, tick, fiat, value, fee, blockTime, actionIndex, memo, pushGeneration }){
        if (!global.hubConnector) throw new Error('oraclePriceHelper.pushQuoteViaHub: no hubConnector; the hub is unreachable from this venue')
        // The hub's upsert is generation-FENCED: an equal-or-lower push_generation
        // is refused as a duplicate rather than applied. The raw-INSERT path can
        // ignore this because its ON DUPLICATE KEY UPDATE refreshes every column
        // unconditionally, but here a re-run would be rejected outright.
        //
        // It bites because the fixtures reuse a FIXED synthetic action_index while
        // drawing a FRESH source_address each run, and the unique key is
        // (source_chain, action_index): clearQuotes() deletes by address and so
        // cannot see the previous run's row. Advance past whatever is actually
        // there, which makes a re-push a supersede instead of a duplicate.
        if (pushGeneration === undefined){
            pushGeneration = (await module.exports.currentPushGeneration({
                sourceChain: sourceChain || 'BTC', actionIndex
            })) + 1
        }
        let result = await global.hubConnector._call({
            jsonrpc: '2.0', id: 1, method: 'pushoracleprice',
            params: {
                source_chain:    sourceChain || 'BTC',
                source_address:  sourceAddress,
                coin:            coin,
                tick:            tick,
                fiat:            fiat,
                value:           value,
                fee:             fee || '0',
                memo:            memo || 'e2e hub-pushed oracle quote',
                block_time:      blockTime,
                action_index:    actionIndex,
                push_generation: pushGeneration || 0
            }
        }, 15000)
        if (!result) throw new Error('oraclePriceHelper.pushQuoteViaHub: hub returned no result (unreachable or degraded)')
        if (result.error) throw new Error('oraclePriceHelper.pushQuoteViaHub: hub rejected the push: ' + result.error)
        // A duplicate is a stale row from an earlier run at the same synthetic
        // action_index, and the generation-monotonic upsert refuses to overwrite
        // it. Silently accepting one would price the test against the PREVIOUS
        // run's value.
        if (result.accepted === false) throw new Error(
            'oraclePriceHelper.pushQuoteViaHub: hub did not accept the quote (' + (result.reason || 'unknown')
            + '). A "duplicate" here means a row already exists at action_index ' + actionIndex
            + ' with a push_generation at or above ' + pushGeneration + '.')
        return result
    },

    // Highest push_generation a new push must exceed, or -1 when nothing
    // constrains it so the caller's +1 starts at 0. Read from the HUB's own copy,
    // since that is what the aggregator fences against.
    //
    // TWO fences, not one, and missing the second is easy. Besides the
    // generation-monotonic upsert on an existing row, `receiveOraclePrice` first
    // consults `price_ingest_watermarks`: a push is refused as
    // 'stale (retracted generation)' when its generation is at or below the
    // chain's recorded retraction_generation AND its action_index falls at or
    // above from_action_index. The fixtures use deliberately huge synthetic
    // action_index values, so they sit above any real orphan range by
    // construction and the second condition is effectively always true. Once any
    // reorg retraction has been recorded on this chain, a generation-0 push would
    // therefore be rejected even with no row present at all.
    async currentPushGeneration({ sourceChain, actionIndex }){
        let params = topology.seedParams()
        if (!params) return -1
        let conn = await mariadb.createConnection(params)
        try {
            let floor = -1
            let rows = await conn.query(
                'SELECT push_generation FROM oracle_prices WHERE source_chain = ? AND action_index = ? LIMIT 1',
                [sourceChain, actionIndex])
            if (rows && rows.length) floor = parseInt(rows[0].push_generation) || 0
            try {
                let wm = await conn.query(
                    'SELECT retraction_generation, from_action_index FROM price_ingest_watermarks WHERE source_chain = ? LIMIT 1',
                    [sourceChain])
                if (wm && wm.length && actionIndex >= (Number(wm[0].from_action_index) || 0)){
                    floor = Math.max(floor, Number(wm[0].retraction_generation) || 0)
                }
            } catch (e){
                // The watermark table only exists once the hub has handled a
                // retraction. Absent is the common case and means no fence.
            }
            return floor
        } finally {
            await conn.end().catch(() => {})
        }
    },

    // Wait for a quote to be present in the HUB's own oracle_prices, i.e. the push
    // leg only. Distinct from waitForMirror, which watches the far end of the
    // replication. Kept separate so a failure says WHICH leg broke.
    async waitForHubRow({ sourceAddress, coin, tick, fiat, timeoutMs = 30000, pollMs = 500 }){
        let params = topology.seedParams()
        if (!params) throw new Error('oraclePriceHelper.waitForHubRow: no hub database configured')
        let started = Date.now()
        let conn = await mariadb.createConnection(params)
        try {
            for (;;){
                let rows = await conn.query(
                    "SELECT block_time, effective_at, value, fee FROM oracle_prices "
                    + "WHERE source_address = ? AND coin = ? AND tick = ? AND fiat = ? "
                    + "ORDER BY id DESC LIMIT 1",
                    [sourceAddress, coin, tick, fiat])
                if (rows && rows.length) return rows[0]
                if (Date.now() - started > timeoutMs){
                    throw new Error(
                        `oraclePriceHelper.waitForHubRow: quote ${coin}/${tick}/${fiat} for ${sourceAddress} `
                        + `never reached the hub's oracle_prices within ${timeoutMs}ms. The indexer's hub PUSH `
                        + `leg is down (check HUB_API_URL on the indexer).`)
                }
                await new Promise(r => setTimeout(r, pollMs))
            }
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
        // : the CONTRACT here is "when this returns, settlement can match
        // the quote". How that is achieved depends on whether a mirror sits
        // between the fixture and the reader, so the mechanism is chosen here
        // rather than at the ~13 call sites.
        //
        // With replication in play a direct INSERT is doubly wrong: it writes into
        // the copy hub_db_sync owns (skipping the leg under test), and that row
        // does not replicate anywhere. Push through the hub's real write path
        // instead and let it broadcast. block_time is derived so the hub's
        // unconditional +86400 (§5.4) lands on exactly the effective_at asked for,
        // which is what lets a test have an already-effective quote with no
        // mock-time driver.
        if (seedsThroughMirror()){
            await module.exports.pushQuoteViaHub({
                sourceAddress, sourceChain, coin, tick, fiat, value, fee,
                blockTime: effectiveAt - 86400, actionIndex, memo
            })
            await module.exports.waitForMirror({ sourceAddress, coin, tick, fiat, actionIndex })
            return
        }
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
        // : see the twin in priceSnapshotHelper. A no-op on the single-host
        // stack; with the mirror on it waits for hub_db_sync rather than letting
        // the caller broadcast its payment into a race.
        await module.exports.waitForMirror({ sourceAddress, coin, tick, fiat, actionIndex })
    }
}
