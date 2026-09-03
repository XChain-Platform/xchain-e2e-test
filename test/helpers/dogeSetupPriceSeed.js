'use strict'

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// The DOGE-side price seed the three standalone cross-chain setup drivers share
// (dexDogeSetup, swapCrossDogeSetup, xcallDogeSetup).
//
// Those drivers are plain node scripts, not mocha suites, so they cannot use
// priceSnapshotHelper: it resolves its target from the initialCheck globals of the
// BTC harness, and these run against the DOGE stack with no harness at all. They
// each carried their own copy of the same INSERT, anchored on ONE timestamp: the
// DOGE indexer's parsed tip.
//
// A single tip anchor is wrong on an IDLE regtest chain, and that is the state
// these drivers find it in. The tip is whatever was last mined, possibly hours
// ago, while the blocks the driver is ABOUT to mine take wall-clock time (regtest
// stamps a new block at max(median-time-past + 1, now)). So the first
// generate_blocks jumps block time forward by the whole idle gap, and the row the
// driver just seeded is already older than ORACLE_MAX_PRICE_AGE_SECONDS when the
// ISSUE lands. Measured 2026-09-03 on the BTC/DOGE regtest venue: seeded at
// 1788414633, ISSUE landed in a block stamped 1788427123 (12490s later) and indexed
// `invalid: no current oracle price for DOGE/USD (missing or stale beyond 1800s)`,
// which the driver then reported as "ISSUE/escrow or CROSS_CHAIN_DEX gating likely
// failed" - naming neither the price nor the clock.
//
// The remedy is the one nativeFeeHelper already proved for the harness suites: seed
// BOTH anchors. A snapshot at S is usable by a block at time B only inside
// S <= B <= S + maxAge, so
//
//   chain anchor (tip)   the only usable row while the node's clock is PINNED
//                        BEHIND wall time (every clock drill ends that way), where
//                        a wall-clock row would sit in the future of every block
//                        and be excluded outright by the H-3 selection gate;
//   wall anchor (now)    the only usable row on an IDLE chain whose next blocks are
//                        stamped ~now, which is the case above.
//
// Written only when wall > tip, so an ahead-of-clock chain still gets exactly one
// row. The wall pair carries the HIGHER round because getLatestPrice takes the
// highest round among the rows a block may see, so where both are visible the
// fresher one wins.
//
// Rounds stay the four already in SEED_SENTINEL_ROUNDS (990001/990002 chain,
// 990011/990012 wall); clearSeedSentinels retracts all four on a publishing venue.

const { refuseSeedIfSuppressed, SEED_SENTINEL_ROUNDS } = require('./xchainPriceConstants')

// Chain-time anchor. Kept at the values the three drivers already wrote, so a venue
// carrying rows from an earlier run is updated in place rather than gaining a
// second, competing pair.
const CHAIN_COIN_ROUND   = 990001
const CHAIN_XCHAIN_ROUND = 990002
// Wall-clock anchor, written only when the chain trails. Higher, so it wins
// getLatestPrice wherever both rows are visible to the block.
const WALL_COIN_ROUND    = 990011
const WALL_XCHAIN_ROUND  = 990012

// The DOGE indexer's PARSED tip, which is the clock the indexer judges freshness
// against. Falls back to wall clock only when the table is empty (a venue with no
// blocks parsed yet), where the two are the same answer anyway.
async function latestParsedBlockTime(dogeIdx){
    return dogeIdx(async (c) => {
        const rows = await c.query('SELECT block_time FROM blocks ORDER BY block_index DESC LIMIT 1')
        return rows.length ? Number(rows[0].block_time) : Math.floor(Date.now() / 1000)
    })
}

// The anchors to write for a given pair of clocks. Pure, so the window rule is
// testable without a database. Never future-dates the chain anchor: an anchor
// later than the block that reads it fails the H-3 selection gate and reads as no
// price at all.
function usableSeedAnchors(chainTime, wallTime){
    const anchors = [{ time: chainTime, coinRound: CHAIN_COIN_ROUND, xchainRound: CHAIN_XCHAIN_ROUND }]
    if (wallTime > chainTime)
        anchors.push({ time: wallTime, coinRound: WALL_COIN_ROUND, xchainRound: WALL_XCHAIN_ROUND })
    return anchors
}

