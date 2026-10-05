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
    chainRail,
    state,
    sharedBtcLtcAddress,
    transactionHelper,
    listEditWire,
    waitForFinalizedSeq,
    waitForMirrorSeq,
    needsFederation,
    bridgeRailSuite,
} = require('./support');
const { transactionState } = require('../../helpers/core/transactionHelper/lib/01_create_and_send_transaction');
const { spendableInputCount } = require('../../helpers/rail_preflight/policy_at2_at4');
const { verdictOf } = require('../../helpers/bridgeRailVenue');

const HASH_SQL = 'SELECT b.block_index AS block_index, t1.hash AS ledger, t2.hash AS actions, ' +
    't3.hash AS contract, t4.hash AS state FROM blocks b ' +
    'LEFT JOIN index_transactions t1 ON (t1.id = b.ledger_hash_id) ' +
    'LEFT JOIN index_transactions t2 ON (t2.id = b.actions_hash_id) ' +
    'LEFT JOIN index_transactions t3 ON (t3.id = b.contract_hash_id) ' +
    'LEFT JOIN index_transactions t4 ON (t4.id = b.state_hash_id) ' +
    'WHERE b.block_index >= ? ORDER BY b.block_index ASC';

function hashRows(rows) {
    return rows.map((row) => [Number(row.block_index), String(row.ledger), String(row.actions),
        String(row.contract), String(row.state)].join(':'));
}

