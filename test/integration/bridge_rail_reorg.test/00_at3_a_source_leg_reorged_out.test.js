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
 * AT3: a source leg reorged out. Three legs, one lever: the BTC lock is orphaned with
 * EMPTY replacement blocks under a paused miner (the root's `reorgBtcFrom` says why both
 * halves are needed), and every reading that depends on the lock being off the chain is
 * taken before mining resumes.
 *
 ********************************************************************/

'use strict';

const assert            = require('assert');
const chainRail         = require('../../helpers/chainRail');
const cryptoHelper      = require('../../cryptoHelper');
const transactionHelper = require('../../transactionHelper');
const mintHelper        = require('../../helpers/mintHelper');
const bridgeParts       = require('./helpers/fixture');
const {
    lockWireV0,
    classifyInvariant,
    escrowOf,
    withMiningPaused,
    describeRow,
    confirmedHeight,
    destinationApplyBudgetMs,
    hubRelayMarginFloorS,
} = require('../../helpers/bridgeRailVenue');

const GAS_TICK = 'XCHAIN';
const GROUP = 'AT3: a source leg reorged out';

let venue = null;
let dogeRail = null;
let evidence = null;
let needsFederation = null;
let reorgBtcFrom = null;
let venueBtcCaughtUp = null;

function bindBridgeState(state) {
    ({ venue, dogeRail, evidence, needsFederation, reorgBtcFrom, venueBtcCaughtUp } = state);
}

function registerBridgeTest(title, callback) {
    describe('XBRIDGE acceptance drive: reorg and falsification (AT3, AT4)', function () {
        bridgeParts.install(bindBridgeState);
        describe(GROUP, function () {
            it(title, callback);
        });
    });
}

// A fresh DOGE destination and a funded, minted BTC sender for one leg.
async function fundLeg(tag) {
    const dest = await venue.funded(tag + '.DEST', () => chainRail.withRail(dogeRail,
        () => cryptoHelper.getNewFundedAddress(tag + '.DEST', 'dogecoin', NETWORK, null, 'legacy', 0, 1, false)));
    const sender = await venue.funded(tag + '.SENDER',
        () => cryptoHelper.getNewFundedAddress(tag + '.SENDER', 'bitcoin', NETWORK, null, 'legacy', 0, 1, false));
    await mintHelper.sendMintV0(sender, GAS_TICK, 1, sender.address, '');
    return { dest, sender };
}

registerBridgeTest("(a) a lock orphaned before the federation signs never produces a bridge_transfers row", async function () {
    this.timeout(0);
    if (needsFederation(this, 'AT3a')) return;

    // The lock is mined and then orphaned INSIDE the confirmation window, so the
    // engine never sees it at depth. The assertion is the ABSENCE of a row for
    // this destination address, which is why the address is fresh: "no row" is
    // only a claim if nothing else could have written one.
    const { dest, sender } = await fundLeg('AT3A');
    const lockTx = await transactionHelper.createAndSendTransaction(
        sender, lockWireV0('DOGE', dest.address, 1, ''));
    // Confirmed BEFORE the miner is paused: the transaction helper returns once the node
    // knows the lock, not once a block holds it, and a pause taken first would wait on a
    // block nobody is going to mine.
    await confirmedHeight(nodeConnector, lockTx);

    // The orphan and both readings run under the paused miner: from the orphan on, the lock
    // sits in the mempool and the first block anyone mines confirms it again. What remains
    // is the engine's own poll landing between the lock's confirmation and the orphan,
    // which nothing outside the hub can close; the orphan follows the confirmation as
    // closely as the node's own answer allows.
    await withMiningPaused(regtestMinerConnector, async () => {
        const orphan = await reorgBtcFrom(lockTx, 3);
        evidence.at3a = { lockTx, minedAt: orphan.height, orphanedHash: orphan.hash, destAddress: dest.address };

        const row = await venue.waitForFinalizedTransfer(
            (r) => String(r.dest_address) === dest.address, { timeoutMs: 90000 });
        assert.strictEqual(row, null,
            'a bridge_transfers row exists for ' + dest.address + ' whose source lock was orphaned ' +
            'before it ever reached depth: ' + describeRow(row));
        assert.strictEqual(await venue.addressBalance('DOGE', dest.address, GAS_TICK), '0',
            dest.address + ' was credited on DOGE from a lock that is not on the BTC chain');
    });
});

