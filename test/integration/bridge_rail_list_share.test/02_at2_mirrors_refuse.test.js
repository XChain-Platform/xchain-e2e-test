/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 *********************************************************************/

'use strict';

const {
    assert,
    state,
    fundChain,
    newAddress,
    pickFreeTick,
    chainAction,
    issueHelper,
    listEditWire,
    issueListsWire,
    sendWire,
    waitForMirrorSeq,
    listOrigin,
    needsFederation,
    bridgeRailSuite,
} = require('./support');

async function assertMirror(chain) {
    const M = state.listShare.home;
    const mirror = await waitForMirrorSeq(chain, 1);
    const heightField = 'admit_block_' + chain.toLowerCase();
    assert.strictEqual(Number(mirror.applied.block_index), Number(M.seq1[heightField]),
        chain + ' applied seq 1 away from its signed effective height');
    assert.strictEqual(String(mirror.list.hash), String(M.seq1.members_hash),
        chain + ' mirror hash differs from seq 1');
    const origin = await listOrigin(chain, mirror.mapping.action_index);
    const owner = await state.venue.roleAddress(chain, 'BRIDGE_DOGE');
    assert.strictEqual(String(origin.source), String(owner), chain + ' mirror is not bridge-owned');
    state.listShare.mirrors[chain] = mirror;
}

async function createListedToken(chain) {
    const M = state.listShare.home;
    const mirror = state.listShare.mirrors[chain];
    const issuer = await fundChain(chain, 'LISTSHARE.AT2.' + chain + '.ISSUER', 8);
    const tick = await pickFreeTick(chain, 'LISTSHARE.AT2.' + chain);
    const issue = await chainAction(chain, issuer, () => issueHelper.sendIssueV0Raw(
        issuer, tick, 1000, 1000, 0, 'list share AT2', 100), 'issues');
    assert.strictEqual(issue.status, 'valid', chain + ' ISSUE 0 graded ' + issue.status);
    const bind = await chainAction(chain, issuer,
        issueListsWire(tick, null, mirror.mapping.action_index, 'list share AT2'), 'issues');
    assert.strictEqual(bind.status, 'valid', chain + ' ISSUE 5 graded ' + bind.status);
    const other = await newAddress(chain, 'LISTSHARE.AT2.' + chain + '.OTHER');
    return { issuer, tick, issue, bind, other };
}

async function assertRefusals(chain) {
    const M = state.listShare.home;
    const T = state.listShare.tokens[chain];
    const mirrorIndex = state.listShare.mirrors[chain].mapping.action_index;
    const blocked = await chainAction(chain, T.issuer,
        sendWire(T.tick, 1, M.old.address, 'list share AT2 blocked'), 'sends');
    const allowed = await chainAction(chain, T.issuer,
        sendWire(T.tick, 1, T.other.address, 'list share AT2 allowed'), 'sends');
    const edit = await chainAction(chain, T.issuer,
        listEditWire(2, mirrorIndex, [M.old.address], 'list share AT2 refused edit'), 'lists');
    assert.strictEqual(blocked.status, 'invalid: DESTINATION (not authorized)',
        chain + ' listed SEND graded ' + blocked.status);
    assert.strictEqual(allowed.status, 'valid', chain + ' unlisted SEND graded ' + allowed.status);
    assert.strictEqual(edit.status, 'invalid: LIST_ACTION_INDEX (bridge-owned)',
        chain + ' mirror edit graded ' + edit.status);
    return { blocked: blocked.status, allowed: allowed.status, edit: edit.status };
}

bridgeRailSuite('list_share AT2: BTC and LTC mirrors enforce the shared block list', function () {
    it('list_share AT2: BTC and LTC apply seq 1 at their signed heights as bridge-owned mirrors', async function () {
        this.timeout(0);
        if (needsFederation(this, 'list_share AT2 mirror apply')) return;
        assert.ok(state.listShare.home.seq1, 'AT1 must have finalized seq 1');
        await assertMirror('BTC');
        await assertMirror('LTC');
    });

    it('list_share AT2: ISSUE 5 binds a token on BTC and LTC to each local mirror', async function () {
        this.timeout(0);
        if (needsFederation(this, 'list_share AT2 ISSUE 5 bindings')) return;
        state.listShare.tokens.BTC = await createListedToken('BTC');
        state.listShare.tokens.LTC = await createListedToken('LTC');
    });

    it('list_share AT2: listed SENDs and broadcast mirror edits are refused on BTC and LTC', async function () {
        this.timeout(0);
        if (needsFederation(this, 'list_share AT2 refusals')) return;
        const results = {};
        results.BTC = await assertRefusals('BTC');
        results.LTC = await assertRefusals('LTC');
        state.evidence.at2 = results;
    });
});
