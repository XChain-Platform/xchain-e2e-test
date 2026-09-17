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
 * Token AT8, the retraction half, run FIRST (the root says why): a v3 whose source is
 * reorged out of BTC regtest before `effective_time` is retracted and DOGE never gains a
 * root row (D45). Then the same lock rides back in when mining resumes and its legitimate
 * finalization is the FIRST applied in-leg, which is what creates the BTC root on DOGE.
 *
 ********************************************************************/

'use strict';

const {
    assert,
    lockWireV3,
    optInWire,
    issueHelper,
    state,
    btcAction,
    fundBtc,
    fundDoge,
    rowsLike,
    pickFreeTick,
    settleLeg,
    reorgBtcFrom,
    needsFederation,
    bridgeRailSuite,
} = require('./support');
const { withMiningPaused, describeRow } = require('../../helpers/bridgeRailVenue');

const GROUP = 'token AT8 (retraction, first in-leg): a v3 reorged out before effective_time';

// A fresh token, opted in to DOGE, its first lock finalized and NOT yet applied.
async function lockFirstLeg() {
    const R = state.tokens.reorg;
    R.tick = await pickFreeTick(['RETR', 'RETS', 'RETT']);
    assert.ok(R.tick, 'no free tick for the retraction leg');
    R.issuer = await fundBtc('TOKEN.REORG.ISSUER');
    R.dest = await fundDoge('TOKEN.REORG.DEST', 2);
    const issue = await btcAction(R.issuer, () => issueHelper.sendIssueV0Raw(
        R.issuer, R.tick, 1000, 1000, 0, 'token AT8 retraction', 10), 'issues');
    assert.strictEqual(issue.status, 'valid', 'ISSUE ' + R.tick + ' graded ' + issue.status);
    const optIn = await btcAction(R.issuer, optInWire(R.tick, 'DOGE', '', '', 'AT8 opt-in'), 'issues');
    assert.strictEqual(optIn.status, 'valid', 'ISSUE|7 ' + R.tick + ' graded ' + optIn.status);
    R.hashesBefore = await state.venue.blockHashes('DOGE');
    // A rail whose BTC chain already carries token locks from an earlier drive re-finalizes
    // them when the venue arms, so the root may exist before this leg: the claim is that the
    // retracted leg adds none.
    R.rootBefore = (await rowsLike('DOGE', 'BTC')).map((r) => r.tick);
    const lock = await btcAction(R.issuer, lockWireV3(R.tick, 'DOGE', R.dest.address, 1, 'AT8 retraction'), 'xbridges');
    assert.strictEqual(lock.status, 'valid', 'the v3 lock graded ' + lock.status);
    const row = await state.venue.waitForFinalizedTransfer(
        (r) => String(r.dest_address) === R.dest.address && String(r.tick) === R.tick);
    assert.ok(row, 'the retraction leg\'s lock never finalized, so there is nothing to retract.\n' +
        state.venue.hubTails(30));
    state.evidence.at8_retraction = { tick: R.tick, issue, optIn, lock, transferId: row.transfer_id,
        snapshotBlock: String(row.snapshot_block), destAddress: R.dest.address };
    return { lock, row };
}

// The orphan and every reading that depends on the lock being off the chain, under the
// paused miner: the retracted row, the DOGE ledger without a root, child or credit.
async function orphanAndRead(lock, row) {
    const R = state.tokens.reorg;
    const orphan = await reorgBtcFrom(lock.tx, 3);
    const retracted = await state.venue.waitForFinalizedTransfer(
        (r) => String(r.transfer_id) === String(row.transfer_id) && String(r.status) === 'retracted',
        { timeoutMs: 180000 });
    return {
        orphan,
        retracted,
        rootRows: await rowsLike('DOGE', 'BTC'),
        childPresent: await state.venue.hasTokenRow('DOGE', 'BTC.' + R.tick),
        balance: await state.venue.addressBalance('DOGE', R.dest.address, 'BTC.' + R.tick),
        hashesAfter: await state.venue.blockHashes('DOGE', R.hashesBefore[0].block_index),
    };
}