// This helper's own rounds, and every OTHER fixture round in the tree.
//
// Freshness is not what getLatestPrice selects on: it takes the HIGHEST round among
// the rows a block may see, and only then judges the winner's age. So a fixture row
// with a bigger round number and an old timestamp does not lose to a fresher row,
// it wins and is then rejected as stale, and the fresh row is never consulted.
//
// These four rounds are small (990001-990012) and nativeFeeHelper's are enormous
// (888100001-888100012), so ANY earlier harness run on the DOGE stack leaves rows
// that permanently shadow this seed. Measured on the BTC/DOGE regtest venue
// 2026-09-03: DOGE/USD round 888100012 stamped 1788414634 outranked this helper's
// fresh 990011 stamped 1788427625, and every DOGE ISSUE indexed `invalid: no
// current oracle price for DOGE/USD (missing or stale beyond 1800s)` with a good
// row sitting in the table.
//
// nativeFeeHelper avoids this by clearing the whole pair before it seeds. A setup
// driver must not: on a venue whose hub derives DOGE/USD, the pair also holds real
// consensus rounds that are none of a fixture's business. So retract exactly the
// FOREIGN FIXTURE rounds - the same set clearSeedSentinels knows how to undo -
// and leave everything else alone. Anything so retracted is re-seeded by its own
// site on its next action (nativeFeeHelper re-seeds from getNativeFeeOutput, i.e.
// before every action tx), so a harness run sharing the venue heals itself.
//
// That healing is throttled, not instant: nativeFeeHelper skips a re-seed while its
// last one is under SEED_REFRESH_MS old, and it decides that from its own timers
// rather than by checking the rows are still there. So a BTC suite running
// CONCURRENTLY with one of these setups can see up to that window in which
// XCHAIN/USD is only available at this helper's rounds, anchored on the DOGE chain
// clock. These drivers are a serial preamble to their drill, not something to run
// beside a live suite; run them in that order and the window never opens.
//
// The alternative - numbering these rounds ABOVE every other fixture so they simply
// win - was rejected: it trades a bounded window for a permanent one, since the
// higher round would then shadow every later nativeFeeHelper seed on the venue for
// good, which is the bug this whole family keeps producing.
const OWN_ROUNDS = [CHAIN_COIN_ROUND, CHAIN_XCHAIN_ROUND, WALL_COIN_ROUND, WALL_XCHAIN_ROUND]
const FOREIGN_SENTINEL_ROUNDS = SEED_SENTINEL_ROUNDS.filter(r => !OWN_ROUNDS.includes(r))

const UPSERT = `INSERT INTO price_snapshots
        (round_number, coin_pair, price, reference_block, reference_chain,
         block_timestamp, validator_count, consensus_round, consensus_proof, status)
     VALUES (?, ?, ?, 0, 'BTC', ?, 1, 1, '[]', 'finalized')
     ON DUPLICATE KEY UPDATE price = VALUES(price), block_timestamp = VALUES(block_timestamp), status = 'finalized'`

// Seed {coinPair}/USD and XCHAIN/USD where the DOGE indexer reads them, at every
// anchor a block could judge them by.
//
// `hubConn` and `dogeIdx` are the driver's own connection wrappers (each takes an
// async callback and hands it a connection), so this file opens nothing itself and
// each driver keeps owning its credentials. Re-reads the tip on every call, which
// is what makes it safe to call again immediately before each submit.
//
// Returns { chainTime, wallTime, anchors, shadowsCleared } for the caller's log line.
async function seedDogeFixturePrices(opts){
    const { hubConn, dogeIdx, coinPair, coinUsd, xchainUsd, label } = opts
    refuseSeedIfSuppressed(label)

    const chainTime = await latestParsedBlockTime(dogeIdx)
    const wallTime  = Math.floor(Date.now() / 1000)
    const anchors   = usableSeedAnchors(chainTime, wallTime)

    let shadowsCleared = 0
    await hubConn(async (c) => {
        shadowsCleared = await clearForeignSentinels(c, [coinPair, 'XCHAIN/USD'])
        for (const a of anchors){
            await seedPrice(c, coinPair,     coinUsd,   a.time, a.coinRound)
            await seedPrice(c, 'XCHAIN/USD', xchainUsd, a.time, a.xchainRound)
        }
    })
    return { chainTime, wallTime, anchors, shadowsCleared }
}

// Retract the other seed sites' rounds for these pairs, so this seed is the highest
// fixture round and getLatestPrice reaches it. See FOREIGN_SENTINEL_ROUNDS above.
// Returns how many rows went, for the caller's log.
async function clearForeignSentinels(conn, pairs){
    if (!FOREIGN_SENTINEL_ROUNDS.length) return 0
    const res = await conn.query(
        'DELETE FROM price_snapshots WHERE coin_pair IN (' + pairs.map(() => '?').join(', ') + ')' +
        ' AND round_number IN (' + FOREIGN_SENTINEL_ROUNDS.map(() => '?').join(', ') + ')',
        pairs.concat(FOREIGN_SENTINEL_ROUNDS))
    return Number((res && res.affectedRows) || 0)
}

// One row. Kept as a named wrapper rather than an inline query so the
// seed-sentinel coverage guard can see the rounds this file writes.
async function seedPrice(conn, pair, price, blockTimestamp, round){
    return conn.query(UPSERT, [round, pair, price, blockTimestamp])
}

// A one-line summary of what was written, for the drivers' existing log style.
function describeSeed(result){
    return result.anchors.map(a => a.time).join(' + ') +
        (result.anchors.length > 1 ? ' (chain tip + wall clock)' : ' (chain tip)') +
        (result.shadowsCleared ? ', retracted ' + result.shadowsCleared +
            ' shadowing fixture row(s)' : '')
}

module.exports = {
    seedDogeFixturePrices,
    usableSeedAnchors,
    latestParsedBlockTime,
    clearForeignSentinels,
    describeSeed,
    CHAIN_COIN_ROUND, CHAIN_XCHAIN_ROUND, WALL_COIN_ROUND, WALL_XCHAIN_ROUND,
    FOREIGN_SENTINEL_ROUNDS,
}
