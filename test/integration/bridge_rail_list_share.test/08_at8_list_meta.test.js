/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 *********************************************************************/

'use strict';

const axios = require('axios');

const {
    assert,
    state,
    fundChain,
    sharedBtcLtcAddress,
    chainAction,
    listShareWire,
    waitForFinalizedSeq,
    waitForMirrorSeq,
    needsFederation,
    bridgeRailSuite,
} = require('./support');

function listCreateMetaWire(type, name, description, items, memo) {
    assert.ok([1, 2, 3].includes(Number(type)), 'LIST meta create type must be 1, 2 or 3');
    assert.ok(Array.isArray(items), 'LIST meta create needs an item array');
    return ['LIST', '4', String(type), String(name || ''), String(description || ''), String(memo || '')]
        .concat(items.map(String)).join('|');
}

function listSetMetaWire(listIndex, name, description, memo) {
    return ['LIST', '5', String(listIndex), String(name || ''), String(description || ''),
        String(memo || '')].join('|');
}

function explorerActionBody(data) {
    if (Array.isArray(data)) return data[0] || null;
    return data || null;
}

async function waitForDogeExplorerAction(actionIndex, expectedName) {
    const base = state.dogeRail.globals.explorerConnector.url.replace(/\/+$/, '');
    const url = base + '/RDOGE/api/action/' + encodeURIComponent(String(actionIndex));
    let action = null;
    await state.venue.waitUntil('DOGE explorer to show LIST ' + actionIndex + ' named ' + expectedName,
        async () => {
            try {
                const response = await axios.get(url, { timeout: 15000 });
                action = explorerActionBody(response.data);
                return action && action.name === expectedName;
            } catch (error) {
                return false;
            }
        }, { timeoutMs: 5 * 60 * 1000, everyMs: 2000 });
    return action;
}

function assertMeta(actual, name, description, where) {
    assert.strictEqual(actual.name, name, where + ' name is ' + actual.name);
    assert.strictEqual(actual.description, description, where + ' description is ' + actual.description);
}

async function homeListAt(block) {
    const M = state.listShare.home;
    return state.venue.indexerRpc('DOGE', 'getlistat', {
        list_index: Number(M.rootIndex), block: Number(block),
    });
}

async function assertMirrorMeta(chain, seq, name, description, membersHash) {
    const mirror = await waitForMirrorSeq(chain, seq);
    assertMeta(mirror.list, name, description, chain + ' mirror at seq ' + seq);
    assert.strictEqual(String(mirror.list.hash), String(membersHash),
        chain + ' mirror membership changed at seq ' + seq);
    state.listShare.mirrors[chain] = mirror;
    return mirror;
}

