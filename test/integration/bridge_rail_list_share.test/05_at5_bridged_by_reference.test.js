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
    fundChain,
    newAddress,
    sharedBtcLtcAddress,
    pickFreeTick,
    chainAction,
    issueHelper,
    listEditWire,
    issueListsWire,
    lockWireV3,
    optInWire,
    sendWire,
    oneDogeBlock,
    waitForFinalizedSeq,
    waitForMirrorSeq,
    needsFederation,
    bridgeRailSuite,
} = require('./support');

const LOCK = 5;

async function hubPolicyCount(tick) {
    let count = 0, reads = 0, lastError = null;
    for (const hub of state.venue.hubs) {
        try {
            const rows = await state.venue.queryHubDb(hub.dbName,
                'SELECT COUNT(*) AS n FROM policy_snapshots WHERE tick = ?', [String(tick)]);
            reads++;
            count += Number(rows[0].n);
        } catch (error) { lastError = error; }
    }
    if (!reads && lastError) throw lastError;
    return count;
}

async function btcPolicySettlements() {
    const rows = await state.venue.queryIndexerDb('BTC',
        "SELECT COUNT(*) AS n FROM bridge_settlements WHERE kind = 'policy'", []);
    return Number(rows[0].n);
}

function refreshBtcMirror() {
    const venue = state.venue.btcVenue;
    for (const indexer of (venue && venue.indexers) || []) {
        if (indexer.mirrorProxy) indexer.mirrorProxy.dropSockets();
    }
}

async function copyReading(tick) {
    const tip = Number((await state.venue.venueTips()).BTC);
    return state.venue.indexerRpc('BTC', 'gettokenpolicy',
        { tick: 'DOGE.' + tick, origin_block: tip, snapshot_block: tip });
}

async function freePair(label) {
    for (let attempt = 0; attempt < 16; attempt++) {
        const tick = await pickFreeTick('DOGE', label + '.' + attempt);
        if (!await state.venue.hasTokenRow('BTC', 'DOGE.' + tick)) return tick;
    }
    return assert.fail('no tick free on DOGE and as a BTC copy for ' + label);
}

