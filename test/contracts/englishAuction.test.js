// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// English Auction (on-chain): ascending-bid auction with instant outbid
// refunds and a block-deadline settlement.
//
//   DEPLOY englishAuction(seller, itemTick, itemAmount, bidTick, minBid, deadlineBlocks)
//   seller: DEPOSIT(contract, ITEM_TICK, itemAmount), EXECUTE "fund"
//   bidder: DEPOSIT(contract, BID_TICK, amount),       EXECUTE "bid"
//              -> a strictly-higher bid instantly refunds the previous leader
//                 in the SAME execution that supersedes it.
//   anyone: EXECUTE "settle" (after the deadline) -> item to the high bidder,
//           winning bid to the seller (or item back to the seller, if unsold)
//
// This is the first e2e that exercises repeated deposits into the SAME
// contract balance from DIFFERENT callers with an interleaved refund - the
// delta-accounting idiom the crowdsale template introduced, now combined with
// an emitted refund mid-sequence (not just at settlement).
//
// The contract source below is a compacted copy of the canonical template at
// xchain-contracts/englishAuction/englishAuction.js (kept inline so the test
// is self-contained inside the e2e container, same convention as
// stableVault.test.js / escrowDelivery.test.js). Behaviour is identical; the
// VM unit test (englishAuction.test.js in xchain-contracts) covers the full
// matrix including the adversarial paths.

const assert = require('assert')
const cryptoHelper = require('../cryptoHelper')
const vmHelper = require('../helpers/vmHelper')
const issueHelper = require('../helpers/issueHelper')
const gasHelper = require('../helpers/gasHelper')

// NOTE: minified (short var names, terse messages) to stay well under the
// DEPLOY payload cap; the readable canonical source lives in
// xchain-contracts/englishAuction/englishAuction.js. Behaviour is identical.
const ENGLISH_AUCTION = `module.exports = {
    initialize: function (x) {
        var s=x.getInputParam(0), it=x.getInputParam(1), ia=x.getInputParam(2),
            bt=x.getInputParam(3), mb=x.getInputParam(4), d=x.getInputParam(5);
        x.require(s, 'seller required');
        x.require(it && bt, 'itemTick, bidTick required');
        x.require(it !== bt, 'ticks must differ');
        x.require(ia && x.math.gt(ia, '0'), 'itemAmount must be positive');
        x.require(mb && x.math.gt(mb, '0'), 'minBid must be positive');
        var w = parseInt(d);
        x.require(w > 0, 'deadlineBlocks must be positive');
        x.state.set('seller', s); x.state.set('itemTick', it); x.state.set('itemAmount', ia);
        x.state.set('bidTick', bt); x.state.set('minBid', mb); x.state.set('window', String(w));
        x.state.set('highBid', '0'); x.state.set('status', 'INIT');
    },
    fund: function (x) {
        x.require(x.state.get('status') === 'INIT', 'not awaiting item');
        x.require(x.getSourceAddress() === x.state.get('seller'), 'seller only');
        var it = x.state.get('itemTick'), ia = x.state.get('itemAmount');
        var h = x.getBalance(x.getContractAddress(), it) || '0';
        x.require(x.math.gte(h, ia), 'insufficient item deposit');
        x.state.set('deadline', String(x.getBlockHeight() + parseInt(x.state.get('window'))));
        x.state.set('status', 'ACTIVE');
    },
    bid: function (x) {
        x.require(x.state.get('status') === 'ACTIVE', 'not active');
        x.require(x.getBlockHeight() < parseInt(x.state.get('deadline')), 'bidding closed');
        var c = x.getSourceAddress(), p = x.state.get('highBidder');
        x.require(c !== p, 'already high bidder');
        var bt = x.state.get('bidTick'), h = x.getBalance(x.getContractAddress(), bt) || '0';
        var hb = x.state.get('highBid'), nb = x.math.subtract(h, hb);
        x.require(x.math.gt(nb, '0'), 'no bid received');
        x.require(x.math.gte(nb, x.state.get('minBid')), 'below minimum');
        x.require(x.math.gt(nb, hb), 'must exceed high bid');
        if (p) x.emit.send({ destination: p, tick: bt, quantity: hb });
        x.state.set('highBid', nb); x.state.set('highBidder', c);
    },
    settle: function (x) {
        x.require(x.state.get('status') === 'ACTIVE', 'not active');
        x.require(x.getBlockHeight() >= parseInt(x.state.get('deadline')), 'deadline not reached');
        var it = x.state.get('itemTick'), ia = x.state.get('itemAmount'), w = x.state.get('highBidder');
        if (w) {
            x.state.set('status', 'SOLD');
            x.emit.send({ destination: w, tick: it, quantity: ia });
            x.emit.send({ destination: x.state.get('seller'), tick: x.state.get('bidTick'), quantity: x.state.get('highBid') });
        } else {
            x.state.set('status', 'UNSOLD');
            x.emit.send({ destination: x.state.get('seller'), tick: it, quantity: ia });
        }
    },
    cancel: function (x) {
        x.require(x.state.get('status') === 'ACTIVE', 'not active');
        x.require(x.getSourceAddress() === x.state.get('seller'), 'seller only');
        x.require(!x.state.get('highBidder'), 'a bid already placed');
        x.state.set('status', 'CANCELLED');
        x.emit.send({ destination: x.state.get('seller'), tick: x.state.get('itemTick'), quantity: x.state.get('itemAmount') });
    }
};`

