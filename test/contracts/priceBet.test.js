// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// Price Bet (on-chain): a two-party binary option settled by the PRICE oracle.
//
//   DEPLOY priceBet(maker, coinPair, strike, side, tick, amount, settleRound, deadlineBlocks)
//   maker:  DEPOSIT(contract, TICK, stake)  then  EXECUTE(contract, "fund")
//   taker:  DEPOSIT(contract, TICK, stake)  then  EXECUTE(contract, "accept")
//   anyone: EXECUTE(contract, "settle")  once the oracle round is finalized
//           -> reads oracle.getPriceAtRound(pair, round); above the strike the
//              OVER side wins the whole pot, below UNDER wins, equal is a push.
//
// This is the first e2e that exercises the VM's ORACLE wiring end-to-end:
// price_snapshots row (finalized) -> indexer getOracleDataForVM -> VM
// readonly-accessors -> contract getPriceAtRound -> emit.send payout. A
// 'valid' settle with the correct winner is the proof of that whole chain.
// Rounds are seeded with priceSnapshotHelper (same table the indexer reads;
// note getPriceAtRound has NO staleness filter, only reference_block <= tip).
//
// The contract source below is a compacted copy of the canonical template at
// xchain-contracts/priceBet/priceBet.js (kept inline so the test is
// self-contained inside the e2e container). Behaviour is identical; the VM
// unit test (priceBet.test.js in xchain-contracts) covers the full matrix.

const assert = require('assert')
const cryptoHelper = require('../cryptoHelper')
const vmHelper = require('../helpers/vmHelper')
const gasHelper = require('../helpers/gasHelper')
const priceSnapshotHelper = require('../helpers/priceSnapshotHelper')

