// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// Stable Vault (on-chain): a mini-MakerDAO -- over-collateralized vaults where
// the CONTRACT issues and mints its own stable token against oracle-priced
// collateral.
//
//   DEPLOY stableVault(collateralTick, stableTick, coinPair, minRatioPct,
//                      liqBonusPct, maxSnapshotAge)
//     -> initialize emits ISSUE(stableTick): the contract is the issuer.
//   vault owner: DEPOSIT(contract, COLL, x) then EXECUTE "deposit"
//                EXECUTE "borrow" amount   -> emits MINT + SEND of the stable
//                DEPOSIT(contract, STABLE, x) then EXECUTE "repay" -> DESTROY
//   anyone:      DEPOSIT(contract, STABLE, >= debt) then EXECUTE "liquidate"
//                once the oracle price puts the vault under the minimum ratio.
//
// This is the first e2e where a contract EMITS ISSUE/MINT/DESTROY on-chain:
// it proves the emission path indexer actionIssue/actionMint/actionDestroy <-
// VM emissionCollector <- contract emit.*, on top of the PRICE-oracle wiring
// already proven by the priceBet suite (getPrice + getSnapshotAge here).
//
// The contract source below is a compacted copy of the canonical template at
// xchain-contracts/stableVault/stableVault.js (kept inline so the test is
// self-contained inside the e2e container). Behaviour is identical; the VM
// unit test (stableVault.test.js in xchain-contracts) covers the full matrix.

const assert = require('assert')
const cryptoHelper = require('../cryptoHelper')
const vmHelper = require('../helpers/vmHelper')
const gasHelper = require('../helpers/gasHelper')
const priceSnapshotHelper = require('../helpers/priceSnapshotHelper')