describe('English Auction: ascending bids with instant outbid refunds, deadline settlement', function () {
    this.timeout(10 * 60 * 1000)

    const CHAIN = ({ bitcoin: 'BTC', litecoin: 'LTC', dogecoin: 'DOGE' })[COIN] || 'BTC'
    const BID = 'XCHAIN' // gas token doubles as the bidding currency; 0 decimals in this stack
    const MIN_BID = '50'
    const DEADLINE = '5'
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
    // funded by the seller. Each call gets its own item tick so successive
    // auctions never share custody state.
    async function deployAndFund(itemAmount) {
        const seller = await cryptoHelper.getNewFundedAddress('eng-auc-seller', COIN, NETWORK, null, 'legacy', 0, 0.02)
        await gasHelper.ensureGasBalance(seller, '500')

        const itemTick = randTick('EAIT')
        await issueHelper.sendIssueV0(seller, itemTick, '1000', '1000', '0', 'auction item ' + itemTick, itemAmount)

        const params = [seller.address, itemTick, itemAmount, BID, MIN_BID, DEADLINE].join('|')
        const dep = await vmHelper.sendDeployV0(seller, ENGLISH_AUCTION, 1000000, params)
        const ci = dep.contract.action_index
        const contractAddr = `C:${CHAIN}:${ci}`
        assert.strictEqual(await stateOf(ci, 'status'), 'INIT')

        await vmHelper.sendDepositV0(seller, ci, itemTick, itemAmount)
        const fund = await vmHelper.sendExecuteV0(seller, ci, 'fund', [])
        assert(fund.execution && fund.execution.status === 'valid', 'fund should index a valid execution')
        assert.strictEqual(await stateOf(ci, 'status'), 'ACTIVE')

        return { ci, contractAddr, itemTick, seller }
    }

    async function bid(ci, bidder, amount) {
        await vmHelper.sendDepositV0(bidder, ci, BID, amount)
        const ex = await vmHelper.sendExecuteV0(bidder, ci, 'bid', [])
        assert(ex.execution && ex.execution.status === 'valid', 'bid of ' + amount + ' should index a valid execution')
        return ex
    }

    it('a higher bid instantly refunds the previous leader, and settle() pays the winner + seller', async function () {
        const { ci, contractAddr, itemTick, seller } = await deployAndFund('10')

        const alice = await cryptoHelper.getNewFundedAddress('eng-auc-alice', COIN, NETWORK, null, 'legacy', 0, 0.02)
        const bob   = await cryptoHelper.getNewFundedAddress('eng-auc-bob', COIN, NETWORK, null, 'legacy', 0, 0.02)
        await gasHelper.ensureGasBalance(alice, '200')
        await gasHelper.ensureGasBalance(bob, '200')

        await bid(ci, alice, '50')
        assert.strictEqual(await stateOf(ci, 'highBidder'), alice.address)
        assert.strictEqual(await stateOf(ci, 'highBid'), '50')

        const aliceBeforeOutbid = await balanceOf(alice.address, BID)
        await bid(ci, bob, '80')
        assert.strictEqual(await stateOf(ci, 'highBidder'), bob.address)
        assert.strictEqual(await stateOf(ci, 'highBid'), '80')
        const aliceAfterOutbid = await balanceOf(alice.address, BID)
        assert.strictEqual(aliceAfterOutbid - aliceBeforeOutbid, 50, 'alice should be refunded her full 50 the instant bob outbids her')

        await regtestMinerConnector.generateBlocks(Number(DEADLINE) + 3)

        const sellerBefore = await balanceOf(seller.address, BID)
        const settle = await vmHelper.sendExecuteV0(bob, ci, 'settle', [])
        assert(settle.execution && settle.execution.status === 'valid', 'settle should index a valid execution')

        assert.strictEqual(await stateOf(ci, 'status'), 'SOLD')
        assert.strictEqual(await balanceOf(bob.address, itemTick), 10, 'bob (the winner) should receive the item')
        assert.strictEqual((await balanceOf(seller.address, BID)) - sellerBefore, 80, 'seller should receive the winning bid')
        assert.strictEqual(await balanceOf(contractAddr, itemTick), 0, 'the contract should hold no item afterward')
        assert.strictEqual(await balanceOf(contractAddr, BID), 0, 'the contract should hold no bid tokens afterward')
    })

    it('no bids: settle() returns the item to the seller (UNSOLD)', async function () {
        const { ci, contractAddr, itemTick, seller } = await deployAndFund('7')

        await regtestMinerConnector.generateBlocks(Number(DEADLINE) + 3)

        const sellerItemBefore = await balanceOf(seller.address, itemTick)
        const settle = await vmHelper.sendExecuteV0(seller, ci, 'settle', [])
        assert(settle.execution && settle.execution.status === 'valid', 'settle should index a valid execution')

        assert.strictEqual(await stateOf(ci, 'status'), 'UNSOLD')
        assert.strictEqual((await balanceOf(seller.address, itemTick)) - sellerItemBefore, 7, 'seller should get the unsold item back in full')
        assert.strictEqual(await balanceOf(contractAddr, itemTick), 0)
    })

    it('seller cancels before any bid and reclaims the item', async function () {
        const { ci, contractAddr, itemTick, seller } = await deployAndFund('4')

        const sellerItemBefore = await balanceOf(seller.address, itemTick)
        const cancel = await vmHelper.sendExecuteV0(seller, ci, 'cancel', [])
        assert(cancel.execution && cancel.execution.status === 'valid', 'cancel should index a valid execution')

        assert.strictEqual(await stateOf(ci, 'status'), 'CANCELLED')
        assert.strictEqual((await balanceOf(seller.address, itemTick)) - sellerItemBefore, 4)
        assert.strictEqual(await balanceOf(contractAddr, itemTick), 0)
    })
})