const PRICE_BET = `module.exports = {
    initialize: function (xchain) {
        var maker = xchain.getInputParam(0), coinPair = xchain.getInputParam(1),
            strike = xchain.getInputParam(2), side = xchain.getInputParam(3),
            tick = xchain.getInputParam(4), amount = xchain.getInputParam(5),
            settleRound = xchain.getInputParam(6), deadlineBlocks = xchain.getInputParam(7);
        xchain.require(maker, 'maker required');
        xchain.require(coinPair, 'coinPair required');
        xchain.require(strike && xchain.math.gt(strike, '0'), 'strike must be positive');
        xchain.require(side === 'OVER' || side === 'UNDER', 'side must be OVER or UNDER');
        xchain.require(tick, 'tick required');
        xchain.require(amount && xchain.math.gt(amount, '0'), 'amount must be positive');
        var round = parseInt(settleRound);
        xchain.require(round > 0, 'settleRound must be a positive integer');
        var window = parseInt(deadlineBlocks);
        xchain.require(window > 0, 'deadlineBlocks must be a positive integer');
        xchain.state.set('maker', maker);
        xchain.state.set('coinPair', coinPair);
        xchain.state.set('strike', strike);
        xchain.state.set('side', side);
        xchain.state.set('tick', tick);
        xchain.state.set('amount', amount);
        xchain.state.set('settleRound', String(round));
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
        var needed = xchain.math.multiply(xchain.state.get('amount'), '2');
        xchain.require(xchain.math.gte(held(xchain), needed), 'insufficient deposit');
        xchain.state.set('taker', taker);
        xchain.state.set('deadline', String(xchain.getBlockHeight() + parseInt(xchain.state.get('window'))));
        xchain.state.set('status', 'MATCHED');
    },
    settle: function (xchain) {
        xchain.require(xchain.state.get('status') === 'MATCHED', 'bet not matched / already settled');
        var price = roundPrice(xchain);
        xchain.require(price !== null, 'settle round not published yet');
        var strike = xchain.state.get('strike');
        if (xchain.math.eq(price, strike)) {
            xchain.state.set('status', 'PUSH');
            refundBoth(xchain);
            return;
        }
        var overWon = xchain.math.gt(price, strike);
        var makerIsOver = xchain.state.get('side') === 'OVER';
        var winner = (overWon === makerIsOver) ? xchain.state.get('maker') : xchain.state.get('taker');
        var pot = held(xchain);
        xchain.state.set('status', 'SETTLED');
        xchain.state.set('winner', winner);
        xchain.emit.send({ destination: winner, tick: xchain.state.get('tick'), quantity: pot });
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
        xchain.require(roundPrice(xchain) === null, 'round published: settle() instead');
        xchain.state.set('status', 'VOID');
        refundBoth(xchain);
    }
};
function roundPrice(xchain) {
    var r = xchain.oracle.getPriceAtRound(xchain.state.get('coinPair'), parseInt(xchain.state.get('settleRound')));
    if (r === null || r === undefined) return null;
    if (typeof r === 'object') return (r.price === null || r.price === undefined) ? null : String(r.price);
    return String(r);
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

describe('Price Bet: binary option settled by the PRICE oracle (getPriceAtRound wiring)', function () {

    const CHAIN = ({ bitcoin: 'BTC', litecoin: 'LTC', dogecoin: 'DOGE' })[COIN] || 'BTC'
    const TICK = 'XCHAIN'      // stakes in the gas token; nothing extra to issue
    const STAKE = '100'
    const STRIKE = '60000'
    const ROUND = 7
    // Unique pair per run: UNIQUE(round_number, coin_pair) + clearPair keep
    // reruns deterministic without touching other suites' pairs.
    const PAIR = 'BT' + Math.floor(Math.random() * 900 + 100) + '/USD'

    let maker = null
    let taker = null
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
        maker = await cryptoHelper.getNewFundedAddress('pricebet-maker', COIN, NETWORK, null, 'legacy', 0, 1)
        taker = await cryptoHelper.getNewFundedAddress('pricebet-taker', COIN, NETWORK, null, 'legacy', 0, 1)
        await gasHelper.ensureGasBalance(maker, '2000')
        await gasHelper.ensureGasBalance(taker, '2000')
        // No leftover snapshots for our pair from a previous run.
        if (await priceSnapshotHelper.isAvailable()) await priceSnapshotHelper.clearPair(PAIR)
    })

    it('deploys the bet and the maker escrows their stake (fund)', async function () {
        const params = [maker.address, PAIR, STRIKE, 'OVER', TICK, STAKE, String(ROUND), '50'].join('|')
        const dep = await vmHelper.sendDeployV0(maker, PRICE_BET, 1000000, params)
        ci = dep.contract.action_index
        contractAddr = `C:${CHAIN}:${ci}`
        assert.strictEqual(await stateOf('status'), 'INIT', 'deploy should leave the bet in INIT')

        await vmHelper.sendDepositV0(maker, ci, TICK, STAKE)
        const ex = await vmHelper.sendExecuteV0(maker, ci, 'fund', [])
        assert(ex.execution && ex.execution.status === 'valid', 'fund should index a valid execution')
        assert.strictEqual(await balanceOf(contractAddr, TICK), STAKE, 'contract should escrow the maker stake')
        assert.strictEqual(await stateOf('status'), 'OPEN')
    })

    it('the taker matches the stake and takes the opposite side (accept)', async function () {
        await vmHelper.sendDepositV0(taker, ci, TICK, STAKE)
        const ex = await vmHelper.sendExecuteV0(taker, ci, 'accept', [])
        assert(ex.execution && ex.execution.status === 'valid', 'accept should index a valid execution')
        assert.strictEqual(await balanceOf(contractAddr, TICK), '200', 'pot should hold both stakes')
        assert.strictEqual(await stateOf('status'), 'MATCHED')
        assert.strictEqual(await stateOf('taker'), taker.address)
    })

    it('settle before the oracle round exists is rejected on-chain', async function () {
        const ex = await vmHelper.sendExecuteV0Invalid(taker, ci, 'settle', [])
        assert(ex.execution, 'rejected settle should still record an execution row')
        assert.notStrictEqual(ex.execution.status, 'valid', 'settle without the round must not be valid')
        assert.strictEqual(await stateOf('status'), 'MATCHED', 'bet must remain matched')
        assert.strictEqual(await balanceOf(contractAddr, TICK), '200', 'pot must be untouched')
    })

    it('once the round is finalized, settle pays the whole pot to the winner', async function () {
        assert(await priceSnapshotHelper.isAvailable(), 'price_snapshots must be reachable for this suite')
        // Round 7 finalizes ABOVE the strike: the OVER maker wins.
        await priceSnapshotHelper.seedSnapshot({
            coinPair: PAIR,
            price: '61000.00000000',
            blockTimestamp: await priceSnapshotHelper.latestBlockTime(),
            roundNumber: ROUND
        })

        const makerBefore = await balanceOf(maker.address, TICK) || '0'
        // The LOSER triggers settlement: the outcome is oracle-determined, so
        // who calls (and when) cannot change who gets paid.
        const ex = await vmHelper.sendExecuteV0(taker, ci, 'settle', [])
        assert(ex.execution && ex.execution.status === 'valid',
            'settle should index a valid execution (oracle getPriceAtRound wiring)')

        const makerAfter = await balanceOf(maker.address, TICK) || '0'
        assert.strictEqual(Number(makerAfter) - Number(makerBefore), 200, 'winner receives the whole pot')
        const left = await balanceOf(contractAddr, TICK)
        assert(left === null || left === '0', 'contract should be drained')
        assert.strictEqual(await stateOf('status'), 'SETTLED')
        assert.strictEqual(await stateOf('winner'), maker.address)

        // Double-settle is impossible: the status guard blocks a second payout.
        const again = await vmHelper.sendExecuteV0Invalid(taker, ci, 'settle', [])
        assert(again.execution, 'second settle should record a row')
        assert.notStrictEqual(again.execution.status, 'valid', 'second settle must not be valid')
    })
})