bridgeRailSuite('list_share AT8: names and descriptions follow a shared list', function () {
    it('list_share AT8: a DOGE owner creates a named format 4 address list and the explorer serves its name', async function () {
        this.timeout(0);
        if (needsFederation(this, 'list_share AT8 named create')) return;
        assert.ok(state.evidence.at7_replay, 'AT7 must have completed before the metadata drive');
        const M = state.listShare.meta = {};
        state.listShare.home = M;
        state.listShare.mirrors = {};
        M.name = 'Rail custodians';
        M.description = 'Addresses watched by the list-share rail';
        M.owner = await fundChain('DOGE', 'LISTSHARE.AT8.OWNER', 10);
        M.member = await sharedBtcLtcAddress('LISTSHARE.AT8.MEMBER');
        M.members = [M.member.address];
        M.create = await chainAction('DOGE', M.owner,
            listCreateMetaWire(2, M.name, M.description, M.members, 'list share AT8 create'), 'lists');
        assert.strictEqual(M.create.status, 'valid', 'the format 4 create graded ' + M.create.status);
        M.rootIndex = M.create.actionIndex;
        const action = await waitForDogeExplorerAction(M.rootIndex, M.name);
        assert.strictEqual(String(action.action), 'LIST', 'the explorer action type is ' + action.action);
        assert.strictEqual(Number(action.action_format), 4,
            'the explorer LIST format is ' + action.action_format);
        assertMeta(action, M.name, M.description, 'DOGE explorer');
    });

    it('list_share AT8: a non-owner rename is refused and seq 1 gives both mirrors the original metadata', async function () {
        this.timeout(0);
        if (needsFederation(this, 'list_share AT8 initial metadata')) return;
        const M = state.listShare.home;
        assert.ok(M.create && M.create.status === 'valid', 'the format 4 create must have run');
        M.nonOwner = await fundChain('DOGE', 'LISTSHARE.AT8.NONOWNER', 2);
        M.refused = await chainAction('DOGE', M.nonOwner,
            listSetMetaWire(M.rootIndex, 'Impostor name', '', 'list share AT8 non-owner'), 'list_metas');
        assert.strictEqual(M.refused.status, 'invalid: LIST_ACTION_INDEX (not owner)',
            'the non-owner format 5 graded ' + M.refused.status);
        M.share = await chainAction('DOGE', M.owner,
            listShareWire(M.rootIndex, 'list share AT8 share'), 'lists');
        assert.strictEqual(M.share.status, 'valid', 'the metadata LIST share graded ' + M.share.status);
        M.seq1 = await waitForFinalizedSeq(1);
        assertMeta(M.seq1, M.name, M.description, 'signed seq 1');
        M.membersHash = String(M.seq1.members_hash);
        M.originalMembers = JSON.parse(M.seq1.added);
        assert.deepStrictEqual(M.originalMembers, M.members, 'seq 1 membership differs from the format 4 list');
        await assertMirrorMeta('BTC', 1, M.name, M.description, M.membersHash);
        await assertMirrorMeta('LTC', 1, M.name, M.description, M.membersHash);
    });

    it('list_share AT8: the owner renames with format 5 and seq 2 changes no membership on either mirror', async function () {
        this.timeout(0);
        if (needsFederation(this, 'list_share AT8 owner rename')) return;
        const M = state.listShare.home;
        assert.ok(M.seq1, 'the named list must have finalized seq 1');
        M.renamedName = 'Rail custody addresses';
        M.renamedDescription = 'Current custodians mirrored across the rail';
        M.rename = await chainAction('DOGE', M.owner,
            listSetMetaWire(M.rootIndex, M.renamedName, M.renamedDescription,
                'list share AT8 rename'), 'list_metas');
        assert.strictEqual(M.rename.status, 'valid', 'the owner format 5 graded ' + M.rename.status);
        M.seq2 = await waitForFinalizedSeq(2);
        assert.strictEqual(String(M.seq2.kind), 'delta', 'rename-only seq 2 kind is ' + M.seq2.kind);
        assert.deepStrictEqual(JSON.parse(M.seq2.added), [], 'rename-only seq 2 added members');
        assert.deepStrictEqual(JSON.parse(M.seq2.removed), [], 'rename-only seq 2 removed members');
        assert.strictEqual(String(M.seq2.members_hash), M.membersHash,
            'rename-only seq 2 changed the signed members hash');
        assertMeta(M.seq2, M.renamedName, M.renamedDescription, 'signed seq 2');
        const home = await homeListAt(M.seq2.origin_block);
        assertMeta(home, M.renamedName, M.renamedDescription, 'DOGE home at seq 2');
        assert.deepStrictEqual(home.members, M.originalMembers, 'format 5 changed the DOGE membership');
        await assertMirrorMeta('BTC', 2, M.renamedName, M.renamedDescription, M.membersHash);
        await assertMirrorMeta('LTC', 2, M.renamedName, M.renamedDescription, M.membersHash);
    });

    it('list_share AT8: clearing the description with a dash clears both mirrors at seq 3', async function () {
        this.timeout(0);
        if (needsFederation(this, 'list_share AT8 clear description')) return;
        const M = state.listShare.home;
        assert.ok(M.seq2, 'the rename must have finalized seq 2');
        M.clear = await chainAction('DOGE', M.owner,
            listSetMetaWire(M.rootIndex, '', '-', 'list share AT8 clear description'), 'list_metas');
        assert.strictEqual(M.clear.status, 'valid', 'the description clear graded ' + M.clear.status);
        M.seq3 = await waitForFinalizedSeq(3);
        assert.strictEqual(String(M.seq3.members_hash), M.membersHash,
            'description-only seq 3 changed the signed members hash');
        assertMeta(M.seq3, M.renamedName, null, 'signed seq 3');
        const home = await homeListAt(M.seq3.origin_block);
        assertMeta(home, M.renamedName, null, 'DOGE home at seq 3');
        assert.deepStrictEqual(home.members, M.originalMembers, 'description clear changed the DOGE membership');
        await assertMirrorMeta('BTC', 3, M.renamedName, null, M.membersHash);
        await assertMirrorMeta('LTC', 3, M.renamedName, null, M.membersHash);
    });

    it('list_share AT8: a broadcast format 5 on the BTC mirror is refused as bridge-owned', async function () {
        this.timeout(0);
        if (needsFederation(this, 'list_share AT8 mirror rename refusal')) return;
        const M = state.listShare.home;
        const mirror = state.listShare.mirrors.BTC;
        assert.ok(M.seq3 && mirror, 'the cleared metadata must have reached the BTC mirror');
        M.btcBroadcaster = await fundChain('BTC', 'LISTSHARE.AT8.BTC.BROADCASTER', 2);
        M.mirrorRefused = await chainAction('BTC', M.btcBroadcaster,
            listSetMetaWire(mirror.mapping.action_index, 'Forbidden mirror name', '',
                'list share AT8 mirror rename'), 'list_metas');
        assert.strictEqual(M.mirrorRefused.status, 'invalid: LIST_ACTION_INDEX (bridge-owned)',
            'the BTC mirror format 5 graded ' + M.mirrorRefused.status);
        const tip = Number((await state.venue.venueTips()).BTC);
        const after = await state.venue.indexerRpc('BTC', 'getlistat', {
            list_index: Number(mirror.mapping.action_index), block: tip,
        });
        assertMeta(after, M.renamedName, null, 'BTC mirror after refused broadcast');
        assert.strictEqual(String(after.hash), M.membersHash,
            'the refused BTC broadcast changed mirror membership');
        state.evidence.at8 = {
            rootIndex: M.rootIndex,
            snapshots: [M.seq1.snapshot_id, M.seq2.snapshot_id, M.seq3.snapshot_id],
            mirrorRefusal: M.mirrorRefused.status,
        };
    });
});
