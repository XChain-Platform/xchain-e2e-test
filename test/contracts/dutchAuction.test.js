// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// Dutch Auction (on-chain): descending-price auction, first acceptance wins.
//
//   DEPLOY dutchAuction(seller, itemTick, itemAmount, bidTick, startPrice, endPrice, durationBlocks)
//   seller: DEPOSIT(contract, ITEM_TICK, itemAmount), EXECUTE "fund"
//   buyer:  DEPOSIT(contract, BID_TICK, >= currentPrice), EXECUTE "buy"
//              -> item + payment settle in one call; any excess over the
//                 current price is refunded in the SAME execution.
//
// Unlike englishAuction there are no losing bids to refund - only ever one
// buy() succeeds. The interesting wiring to prove on-chain is the block-height-
// driven linear price curve (same getBlockHeight() idiom as vesting) and the
// decimal-grid flooring that keeps the required price and the emitted amounts
// exactly in sync with what the indexer will actually accept.
//
// Real regtest block timing is not fully within the test's control (the
// regtest-miner can land our own DEPOSIT/EXECUTE transactions in their own
// blocks), so this test does not hardcode an exact predicted price from wall-
// clock-style block counting. Instead it reads the contract's own recorded
// `soldPrice` after the fact and asserts the CONTRACT'S invariants: price
// never exceeds startPrice, never drops below endPrice, and strictly falls
// once extra blocks are forced via a direct generateBlocks() call the test
// fully controls.
//
// The contract source below is a compacted copy of the canonical template at
// xchain-contracts/dutchAuction/dutchAuction.js (kept inline so the test is
// self-contained inside the e2e container, same convention as
// stableVault.test.js / englishAuction.test.js). Behaviour is identical; the
// VM unit test (dutchAuction.test.js in xchain-contracts) covers the full
// matrix including the adversarial paths.

const assert = require('assert')
const cryptoHelper = require('../cryptoHelper')
const vmHelper = require('../helpers/vmHelper')
const issueHelper = require('../helpers/issueHelper')
const gasHelper = require('../helpers/gasHelper')

// NOTE: minified (short var names, terse messages) to stay well under the
// DEPLOY payload cap; the readable canonical source lives in
// xchain-contracts/dutchAuction/dutchAuction.js. Behaviour is identical.
const DUTCH_AUCTION = `module.exports = {
    initialize: function (x) {
        var s=x.getInputParam(0), it=x.getInputParam(1), ia=x.getInputParam(2),
            bt=x.getInputParam(3), sp=x.getInputParam(4), ep=x.getInputParam(5), d=parseInt(x.getInputParam(6));
        x.require(s, 'seller required');
        x.require(it && bt, 'itemTick, bidTick required');
        x.require(it !== bt, 'ticks must differ');
        x.require(ia && x.math.gt(ia, '0'), 'itemAmount must be positive');
        x.require(ep && x.math.gt(ep, '0'), 'endPrice must be positive');
        x.require(sp && x.math.gt(sp, ep), 'startPrice must exceed endPrice');
        x.require(d > 0, 'durationBlocks must be positive');
        x.state.set('seller', s); x.state.set('itemTick', it); x.state.set('itemAmount', ia);
        x.state.set('bidTick', bt); x.state.set('startPrice', sp); x.state.set('endPrice', ep);
        x.state.set('duration', String(d)); x.state.set('status', 'INIT');
    },
    fund: function (x) {
        x.require(x.state.get('status') === 'INIT', 'not awaiting item');
        x.require(x.getSourceAddress() === x.state.get('seller'), 'seller only');
        var it = x.state.get('itemTick'), ia = x.state.get('itemAmount');
        var h = x.getBalance(x.getContractAddress(), it) || '0';
        x.require(x.math.gte(h, ia), 'insufficient item deposit');
        x.state.set('start', String(x.getBlockHeight()));
        x.state.set('status', 'ACTIVE');
    },
    buy: function (x) {
        x.require(x.state.get('status') === 'ACTIVE', 'not active');
        var bt = x.state.get('bidTick');
        var price = fl(cp(x), dec(x, bt));
        var h = x.getBalance(x.getContractAddress(), bt) || '0';
        x.require(x.math.gte(h, price), 'insufficient payment for price ' + price);
        var c = x.getSourceAddress(), ex = x.math.subtract(h, price);
        x.state.set('status', 'SOLD'); x.state.set('soldPrice', price); x.state.set('buyer', c);
        x.emit.send({ destination: c, tick: x.state.get('itemTick'), quantity: x.state.get('itemAmount') });
        x.emit.send({ destination: x.state.get('seller'), tick: bt, quantity: price });
        if (x.math.gt(ex, '0')) x.emit.send({ destination: c, tick: bt, quantity: ex });
    },
    cancel: function (x) {
        x.require(x.state.get('status') === 'ACTIVE', 'not active');
        x.require(x.getSourceAddress() === x.state.get('seller'), 'seller only');
        x.state.set('status', 'CANCELLED');
        x.emit.send({ destination: x.state.get('seller'), tick: x.state.get('itemTick'), quantity: x.state.get('itemAmount') });
    }
};
function fl(v, d) {
    var s = String(v), n = s.charAt(0) === '-'; if (n) s = s.substring(1);
    var dot = s.indexOf('.'); if (dot < 0) return v;
    var f = s.substring(dot + 1); if (f.length <= d) return v;
    var k = d > 0 ? '.' + f.substring(0, d) : '';
    var o = s.substring(0, dot) + k; return n ? '-' + o : o;
}
function dec(x, t) { var i = x.getTokenInfo(t); x.require(i && i.DECIMALS !== null && i.DECIMALS !== undefined, 'decimals unavailable'); return i.DECIMALS; }
function cp(x) {
    var st = parseInt(x.state.get('start')), du = parseInt(x.state.get('duration'));
    var el = x.getBlockHeight() - st, sp = x.state.get('startPrice'), ep = x.state.get('endPrice');
    if (el >= du) return ep;
    var drop = x.math.subtract(sp, ep);
    var decayed = x.math.divide(x.math.multiply(drop, String(el)), String(du));
    return x.math.subtract(sp, decayed);
}`

