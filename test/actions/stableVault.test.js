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

// NOTE: aggressively minified (one-letter helpers, terse messages) because a
// DEPLOY payload is capped at 8192 bytes by the encoder; the readable
// canonical source lives in xchain-contracts/stableVault/stableVault.js.
const STABLE_VAULT = `module.exports = {
    initialize: function (x) {
        var ct = x.getInputParam(0), st = x.getInputParam(1), cp = x.getInputParam(2),
            mr = x.getInputParam(3), lb = x.getInputParam(4), ma = x.getInputParam(5);
        x.require(ct, 'collateralTick required');
        x.require(st, 'stableTick required');
        x.require(ct !== st, 'ticks must differ');
        x.require(cp, 'coinPair required');
        x.require(mr && x.math.gt(mr, '100'), 'minRatioPct must exceed 100');
        x.require(lb && x.math.gte(lb, '0'), 'liqBonusPct must be >= 0');
        var mx = parseInt(ma);
        x.require(mx > 0, 'maxSnapshotAge must be positive');
        x.state.set('collateralTick', ct);
        x.state.set('stableTick', st);
        x.state.set('coinPair', cp);
        x.state.set('minRatioPct', mr);
        x.state.set('liqBonusPct', lb);
        x.state.set('maxSnapshotAge', String(mx));
        x.state.set('trackedColl', '0');
        x.state.set('trackedStable', '0');
        x.state.set('totalDebt', '0');
        x.emit.issue({ tick: st });
    },
    deposit: function (x) {
        var a = x.getSourceAddress();
        var d = cd(x);
        x.require(x.math.gt(d, '0'), 'no collateral received');
        sv(x, a, 'coll', x.math.add(gv(x, a, 'coll'), d));
        x.state.set('trackedColl', x.math.add(x.state.get('trackedColl'), d));
    },
    borrow: function (x) {
        var a = x.getSourceAddress();
        var m = x.getInputParam(0);
        x.require(m && x.math.gt(m, '0'), 'amount must be positive');
        var p = fp(x);
        var nd = x.math.add(gv(x, a, 'debt'), m);
        x.require(ok(x, gv(x, a, 'coll'), nd, p), 'under-collateralized');
        sv(x, a, 'debt', nd);
        x.state.set('totalDebt', x.math.add(x.state.get('totalDebt'), m));
        x.emit.mint({ tick: x.state.get('stableTick'), quantity: m });
        x.emit.send({ destination: a, tick: x.state.get('stableTick'), quantity: m });
    },
    repay: function (x) {
        var a = x.getSourceAddress();
        var r = sd(x);
        x.require(x.math.gt(r, '0'), 'no stable received');
        var d = gv(x, a, 'debt');
        var b = x.math.min(r, d);
        var e = x.math.subtract(r, b);
        sv(x, a, 'debt', x.math.subtract(d, b));
        x.state.set('totalDebt', x.math.subtract(x.state.get('totalDebt'), b));
        if (x.math.gt(b, '0')) x.emit.destroy({ tick: x.state.get('stableTick'), quantity: b });
        if (x.math.gt(e, '0')) x.emit.send({ destination: a, tick: x.state.get('stableTick'), quantity: e });
    },
    withdraw: function (x) {
        var a = x.getSourceAddress();
        var m = x.getInputParam(0);
        x.require(m && x.math.gt(m, '0'), 'amount must be positive');
        var c = gv(x, a, 'coll');
        x.require(x.math.gte(c, m), 'insufficient collateral');
        var l = x.math.subtract(c, m);
        var d = gv(x, a, 'debt');
        if (x.math.gt(d, '0')) x.require(ok(x, l, d, fp(x)), 'under-collateralized');
        sv(x, a, 'coll', l);
        x.state.set('trackedColl', x.math.subtract(x.state.get('trackedColl'), m));
        x.emit.send({ destination: a, tick: x.state.get('collateralTick'), quantity: m });
    },
    liquidate: function (x) {
        var q = x.getSourceAddress();
        var o = x.getInputParam(0);
        x.require(o, 'vaultOwner required');
        x.require(q !== o, 'own vault');
        var d = gv(x, o, 'debt');
        x.require(x.math.gt(d, '0'), 'no debt');
        var p = fp(x);
        var c = gv(x, o, 'coll');
        x.require(!ok(x, c, d, p), 'vault is healthy');
        var r = sd(x);
        x.require(x.math.gte(r, d), 'must cover the full debt');
        var e = x.math.subtract(r, d);
        var w = x.math.divide(
            x.math.multiply(d, x.math.add('100', x.state.get('liqBonusPct'))),
            x.math.multiply(p, '100'));
        var z = x.math.min(w, c);
        sv(x, o, 'debt', '0');
        sv(x, o, 'coll', x.math.subtract(c, z));
        x.state.set('totalDebt', x.math.subtract(x.state.get('totalDebt'), d));
        x.state.set('trackedColl', x.math.subtract(x.state.get('trackedColl'), z));
        x.emit.destroy({ tick: x.state.get('stableTick'), quantity: d });
        x.emit.send({ destination: q, tick: x.state.get('collateralTick'), quantity: z });
        if (x.math.gt(e, '0')) x.emit.send({ destination: q, tick: x.state.get('stableTick'), quantity: e });
    }
};
function gv(x, a, f) { return x.state.get('v:' + a + ':' + f) || '0'; }
function sv(x, a, f, v) { x.state.set('v:' + a + ':' + f, v); }
function cd(x) {
    var h = x.getBalance(x.getContractAddress(), x.state.get('collateralTick')) || '0';
    return x.math.subtract(h, x.state.get('trackedColl'));
}
function sd(x) {
    var h = x.getBalance(x.getContractAddress(), x.state.get('stableTick')) || '0';
    return x.math.subtract(h, x.state.get('trackedStable'));
}
function fp(x) {
    x.require(x.oracle.getSnapshotAge() <= parseInt(x.state.get('maxSnapshotAge')), 'stale oracle');
    var r = x.oracle.getPrice(x.state.get('coinPair'));
    x.require(r !== null && r !== undefined, 'no price');
    var p = (typeof r === 'object') ? r.price : r;
    x.require(p !== null && p !== undefined, 'no price');
    p = String(p);
    x.require(x.math.gt(p, '0'), 'bad price');
    return p;
}
function ok(x, c, d, p) {
    if (!x.math.gt(d, '0')) return true;
    return x.math.gte(x.math.multiply(x.math.multiply(c, p), '100'),
        x.math.multiply(d, x.state.get('minRatioPct')));
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