const STABLE_VAULT = `module.exports = {
    initialize: function (xchain) {
        var collateralTick = xchain.getInputParam(0), stableTick = xchain.getInputParam(1),
            coinPair = xchain.getInputParam(2), minRatioPct = xchain.getInputParam(3),
            liqBonusPct = xchain.getInputParam(4), maxSnapshotAge = xchain.getInputParam(5);
        xchain.require(collateralTick, 'collateralTick required');
        xchain.require(stableTick, 'stableTick required');
        xchain.require(collateralTick !== stableTick, 'collateral and stable must differ');
        xchain.require(coinPair, 'coinPair required');
        xchain.require(minRatioPct && xchain.math.gt(minRatioPct, '100'), 'minRatioPct must exceed 100');
        xchain.require(liqBonusPct && xchain.math.gte(liqBonusPct, '0'), 'liqBonusPct must be >= 0');
        var maxAge = parseInt(maxSnapshotAge);
        xchain.require(maxAge > 0, 'maxSnapshotAge must be a positive integer');
        xchain.state.set('collateralTick', collateralTick);
        xchain.state.set('stableTick', stableTick);
        xchain.state.set('coinPair', coinPair);
        xchain.state.set('minRatioPct', minRatioPct);
        xchain.state.set('liqBonusPct', liqBonusPct);
        xchain.state.set('maxSnapshotAge', String(maxAge));
        xchain.state.set('trackedColl', '0');
        xchain.state.set('trackedStable', '0');
        xchain.state.set('totalDebt', '0');
        xchain.emit.issue({ tick: stableTick });
    },
    deposit: function (xchain) {
        var addr = xchain.getSourceAddress();
        var delta = collDelta(xchain);
        xchain.require(xchain.math.gt(delta, '0'), 'no collateral received');
        setVault(xchain, addr, 'coll', xchain.math.add(getVault(xchain, addr, 'coll'), delta));
        xchain.state.set('trackedColl', xchain.math.add(xchain.state.get('trackedColl'), delta));
    },
    borrow: function (xchain) {
        var addr = xchain.getSourceAddress();
        var amount = xchain.getInputParam(0);
        xchain.require(amount && xchain.math.gt(amount, '0'), 'amount must be positive');
        var price = freshPrice(xchain);
        var coll = getVault(xchain, addr, 'coll');
        var newDebt = xchain.math.add(getVault(xchain, addr, 'debt'), amount);
        xchain.require(ratioOk(xchain, coll, newDebt, price), 'vault would be under-collateralized');
        setVault(xchain, addr, 'debt', newDebt);
        xchain.state.set('totalDebt', xchain.math.add(xchain.state.get('totalDebt'), amount));
        xchain.emit.mint({ tick: xchain.state.get('stableTick'), quantity: amount });
        xchain.emit.send({ destination: addr, tick: xchain.state.get('stableTick'), quantity: amount });
    },
    repay: function (xchain) {
        var addr = xchain.getSourceAddress();
        var received = stableDelta(xchain);
        xchain.require(xchain.math.gt(received, '0'), 'no stable received');
        var debt = getVault(xchain, addr, 'debt');
        var burned = xchain.math.min(received, debt);
        var excess = xchain.math.subtract(received, burned);
        setVault(xchain, addr, 'debt', xchain.math.subtract(debt, burned));
        xchain.state.set('totalDebt', xchain.math.subtract(xchain.state.get('totalDebt'), burned));
        if (xchain.math.gt(burned, '0')) {
            xchain.emit.destroy({ tick: xchain.state.get('stableTick'), quantity: burned });
        }
        if (xchain.math.gt(excess, '0')) {
            xchain.emit.send({ destination: addr, tick: xchain.state.get('stableTick'), quantity: excess });
        }
    },
    withdraw: function (xchain) {
        var addr = xchain.getSourceAddress();
        var amount = xchain.getInputParam(0);
        xchain.require(amount && xchain.math.gt(amount, '0'), 'amount must be positive');
        var coll = getVault(xchain, addr, 'coll');
        xchain.require(xchain.math.gte(coll, amount), 'insufficient collateral');
        var left = xchain.math.subtract(coll, amount);
        var debt = getVault(xchain, addr, 'debt');
        if (xchain.math.gt(debt, '0')) {
            var price = freshPrice(xchain);
            xchain.require(ratioOk(xchain, left, debt, price), 'vault would be under-collateralized');
        }
        setVault(xchain, addr, 'coll', left);
        xchain.state.set('trackedColl', xchain.math.subtract(xchain.state.get('trackedColl'), amount));
        xchain.emit.send({ destination: addr, tick: xchain.state.get('collateralTick'), quantity: amount });
    },
    liquidate: function (xchain) {
        var liquidator = xchain.getSourceAddress();
        var owner = xchain.getInputParam(0);
        xchain.require(owner, 'vaultOwner required');
        xchain.require(liquidator !== owner, 'cannot liquidate your own vault');
        var debt = getVault(xchain, owner, 'debt');
        xchain.require(xchain.math.gt(debt, '0'), 'vault has no debt');
        var price = freshPrice(xchain);
        var coll = getVault(xchain, owner, 'coll');
        xchain.require(!ratioOk(xchain, coll, debt, price), 'vault is healthy');
        var received = stableDelta(xchain);
        xchain.require(xchain.math.gte(received, debt), 'must cover the full debt');
        var excess = xchain.math.subtract(received, debt);
        var owed = xchain.math.divide(
            xchain.math.multiply(debt, xchain.math.add('100', xchain.state.get('liqBonusPct'))),
            xchain.math.multiply(price, '100')
        );
        var seize = xchain.math.min(owed, coll);
        setVault(xchain, owner, 'debt', '0');
        setVault(xchain, owner, 'coll', xchain.math.subtract(coll, seize));
        xchain.state.set('totalDebt', xchain.math.subtract(xchain.state.get('totalDebt'), debt));
        xchain.state.set('trackedColl', xchain.math.subtract(xchain.state.get('trackedColl'), seize));
        xchain.emit.destroy({ tick: xchain.state.get('stableTick'), quantity: debt });
        xchain.emit.send({ destination: liquidator, tick: xchain.state.get('collateralTick'), quantity: seize });
        if (xchain.math.gt(excess, '0')) {
            xchain.emit.send({ destination: liquidator, tick: xchain.state.get('stableTick'), quantity: excess });
        }
    }
};
function getVault(xchain, addr, field) {
    return xchain.state.get('v:' + addr + ':' + field) || '0';
}
function setVault(xchain, addr, field, value) {
    xchain.state.set('v:' + addr + ':' + field, value);
}
function collDelta(xchain) {
    var held = xchain.getBalance(xchain.getContractAddress(), xchain.state.get('collateralTick')) || '0';
    return xchain.math.subtract(held, xchain.state.get('trackedColl'));
}
function stableDelta(xchain) {
    var held = xchain.getBalance(xchain.getContractAddress(), xchain.state.get('stableTick')) || '0';
    return xchain.math.subtract(held, xchain.state.get('trackedStable'));
}
function freshPrice(xchain) {
    var age = xchain.oracle.getSnapshotAge();
    xchain.require(age <= parseInt(xchain.state.get('maxSnapshotAge')), 'oracle price is stale');
    var r = xchain.oracle.getPrice(xchain.state.get('coinPair'));
    xchain.require(r !== null && r !== undefined, 'no oracle price for pair');
    var price = (typeof r === 'object') ? r.price : r;
    xchain.require(price !== null && price !== undefined, 'no oracle price for pair');
    price = String(price);
    xchain.require(xchain.math.gt(price, '0'), 'oracle price must be positive');
    return price;
}
function ratioOk(xchain, coll, debt, price) {
    if (!xchain.math.gt(debt, '0')) return true;
    var lhs = xchain.math.multiply(xchain.math.multiply(coll, price), '100');
    var rhs = xchain.math.multiply(debt, xchain.state.get('minRatioPct'));
    return xchain.math.gte(lhs, rhs);
}`

