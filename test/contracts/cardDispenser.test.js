// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// Card Dispenser (on-chain): a contract that holds an inventory of card tokens
// and, on a paid EXECUTE, sends the buyer ONE random in-stock card (weighted by
// copies held) - NO mint, pure emit.send of its own deposited tokens.
//
//   DEPLOY cardDispenser(payTick, price, unit, card1, card2, card3)
//   operator DEPOSITs card tokens into the contract (the prize pool)
//   buyer:  DEPOSIT(contract, XCHAIN, price)  then  EXECUTE(contract, "draw")
//           -> draw() reads getBalance(self,*) to verify payment + read stock,
//              picks a card via the block hash, and emit.send()s it to the buyer.
//
// A 'valid' draw is itself the proof that the indexer's getBalance wiring works:
// with no balance visibility draw() would revert 'underpaid'.
//
// The contract source below is a compacted copy of the canonical template at
// xchain-contracts/cardDispenser/cardDispenser.js (kept inline so the test is
// self-contained inside the e2e container). Behaviour is identical; the VM unit
// test (cardDispenser.test.js in xchain-contracts) covers distribution.

const assert = require('assert')
const cryptoHelper = require('../cryptoHelper')
const vmHelper = require('../helpers/vmHelper')
const issueHelper = require('../helpers/issueHelper')
const gasHelper = require('../helpers/gasHelper')

const CARD_DISPENSER = `module.exports = {
    initialize: function (xchain) {
        var payTick = xchain.getInputParam(0), price = xchain.getInputParam(1), unit = xchain.getInputParam(2);
        xchain.require(payTick, 'payTick required');
        xchain.require(price && xchain.math.gt(price, '0'), 'price must be > 0');
        xchain.require(unit && xchain.math.gt(unit, '0'), 'unit must be > 0');
        var count = xchain.getInputParamCount();
        xchain.require(count > 3, 'at least one card tick required');
        var cards = [];
        for (var i = 3; i < count; i++) {
            var t = xchain.getInputParam(i);
            xchain.require(t && t.indexOf('|') === -1, 'invalid card tick');
            xchain.require(t !== payTick, 'card tick must differ from payTick');
            cards.push(t);
        }
        xchain.state.set('owner', xchain.getSourceAddress());
        xchain.state.set('payTick', payTick);
        xchain.state.set('price', price);
        xchain.state.set('unit', unit);
        xchain.state.set('cards', cards.join('|'));
        xchain.state.set('acctPay', '0');
        xchain.state.set('nonce', '0');
    },
    draw: function (xchain) {
        var self = xchain.getContractAddress(), buyer = xchain.getSourceAddress();
        var payTick = xchain.state.get('payTick'), price = xchain.state.get('price'), unit = xchain.state.get('unit');
        var curPay = xchain.getBalance(self, payTick) || '0';
        var paid = xchain.math.subtract(curPay, xchain.state.get('acctPay'));
        xchain.require(xchain.math.gte(paid, price), 'underpaid');
        var cards = xchain.state.get('cards').split('|'), weights = [], total = '0';
        for (var i = 0; i < cards.length; i++) {
            var bal = xchain.getBalance(self, cards[i]) || '0';
            var q = xchain.math.divide(bal, unit);
            var copies = xchain.math.subtract(q, xchain.math.mod(q, '1'));
            weights.push(copies);
            total = xchain.math.add(total, copies);
        }
        if (xchain.math.isZero(total)) {
            xchain.emit.send({ destination: buyer, tick: payTick, quantity: paid });
            xchain.state.set('acctPay', curPay);
            return 'sold_out';
        }
        var r = pick(xchain, buyer, total), acc = '0', chosen = null;
        for (var j = 0; j < cards.length; j++) {
            acc = xchain.math.add(acc, weights[j]);
            if (xchain.math.lt(r, acc)) { chosen = cards[j]; break; }
        }
        xchain.require(chosen !== null, 'selection failed');
        xchain.emit.send({ destination: buyer, tick: chosen, quantity: unit });
        xchain.state.set('acctPay', curPay);
        xchain.state.set('nonce', xchain.math.add(xchain.state.get('nonce'), '1'));
        return chosen;
    },
    withdraw: function (xchain) {
        xchain.require(xchain.getSourceAddress() === xchain.state.get('owner'), 'owner only');
        var tick = xchain.getInputParam(0);
        xchain.require(tick, 'tick required');
        var held = xchain.getBalance(xchain.getContractAddress(), tick) || '0';
        xchain.require(xchain.math.gt(held, '0'), 'nothing to withdraw');
        xchain.emit.send({ destination: xchain.state.get('owner'), tick: tick, quantity: held });
    }
};
function pick(xchain, buyer, total) {
    var MOD = '100000000000000000000000000000000000000';
    var seed = fold(xchain, xchain.getBlockHash() || '', MOD);
    var addr = fold(xchain, buyer, MOD);
    var nonce = xchain.state.get('nonce');
    var mix = xchain.math.add(seed, xchain.math.add(xchain.math.multiply(addr, '1000000007'), xchain.math.multiply(nonce, '6364136223846793005')));
    return xchain.math.mod(mix, total);
}
function fold(xchain, s, MOD) {
    var acc = '0';
    for (var i = 0; i < s.length; i++) {
        acc = xchain.math.mod(xchain.math.add(xchain.math.multiply(acc, '131'), String(s.charCodeAt(i))), MOD);
    }
    return acc;
}`

