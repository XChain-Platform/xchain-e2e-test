/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 *
 * Token AT3: a v3 of a token whose BRIDGE_CHAINS excludes DOGE is refused; the owner adds
 * DOGE with format 7 and the same lock then applies; the owner sets BRIDGE_CHAINS=- and a
 * new lock is refused while a v4 burn of the existing balance still applies; the owner
 * sets LOCK_BRIDGE=1 and a further format 7 is refused `BRIDGE_CHAINS (locked)`.
 *
 ********************************************************************/

'use strict';

const {
    assert,
    lockWireV3,
    burnWireV4,
    optInWire,
    issueHelper,
    state,
    btcAction,
    dogeAction,
    fundBtc,
    fundDoge,
    pickFreeTick,
    settleLeg,
    needsFederation,
    bridgeRailSuite,
} = require('./support');

const GROUP = 'token AT3: BRIDGE_CHAINS and LOCK_BRIDGE govern the lock';
const NOT_BRIDGEABLE = 'invalid: TICK (not bridgeable to DEST_COIN)';

// A second token, opted in to LTC only, so DOGE is the excluded chain.
async function issueLtcOnly() {
    const A = state.tokens.at3;
    A.tick = await pickFreeTick(['GUGU', 'GUGB', 'GUGC']);
    assert.ok(A.tick, 'no free second tick');
    A.issuer = await fundBtc('TOKEN.AT3.ISSUER');
    A.dest = await fundDoge('TOKEN.AT3.DEST', 5);
    const steps = {};
    steps.issue = await btcAction(A.issuer, () => issueHelper.sendIssueV0Raw(A.issuer, A.tick, 1000, 1000, 0, 'token AT3', 50), 'issues');
    assert.strictEqual(steps.issue.status, 'valid', 'ISSUE ' + A.tick + ' graded ' + steps.issue.status);
    steps.optInLtcOnly = await btcAction(A.issuer, optInWire(A.tick, 'LTC', '', '', 'AT3 LTC only'), 'issues');
    assert.strictEqual(steps.optInLtcOnly.status, 'valid', 'ISSUE|7 BRIDGE_CHAINS=LTC graded ' + steps.optInLtcOnly.status);
    return steps;
}

bridgeRailSuite(GROUP, function () {
    it('token AT3: a lock to an excluded chain is refused, and the same lock applies once the owner adds DOGE with format 7', async function () {
        this.timeout(0);
        if (needsFederation(this, 'token AT3 opt-in')) return;
        const A = state.tokens.at3;
        const steps = await issueLtcOnly();
        state.evidence.at3 = steps;
        steps.lockExcluded = await btcAction(A.issuer, lockWireV3(A.tick, 'DOGE', A.dest.address, 1, 'AT3 excluded'), 'xbridges');
        assert.strictEqual(steps.lockExcluded.status, NOT_BRIDGEABLE, 'the lock to the excluded chain graded ' + steps.lockExcluded.status);
        steps.optInAddDoge = await btcAction(A.issuer, optInWire(A.tick, 'DOGE,LTC', '', '', 'AT3 add DOGE'), 'issues');
        assert.strictEqual(steps.optInAddDoge.status, 'valid', 'ISSUE|7 BRIDGE_CHAINS=DOGE,LTC graded ' + steps.optInAddDoge.status);
        steps.lockApplies = await btcAction(A.issuer, lockWireV3(A.tick, 'DOGE', A.dest.address, 3, 'AT3 applies'), 'xbridges');
        assert.strictEqual(steps.lockApplies.status, 'valid', 'the same lock after the opt-in graded ' + steps.lockApplies.status);
        const leg = await settleLeg('the AT3 lock',
            (r) => String(r.src_chain) === 'BTC' && String(r.dest_address) === A.dest.address && String(r.tick) === A.tick, 'DOGE');
        steps.lockTransfer = leg.transfer;
        steps.destBalance = await state.venue.addressBalance('DOGE', A.dest.address, 'BTC.' + A.tick);
        assert.strictEqual(Number(steps.destBalance), 3, A.dest.address + ' holds ' + steps.destBalance + ' BTC.' + A.tick);
    });
});

bridgeRailSuite(GROUP, function () {
    it('token AT3: after BRIDGE_CHAINS=- a new lock is refused while a v4 burn of the existing balance still applies', async function () {
        this.timeout(0);
        if (needsFederation(this, 'token AT3 close')) return;
        const A = state.tokens.at3;
        const steps = state.evidence.at3;
        assert.ok(steps && steps.lockTransfer, 'the opt-in half must have run');
        steps.optInNone = await btcAction(A.issuer, optInWire(A.tick, '-', '', '', 'AT3 none'), 'issues');
        assert.strictEqual(steps.optInNone.status, 'valid', 'ISSUE|7 BRIDGE_CHAINS=- graded ' + steps.optInNone.status);
        steps.lockAfterNone = await btcAction(A.issuer, lockWireV3(A.tick, 'DOGE', A.dest.address, 1, 'AT3 after none'), 'xbridges');
        assert.strictEqual(steps.lockAfterNone.status, NOT_BRIDGEABLE, 'a lock after BRIDGE_CHAINS=- graded ' + steps.lockAfterNone.status);
        steps.burnAfterNone = await dogeAction(A.dest, burnWireV4('BTC.' + A.tick, A.issuer.address, 1, 'AT3 burn'), 'xbridges');
        assert.strictEqual(steps.burnAfterNone.status, 'valid', 'the v4 burn after BRIDGE_CHAINS=- graded ' + steps.burnAfterNone.status);
        const leg = await settleLeg('the AT3 burn',
            (r) => String(r.src_chain) === 'DOGE' && String(r.dest_address) === A.issuer.address && String(r.tick) === A.tick, 'BTC');
        steps.burnTransfer = leg.transfer;
        steps.destBalanceAfterBurn = await state.venue.addressBalance('DOGE', A.dest.address, 'BTC.' + A.tick);
        assert.strictEqual(Number(steps.destBalanceAfterBurn), 2, A.dest.address + ' holds ' + steps.destBalanceAfterBurn + ' after the burn');
    });
});

bridgeRailSuite(GROUP, function () {
    it('token AT3: LOCK_BRIDGE=1 freezes the fields and a further format 7 is refused BRIDGE_CHAINS (locked)', async function () {
        this.timeout(0);
        if (needsFederation(this, 'token AT3 lock')) return;
        const A = state.tokens.at3;
        const steps = state.evidence.at3;
        assert.ok(steps && steps.burnTransfer, 'the close half must have run');
        steps.lockBridge = await btcAction(A.issuer, optInWire(A.tick, '', '', '1', 'AT3 lock'), 'issues');
        assert.strictEqual(steps.lockBridge.status, 'valid', 'ISSUE|7 LOCK_BRIDGE=1 graded ' + steps.lockBridge.status);
        steps.optInAfterLock = await btcAction(A.issuer, optInWire(A.tick, 'DOGE', '', '', 'AT3 after lock'), 'issues');
        assert.strictEqual(steps.optInAfterLock.status, 'invalid: BRIDGE_CHAINS (locked)');
        const row = await state.venue.tokenParameters('BTC', A.tick);
        steps.btcRow = row;
        assert.strictEqual(String(row.params.lock_bridge), '1', 'the BTC row reads lock_bridge ' + row.params.lock_bridge);
    });
});
