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
    listCreateWire,
    issueListsWire,
    sendWire,
    needsFederation,
    bridgeRailSuite,
} = require('./support');

async function unionMembers(unionIndex) {
    const tip = Number((await state.venue.venueTips()).BTC);
    const read = await state.venue.indexerRpc('BTC', 'getlistat', {
        list_index: Number(unionIndex), block: tip,
    });
    return read.members;
}

bridgeRailSuite('list_share AT4: a union of a local list and a mirror blocks both', function () {
    it('list_share AT4: a type 3 union combines a local type 2 list and the BTC mirror', async function () {
        this.timeout(0);
        if (needsFederation(this, 'list_share AT4 union create')) return;
        const M = state.listShare.home;
        const mirror = state.listShare.mirrors.BTC;
        assert.ok(state.evidence.at3 && mirror, 'AT3 must have applied seq 2 on BTC');
        const U = state.listShare.union = {};
        U.owner = await fundChain('BTC', 'LISTSHARE.AT4.OWNER', 8);
        U.local = await newAddress('BTC', 'LISTSHARE.AT4.LOCAL');
        U.other = await newAddress('BTC', 'LISTSHARE.AT4.OTHER');
        U.localList = await chainAction('BTC', U.owner,
            listCreateWire(2, [U.local.address], 'list share AT4 local'), 'lists');
        assert.strictEqual(U.localList.status, 'valid', 'the local LIST create graded ' + U.localList.status);
        U.create = await chainAction('BTC', U.owner, listCreateWire(3,
            [U.localList.actionIndex, mirror.mapping.action_index], 'list share AT4 union'), 'lists');
        assert.strictEqual(U.create.status, 'valid', 'the type 3 union create graded ' + U.create.status);
        const members = await unionMembers(U.create.actionIndex);
        assert.ok(members.includes(U.local.address), 'the union lacks the local member');
        assert.ok(members.includes(M.added.BTC.address), 'the union lacks the mirror member');
        assert.ok(!members.includes(M.old.BTC.address), 'the union holds a member the mirror removed');
    });

    it('list_share AT4: a token blocking the union refuses a SEND to a member of either list', async function () {
        this.timeout(0);
        if (needsFederation(this, 'list_share AT4 union enforcement')) return;
        const M = state.listShare.home;
        const U = state.listShare.union;
        assert.ok(U && U.create && U.create.status === 'valid', 'the union create must have run');
        const tick = await pickFreeTick('BTC', 'LISTSHARE.AT4');
        const issue = await chainAction('BTC', U.owner, () => issueHelper.sendIssueV0Raw(
            U.owner, tick, 1000, 1000, 0, 'list share AT4', 100), 'issues');
        assert.strictEqual(issue.status, 'valid', 'ISSUE 0 graded ' + issue.status);
        const bind = await chainAction('BTC', U.owner,
            issueListsWire(tick, null, U.create.actionIndex, 'list share AT4'), 'issues');
        assert.strictEqual(bind.status, 'valid', 'ISSUE 5 binding the union graded ' + bind.status);
        const toLocal = await chainAction('BTC', U.owner,
            sendWire(tick, 1, U.local.address, 'list share AT4 local member'), 'sends');
        const toMirror = await chainAction('BTC', U.owner,
            sendWire(tick, 1, M.added.BTC.address, 'list share AT4 mirror member'), 'sends');
        const toOther = await chainAction('BTC', U.owner,
            sendWire(tick, 1, U.other.address, 'list share AT4 unlisted'), 'sends');
        assert.strictEqual(toLocal.status, 'invalid: DESTINATION (not authorized)',
            'a SEND to the local member graded ' + toLocal.status);
        assert.strictEqual(toMirror.status, 'invalid: DESTINATION (not authorized)',
            'a SEND to the mirror member graded ' + toMirror.status);
        assert.strictEqual(toOther.status, 'valid', 'a SEND to an unlisted address graded ' + toOther.status);
        state.evidence.at4 = { tick, union: U.create.actionIndex,
            local: toLocal.status, mirror: toMirror.status, other: toOther.status };
    });
});
