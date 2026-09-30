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
    chainAction,
    listCreateWire,
    listShareWire,
    waitForFinalizedSeq,
    needsFederation,
    bridgeRailSuite,
} = require('./support');

bridgeRailSuite('list_share AT1: a DOGE address list becomes a signed full version', function () {
    it('list_share AT1: a DOGE owner creates and shares a type 2 list with BTC, LTC and DOGE addresses', async function () {
        this.timeout(0);
        if (needsFederation(this, 'list_share AT1 create and share')) return;
        assert.ok(state.evidence.t0, 'T0 must have armed the venue');
        const M = state.listShare.home;
        M.owner = await fundChain('DOGE', 'LISTSHARE.AT1.OWNER', 10);
        M.old = await fundChain('BTC', 'LISTSHARE.AT1.BTC');
        M.ltc = await fundChain('LTC', 'LISTSHARE.AT1.LTC', 1);
        M.doge = await fundChain('DOGE', 'LISTSHARE.AT1.DOGE', 1);
        M.members = [M.old.address, M.ltc.address, M.doge.address];
        M.create = await chainAction('DOGE', M.owner,
            listCreateWire(2, M.members, 'list share AT1'), 'lists');
        assert.strictEqual(M.create.status, 'valid', 'the home LIST create graded ' + M.create.status);
        M.rootIndex = M.create.actionIndex;
        M.share = await chainAction('DOGE', M.owner,
            listShareWire(M.rootIndex, 'list share AT1'), 'lists');
        assert.strictEqual(M.share.status, 'valid', 'LIST format 2 graded ' + M.share.status);
    });

    it('list_share AT1: seq 1 is full and its signed members hash equals getlistat on DOGE', async function () {
        this.timeout(0);
        if (needsFederation(this, 'list_share AT1 full version')) return;
        const M = state.listShare.home;
        assert.ok(M.share && M.share.status === 'valid', 'the share action must have run');
        M.seq1 = await waitForFinalizedSeq(1);
        const read = await state.venue.indexerRpc('DOGE', 'getlistat', {
            list_index: Number(M.rootIndex), block: Number(M.seq1.origin_block),
        });
        assert.strictEqual(Number(M.seq1.seq), 1, 'the first version is seq ' + M.seq1.seq);
        assert.strictEqual(String(M.seq1.kind), 'full', 'seq 1 kind is ' + M.seq1.kind);
        assert.strictEqual(Number(M.seq1.list_type), 2, 'seq 1 type is ' + M.seq1.list_type);
        assert.strictEqual(String(M.seq1.members_hash), String(read.hash),
            'the signed members hash differs from getlistat');
        assert.deepStrictEqual(JSON.parse(M.seq1.added), read.members,
            'seq 1 does not carry the full canonical membership');
        assert.deepStrictEqual(JSON.parse(M.seq1.removed), [], 'seq 1 carries removed members');
        state.evidence.at1 = { rootIndex: M.rootIndex, snapshotId: M.seq1.snapshot_id,
            members: read.members, membersHash: read.hash };
    });
});