function pause(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function btcIndexerTip() {
    const answer = await state.venue.indexerRpc('BTC', 'getblockhashes', {});
    return Number(answer.block_index);
}

async function btcListMirrorStatus() {
    const status = await state.venue.btcVenue.statusOf(0);
    return status.body && status.body.hubMirror;
}

async function btcListSettlements() {
    const rows = await state.venue.queryIndexerDb('BTC',
        "SELECT COUNT(*) AS n FROM bridge_settlements WHERE kind = 'list'", []);
    return Number(rows[0].n);
}

async function btcMirrorVersion(block) {
    const mirror = state.listShare.mirrors.BTC;
    const list = await state.venue.indexerRpc('BTC', 'getlistat', {
        list_index: Number(mirror.mapping.action_index), block: Number(block),
    });
    return String(list.hash);
}

async function stopEveryHub() {
    for (const hub of state.venue.hubs) await state.venue.btcVenue.stopHub(hub.index);
}

async function startEveryHub() {
    for (const hub of state.venue.hubs) await state.venue.btcVenue.startHub(hub.index);
}

async function fundOwnerInput(owner) {
    await chainRail.withRail(state.dogeRail, async () => {
        const before = await utxoTrackerConnector.getUtxosFromAddress(owner.address);
        const opening = spendableInputCount(before && before.utxos);
        const tx = await regtestMinerConnector.sendFunds(owner.address, 1);
        await nodeConnector.waitForTx(tx, 60000);
        await regtestMinerConnector.generateBlocks(1);
        await state.venue.waitUntil('a fresh DOGE list-owner input', async () => {
            const now = await utxoTrackerConnector.getUtxosFromAddress(owner.address);
            return spendableInputCount(now && now.utxos) >= opening + 1;
        }, { timeoutMs: 180000, everyMs: 1000 });
        transactionState.verifiedUtxos = null;
        transactionState.verifiedUtxosAddress = null;
    });
}

async function broadcastHomeEdit(owner, wire) {
    return chainRail.withRail(state.dogeRail, async () => {
        const tx = await transactionHelper.createAndSendTransaction(owner, wire);
        await regtestMinerConnector.generateBlocks(Number(state.venue.confirmations.DOGE || 1) + 1);
        return tx;
    });
}

async function nodeBtcTip() {
    return Number(await nodeConnector.getBlockCount());
}

bridgeRailSuite('list_share AT7: stopped hubs defer the venue and a restart resumes it', function () {
    it('list_share AT7: with every hub stopped a home edit is not applied and the BTC indexer holds its tip', async function () {
        this.timeout(0);
        if (needsFederation(this, 'list_share AT7 deferral')) return;
        const M = state.listShare.home;
        assert.ok(state.evidence.at5 && M.seq3, 'AT5 must have finalized seq 3');
        const D = state.listShare.deferred = {};
        D.added = await sharedBtcLtcAddress('LISTSHARE.AT7.ADDED');
        await fundOwnerInput(M.owner);
        D.settlementsBefore = await btcListSettlements();
        D.tipBefore = await btcIndexerTip();
        D.mirrorHashBefore = await btcMirrorVersion(D.tipBefore);
        await stopEveryHub();
        try {
            D.tx = await broadcastHomeEdit(M.owner,
                listEditWire(1, M.rootIndex, [D.added.address], 'list share AT7 add'));
            await regtestMinerConnector.generateBlocks(3);
            const target = await nodeBtcTip();
            await pause(30000);
            D.held = await btcIndexerTip();
            D.settlementsHeld = await btcListSettlements();
            D.mirrorHashHeld = await btcMirrorVersion(D.held);
            await regtestMinerConnector.generateBlocks(2);
            await pause(30000);
            D.heldAgain = await btcIndexerTip();
            D.settlementsHeldAgain = await btcListSettlements();
            D.mirrorHashHeldAgain = await btcMirrorVersion(D.heldAgain);
            D.mirrorStatus = await btcListMirrorStatus();
            D.nodeTip = await nodeBtcTip();
            assert.ok(D.nodeTip > target, 'the BTC chain did not grow while the hubs were stopped');
            assert.ok(D.held < D.nodeTip, 'the BTC indexer reached the chain tip ' + D.nodeTip + ' with every hub stopped');
            assert.strictEqual(D.heldAgain, D.held, 'the BTC indexer moved from ' + D.held + ' to ' + D.heldAgain +
                ' with every hub stopped');
            assert.ok(D.mirrorStatus, 'the BTC indexer reports no hub mirror status');
            assert.strictEqual(D.mirrorStatus.connected, false,
                'the BTC indexer reports its hub mirror connected with every hub stopped');
            assert.strictEqual(D.mirrorStatus.bootstrapped, false,
                'the BTC indexer reports its hub mirror bootstrapped with every hub stopped');
            const listHeights = D.mirrorStatus.heights && D.mirrorStatus.heights.list_snapshots;
            assert.strictEqual(listHeights && listHeights.BTC, undefined,
                'the BTC indexer retained an active list_snapshots height with every hub stopped');
            // A shortfall is recorded only when a block asks that barrier, and with every hub
            // stopped an earlier barrier holds the tip first, so the map is evidence, not a gate.
            D.mirrorHeightShortfalls = D.mirrorStatus.heightShortfalls || {};
            assert.strictEqual(D.settlementsHeld, D.settlementsBefore,
                'BTC applied a shared-list settlement during the first stopped-hub window');
            assert.strictEqual(D.mirrorHashHeld, D.mirrorHashBefore,
                'the BTC mirror version changed during the first stopped-hub window');
            assert.strictEqual(D.settlementsHeldAgain, D.settlementsBefore,
                'BTC applied a shared-list settlement during the second stopped-hub window');
            assert.strictEqual(D.mirrorHashHeldAgain, D.mirrorHashBefore,
                'the BTC mirror version changed during the second stopped-hub window');
        } finally {
            await startEveryHub();
        }
        state.evidence.at7_deferred = { held: D.held, mirrorHeightShortfalls: D.mirrorHeightShortfalls,
            nodeTip: D.nodeTip, edit: D.tx };
    });

    it('list_share AT7: the restarted hubs finalize the next seq and the BTC mirror applies it', async function () {
        this.timeout(0);
        if (needsFederation(this, 'list_share AT7 resume')) return;
        const M = state.listShare.home;
        const D = state.listShare.deferred;
        assert.ok(D && D.tx, 'the deferral half must have run');
        const graded = await verdictOf(state.venue.dogeVenue, 'lists', D.tx);
        assert.ok(graded && graded.status === 'valid', 'the home edit graded ' + (graded && graded.status));
        M.seq4 = await waitForFinalizedSeq(4);
        assert.deepStrictEqual(JSON.parse(M.seq4.added), [D.added.address], 'seq 4 added set differs');
        const mirror = await waitForMirrorSeq('BTC', 4);
        assert.notStrictEqual(String(mirror.list.hash), D.mirrorHashBefore, 'the BTC mirror hash did not change');
        assert.strictEqual(String(mirror.list.hash), String(M.seq4.members_hash),
            'the BTC mirror hash differs from the signed seq 4 hash');
        assert.ok(await btcListSettlements() > D.settlementsBefore, 'BTC recorded no list settlement for seq 4');
        state.listShare.mirrors.BTC = mirror;
    });

    it('list_share AT7: a fresh BTC replay still matches every block hash', async function () {
        this.timeout(0);
        if (needsFederation(this, 'list_share AT7 replay')) return;
        const M = state.listShare.home;
        assert.ok(M.seq4, 'the resume half must have applied seq 4');
        const first = Number(M.seq1.admit_block_btc);
        const tip = await btcIndexerTip();
        const handle = await state.venue.replayIndexer('BTC');
        try {
            const live = hashRows(await state.venue.queryIndexerDb('BTC', HASH_SQL, [first]));
            const replayed = hashRows(await handle.queryDb(HASH_SQL, [first]));
            const last = Number(replayed[replayed.length - 1].split(':')[0]);
            assert.ok(last >= tip, 'the BTC replay stopped at ' + last + ', below the tip ' + tip);
            const compared = Math.min(live.length, replayed.length);
            assert.ok(compared >= tip - first + 1, 'only ' + compared + ' blocks compare from ' + first + ' to ' + tip);
            for (let i = 0; i < compared; i++) {
                assert.strictEqual(replayed[i], live[i], 'the BTC replay differs from the live indexer at row ' + i);
            }
            state.evidence.at7_replay = { from: first, to: tip, blocks: compared };
        } finally {
            await handle.stop();
        }
    });
});