registerBridgeTest("(b) a finalized row whose source is orphaned before effective_time is retracted and never applied", async function () {
    this.timeout(0);
    if (needsFederation(this, 'AT3b')) return;

    const { dest, sender } = await fundLeg('AT3B');
    const hashesBefore = await venue.blockHashes('DOGE');
    const lockTx = await transactionHelper.createAndSendTransaction(
        sender, lockWireV0('DOGE', dest.address, 1, ''));
    const row = await venue.waitForFinalizedTransfer((r) => String(r.dest_address) === dest.address);
    assert.ok(row, 'the AT3b lock never finalized, so there is nothing to retract');

    // The retraction is FENCED and CO-SIGNED: the row leaves the mirror stream by a
    // quorum act, not by one hub deleting a row. What the destination must never do is
    // apply it, so the DOGE credit and the DOGE hashes are what the assertions read.
    // Mining stays paused through the wait: a lock that rides back into the chain hands
    // the federation a legitimate leg, and a row left finalized for it proves nothing
    // about retraction either way.
    const reading = await withMiningPaused(regtestMinerConnector, async () => {
        const orphan = await reorgBtcFrom(lockTx, 3);
        const retracted = await venue.waitForFinalizedTransfer(
            (r) => String(r.transfer_id) === String(row.transfer_id) &&
                   String(r.status || '').toLowerCase().includes('retract'),
            { timeoutMs: 180000 });
        return {
            orphan,
            retracted,
            balance: await venue.addressBalance('DOGE', dest.address, GAS_TICK),
            hashesAfter: await venue.blockHashes('DOGE', hashesBefore[0].block_index),
        };
    });
    evidence.at3b = { lockTx, transferId: row.transfer_id, minedAt: reading.orphan.height,
        orphanedHash: reading.orphan.hash, retracted: !!reading.retracted, destAddress: dest.address };

    assert.strictEqual(reading.balance, '0',
        'the DOGE indexer applied a transfer whose source leg is no longer on the BTC chain');
    assert.strictEqual(String(reading.hashesAfter[0].ledger_hash), String(hashesBefore[0].ledger_hash),
        'the DOGE ledger_hash at block ' + hashesBefore[0].block_index + ' moved');
    assert.strictEqual(String(reading.hashesAfter[0].actions_hash), String(hashesBefore[0].actions_hash),
        'the DOGE actions_hash at block ' + hashesBefore[0].block_index + ' moved');
    // The retraction itself is the claim (spec section 15, AT3 b): a row that stays
    // finalized while its source is off the chain is applied the moment effective_time
    // passes, and "never applied" above was only ever a reading taken before then.
    assert.ok(reading.retracted,
        'transfer ' + row.transfer_id + ' stayed finalized for 180s after its source lock left the ' +
        'BTC chain; the federation never retracted it');
});

// Poll the destination credit up to `budgetMs`, then require it: the orphan that follows
// only means "after the mint" if the mint is on the DOGE ledger first.
async function waitForMintApplied(dest, budgetMs) {
    const deadline = Date.now() + budgetMs;
    while (Date.now() < deadline &&
           Number(await venue.addressBalance('DOGE', dest.address, GAS_TICK)) < 1) {
        await new Promise((r) => setTimeout(r, 3000));
    }
    assert.strictEqual(await venue.addressBalance('DOGE', dest.address, GAS_TICK), '1',
        'the mint never applied on DOGE within ' + Math.round(budgetMs / 1000) +
        's, so this case cannot orphan "after the mint"');
}

