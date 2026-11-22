// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.
//
// Shared venue plumbing for the XCHAIN price derivation parts: sibling
// module lookup, hub and miner access, chain advance, and the query adapter.

const fs = require('fs')
const path = require('path')
const { captureCurrentRail } = require('../../../helpers/chainRail')
const { minerRpc: sharedMinerRpc } = require('../../../helpers/minerRpc')

const { code: COIN_CODE } = captureCurrentRail()

// The derivation lives in xchain-indexer and is vendored byte-identically into
// xchain-hub. Require it from the sibling checkout rather than copying it here:
// a local copy in the e2e repo would be a THIRD implementation to drift, and the
// whole point is to exercise the one production actually runs. Absent sibling ->
// skip, matching the cross-repo guard convention used elsewhere.
const INDEXER_DIR = process.env.XCHAIN_INDEXER_DIR ||
    path.join(__dirname, '..', '..', '..', '..', '..', 'xchain-indexer')
// Snake_case first (the indexer's names since its twin rename), then the camelCase an older indexer origin still carries.
const inConsensus = (...names) => names.map((n) => path.join(INDEXER_DIR, 'src', 'consensus', n)).find((p) => fs.existsSync(p))
const QUERY_PATH = inConsensus('xchain_price_query.js', 'xchainPriceQuery.js')
const PRICE_PATH = inConsensus('xchain_price.js', 'xchainPrice.js')

const GAS_TICK = 'XCHAIN'

// The hub-published half of the proof needs a live price-capability VALIDATOR
// hub and a miner API on the same venue (both reachable over the operator's SSH
// tunnels). Both legs skip cleanly when the venue is not built that way, exactly
// like the sibling-checkout guard above.
const HUB_API_URL   = process.env.HUB_API_URL   || 'http://127.0.0.1:10000'
const MINER_API_URL = process.env.MINER_API_URL || 'http://127.0.0.1:3025'
// The indexer's HTTP health view (chain lag), beside its JSON-RPC port.
const INDEXER_STATUS_URL = process.env.INDEXER_STATUS_URL ||
    ('http://' + (process.env.INDEXER_URL || '127.0.0.1') + ':' +
     (process.env.INDEXER_API_PORT || '3024') + '/status')

// Production window constants (constants.js on both sides of the vendoring).
// The venue must run the hub with these UNSET so the drill proves the shipped
// values; if an override is ever set on the venue the equality assertion below
// fails loudly rather than silently proving a different window.
const WINDOW_BLOCKS = 1000
const CONFIRMATION_BUFFER = 6

// Lowest synthetic round number any seeding helper in this repo writes
// (nativeFeeHelper 888100001, nativeFeeLive 999200001, nativeFeeDispenser
// 999300001, the DOGE setups 990001). A price_snapshots row at or above it is a
// fixture; a hub's round counter is a small monotonic integer that needs decades
// at a ten-minute cadence to reach six digits.
const SEED_ROUND_FLOOR = 990000

// The finalized rows a hub actually published. The root hook's fee seeds land in
// the same table the snapshot route serves, at rounds above SEED_ROUND_FLOOR, so
// sorted by round they outrank every hub round: read unfiltered, the carry-forward
// "stabilized" on the seed (XCHAIN/USD 2.00000000) and the drill priced off a
// seeded BTC/USD. The hub itself never sees them either, since its reference is
// the newest finalized row strictly below its own small round number.
function hubRounds(rows) {
    return rows.filter(r => r.status === 'finalized' && Number(r.round_number) < SEED_ROUND_FLOOR)
}

// Page to exhaustion: this venue finalizes 37 pairs a minute, so a single
// since_id=0 fetch stops covering the NEWEST rounds within hours of venue
// uptime, and every consumer below reasons about the newest rounds.
async function hubPriceSnapshots(fetchImpl = fetch) {
    const all = []
    let since = 0
    for (;;) {
        const res = await fetchImpl(HUB_API_URL + '/hub-db/snapshot/price_snapshots?since_id=' + since + '&limit=5000')
        if (!res.ok) throw new Error('hub snapshot endpoint HTTP ' + res.status)
        const body = await res.json()
        const rows = body.rows || []
        if (!rows.length) break
        all.push(...rows)
        since = rows[rows.length - 1].id
        if (rows.length < 5000) break
    }
    return hubRounds(all)
}

// Finalized rows for a pair, ascending by round. The reference reads mirror the
// hub's lastFinalized: the newest finalized row STRICTLY BELOW a round.
function pairRows(rows, pair) {
    return rows.filter(r => r.coin_pair === pair)
        .sort((a, b) => Number(a.round_number) - Number(b.round_number))
}
function lastBelow(rows, pair, round) {
    const below = pairRows(rows, pair).filter(r => Number(r.round_number) < Number(round))
    return below.length ? below[below.length - 1] : null
}

