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
 * Token AT6 (policy and roots). The reserved roots and the R8 namespace on DOGE, from a
 * user; then the policy direction on the ORIGIN rows, from their owners: format 7 on a
 * token with a BLOCK_LIST, and format 5 or a format 0 carrying a list on a bridged token,
 * before and after BRIDGE_CHAINS=-.
 *
 * THE POLICY VERDICTS FOLLOW THE FLAG, READ FROM THE INDEXER'S OWN REGISTRY at the case's
 * block (the root says why): below TOKEN_POLICY_INHERITANCE_ACTIVATION they are the token
 * spec's milestone-1 refusals, verbatim; at or above it (regtest today) the policy spec's
 * flag day has lifted them and each one applies. Both readings are journaled with the
 * flag state beside them, so a run on either side of the flag proves the verdicts that
 * side owes.
 *
 * The policy legs run on the depth tick (bridgeable and bridged, not needed later) and
 * on AT3's tick (bridged, then set to `-`), never on FUFU, whose bridgeability AT7 and
 * AT8 still depend on.
 *
 ********************************************************************/

'use strict';

const {
    assert,
    optInWire,
    issueHelper,
    state,
    btcAction,
    dogeAction,
    fundBtc,
    fundDoge,
    pickFreeTick,
    policyInheritanceActive,
    needsFederation,
    bridgeRailSuite,
} = require('./support');

const GROUP = 'token AT6: policy and roots';
const NOT_BRIDGEABLE_POLICY = 'invalid: TICK (policy-bound tokens are not bridgeable yet)';
const NOT_BINDABLE_BRIDGED  = 'invalid: TICK (bridged tokens cannot be policy-bound yet)';

bridgeRailSuite(GROUP, function () {
    it('token AT6 (roots and R8 namespace): btc, BTC, ETH, eth and BASE are reserved, ABC and Z fail length, ABCD applies, ETH.ANY has no parent', async function () {
        this.timeout(0);
        if (needsFederation(this, 'token AT6 roots')) return;
        const user = await fundDoge('TOKEN.AT6.USER', 5);
        const r = {};
        for (const tick of ['btc', 'BTC', 'ETH', 'eth', 'BASE', 'ABC', 'Z', 'ABCD', 'ETH.ANY']) {
            r['issue_' + tick] = await dogeAction(user, () => issueHelper.sendIssueV0Raw(user, tick, 1000, 1000, 0, 'AT6', 0), 'issues');
        }
        state.evidence.at6_roots = r;
        for (const tick of ['btc', 'BTC', 'ETH', 'eth', 'BASE'])
            assert.strictEqual(r['issue_' + tick].status, 'invalid: TICK (reserved)', 'ISSUE ' + tick + ' graded ' + r['issue_' + tick].status);
        for (const tick of ['ABC', 'Z'])
            assert.strictEqual(r['issue_' + tick].status, 'invalid: TICK (length)', 'ISSUE ' + tick + ' graded ' + r['issue_' + tick].status);
        assert.strictEqual(r['issue_ETH.ANY'].status, 'invalid: TICK (parent unknown)', 'ISSUE ETH.ANY graded ' + r['issue_ETH.ANY'].status);
        assert.strictEqual(r.issue_ABCD.status, 'valid', 'ISSUE ABCD graded ' + r.issue_ABCD.status);
    });
});

bridgeRailSuite(GROUP, function () {
    it('token AT6 (R8): a ^id edit of a pre-flag three-character row applies', function () {
        // Not drivable on this rail: TICK_NAMESPACE_ACTIVATION is height 0 on regtest, so
        // no three-character row can exist below the flag to be edited above it. The
        // indexer's unit tier carries it; named here so the gap is visible.
        console.log('  token AT6 pre-flag ^id edit NOT DRIVABLE on regtest (TICK_NAMESPACE_ACTIVATION is 0); unit-covered in xchain-indexer');
        this.skip();
    });
});

// A type-2 LIST on BTC from `owner`, the list every policy leg below points at.
async function addressList(owner, member) {
    const list = await btcAction(owner, 'LIST|0|2||' + member, 'lists');
    assert.strictEqual(list.status, 'valid', 'the BTC address LIST graded ' + list.status);
    return list.actionIndex;
}

async function flagAtTip() {
    const tip = Number(await nodeConnector.getBlockCount());
    const active = policyInheritanceActive(tip + 1);
    state.evidence.at6_policyFlag = { btcTip: tip, policyInheritanceActive: active };
    console.log('  token AT6 policy verdicts read ' + (active ? 'ABOVE' : 'BELOW') + ' TOKEN_POLICY_INHERITANCE_ACTIVATION at BTC ' + tip);
    return active;
}

