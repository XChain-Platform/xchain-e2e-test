// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// Price Bet Timed (on-chain): the timestamp variant (v2) of priceBet. The
// parties agree on a SETTLE TIME (unix seconds) instead of an oracle round;
// the bet is decided by the FIRST finalized round whose consensus timestamp
// is at/after that instant.
//
//   DEPLOY priceBetTimed(maker, coinPair, strike, side, tick, amount, settleTime, deadlineBlocks)
//   maker:  DEPOSIT + EXECUTE("fund")
//   taker:  DEPOSIT + EXECUTE("accept")   (anchors the scan cursor at the
//           round current at match time; rounds finalized before the match
//           can never qualify)
//   anyone: EXECUTE("settle") - walks rounds upward from the cursor via
//           getPriceAtRound; returns 'PENDING' (a VALID no-op execution)
//           while no round has reached settleTime, so the cursor advance can
//           persist (a revert would discard it).
//
// On top of priceBet's getPriceAtRound wiring this exercises the OBJECT shape
// of oracle.getPrice() in production ({price, roundNumber, timestamp} from
// indexer getOracleDataForVM): the contract refuses to run against a
// metadata-less accessor, and both cursor anchoring (accept) and the
// PENDING-then-SETTLED progression depend on the round metadata being real.
//
// Helper-matching note: sendExecuteV0's fallback and sendExecuteV0Invalid
// match on (contract, caller, method) with no ordering, so every settle
// assertion below uses a DISTINCT caller: taker (PENDING), maker (SETTLED),
// stranger (double-settle invalid).
//
// The contract source below is a compacted copy of the canonical template at
// xchain-contracts/priceBetTimed/priceBetTimed.js (abi/info trimmed to stay
// well under the 8192-byte DEPLOY payload cap). Behaviour is identical; the
// VM unit test (priceBetTimed.test.js in xchain-contracts) covers the full
// matrix (push, reclaim, SCANNING paging, etc.).

const assert = require('assert')
const cryptoHelper = require('../cryptoHelper')
const vmHelper = require('../helpers/vmHelper')
const gasHelper = require('../helpers/gasHelper')
const priceSnapshotHelper = require('../helpers/priceSnapshotHelper')