bridgeRailSuite('list_share AT5: a bridged token carries its shared list by reference', function () {
    it('list_share AT5: a DOGE token blocking the home list opts into BTC and is locked across', async function () {
        this.timeout(0);
        if (needsFederation(this, 'list_share AT5 lock')) return;
        const M = state.listShare.home;
        assert.ok(state.evidence.at4, 'AT4 must have run');
        const R = state.listShare.referenced = {};
        R.issuer = await fundChain('DOGE', 'LISTSHARE.AT5.ISSUER', 8);
        R.holder = await fundChain('BTC', 'LISTSHARE.AT5.HOLDER', 4);
        R.other = await newAddress('BTC', 'LISTSHARE.AT5.OTHER');
        R.tick = await freePair('LISTSHARE.AT5');
        const issue = await chainAction('DOGE', R.issuer, () => issueHelper.sendIssueV0Raw(
            R.issuer, R.tick, 1000, 1000, 0, 'list share AT5', 100), 'issues');
        assert.strictEqual(issue.status, 'valid', 'ISSUE 0 on DOGE graded ' + issue.status);
        const bind = await chainAction('DOGE', R.issuer,
            issueListsWire(R.tick, null, M.rootIndex, 'list share AT5'), 'issues');
        assert.strictEqual(bind.status, 'valid', 'ISSUE 5 binding the home list graded ' + bind.status);
        const optIn = await chainAction('DOGE', R.issuer,
            optInWire(R.tick, 'BTC', '', '', 'list share AT5 opt-in'), 'issues');
        assert.strictEqual(optIn.status, 'valid', 'ISSUE 7 BRIDGE_CHAINS=BTC graded ' + optIn.status);
        R.lock = await chainAction('DOGE', R.issuer,
            lockWireV3(R.tick, 'BTC', R.holder.address, LOCK, 'list share AT5'), 'xbridges');
        assert.strictEqual(R.lock.status, 'valid', 'the XBRIDGE v3 lock graded ' + R.lock.status);
        await chainRail.withRail(state.dogeRail, () => regtestMinerConnector.generateBlocks(
            Number(state.venue.confirmations.DOGE || 1) + 2));
        R.row = await state.venue.waitForFinalizedTransfer((row) => String(row.src_chain) === 'DOGE' &&
            String(row.dest_chain) === 'BTC' && String(row.dest_address) === R.holder.address &&
            String(row.tick) === R.tick, { timeoutMs: 30 * 60 * 1000 });
        assert.ok(R.row, 'the lock never finalized on any venue hub');
        const timer = setInterval(refreshBtcMirror, 30000);
        try {
            refreshBtcMirror();
            R.applied = await state.venue.waitForBridgeApplied('BTC', R.row.transfer_id,
                { timeoutMs: 35 * 60 * 1000 });
        } finally { clearInterval(timer); }
        assert.ok(R.applied, 'BTC never applied the lock ' + R.row.transfer_id);
        const held = await state.venue.addressBalance('BTC', R.holder.address, 'DOGE.' + R.tick);
        assert.strictEqual(Number(held), LOCK, 'the BTC holder holds ' + held + ' DOGE.' + R.tick);
    });

    it('list_share AT5: the BTC copy names the home list by reference and binds the BTC mirror', async function () {
        this.timeout(0);
        if (needsFederation(this, 'list_share AT5 reference')) return;
        const M = state.listShare.home;
        const R = state.listShare.referenced;
        assert.ok(R && R.applied, 'the lock half must have run');
        const mirror = state.listShare.mirrors.BTC;
        const ref = 'DOGE:' + M.rootIndex;
        await state.venue.waitUntil('the BTC copy to bind the mirror', async () => {
            refreshBtcMirror();
            const copy = await state.venue.tokenParameters('BTC', 'DOGE.' + R.tick);
            return !!copy && String(copy.params.block_list) === String(mirror.mapping.action_index);
        }, { timeoutMs: 35 * 60 * 1000, everyMs: 3000 });
        const reading = await copyReading(R.tick);
        assert.strictEqual(reading.block_list_ref, ref, 'block_list_ref reads ' + reading.block_list_ref);
        assert.strictEqual(reading.block_list, ref, 'block_list reads ' + JSON.stringify(reading.block_list));
        R.reading = reading;
    });

    it('list_share AT5: a home edit reaches the copy with no new policy snapshot or policy settlement', async function () {
        this.timeout(0);
        if (needsFederation(this, 'list_share AT5 edit')) return;
        const M = state.listShare.home;
        const R = state.listShare.referenced;
        assert.ok(R && R.reading, 'the reference half must have run');
        const snapshotsBefore = await hubPolicyCount(R.tick);
        const settlementsBefore = await btcPolicySettlements();
        R.added = await sharedBtcLtcAddress('LISTSHARE.AT5.ADDED');
        const edits = await oneDogeBlock(M.owner, [
            listEditWire(1, M.rootIndex, [R.added.address], 'list share AT5 add'),
        ]);
        assert.strictEqual(edits[0].status, 'valid', 'home edit graded ' + edits[0].status);
        M.seq3 = await waitForFinalizedSeq(3);
        await waitForMirrorSeq('BTC', 3);
        const blocked = await chainAction('BTC', R.holder,
            sendWire('DOGE.' + R.tick, 1, R.added.BTC.address, 'list share AT5 newly listed'), 'sends');
        const allowed = await chainAction('BTC', R.holder,
            sendWire('DOGE.' + R.tick, 1, R.other.address, 'list share AT5 unlisted'), 'sends');
        assert.strictEqual(blocked.status, 'invalid: DESTINATION (not authorized)',
            'a SEND of the copy to the newly listed address graded ' + blocked.status);
        assert.strictEqual(allowed.status, 'valid', 'a SEND of the copy to an unlisted address graded ' + allowed.status);
        const snapshotsAfter = await hubPolicyCount(R.tick);
        const settlementsAfter = await btcPolicySettlements();
        assert.strictEqual(snapshotsAfter, snapshotsBefore,
            'the home edit added hub policy_snapshots rows for ' + R.tick);
        assert.strictEqual(settlementsAfter, settlementsBefore,
            'the home edit added BTC policy settlements');
        state.evidence.at5 = { tick: R.tick, ref: R.reading.block_list_ref, snapshots: snapshotsAfter,
            settlements: settlementsAfter, blocked: blocked.status, allowed: allowed.status };
    });
});