bridgeRailSuite(GROUP, function () {
    it('token AT8: the finalized row is retracted and the DOGE ledger gains no root row, no child row and no credit', async function () {
        this.timeout(0);
        if (needsFederation(this, 'token AT8 retraction')) return;
        assert.ok(state.baseline, 'the arming case must have run');
        const R = state.tokens.reorg;
        const { lock, row } = await lockFirstLeg();
        // Mining stays paused through every read: the first block mined afterwards
        // confirms the lock again and hands the federation a legitimate leg.
        const reading = await withMiningPaused(regtestMinerConnector, () => orphanAndRead(lock, row));
        Object.assign(state.evidence.at8_retraction, { minedAt: reading.orphan.height,
            orphanedHash: reading.orphan.hash, retracted: !!reading.retracted,
            rootRowsDuringOrphan: reading.rootRows.map((r) => r.tick), childDuringOrphan: reading.childPresent });
        assert.ok(reading.retracted,
            'transfer ' + row.transfer_id + ' stayed finalized for 180s after its source lock left the BTC ' +
            'chain; the federation never retracted it: ' + describeRow(row));
        assert.deepStrictEqual(reading.rootRows.map((r) => r.tick), R.rootBefore, 'DOGE gained a root row from a retracted first in-leg');
        assert.strictEqual(reading.childPresent, false, 'DOGE gained BTC.' + R.tick + ' from a retracted in-leg');
        assert.strictEqual(reading.balance, '0', R.dest.address + ' was credited from a lock that is not on the BTC chain');
        assert.strictEqual(String(reading.hashesAfter[0].ledger_hash), String(R.hashesBefore[0].ledger_hash),
            'the DOGE ledger_hash at block ' + R.hashesBefore[0].block_index + ' moved');
    });
});

bridgeRailSuite(GROUP, function () {
    it('token AT8 (ride-back): the re-mined lock finalizes as the first applied in-leg and creates root BTC and child BTC.<tick> owned by BRIDGE_BTC', async function () {
        this.timeout(0);
        if (needsFederation(this, 'token AT8 ride-back')) return;
        const R = state.tokens.reorg;
        assert.ok(state.evidence.at8_retraction && state.evidence.at8_retraction.retracted, 'the retraction half must have run');
        // A re-parsed lock may carry a new action index and so a new transfer id: matched by
        // destination and tick among the rows that are NOT the retracted one.
        const leg = await settleLeg('the ride-back of the retracted lock',
            (r) => String(r.dest_address) === R.dest.address && String(r.tick) === R.tick && String(r.status) !== 'retracted',
            'DOGE');
        // The root is read by its interned spelling, which a refused ISSUE of btc can have fixed in lower case.
        const root = await state.venue.tokenParameters('DOGE', ((await rowsLike('DOGE', 'BTC'))[0] || {}).tick || 'BTC');
        const child = await state.venue.tokenParameters('DOGE', 'BTC.' + R.tick);
        state.evidence.at8_rideBack = { transfer: leg.transfer, root, child,
            balance: await state.venue.addressBalance('DOGE', R.dest.address, 'BTC.' + R.tick) };
        assert.ok(root, 'DOGE holds no BTC root row after the first applied in-leg');
        assert.ok(child, 'DOGE holds no BTC.' + R.tick + ' row after the first applied in-leg');
        assert.strictEqual(root.ownerAddress, state.evidence.bridgeRoleDoge, 'the BTC root on DOGE is owned by ' + root.ownerAddress);
        assert.strictEqual(child.ownerAddress, state.evidence.bridgeRoleDoge, 'BTC.' + R.tick + ' is owned by ' + child.ownerAddress);
        assert.strictEqual(String(child.params.decimals), '0', 'the copy carries decimals ' + child.params.decimals);
        assert.strictEqual(String(root.params.lock_mint), '1', 'the root row is not mint-locked');
        assert.strictEqual(Number(state.evidence.at8_rideBack.balance), 1, R.dest.address + ' holds ' + state.evidence.at8_rideBack.balance);
    });
});