const PRICE_BET_TIMED = `module.exports = {
initialize: function (xchain) {
var maker = xchain.getInputParam(0), coinPair = xchain.getInputParam(1),
strike = xchain.getInputParam(2), side = xchain.getInputParam(3),
tick = xchain.getInputParam(4), amount = xchain.getInputParam(5),
settleTime = xchain.getInputParam(6), deadlineBlocks = xchain.getInputParam(7);
xchain.require(maker, 'maker required');
xchain.require(coinPair, 'coinPair required');
xchain.require(strike && xchain.math.gt(strike, '0'), 'strike must be positive');
xchain.require(side === 'OVER' || side === 'UNDER', 'side must be OVER or UNDER');
xchain.require(tick, 'tick required');
xchain.require(amount && xchain.math.gt(amount, '0'), 'amount must be positive');
var when = parseInt(settleTime);
xchain.require(when > 0, 'settleTime must be a positive unix timestamp');
xchain.require(when > xchain.getBlockTimestamp(), 'settleTime must be in the future');
var window = parseInt(deadlineBlocks);
xchain.require(window > 0, 'deadlineBlocks must be a positive integer');
xchain.state.set('maker', maker);
xchain.state.set('coinPair', coinPair);
xchain.state.set('strike', strike);
xchain.state.set('side', side);
xchain.state.set('tick', tick);
xchain.state.set('amount', amount);
xchain.state.set('settleTime', String(when));
xchain.state.set('window', String(window));
xchain.state.set('status', 'INIT');
},
fund: function (xchain) {
xchain.require(xchain.state.get('status') === 'INIT', 'bet not awaiting funds');
xchain.require(xchain.getSourceAddress() === xchain.state.get('maker'), 'only the maker funds');
xchain.require(xchain.math.gte(held(xchain), xchain.state.get('amount')), 'insufficient deposit');
xchain.state.set('status', 'OPEN');
},
accept: function (xchain) {
xchain.require(xchain.state.get('status') === 'OPEN', 'bet not open');
var taker = xchain.getSourceAddress();
xchain.require(taker !== xchain.state.get('maker'), 'maker cannot take their own bet');
xchain.require(xchain.getBlockTimestamp() < parseInt(xchain.state.get('settleTime')), 'betting window closed');
var needed = xchain.math.multiply(xchain.state.get('amount'), '2');
xchain.require(xchain.math.gte(held(xchain), needed), 'insufficient deposit');
var latest = latestRound(xchain);
var cursor = (latest !== null && latest.roundNumber > 0) ? latest.roundNumber : 1;
xchain.state.set('taker', taker);
xchain.state.set('cursor', String(cursor));
xchain.state.set('deadline', String(xchain.getBlockHeight() + parseInt(xchain.state.get('window'))));
xchain.state.set('status', 'MATCHED');
},
settle: function (xchain) {
xchain.require(xchain.state.get('status') === 'MATCHED', 'bet not matched / already settled');
var T = parseInt(xchain.state.get('settleTime'));
var latest = latestRound(xchain);
xchain.require(latest !== null, 'no oracle data yet');
if (latest.timestamp < T) return 'PENDING';
var MAX_READS = 200;
var coinPair = xchain.state.get('coinPair');
var r = parseInt(xchain.state.get('cursor'));
var top = latest.roundNumber;
var found = null;
for (var i = 0; i < MAX_READS && r <= top; i++, r++) {
var data = normalize(xchain.oracle.getPriceAtRound(coinPair, r));
if (data !== null && data.timestamp >= T) { found = data; break; }
}
if (found === null) {
xchain.state.set('cursor', String(r));
return 'SCANNING';
}
var strike = xchain.state.get('strike');
if (xchain.math.eq(found.price, strike)) {
xchain.state.set('status', 'PUSH');
refundBoth(xchain);
return 'PUSH';
}
var overWon = xchain.math.gt(found.price, strike);
var makerIsOver = xchain.state.get('side') === 'OVER';
var winner = (overWon === makerIsOver) ? xchain.state.get('maker') : xchain.state.get('taker');
var pot = held(xchain);
xchain.state.set('status', 'SETTLED');
xchain.state.set('winner', winner);
xchain.state.set('settledRound', String(found.roundNumber));
xchain.emit.send({ destination: winner, tick: xchain.state.get('tick'), quantity: pot });
return 'SETTLED';
},
cancel: function (xchain) {
xchain.require(xchain.state.get('status') === 'OPEN', 'bet not open');
xchain.require(xchain.getSourceAddress() === xchain.state.get('maker'), 'only the maker can cancel');
var h = held(xchain);
xchain.state.set('status', 'CANCELLED');
xchain.emit.send({ destination: xchain.state.get('maker'), tick: xchain.state.get('tick'), quantity: h });
},
reclaim: function (xchain) {
xchain.require(xchain.state.get('status') === 'MATCHED', 'bet not matched');
var caller = xchain.getSourceAddress();
xchain.require(caller === xchain.state.get('maker') || caller === xchain.state.get('taker'), 'caller not a party to this bet');
xchain.require(xchain.getBlockHeight() >= parseInt(xchain.state.get('deadline')), 'deadline not reached');
var latest = latestRound(xchain);
xchain.require(latest === null || latest.timestamp < parseInt(xchain.state.get('settleTime')), 'qualifying round exists: settle() instead');
xchain.state.set('status', 'VOID');
refundBoth(xchain);
}
};
function normalize(r) {
if (r === null || r === undefined) return null;
if (typeof r === 'object') {
return {
price: (r.price === null || r.price === undefined) ? null : String(r.price),
roundNumber: parseInt(r.roundNumber),
timestamp: parseInt(r.timestamp)
};
}
return { price: String(r), roundNumber: NaN, timestamp: NaN };
}
function latestRound(xchain) {
var latest = normalize(xchain.oracle.getPrice(xchain.state.get('coinPair')));
if (latest === null) return null;
xchain.require(!isNaN(latest.roundNumber) && !isNaN(latest.timestamp), 'oracle accessor lacks round metadata');
return latest;
}
function held(xchain) {
return xchain.getBalance(xchain.getContractAddress(), xchain.state.get('tick')) || '0';
}
function refundBoth(xchain) {
var tick = xchain.state.get('tick'), amount = xchain.state.get('amount');
var rest = xchain.math.subtract(held(xchain), amount);
xchain.emit.send({ destination: xchain.state.get('maker'), tick: tick, quantity: amount });
if (xchain.math.gt(rest, '0')) {
xchain.emit.send({ destination: xchain.state.get('taker'), tick: tick, quantity: rest });
}
}`