// No timeout: a call mines up to 200 blocks. The shared helper also rejects a
// refusal the miner returns inside `result`.
function minerRpc(method, params) {
    return sharedMinerRpc(MINER_API_URL + '/', method, params, { timeout: 0 })
}

// The indexer's own view of how far behind the CHAIN it is. `blocks` only says
// what the indexer has parsed, so a target of "the height I saw plus what I
// mined" is satisfied while the chain is still hundreds of blocks ahead - and
// every wait after that (waitForOrder, waitForDispense) then times out against
// actions sitting in blocks the indexer has not reached. Ask the service.
async function indexerLag() {
    const res = await fetch(INDEXER_STATUS_URL)
    if (!res.ok) throw new Error('indexer /status HTTP ' + res.status)
    const body = await res.json()
    return { lag: Number(body.lag), indexerBlock: Number(body.indexerBlock),
             decoderBlock: Number(body.decoderBlock) }
}

async function generateBlocks(count) {
    let remaining = count
    while (remaining > 0) {
        const n = Math.min(200, remaining)
        await minerRpc('generate_blocks', { count: n })
        remaining -= n
    }
}

// Advance the chain by `count` blocks and wait for the indexer to catch up.
// This venue's miner mines on tx arrival only (no idle blocks), which is what
// makes the derivation window deterministic enough to reproduce exactly: the
// tip moves precisely when this test says so.
async function mineAndIndex(db, count, timeoutMs) {
    await generateBlocks(count)
    // Wait for the indexer to reach the CHAIN, not a height arithmetic says it
    // should have reached: a thousand-block burial takes minutes to parse, and
    // returning early is what turns this leg's later waits into timeouts that
    // read like protocol failures.
    const deadline = Date.now() + (timeoutMs || 300000)
    let last = null
    for (;;) {
        last = await indexerLag()
        if (Number.isFinite(last.lag) && last.lag <= 0) return last.indexerBlock
        if (Date.now() > deadline)
            throw new Error('indexer still ' + last.lag + ' blocks behind the chain (' +
                last.indexerBlock + '/' + last.decoderBlock + ') after mining ' + count)
        await new Promise(r => setTimeout(r, 5000))
    }
}

// Adapt the e2e Database to the one method the query module needs. The module was
// built to require nothing else precisely so it can run here, in the indexer and
// in the hub without a per-caller shim.
function queryAdapter(db) {
    return {
        async doQuery(sql, args) {
            const connection = await db.getConnection()
            try {
                return await connection.query(sql, args || [])
            } finally {
                if (connection && connection.release) connection.release()
            }
        }
    }
}

// bcmath in the shape the formula expects. The e2e has no Utility, so borrow the
// hub's vendored bcmath if present; it is verified byte-equivalent to the
// indexer's Utility across every operation the derivation performs.
function loadBcmath() {
    const hubBc = path.join(__dirname, '..', '..', '..', '..', '..', 'xchain-hub', 'src', 'bcmath.js')
    return fs.existsSync(hubBc) ? require(hubBc) : null
}

// Highest indexed action height: the tip every selection below is read at.
async function actionTip(db) {
    return Number((await db.doQuery('SELECT MAX(block_index) AS h FROM actions'))[0].h)
}

// The CHAIN's clock plus a day, never the wall clock: a regtest chain that has
// been through a setmocktime drill can sit hours ahead of real time, and the
// indexer validates EXPIRATION against block time.
async function chainExpiration(db) {
    const clock = await db.doQuery('SELECT MAX(block_time) AS t FROM blocks')
    return Number(clock[0].t) + 86400
}

// Window fills at a reference height, with the gas tick and coin fixed.
function windowFills(ctx, db, opts) {
    return ctx.derivation.query.getWindowFills(db, Object.assign({
        confirmationBuffer: 0, gasTick: GAS_TICK, coin: COIN_CODE
    }, opts))
}

// XCHAIN is BTC-only as a balance-bearing token; trade legs can only run on a BTC venue.
function skipUnlessBtc(suite) {
    if (COIN_CODE !== 'BTC') suite.skip()
}

module.exports = {
    COIN_CODE, QUERY_PATH, PRICE_PATH, GAS_TICK,
    WINDOW_BLOCKS, CONFIRMATION_BUFFER, SEED_ROUND_FLOOR,
    hubRounds, hubPriceSnapshots, pairRows, lastBelow, minerRpc, indexerLag, mineAndIndex,
    queryAdapter, loadBcmath, actionTip, chainExpiration, windowFills, skipUnlessBtc
}