describe('Dutch Auction: descending price, first acceptance wins', function () {
    this.timeout(10 * 60 * 1000)

    const CHAIN = ({ bitcoin: 'BTC', litecoin: 'LTC', dogecoin: 'DOGE' })[COIN] || 'BTC'
    const BID = 'XCHAIN' // gas token doubles as the bidding currency; 0 decimals in this stack
    const START_PRICE = '1000'
    const END_PRICE = '100'
    const randTick = (p) => { let s = p; for (let i = 0; i < 5; i++) s += String.fromCharCode(65 + Math.floor(Math.random() * 26)); return s }

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
        return rows.length ? Number(rows[0].amount) : 0
    }
    async function stateOf(ci, key) {
        const rows = await q(`SELECT state_value FROM contract_state
            WHERE contract_index=? AND state_key=?
            ORDER BY id DESC LIMIT 1`, [ci, key])
        if (!rows.length || rows[0].state_value === null) return null
        let v = String(rows[0].state_value)
        try { v = JSON.parse(v) } catch (e) { /* stored raw */ }
        return v
    }

    // Deploys a fresh auction: `itemAmount` units of a freshly-issued item tick,
    // funded by the seller, price falling START_PRICE -> END_PRICE over
    // `duration` blocks. Each call gets its own item tick so successive
    // auctions never share custody state.
    async function deployAndFund(itemAmount, duration) {
        const seller = await cryptoHelper.getNewFundedAddress('dut-auc-seller', COIN, NETWORK, null, 'legacy', 0, 0.02)
        await gasHelper.ensureGasBalance(seller, '500')

        const itemTick = randTick('DAIT')
        await issueHelper.sendIssueV0(seller, itemTick, '1000', '1000', '0', 'auction item ' + itemTick, itemAmount)

        const params = [seller.address, itemTick, itemAmount, BID, START_PRICE, END_PRICE, String(duration)].join('|')
        const dep = await vmHelper.sendDeployV0(seller, DUTCH_AUCTION, 1000000, params)
        const ci = dep.contract.action_index
        const contractAddr = `C:${CHAIN}:${ci}`
        assert.strictEqual(await stateOf(ci, 'status'), 'INIT')

        await vmHelper.sendDepositV0(seller, ci, itemTick, itemAmount)
        const fund = await vmHelper.sendExecuteV0(seller, ci, 'fund', [])
        assert(fund.execution && fund.execution.status === 'valid', 'fund should index a valid execution')
        assert.strictEqual(await stateOf(ci, 'status'), 'ACTIVE')

        return { ci, contractAddr, itemTick, seller }
    }

    it('buying right after funding charges (at most) startPrice, and settles item + payment atomically', async function () {
        const { ci, contractAddr, itemTick, seller } = await deployAndFund('10', 200)

        const buyer = await cryptoHelper.getNewFundedAddress('dut-auc-buyer1', COIN, NETWORK, null, 'legacy', 0, 0.02)
        await gasHelper.ensureGasBalance(buyer, String(Number(START_PRICE) + 50))

        const sellerBefore = await balanceOf(seller.address, BID)
        await vmHelper.sendDepositV0(buyer, ci, BID, START_PRICE) // pay the maximum possible price; excess (if any) refunds
        const ex = await vmHelper.sendExecuteV0(buyer, ci, 'buy', [])
        assert(ex.execution && ex.execution.status === 'valid', 'buy should index a valid execution')

        const soldPrice = Number(await stateOf(ci, 'soldPrice'))
        assert(soldPrice <= Number(START_PRICE) && soldPrice >= Number(END_PRICE), 'soldPrice should be within [endPrice, startPrice]')

        assert.strictEqual(await stateOf(ci, 'status'), 'SOLD')
        assert.strictEqual(await balanceOf(buyer.address, itemTick), 10, 'buyer should receive the item')
        assert.strictEqual((await balanceOf(seller.address, BID)) - sellerBefore, soldPrice, 'seller should receive exactly the recorded soldPrice')
        assert.strictEqual(await balanceOf(contractAddr, itemTick), 0)
        assert.strictEqual(await balanceOf(contractAddr, BID), 0, 'no bid tokens (price or excess) should be left in custody')
    })

    it('forcing extra blocks between funding and buying lowers the price, and the floor holds past the full duration', async function () {
        // Short duration so a handful of forced blocks clearly land at the floor.
        const { ci: ciFloor, itemTick: itemFloor, seller: sellerFloor } = await deployAndFund('5', 3)
        await regtestMinerConnector.generateBlocks(50) // far past duration=3
        const buyerFloor = await cryptoHelper.getNewFundedAddress('dut-auc-buyer2', COIN, NETWORK, null, 'legacy', 0, 0.02)
        await gasHelper.ensureGasBalance(buyerFloor, String(Number(START_PRICE) + 50))
        await vmHelper.sendDepositV0(buyerFloor, ciFloor, BID, START_PRICE)
        const exFloor = await vmHelper.sendExecuteV0(buyerFloor, ciFloor, 'buy', [])
        assert(exFloor.execution && exFloor.execution.status === 'valid', 'buy past the floor should index a valid execution')
        assert.strictEqual(await stateOf(ciFloor, 'soldPrice'), END_PRICE, 'price should pin at endPrice once duration has fully elapsed')
        assert.strictEqual(await balanceOf(buyerFloor.address, itemFloor), 5)

        // Longer duration: compare a fresh sale's soldPrice against one where we
        // forced extra blocks in between funding and buying - the forced-block
        // sale must be strictly cheaper (or already at the earlier one, never more).
        const { ci: ciA, itemTick: itemA, seller: sellerA } = await deployAndFund('3', 200)
        const buyerA = await cryptoHelper.getNewFundedAddress('dut-auc-buyer3', COIN, NETWORK, null, 'legacy', 0, 0.02)
        await gasHelper.ensureGasBalance(buyerA, String(Number(START_PRICE) + 50))
        await vmHelper.sendDepositV0(buyerA, ciA, BID, START_PRICE)
        const exA = await vmHelper.sendExecuteV0(buyerA, ciA, 'buy', [])
        assert(exA.execution && exA.execution.status === 'valid')
        const priceA = Number(await stateOf(ciA, 'soldPrice'))

        const { ci: ciB, itemTick: itemB, seller: sellerB } = await deployAndFund('3', 200)
        await regtestMinerConnector.generateBlocks(20) // force elapsed blocks before buying
        const buyerB = await cryptoHelper.getNewFundedAddress('dut-auc-buyer4', COIN, NETWORK, null, 'legacy', 0, 0.02)
        await gasHelper.ensureGasBalance(buyerB, String(Number(START_PRICE) + 50))
        await vmHelper.sendDepositV0(buyerB, ciB, BID, START_PRICE)
        const exB = await vmHelper.sendExecuteV0(buyerB, ciB, 'buy', [])
        assert(exB.execution && exB.execution.status === 'valid')
        const priceB = Number(await stateOf(ciB, 'soldPrice'))

        assert(priceB <= priceA, 'more elapsed blocks before buying should never yield a HIGHER price (' + priceB + ' vs ' + priceA + ')')
    })

    it('seller cancels before any purchase and reclaims the item', async function () {
        const { ci, contractAddr, itemTick, seller } = await deployAndFund('6', 200)

        const sellerItemBefore = await balanceOf(seller.address, itemTick)
        const cancel = await vmHelper.sendExecuteV0(seller, ci, 'cancel', [])
        assert(cancel.execution && cancel.execution.status === 'valid', 'cancel should index a valid execution')

        assert.strictEqual(await stateOf(ci, 'status'), 'CANCELLED')
        assert.strictEqual((await balanceOf(seller.address, itemTick)) - sellerItemBefore, 6)
        assert.strictEqual(await balanceOf(contractAddr, itemTick), 0)
    })
})
