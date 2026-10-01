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
    sharedBtcLtcAddress,
    chainAction,
    listEditWire,
    sendWire,
    oneDogeBlock,
    waitForFinalizedSeq,
    waitForMirrorSeq,
    needsFederation,
    bridgeRailSuite,
} = require('./support');

async function assertDeltaMirror(chain) {
    const M = state.listShare.home;
    const mirror = await waitForMirrorSeq(chain, 2);
    const heightField = 'admit_block_' + chain.toLowerCase();
    assert.strictEqual(Number(mirror.applied.block_index), Number(M.seq2[heightField]),
        chain + ' applied seq 2 away from its signed effective height');
    assert.strictEqual(String(mirror.list.hash), String(M.seq2.members_hash),
        chain + ' mirror hash differs from seq 2');
    state.listShare.mirrors[chain] = mirror;
}

async function assertFlippedVerdicts(chain) {
    const M = state.listShare.home;
    const T = state.listShare.tokens[chain];
    const blocked = await chainAction(chain, T.issuer,
        sendWire(T.tick, 1, M.added[chain].address, 'list share AT3 newly blocked'), 'sends');
    const allowed = await chainAction(chain, T.issuer,
        sendWire(T.tick, 1, M.old[chain].address, 'list share AT3 removed'), 'sends');
    assert.strictEqual(blocked.status, 'invalid: DESTINATION (not authorized)',
        chain + ' newly listed SEND graded ' + blocked.status);
    assert.strictEqual(allowed.status, 'valid', chain + ' removed-member SEND graded ' + allowed.status);
    return { blocked: blocked.status, allowed: allowed.status };
}

bridgeRailSuite('list_share AT3: one home delta reaches both mirrors', function () {
    it('list_share AT3: one DOGE block adds one address and removes one, producing delta seq 2', async function () {
        this.timeout(0);
        if (needsFederation(this, 'list_share AT3 home delta')) return;
        const M = state.listShare.home;
        assert.ok(state.evidence.at2, 'AT2 must have established the two token bindings');
        M.added = await sharedBtcLtcAddress('LISTSHARE.AT3.ADDED');
        const edits = await oneDogeBlock(M.owner, [
            listEditWire(1, M.rootIndex, [M.added.address], 'list share AT3 add'),
            listEditWire(2, M.rootIndex, [M.old.address], 'list share AT3 remove'),
        ]);
        for (const edit of edits) assert.strictEqual(edit.status, 'valid', 'home edit graded ' + edit.status);
        M.seq2 = await waitForFinalizedSeq(2);
        assert.strictEqual(String(M.seq2.kind), 'delta', 'seq 2 kind is ' + M.seq2.kind);
        assert.deepStrictEqual(JSON.parse(M.seq2.added), [M.added.address], 'seq 2 added set differs');
        assert.deepStrictEqual(JSON.parse(M.seq2.removed), [M.old.address], 'seq 2 removed set differs');
        const read = await state.venue.indexerRpc('DOGE', 'getlistat', {
            list_index: Number(M.rootIndex), block: Number(M.seq2.origin_block),
        });
        assert.strictEqual(String(M.seq2.members_hash), String(read.hash),
            'seq 2 signed hash differs from the DOGE membership');
    });

    it('list_share AT3: BTC and LTC apply seq 2 with the signed hash and flip both SEND verdicts', async function () {
        this.timeout(0);
        if (needsFederation(this, 'list_share AT3 mirror delta')) return;
        await assertDeltaMirror('BTC');
        await assertDeltaMirror('LTC');
        const verdicts = {};
        verdicts.BTC = await assertFlippedVerdicts('BTC');
        verdicts.LTC = await assertFlippedVerdicts('LTC');
        state.evidence.at3 = { snapshotId: state.listShare.home.seq2.snapshot_id, verdicts };
    });
});