describe('Stable Vault: mini-MakerDAO (contract-emitted ISSUE/MINT/DESTROY + oracle getPrice)', function () {

    const CHAIN = ({ bitcoin: 'BTC', litecoin: 'LTC', dogecoin: 'DOGE' })[COIN] || 'BTC'
    const COLL = 'XCHAIN'      // collateral = the gas token; nothing extra to issue
    const RATIO = '150'
    const BONUS = '10'
    const MAXAGE = '100000'    // blocks; staleness is unit-tested, not the point here
    // Unique stable tick + oracle pair per run, so reruns never collide with a
    // tick already issued (by a previous contract address) or older snapshots.
    const rand = () => String.fromCharCode(65 + Math.floor(Math.random() * 26))
    const STABLE = 'DU' + rand() + rand() + rand()
    const PAIR = 'XC' + Math.floor(Math.random() * 900 + 100) + '/USD'

    let alice = null           // vault owner who gets liquidated
    let liq = null             // second vault owner acting as liquidator
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
    async function stateOf(key) {
        const rows = await q(`SELECT state_value FROM contract_state
            WHERE contract_index=? AND state_key=?
            ORDER BY id DESC LIMIT 1`, [ci, key])
        if (!rows.length || rows[0].state_value === null) return null
        let v = String(rows[0].state_value)
        try { v = JSON.parse(v) } catch (e) { /* stored raw */ }
        return v
    }
    async function setPrice(price, round) {
        await priceSnapshotHelper.seedSnapshot({
            coinPair: PAIR,
            price: price,
            blockTimestamp: await priceSnapshotHelper.latestBlockTime(),
            roundNumber: round
        })
    }

    before(async function () {
        alice = await cryptoHelper.getNewFundedAddress('vault-alice', COIN, NETWORK, null, 'legacy', 0, 1)
        liq = await cryptoHelper.getNewFundedAddress('vault-liq', COIN, NETWORK, null, 'legacy', 0, 1)
        await gasHelper.ensureGasBalance(alice, '2000')
        await gasHelper.ensureGasBalance(liq, '2000')
        assert(await priceSnapshotHelper.isAvailable(), 'price_snapshots must be reachable for this suite')
        await priceSnapshotHelper.clearPair(PAIR)
    })

    it('deploys the vault system and ISSUEs its own stable token', async function () {
        const params = [COLL, STABLE, PAIR, RATIO, BONUS, MAXAGE].join('|')
        const dep = await vmHelper.sendDeployV0(alice, STABLE_VAULT, 1000000, params)
        ci = dep.contract.action_index
        contractAddr = `C:${CHAIN}:${ci}`
        assert.strictEqual(await stateOf('stableTick'), STABLE, 'terms should be persisted')
        assert.strictEqual(await stateOf('totalDebt'), '0')

        // The emitted ISSUE must have registered the stable with the CONTRACT
        // as its issuer.
        const issued = await q(
            `SELECT source FROM issues WHERE tick=? ORDER BY id DESC LIMIT 1`, [STABLE])
        assert(issued.length, 'contract-emitted ISSUE should land in the issues table')
        assert.strictEqual(String(issued[0].source), contractAddr, 'the contract is the issuer')
    })

    it('deposit collateral, borrow the stable up to the ratio limit, not a unit more', async function () {
        await setPrice('100.00000000', 1)

        await vmHelper.sendDepositV0(alice, ci, COLL, '3')
        const dep = await vmHelper.sendExecuteV0(alice, ci, 'deposit', [])
        assert(dep.execution && dep.execution.status === 'valid', 'deposit should index a valid execution')
        assert.strictEqual(await stateOf('v:' + alice.address + ':coll'), '3')

        // 3 XCHAIN * $100 * 100 = 30000 >= debt * 150  ->  max debt 200.
        const ex = await vmHelper.sendExecuteV0(alice, ci, 'borrow', ['200'])
        assert(ex.execution && ex.execution.status === 'valid',
            'borrow should index a valid execution (emitted MINT + SEND)')
        assert.strictEqual(Number(await balanceOf(alice.address, STABLE)), 200,
            'the borrower holds the freshly minted stable')
        assert.strictEqual(await stateOf('v:' + alice.address + ':debt'), '200')

        const over = await vmHelper.sendExecuteV0Invalid(alice, ci, 'borrow', ['1'])
        assert(over.execution, 'over-borrow should still record an execution row')
        assert.notStrictEqual(over.execution.status, 'valid', 'over-borrow must not be valid')
    })

    it('repay burns the stable against the debt (emitted DESTROY)', async function () {
        await vmHelper.sendDepositV0(alice, ci, STABLE, '50')
        const ex = await vmHelper.sendExecuteV0(alice, ci, 'repay', [])
        assert(ex.execution && ex.execution.status === 'valid', 'repay should index a valid execution')
        assert.strictEqual(await stateOf('v:' + alice.address + ':debt'), '150')
        assert.strictEqual(await stateOf('totalDebt'), '150')
        assert.strictEqual(Number(await balanceOf(alice.address, STABLE)), 150)
        // Burned, not held: the 50 must NOT sit in contract custody.
        const held = await balanceOf(contractAddr, STABLE)
        assert(held === null || Number(held) === 0, 'repaid stable should be destroyed')
    })

    it('liquidating a healthy vault is rejected on-chain', async function () {
        // No stable deposit needed: the health check fires before funding.
        const ex = await vmHelper.sendExecuteV0Invalid(liq, ci, 'liquidate', [alice.address])
        assert(ex.execution, 'rejected liquidate should still record an execution row')
        assert.notStrictEqual(ex.execution.status, 'valid', 'liquidating a healthy vault must not be valid')
        assert.strictEqual(await stateOf('v:' + alice.address + ':debt'), '150', 'vault must be untouched')
    })

    it('price drop: a second vault borrows the stable and liquidates the first', async function () {
        // The liquidator sources stable the honest way: their own vault.
        await vmHelper.sendDepositV0(liq, ci, COLL, '3')
        const dep = await vmHelper.sendExecuteV0(liq, ci, 'deposit', [])
        assert(dep.execution && dep.execution.status === 'valid')
        const bor = await vmHelper.sendExecuteV0(liq, ci, 'borrow', ['150'])
        assert(bor.execution && bor.execution.status === 'valid')

        // Round 2 finalizes at $60: alice's vault is under water
        // (3 * 60 * 100 = 18000 < 150 * 150 = 22500). The liquidator's own
        // vault is equally under water, which is irrelevant: being under-
        // collateralized exposes you to liquidation, it does not block you
        // from liquidatING. Seizure: 150 * 110 / (60 * 100) = 2.75 XCHAIN.
        await setPrice('60.00000000', 2)

        const collBefore = Number(await balanceOf(liq.address, COLL))
        await vmHelper.sendDepositV0(liq, ci, STABLE, '150')
        const ex = await vmHelper.sendExecuteV0(liq, ci, 'liquidate', [alice.address])
        assert(ex.execution && ex.execution.status === 'valid',
            'liquidate should index a valid execution (DESTROY debt + SEND collateral)')

        const collAfter = Number(await balanceOf(liq.address, COLL))
        assert.strictEqual(Math.round((collAfter - collBefore) * 1e8) / 1e8, 2.75,
            'liquidator seizes debt + 10% bonus at the oracle price')
        assert.strictEqual(Number(await stateOf('v:' + alice.address + ':coll')), 0.25,
            'the leftover collateral stays credited to the vault owner')
        assert.strictEqual(await stateOf('v:' + alice.address + ':debt'), '0')
        assert.strictEqual(await stateOf('totalDebt'), '150', 'only the liquidator debt remains')
        const held = await balanceOf(contractAddr, STABLE)
        assert(held === null || Number(held) === 0, 'the covered debt should be destroyed')

        // The former owner can still withdraw their leftover collateral.
        const wd = await vmHelper.sendExecuteV0(alice, ci, 'withdraw', ['0.25'])
        assert(wd.execution && wd.execution.status === 'valid', 'debt-free withdraw should be valid')
    })
})
