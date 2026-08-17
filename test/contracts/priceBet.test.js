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
//
// "Behaviour is identical" is a claim that rots: this copy silently missed the
// accept() betting-window guard when it landed canonically, so the e2e was
// exercising a strictly weaker contract than the one that ships while still
// reporting green. The parity block at the bottom of this file now reads the
// canonical template and fails if a guard is missing here, whenever the sibling
// checkout is reachable. Re-compact this copy when the template changes.

const assert = require('assert')
const fs = require('fs')
const path = require('path')
const cryptoHelper = require('../cryptoHelper')
const vmHelper = require('../helpers/vmHelper')
const gasHelper = require('../helpers/gasHelper')
const priceSnapshotHelper = require('../helpers/priceSnapshotHelper')

const MAX_ROUND = 1000000000
const MAX_WINDOW_BLOCKS = 1000000

const PRICE_BET = `var MAX_ROUND = ${MAX_ROUND};
var MAX_WINDOW_BLOCKS = ${MAX_WINDOW_BLOCKS};
module.exports = {
    initialize: function (xchain) {
        var maker = xchain.getInputParam(0), coinPair = xchain.getInputParam(1),
            strike = xchain.getInputParam(2), side = xchain.getInputParam(3),
            tick = xchain.getInputParam(4), amount = xchain.getInputParam(5),
            settleRound = xchain.getInputParam(6), deadlineBlocks = xchain.getInputParam(7);
        xchain.require(maker, 'maker required');
        xchain.require(coinPair, 'coinPair required');
        xchain.require(strike && xchain.math.gt(strike, '0'), 'strike must be positive');
        requirePlainDecimal(xchain, strike, 'strike');
        xchain.require(side === 'OVER' || side === 'UNDER', 'side must be OVER or UNDER');
        xchain.require(tick, 'tick required');
        xchain.require(amount && xchain.math.gt(amount, '0'), 'amount must be positive');
        requirePlainDecimal(xchain, amount, 'amount');
        requireIntInRange(xchain, settleRound, 1, MAX_ROUND, 'settleRound');
        requireIntInRange(xchain, deadlineBlocks, 1, MAX_WINDOW_BLOCKS, 'deadlineBlocks');
        var round = parseInt(settleRound, 10);
        var window = parseInt(deadlineBlocks, 10);
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
        xchain.require(roundPrice(xchain) === null, 'settle round already published');
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
function tickDecimals(xchain, tick) {
    var info = xchain.getTokenInfo(tick);
    xchain.require(info && info.DECIMALS !== null && info.DECIMALS !== undefined,
        'token decimals unavailable: ' + tick);
    return info.DECIMALS;
}
function floorToDecimals(value, decimals) {
    var s = String(value);
    var neg = s.charAt(0) === '-';
    if (neg) s = s.substring(1);
    var dot = s.indexOf('.');
    if (dot < 0) return value;
    var frac = s.substring(dot + 1);
    if (frac.length <= decimals) return value;
    var kept = decimals > 0 ? '.' + frac.substring(0, decimals) : '';
    var out = s.substring(0, dot) + kept;
    return neg ? '-' + out : out;
}
function refundBoth(xchain) {
    var tick = xchain.state.get('tick');
    var amount = floorToDecimals(xchain.state.get('amount'), tickDecimals(xchain, tick));
    var rest = xchain.math.subtract(held(xchain), amount);
    xchain.emit.send({ destination: xchain.state.get('maker'), tick: tick, quantity: amount });
    if (xchain.math.gt(rest, '0')) {
        xchain.emit.send({ destination: xchain.state.get('taker'), tick: tick, quantity: rest });
    }
}
function requirePlainDecimal(xchain, value, label) {
    var s = String(value);
    xchain.require(s.length > 0, label + ' must be a plain decimal string');
    var dot = -1;
    for (var i = 0; i < s.length; i++) {
        var c = s.charAt(i);
        if (c === '.') {
            xchain.require(dot < 0, label + ' must carry at most one decimal point');
            xchain.require(i > 0 && i < s.length - 1,
                label + ' needs digits on both sides of its decimal point');
            dot = i;
        } else {
            xchain.require(c >= '0' && c <= '9',
                label + ' must be a plain decimal: digits and one optional decimal point, ' +
                'no exponent / sign / radix prefix (got "' + s + '")');
        }
    }
}
function requireIntInRange(xchain, v, min, max, name) {
    var msg = name + ' must be an integer in [' + min + ', ' + max + ']';
    var s = (typeof v === 'string') ? v : '';
    var i = (s.charAt(0) === '-') ? 1 : 0;
    var ok = s.length > i;
    for (; i < s.length; i++) {
        var ch = s.charAt(i);
        if (ch < '0' || ch > '9') { ok = false; break; }
    }
    xchain.require(ok, msg);
    var n = parseInt(s, 10);
    xchain.require(n >= min && n <= max, msg);
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

// --- Canonical-template parity ----------------------------------------------
//
// PRICE_BET above is a hand-compacted copy of xchain-contracts/priceBet/priceBet.js.
// Compaction is fine; silently dropping a guard is not, and that is exactly what
// happened once: accept() gained a betting-window check upstream (a taker who
// matches AFTER the settle round is published is exercising a free option on the
// maker's stake, not taking a bet) and this copy never got it, so the e2e kept
// certifying a weaker contract than the one that ships.
//
// Pin it cheaply: every guard MESSAGE the canonical template can throw must exist
// in the copy. Messages are the observable surface of a require, so a new or
// changed guard upstream cannot land without showing up here. This is a source
// check, not a chain check, so it costs nothing and needs no services.
//
// Skips (loudly) when the sibling checkout is not mounted, e.g. inside a slim e2e
// container. On any developer machine and on CI, where the siblings ARE checked
// out, it runs.
describe('Price Bet: inline copy matches the canonical template', function () {
    const CANONICAL = path.join(__dirname, '..', '..', '..', 'xchain-contracts', 'priceBet', 'priceBet.js')

    // Every single-quoted literal appearing inside an xchain.require(...) call.
    // Concatenated messages contribute each of their fragments, which is what we
    // want: a reworded fragment is a changed guard.
    function requireMessages(source) {
        const out = new Set()
        const calls = source.match(/xchain\.require\(([\s\S]*?)\);/g) || []
        for (const call of calls) {
            const literals = call.match(/'((?:[^'\\]|\\.)*)'/g) || []
            for (const lit of literals) out.add(lit.slice(1, -1))
        }
        return out
    }

    let canonicalSource = null
    before(function () {
        try { canonicalSource = fs.readFileSync(CANONICAL, 'utf8') }
        catch (e) {
            console.log('Skipping priceBet template parity: xchain-contracts not mounted at ' + CANONICAL)
        }
    })

    it('carries every guard message the canonical template can throw', function () {
        if (canonicalSource === null) return this.skip()
        const missing = [...requireMessages(canonicalSource)].filter(m => !PRICE_BET.includes(m))
        assert.deepStrictEqual(missing, [],
            'inline priceBet copy is missing canonical guard(s): ' + JSON.stringify(missing) +
            ' - re-compact PRICE_BET from ' + CANONICAL)
    })

    it('carries the accept() betting-window guard specifically', function () {
        // The one that was actually lost. Named on its own so a regression reads
        // as the security finding it is, not as a generic parity diff.
        assert.ok(PRICE_BET.includes('settle round already published'),
            'accept() must reject a taker once the settle round is public')
    })
})
