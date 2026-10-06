// Copyright © 2025–2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const STABLE_VAULT = `module.exports = {
    meta: { name: 'Stable Vault', description: 'Mints a stable token against collateral deposited into the vault.', version: '1.0.0' },
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
        x.emit.issue({ tick: st, decimals: '0', maxSupply: '1000000000' });
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

module.exports = { STABLE_VAULT }