// Every reading here is of the ledger WITHOUT the lock: it waits for the venue BTC indexer
// to have rolled the lock back and is taken while mining is still paused, because the
// first block mined afterwards confirms the lock again and the escrow comes back with it.
async function readLedgerWithoutLock(dest, dogeHashBefore) {
    await venueBtcCaughtUp('after the AT3c orphan');
    return {
        inv: await venue.bridgeInvariant(GAS_TICK),
        escrow: escrowOf(await venue.bridgeBalances('BTC', GAS_TICK), 'DOGE'),
        balance: await venue.addressBalance('DOGE', dest.address, GAS_TICK),
        dogeHashAfter: await venue.blockHashes('DOGE', dogeHashBefore[0].block_index),
    };
}

registerBridgeTest("(c) a lock orphaned AFTER the mint applied leaves the credit, and the deficit reads CRIT", async function () {
    this.timeout(0);
    if (needsFederation(this, 'AT3c')) return;

    // D16, ruled: milestone 1 ships NO destination-side unwind. So the correct
    // behaviour is the uncomfortable one, and this case pins it: the DOGE credit
    // STAYS, the DOGE hashes do not move, the BTC escrow falls away with BTC's own
    // rollback, and the invariant is what surfaces the damage.
    const { dest, sender } = await fundLeg('AT3C');
    const lockTx = await transactionHelper.createAndSendTransaction(
        sender, lockWireV0('DOGE', dest.address, 1, ''));
    const row = await venue.waitForFinalizedTransfer((r) => String(r.dest_address) === dest.address);
    assert.ok(row, 'the AT3c lock never finalized');

    // FREEZE BTC from here, not sooner: the source leg is already finalized, and every
    // step left is a wait on the DESTINATION's own clock (the hub stamps effective_time
    // off wall time plus DOGE's relay margin, and DOGE applies at its own next block past
    // it), so no further BTC block buys this case anything, while every ambient BTC block
    // deepens the orphan towards the tracker's undo window. The wait is budgeted from the
    // hub's own margin: a leg cannot apply before the margin has run, so a wait equal to
    // the margin ends at the first second the leg is even eligible.
    const budgetMs = destinationApplyBudgetMs(hubRelayMarginFloorS('DOGE'));
    const reading = await withMiningPaused(regtestMinerConnector, async () => {
        // Wait for the mint to APPLY before the orphan; orphaning first would be AT3b.
        await waitForMintApplied(dest, budgetMs);
        const dogeHashBefore = await venue.blockHashes('DOGE');
        const orphan = await reorgBtcFrom(lockTx, 4);
        return Object.assign({ orphan, dogeHashBefore }, await readLedgerWithoutLock(dest, dogeHashBefore));
    });

    const entry = reading.inv[GAS_TICK].DOGE;
    const cls = classifyInvariant(entry);
    evidence.at3c = { lockTx, transferId: row.transfer_id, minedAt: reading.orphan.height,
        orphanedHash: reading.orphan.hash, applyBudgetMs: budgetMs, invariant: entry, escrow: reading.escrow };

    assert.strictEqual(reading.balance, '1',
        'the DOGE credit was unwound, which milestone 1 explicitly does not do (D16)');
    assert.strictEqual(String(reading.dogeHashAfter[0].ledger_hash), String(reading.dogeHashBefore[0].ledger_hash),
        'a BTC reorg moved a DOGE ledger hash');
    assert.strictEqual(cls.verdict, 'deficit',
        'getbridgeinvariant reads ' + JSON.stringify(entry) + ' rather than a deficit');

    const watch = require('../../../../claude/scripts/xchain-watch.js');
    const items = watch.bridgeInvariantVerdicts([{ label: 'venue-hub-0', ok: true, byTick: reading.inv }])
        .filter((i) => i.tick === GAS_TICK && i.chain === 'DOGE');
    evidence.at3c_watch = items.map((i) => ({ sev: i.sev, kind: i.kind }));
    assert.strictEqual(items.length, 1);
    assert.strictEqual(items[0].sev, 'crit');
    assert.strictEqual(items[0].kind, 'BRIDGE_INVARIANT_DEFICIT');
});
