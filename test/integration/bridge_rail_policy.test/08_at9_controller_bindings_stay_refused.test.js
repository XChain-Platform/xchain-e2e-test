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
 * Policy AT9 (controller refusals under R1(a)): format 7 on a controller-bound token and
 * format 6 on the bridged token are both still refused above the flag with the milestone-1
 * verdicts. Runs before AT8, whose reorg moves the DOGE ledger these claims are about.
 *
 * A REAL CONTROLLER, because both refusals sit behind the CONTROLLER-active check: a format 6
 * naming no deployed contract is refused `invalid: CONTROLLER (unknown)` before the bridge rule
 * is ever reached (xchain-indexer src/actions/issue/index.js validation order), which would pass
 * this case for the wrong reason. The guard is the controller suite's own shape, deployed on
 * BTC regtest by P2SH with gas funded the way that suite funds it.
 *
 * FORMAT 6 IN BOTH PLACES THE SPEC'S SENTENCE CAN MEAN. On the ORIGIN row, by its owner, the
 * milestone-1 bridge rule is what refuses it. On the DOGE COPY the keyless owner refuses any
 * user first (`invalid: issued by another address`), which is recorded as the copy half.
 *
 ********************************************************************/

'use strict';

const gasHelper = require('../../helpers/gasHelper');
const { controllerBindWire } = require('../../helpers/bridgeRailVenue');
const {
    assert,
    optInWire,
    issueHelper,
    transactionHelper,
    state,
    btcAction,
    dogeAction,
    fundBtc,
    fundDoge,
    pickFreeTick,
    needsFederation,
    bridgeRailSuite,
} = require('./support');

const GROUP = 'policy AT9: controller bindings stay refused';
const NOT_BRIDGEABLE = 'invalid: TICK (policy-bound tokens are not bridgeable yet)';
const NOT_BINDABLE = 'invalid: TICK (bridged tokens cannot be policy-bound yet)';

// A guard that allows everything: the claim is about binding it, never about what it gates.
const PASS_GUARD = "module.exports = { meta: { name: 'Policy Rail Gate', description: 'Controller guard for policy AT9.', " +
    "version: '1.0.0' }, guard: function(){ return {}; }};";

// A deployed guard contract on BTC regtest, graded on the venue BTC ledger.
async function deployGuard(owner) {
    await gasHelper.ensureGasBalance(owner, '5000');
    const wire = 'DEPLOY|0|' + Buffer.from(PASS_GUARD, 'utf8').toString('base64') + '|250000';
    const dep = await btcAction(owner, () => transactionHelper.createAndSendTransaction(owner, wire, null, [], 'P2SH'), 'contracts');
    assert.strictEqual(dep.status, 'valid', 'the guard DEPLOY graded ' + dep.status);
    return dep.actionIndex;
}

bridgeRailSuite(GROUP, function () {
    it('policy AT9 (origin): format 7 on a controller-bound token and format 6 on the bridged origin row are refused with the milestone-1 verdicts', async function () {
        this.timeout(0);
        if (needsFederation(this, 'policy AT9 origin')) return;
        const M = state.policy.main;
        const C = state.policy.ctl;
        assert.ok(M.seq2, 'AT1 and AT2 must have run, so the origin row is bridged');
        C.owner = await fundBtc('POLICY.AT9.OWNER');
        C.guard = await deployGuard(C.owner);
        C.tick = await pickFreeTick(['CTLA', 'CTLB', 'CTLC']);
        assert.ok(C.tick, 'no free tick for the controller-bound token');
        const issue = await btcAction(C.owner, () => issueHelper.sendIssueV0Raw(C.owner, C.tick, 1000, 1000, 0, 'policy AT9', 10), 'issues');
        assert.strictEqual(issue.status, 'valid', 'ISSUE ' + C.tick + ' graded ' + issue.status);
        const bind = await btcAction(C.owner, controllerBindWire(C.tick, C.guard, 'transfer', 0, 'policy AT9 bind'), 'issues');
        assert.strictEqual(bind.status, 'valid', 'the controller bind on ' + C.tick + ' graded ' + bind.status);
        const optIn = await btcAction(C.owner, optInWire(C.tick, 'DOGE', '', '', 'policy AT9 opt-in'), 'issues');
        const bindBridged = await btcAction(M.issuer, controllerBindWire(M.tick, C.guard, 'transfer', 0, 'policy AT9 bridged'), 'issues');
        state.evidence.at9_origin = { guard: C.guard, tick: C.tick, bind, optIn, bindBridged };
        assert.strictEqual(optIn.status, NOT_BRIDGEABLE, 'format 7 on a controller-bound token graded ' + optIn.status);
        assert.strictEqual(bindBridged.status, NOT_BINDABLE, 'format 6 on the bridged origin row ' + M.tick + ' graded ' + bindBridged.status);
    });
});

bridgeRailSuite(GROUP, function () {
    it('policy AT9 (copy): format 6 on the DOGE copy by any key is refused, and the copy binds no controller', async function () {
        this.timeout(0);
        if (needsFederation(this, 'policy AT9 copy')) return;
        const M = state.policy.main;
        const C = state.policy.ctl;
        assert.ok(C.guard, 'the origin half must have run');
        const user = await fundDoge('POLICY.AT9.USER', 2);
        const got = await dogeAction(user, controllerBindWire('BTC.' + M.tick, C.guard, 'transfer', 0, 'policy AT9 copy'), 'issues');
        const bound = await state.venue.queryIndexerDb('DOGE',
            'SELECT COUNT(*) AS n FROM token_controllers tc INNER JOIN index_tickers ti ON (ti.id = tc.tick_id) WHERE ti.tick = ?',
            ['BTC.' + M.tick]);
        state.evidence.at9_copy = { got, controllerEvents: Number(bound[0].n) };
        assert.strictEqual(got.status, 'invalid: issued by another address', 'format 6 on the DOGE copy graded ' + got.status);
        assert.strictEqual(Number(bound[0].n), 0, 'the DOGE copy holds ' + bound[0].n + ' controller events');
    });
});