describe('Price Bet Timed: binary option settled by the first round at/after settleTime', function () {

    const CHAIN = ({ bitcoin: 'BTC', litecoin: 'LTC', dogecoin: 'DOGE' })[COIN] || 'BTC'
    const TICK = 'XCHAIN'      // stakes in the gas token; nothing extra to issue
    const STAKE = '100'
    const STRIKE = '60000'
    const EARLY_ROUND = 5      // finalized BEFORE settleTime (anchors the cursor)
    const DECIDING_ROUND = 6   // first round with timestamp >= settleTime
    // Unique pair per run: UNIQUE(round_number, coin_pair) + clearPair keep
    // reruns deterministic without touching other suites' pairs.
    const PAIR = 'TB' + Math.floor(Math.random() * 900 + 100) + '/USD'

    let maker = null
    let taker = null
    let stranger = null        // virgin caller for the double-settle assert
    let settleTime = null      // unix seconds; chain-clock anchored
    let ci = null              // contract action_index
    let contractAddr = null

    async function q(sql, params) {
        const conn = await indexerDatabase.getConnection()
        try { return await conn.query(sql, params) }
        finally { await conn.release() }
    }
    async function balanceOf(address, tick) {
        const rows = await q(`SELECT b.amount FROM balances b
            JOIN index_addresses ia ON ia.id=b.address_id
            JOIN index_tickers it ON it.id=b.tick_id
            WHERE ia.address=? AND it.tick=?`, [address, tick])
        return rows.length ? String(rows[0].amount) : null
    }
    // Latest value of a contract state key (contract_state is append-only per
    // block; the newest row wins). State values are stored JSON-serialized.
    async function stateOf(key) {
        const rows = await q(`SELECT state_value FROM contract_state
            WHERE contract_index=? AND state_key=?
            ORDER BY id DESC LIMIT 1`, [ci, key])
        if (!rows.length || rows[0].state_value === null) return null
        let v = String(rows[0].state_value)
        try { v = JSON.parse(v) } catch (e) { /* stored raw */ }
        return v
    }

    before(async function () {
        maker = await cryptoHelper.getNewFundedAddress('pricebettimed-maker', COIN, NETWORK, null, 'legacy', 0, 1)
        taker = await cryptoHelper.getNewFundedAddress('pricebettimed-taker', COIN, NETWORK, null, 'legacy', 0, 1)
        stranger = await cryptoHelper.getNewFundedAddress('pricebettimed-stranger', COIN, NETWORK, null, 'legacy', 0, 1)
        await gasHelper.ensureGasBalance(maker, '2000')
        await gasHelper.ensureGasBalance(taker, '2000')
        await gasHelper.ensureGasBalance(stranger, '2000')
        assert(await priceSnapshotHelper.isAvailable(), 'price_snapshots must be reachable for this suite')
        await priceSnapshotHelper.clearPair(PAIR)
        // Far enough out that deploy/fund/accept all land while the chain
        // clock is still before T (initialize and accept both require it);
        // the deciding round is SEEDED with timestamp = T, so the test never
        // waits for the chain to actually reach it.
        settleTime = (await priceSnapshotHelper.latestBlockTime()) + 3600
    })

    it('deploys the timed bet and the maker escrows their stake (fund)', async function () {
        const params = [maker.address, PAIR, STRIKE, 'OVER', TICK, STAKE, String(settleTime), '500'].join('|')
        const dep = await vmHelper.sendDeployV0(maker, PRICE_BET_TIMED, 1000000, params)
        ci = dep.contract.action_index
        contractAddr = `C:${CHAIN}:${ci}`
        assert.strictEqual(await stateOf('status'), 'INIT', 'deploy should leave the bet in INIT')
        assert.strictEqual(await stateOf('settleTime'), String(settleTime))

        await vmHelper.sendDepositV0(maker, ci, TICK, STAKE)
        const ex = await vmHelper.sendExecuteV0(maker, ci, 'fund', [])
        assert(ex.execution && ex.execution.status === 'valid', 'fund should index a valid execution')
        assert.strictEqual(await balanceOf(contractAddr, TICK), STAKE, 'contract should escrow the maker stake')
        assert.strictEqual(await stateOf('status'), 'OPEN')
    })

    it('accept anchors the scan cursor at the round current at match time', async function () {
        // A round finalized BEFORE the match, and before settleTime: it can
        // never decide the bet, but it is where the scan starts.
        await priceSnapshotHelper.seedSnapshot({
            coinPair: PAIR,
            price: '59000.00000000',
            blockTimestamp: await priceSnapshotHelper.latestBlockTime(),
            roundNumber: EARLY_ROUND
        })

        await vmHelper.sendDepositV0(taker, ci, TICK, STAKE)
        const ex = await vmHelper.sendExecuteV0(taker, ci, 'accept', [])
        assert(ex.execution && ex.execution.status === 'valid', 'accept should index a valid execution')
        assert.strictEqual(await balanceOf(contractAddr, TICK), '200', 'pot should hold both stakes')
        assert.strictEqual(await stateOf('status'), 'MATCHED')
        assert.strictEqual(await stateOf('taker'), taker.address)
        assert.strictEqual(await stateOf('cursor'), String(EARLY_ROUND),
            'cursor must anchor at the latest round at match time (oracle getPrice round metadata)')
    })

    it('settle before any round reaches settleTime is a VALID no-op (PENDING)', async function () {
        // The latest round (EARLY_ROUND) is before T, so settle() returns
        // 'PENDING' instead of reverting: the execution indexes as valid but
        // nothing changes - that persistence-friendly no-op is the design
        // core of the timed variant.
        const ex = await vmHelper.sendExecuteV0(taker, ci, 'settle', [])
        assert(ex.execution && ex.execution.status === 'valid', 'PENDING settle should index a valid execution')
        assert.strictEqual(await stateOf('status'), 'MATCHED', 'bet must remain matched')
        assert.strictEqual(await stateOf('cursor'), String(EARLY_ROUND), 'cursor untouched on the PENDING fast-path')
        assert.strictEqual(await balanceOf(contractAddr, TICK), '200', 'pot must be untouched')
    })

    it('the first round at/after settleTime decides: settle pays the winner', async function () {
        // The deciding round finalizes AT settleTime, above the strike: the
        // OVER maker wins. The scan starts at EARLY_ROUND (below T), steps to
        // DECIDING_ROUND and stops there.
        await priceSnapshotHelper.seedSnapshot({
            coinPair: PAIR,
            price: '61000.00000000',
            blockTimestamp: settleTime,
            roundNumber: DECIDING_ROUND
        })

        const makerBefore = await balanceOf(maker.address, TICK) || '0'
        const ex = await vmHelper.sendExecuteV0(maker, ci, 'settle', [])
        assert(ex.execution && ex.execution.status === 'valid',
            'settle should index a valid execution (timestamp-to-round translation)')

        const makerAfter = await balanceOf(maker.address, TICK) || '0'
        assert.strictEqual(Number(makerAfter) - Number(makerBefore), 200, 'winner receives the whole pot')
        const left = await balanceOf(contractAddr, TICK)
        assert(left === null || left === '0', 'contract should be drained')
        assert.strictEqual(await stateOf('status'), 'SETTLED')
        assert.strictEqual(await stateOf('winner'), maker.address)
        assert.strictEqual(await stateOf('settledRound'), String(DECIDING_ROUND),
            'the FIRST round with timestamp >= settleTime must decide')

        // Double-settle is impossible: the status guard blocks a second
        // payout. A virgin caller keeps the (contract, caller, method) row
        // match unambiguous.
        const again = await vmHelper.sendExecuteV0Invalid(stranger, ci, 'settle', [])
        assert(again.execution, 'second settle should record a row')
        assert.notStrictEqual(again.execution.status, 'valid', 'second settle must not be valid')
    })
})