bridgeRailSuite(GROUP, function () {
    it('token AT6 (opt-in direction): format 7 on a token with a BLOCK_LIST is refused below the policy flag and applies above it', async function () {
        this.timeout(0);
        if (needsFederation(this, 'token AT6 opt-in direction')) return;
        const active = await flagAtTip();
        const owner = await fundBtc('TOKEN.AT6.LISTED.OWNER');
        const tick = await pickFreeTick(['LSTD', 'LSTE', 'LSTF']);
        assert.ok(tick, 'no free tick for the listed token');
        const r = { tick };
        r.issue = await btcAction(owner, () => issueHelper.sendIssueV0Raw(owner, tick, 1000, 1000, 0, 'AT6 listed', 10), 'issues');
        assert.strictEqual(r.issue.status, 'valid', 'ISSUE ' + tick + ' graded ' + r.issue.status);
        r.listIndex = await addressList(owner, state.tokens.btcReceiver.address);
        // The list is attached BEFORE any bridge field exists, so this format 5 is judged by
        // neither direction guard and the token is a plain policy-bound row.
        r.attachList = await btcAction(owner, ['ISSUE', '5', tick, '', r.listIndex, 'AT6 block list'].join('|'), 'issues');
        assert.strictEqual(r.attachList.status, 'valid', 'ISSUE|5 attaching the BLOCK_LIST graded ' + r.attachList.status);
        r.optIn = await btcAction(owner, optInWire(tick, 'DOGE', '', '', 'AT6 opt-in of a listed token'), 'issues');
        state.evidence.at6_optInDirection = r;
        assert.strictEqual(r.optIn.status, active ? 'valid' : NOT_BRIDGEABLE_POLICY,
            'ISSUE|7 on a BLOCK_LIST token graded ' + r.optIn.status + ' with the policy flag ' + (active ? 'active' : 'at the sentinel'));
    });
});

// Format 5 and a format 0 carrying a list, from the owner, on one origin row.
async function policyFormatsOn(owner, tick, listIndex, decimals) {
    const r = {};
    r.format5 = await btcAction(owner, ['ISSUE', '5', tick, '', listIndex, 'AT6 format 5'].join('|'), 'issues');
    r.format0WithList = await btcAction(owner, () => issueHelper.sendIssueV0Raw(owner, tick, 1000, 1000, decimals, 'AT6 format 0', 0,
        '', '', '', '', '', '', '', '', '', '', '', String(listIndex)), 'issues');
    return r;
}

bridgeRailSuite(GROUP, function () {
    it('token AT6 (policy direction): format 5 and a format 0 carrying a list on a bridged token are refused below the flag and apply above it, and read the same after BRIDGE_CHAINS=-', async function () {
        this.timeout(0);
        if (needsFederation(this, 'token AT6 policy direction')) return;
        const active = await flagAtTip();
        const D = state.tokens.at5, A = state.tokens.at3;
        assert.ok(D.issuer && state.evidence.at5_depth && state.evidence.at5_depth.transfer, 'the AT5 depth leg must have bridged its token');
        assert.ok(A.issuer && state.evidence.at3 && state.evidence.at3.lockBridge, 'AT3 must have bridged and then closed its token');
        const listIndex = await addressList(D.issuer, state.tokens.btcReceiver.address);
        const want = active ? 'valid' : NOT_BINDABLE_BRIDGED;
        const r = { listIndex };
        r.bridgeable = await policyFormatsOn(D.issuer, D.tick, listIndex, 0);
        r.afterNone = await policyFormatsOn(A.issuer, A.tick, await addressList(A.issuer, state.tokens.btcReceiver.address), 0);
        state.evidence.at6_policyDirection = r;
        for (const [name, got] of [['format 5 on the bridgeable token', r.bridgeable.format5],
                                   ['format 0 with a list on the bridgeable token', r.bridgeable.format0WithList],
                                   ['format 5 after BRIDGE_CHAINS=-', r.afterNone.format5],
                                   ['format 0 with a list after BRIDGE_CHAINS=-', r.afterNone.format0WithList]]) {
            assert.strictEqual(got.status, want, name + ' graded ' + got.status + ' with the policy flag ' + (active ? 'active' : 'at the sentinel'));
        }
    });
});