describe('Card Dispenser: random in-set card from contract inventory (emit.send, no mint)', function () {

    const CHAIN = ({ bitcoin: 'BTC', litecoin: 'LTC', dogecoin: 'DOGE' })[COIN] || 'BTC'
    const PAY = 'XCHAIN'     // buyers pay in the gas token; no separate pay token to fund
    const PRICE = '1'
    const UNIT = '1'
    const STOCK = '3'        // copies of each card deposited into the contract

    let operator = null      // issues cards, deploys, funds inventory, owner
    let buyer = null         // pays + draws; starts with zero cards (clean 0->1 detection)
    let cards = null         // [tickA, tickB, tickC]
    let ci = null            // contract action_index of the main dispenser
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
    // Map of the buyer's held cards (only ticks from our set, non-zero).
    async function buyerCards() {
        const held = {}
        for (const c of cards) {
            const b = await balanceOf(buyer.address, c)
            if (b && b !== '0') held[c] = b
        }
        return held
    }
    function randTick(p) { let s = p; for (let i = 0; i < 5; i++) s += String.fromCharCode(65 + Math.floor(Math.random() * 26)); return s }

    before(async function () {
        operator = await cryptoHelper.getNewFundedAddress('carddisp-op', COIN, NETWORK, null, 'legacy', 0, 1)
        buyer = await cryptoHelper.getNewFundedAddress('carddisp-buyer', COIN, NETWORK, null, 'legacy', 0, 1)
        await gasHelper.ensureGasBalance(operator, '3000')
        await gasHelper.ensureGasBalance(buyer, '500')
    })

    it('deploys the dispenser and funds its card inventory (operator deposits cards)', async function () {
        cards = [randTick('CRDA'), randTick('CRDB'), randTick('CRDC')]
        // Issue the three card tokens to the operator (decimals 0; whole-unit cards).
        for (const c of cards)
            await issueHelper.sendIssueV0(operator, c, '1000', '1000', '0', 'card ' + c, '100')

        const params = [PAY, PRICE, UNIT].concat(cards).join('|')
        const dep = await vmHelper.sendDeployV0(operator, CARD_DISPENSER, 1000000, params)
        ci = dep.contract.action_index
        contractAddr = `C:${CHAIN}:${ci}`

        // Fund the prize pool: deposit STOCK copies of each card into the contract.
        for (const c of cards)
            await vmHelper.sendDepositV0(operator, ci, c, STOCK)

        for (const c of cards)
            assert.strictEqual(await balanceOf(contractAddr, c), STOCK,
                'contract should hold ' + STOCK + ' of ' + c)
    })

    it('paid draws send the buyer one in-set card each and decrement the pool', async function () {
        const DRAWS = 3
        assert.deepStrictEqual(await buyerCards(), {}, 'buyer should start with no cards')

        for (let k = 0; k < DRAWS; k++) {
            await vmHelper.sendDepositV0(buyer, ci, PAY, PRICE)
            const ex = await vmHelper.sendExecuteV0(buyer, ci, 'draw', [])
            // A 'valid' draw is the on-chain proof that getBalance saw the deposit
            // (otherwise draw() reverts 'underpaid' and this row never goes valid).
            assert(ex.execution, 'draw #' + (k + 1) + ' should index a valid execution (getBalance wiring)')
            assert.strictEqual(ex.execution.status, 'valid', 'draw #' + (k + 1) + ' status')
        }

        // Buyer ends with exactly DRAWS cards, all drawn from the declared set.
        const held = await buyerCards()
        let totalHeld = 0
        for (const c of Object.keys(held)) {
            assert(cards.indexOf(c) !== -1, 'held tick must be one of the declared cards: ' + c)
            totalHeld += Number(held[c])
        }
        assert.strictEqual(totalHeld, DRAWS, 'buyer should hold exactly ' + DRAWS + ' cards total')

        // The pool shrank by exactly DRAWS across all cards.
        let poolLeft = 0
        for (const c of cards) poolLeft += Number(await balanceOf(contractAddr, c) || '0')
        assert.strictEqual(poolLeft, Number(STOCK) * cards.length - DRAWS,
            'contract pool should have dropped by ' + DRAWS)
    })

    it('refunds the payment instead of stranding it when sold out', async function () {
        // A fresh dispenser with a single card and a single copy.
        const solo = randTick('SOLO')
        await issueHelper.sendIssueV0(operator, solo, '10', '10', '0', 'solo card', '5')
        const dep = await vmHelper.sendDeployV0(operator, CARD_DISPENSER, 1000000, [PAY, PRICE, UNIT, solo].join('|'))
        const ci2 = dep.contract.action_index
        await vmHelper.sendDepositV0(operator, ci2, solo, '1')

        // First draw drains the only card.
        await vmHelper.sendDepositV0(buyer, ci2, PAY, PRICE)
        const first = await vmHelper.sendExecuteV0(buyer, ci2, 'draw', [])
        assert(first.execution && first.execution.status === 'valid', 'first draw should succeed')
        assert.strictEqual(await balanceOf(buyer.address, solo), '1', 'buyer drew the only card')

        // Second draw: sold out -> refund (still a VALID execution, just no card).
        await vmHelper.sendDepositV0(buyer, ci2, PAY, PRICE)
        const second = await vmHelper.sendExecuteV0(buyer, ci2, 'draw', [])
        assert(second.execution && second.execution.status === 'valid', 'sold-out draw still indexes valid (refund path)')
        assert.strictEqual(await balanceOf(buyer.address, solo), '1', 'no second card dispensed when sold out')
    })

    it('only the owner can withdraw the accumulated proceeds', async function () {
        // A non-owner withdraw must be rejected.
        const bad = await vmHelper.sendExecuteV0Invalid(buyer, ci, 'withdraw', [PAY])
        assert(bad.execution, 'rejected withdraw should still record a row')
        assert.notStrictEqual(bad.execution.status, 'valid', 'non-owner withdraw must not be valid')

        // The owner sweeps the contract's XCHAIN proceeds (3 from the 3 draws above).
        const ok = await vmHelper.sendExecuteV0(operator, ci, 'withdraw', [PAY])
        assert(ok.execution && ok.execution.status === 'valid', 'owner withdraw should succeed')
        const left = await balanceOf(contractAddr, PAY)
        assert(left === null || left === '0', 'contract proceeds should be swept to the owner')
    })
})
