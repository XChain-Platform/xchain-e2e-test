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
 * XChain Platform E2E - BET reorg drill (spec §12 E8)
 *
 * E8 is the sharp one. The pass-4 review found a FORK CLASS in the betting
 * design: the `closed` latch and the terminal flip are in-place UPDATEs on rows
 * that were written in an EARLIER block. Two consequences, both silent:
 *
 *   1. an in-place flip on a surviving row is invisible to action-scoped
 *      hashing, so two nodes can disagree with NO state-hash mismatch, and
 *   2. the append-only rollback (`DELETE WHERE block_index >= ?`) cannot undo
 *      it, so a reorg past a latch block would leave the feed closed forever.
 *
 * The fix was three legs landing together (stateHash class, rollback.js reset,
 * tableLifecycle registration) plus the `closed_block` / `terminal_block` /
 * `settled_block` stamps that make the flips addressable at all. This drill is
 * the live proof that the reset works on a real chain:
 *
 *   Leg 1 (resolution): orphan the block that settled a market. The resolve tx
 *          returns to the mempool and is re-mined, so the market settles a
 *          SECOND time. Payouts must be byte-identical and each bet must still
 *          receive exactly ONE terminal credit -- a rollback that failed to
 *          restore escrows, or a settlement that failed to filter on
 *          bet_status='open', double-pays here and nowhere else.
 *
 *   Leg 2 (latch): orphan the block that latched a feed closed, and assert the
 *          feed is re-latched against a block on the LIVE chain rather than
 *          left stamped with an orphaned block_index.
 *
 * Run: COIN=bitcoin NETWORK=regtest npx mocha --require ./test/initialCheck.test.js \
 *        test/sdk/betReorgDrill.sdk.test.js
 *
 ********************************************************************/

const { expect } = require('chai');
const cryptoHelper = require('../cryptoHelper');
const { makeSdk, fundedGasAddress } = require('./sdkHelper');
const {
    MIN_REFUND_WINDOW, dbQuery, getFeed, getBets, balanceOf, amtEq, actionIndexOf,
    blockTime, jumpTo, resumeMiningAtFrozenClock, releaseClock, waitFeedStatus,
    issueWagerToken, submitBet
} = require('./betHelper');

function haveConnectors() {
    return global.nodeConnector && global.regtestMinerConnector && global.indexerDatabase;
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function blockIndexOfAction(actionIndex) {
    const rows = await dbQuery('SELECT block_index FROM actions WHERE action_index = ?', [actionIndex]);
    return rows.length ? Number(rows[0].block_index) : null;
}

async function indexerTip() {
    const rows = await dbQuery('SELECT MAX(block_index) AS tip FROM blocks', []);
    return rows.length ? Number(rows[0].tip) : 0;
}

// Orphan `targetBlock` and build a longer competing chain over it. Transactions
// from the orphaned blocks return to the mempool and are re-mined onto the new
// branch, which is exactly the replay this drill wants to observe.
async function reorgPast(targetBlock, label) {
    const node  = global.nodeConnector;
    const miner = global.regtestMinerConnector;

    const tipBefore = await node.getBlockCount();
    const oldHash   = await node.getBlockHash(targetBlock);
    const payout    = (await cryptoHelper.getNewAddress(label, global.COIN, global.NETWORK, null, 'legacy', 0)).address;

    await node.invalidateBlock(oldHash);
    expect(await node.getBlockCount(), 'node rolled back below the target block')
        .to.equal(targetBlock - 1);

    const need = tipBefore - (targetBlock - 1) + 2;
    for (let i = 0; i < need; i++) await node.generateBlock(payout, []);
    expect(await node.getBlockHash(targetBlock), 'the chain actually reorged').to.not.equal(oldHash);
    return oldHash;
}

// Wait for the decoder -> indexer rollback + replay to settle at or past `height`.
async function waitIndexerPast(height, timeoutMs = 240000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await indexerTip() >= height) return true;
        await sleep(3000);
    }
    return false;
}

describe('[sdk] BET reorg drill (§12 E8: in-place latch + settlement reset)', function () {
    this.timeout(0);

    let sdk, oracle, p1, p2, tickResolve, tickLatch;

    before(async function () {
        if (!haveConnectors()) this.skip();
        // Empty-competing-chain reorgs are a BTC/LTC mechanism; DOGE regtest's
        // fast-chain mining model differs. Skip, as the other reorg drills do.
        if (global.COIN_CODE === 'DOGE') this.skip();
        // compactAddresses off: the SDK's ^id compaction outruns the indexer's
        // wire acceptance on this stack; this drill tests BET reorg semantics.
        sdk = makeSdk({ compactAddresses: false });

        // All funding happens up front, at the prevailing clock, before any jump.
        oracle = await fundedGasAddress(sdk, 1);
        p1     = await fundedGasAddress(sdk, 1);
        p2     = await fundedGasAddress(sdk, 1);

        tickResolve = await issueWagerToken(sdk, oracle, [
            [p1.address, '10.00000000'], [p2.address, '5.00000000']
        ], 1000000, 'BR8');

        tickLatch = await issueWagerToken(sdk, oracle, [
            [p1.address, '2.00000000']
        ], 1000000, 'BL8');
    });

    after(async function () {
        try { await global.regtestMinerConnector.resumeMining(); } catch (e) { /* best effort */ }
        await releaseClock();
    });

    it('leg 1: orphaning the settlement block re-settles identically, with no double credit', async function () {
        const now = await blockTime();
        const deadline = now + 900;

        let res = await submitBet(sdk, oracle, sdk.betting.createMarketParams({
            label: 'E8 settlement reorg', outcomes: ['Yes', 'No'], tick: tickResolve,
            fee: '1.00', deadline, refundWindow: MIN_REFUND_WINDOW, now
        }));
        expect(res.indexed.status, 'create status').to.equal('valid');
        const feedIndex = actionIndexOf(res);

        res = await submitBet(sdk, p1, sdk.betting.placeBetParams({
            feedActionIndex: feedIndex, outcome: 0, amount: '10.00000000' }));
        expect(res.indexed.status, 'p1 bet status').to.equal('valid');
        res = await submitBet(sdk, p2, sdk.betting.placeBetParams({
            feedActionIndex: feedIndex, outcome: 1, amount: '5.00000000' }));
        expect(res.indexed.status, 'p2 bet status').to.equal('valid');

        await jumpTo(deadline + 60, 2);
        await waitFeedStatus(feedIndex, 'closed');
        await resumeMiningAtFrozenClock();

        res = await submitBet(sdk, oracle, sdk.betting.resolveMarketParams({
            feedActionIndex: feedIndex, outcome: 0 }));
        expect(res.indexed.status, 'resolve status').to.equal('valid');
        const resolveIndex = actionIndexOf(res);

        // T = 15, W = 10, fee = floor(15 * 1/100, 8) = 0.15, pot = 14.85
        // p1 = floor(10 * 14.85 / 10, 8) = 14.85, dust = 0
        const before = {
            p1:     await balanceOf(p1.address, tickResolve),
            p2:     await balanceOf(p2.address, tickResolve),
            oracle: await balanceOf(oracle.address, tickResolve)
        };
        amtEq(before.p1, '14.85', 'p1 payout before the reorg');
        expect((await getFeed(feedIndex)).feed_status, 'resolved before the reorg').to.equal('resolved');

        const resolveBlock = await blockIndexOfAction(resolveIndex);
        expect(resolveBlock, 'resolve block located').to.be.a('number');

        const miner = global.regtestMinerConnector;
        await miner.pauseMining();
        try {
            await reorgPast(resolveBlock, 'bet-reorg-settle');
            expect(await waitIndexerPast(resolveBlock + 1), 'indexer followed the reorg').to.equal(true);
            // Give the replayed resolve room to be re-mined and re-indexed.
            for (let i = 0; i < 4; i++) await global.nodeConnector.generateBlock(
                (await cryptoHelper.getNewAddress('bet-reorg-settle2', global.COIN, global.NETWORK, null, 'legacy', 0)).address, []);
            await sleep(8000);
        } finally {
            await miner.resumeMining();
        }

        // Whether the resolve re-mined immediately or a beat later, the market must
        // converge on the SAME settlement. The failure this guards against is a
        // rollback that restored the credits but not the escrows (or a settlement
        // that summed bets without the bet_status='open' filter), either of which
        // pays the winner twice.
        let feed = null;
        for (let i = 0; i < 40; i++) {
            feed = await getFeed(feedIndex);
            if (feed && feed.feed_status === 'resolved') break;
            await sleep(3000);
        }
        expect(feed.feed_status, 'market re-settled after the reorg').to.equal('resolved');

        amtEq(await balanceOf(p1.address, tickResolve), before.p1,
            'p1 payout is IDENTICAL after rollback + replay (not doubled)');
        amtEq(await balanceOf(p2.address, tickResolve), before.p2,
            'p2 (loser) balance unchanged');
        amtEq(await balanceOf(oracle.address, tickResolve), before.oracle,
            'oracle fee credited exactly once across the reorg');

        const rows = await getBets(feedIndex);
        expect(rows.length, 'both bet rows survive the reorg').to.equal(2);
        expect(rows.filter(r => r.bet_status === 'open').length,
            'no bet left open on the re-settled feed').to.equal(0);

        // One terminal credit per bet, asserted directly rather than inferred from
        // the balances (a compensating pair of errors satisfies a sum).
        //
        // bet_statuses is a TRANSITION history, so a settled bet legitimately holds
        // an 'open' row from the placement plus one terminal row from settlement.
        // What must never appear is the same status twice: that is the signature of
        // a replay whose rollback failed to clear the orphaned history.
        for (const r of rows) {
            const hist = await dbQuery(
                `SELECT s.status AS status, COUNT(*) AS n
                   FROM bet_statuses bs
                   INNER JOIN index_statuses s ON s.id = bs.status_id
                  WHERE bs.bet_action_index = ?
                  GROUP BY s.status`, [r.action_index]);

            const dupes = hist.filter(h => Number(h.n) !== 1).map(h => `${h.status} x${h.n}`);
            expect(dupes.join(', '),
                `bet ${r.action_index}: no status may be recorded twice across a reorg`).to.equal('');

            const terminal = hist.filter(h => ['won', 'lost', 'refunded'].includes(String(h.status)));
            expect(terminal.length,
                `bet ${r.action_index}: exactly one terminal status (got ${hist.map(h => h.status).join('/')})`)
                .to.equal(1);
        }
    });

    it('leg 2: orphaning the latch block re-latches against a live block', async function () {
        const now = await blockTime();
        const deadline = now + 300;

        let res = await submitBet(sdk, oracle, sdk.betting.createMarketParams({
            label: 'E8 latch reorg', outcomes: ['Yes', 'No'], tick: tickLatch,
            fee: '0', deadline, refundWindow: MIN_REFUND_WINDOW, now
        }));
        expect(res.indexed.status, 'create status').to.equal('valid');
        const feedIndex = actionIndexOf(res);

        res = await submitBet(sdk, p1, sdk.betting.placeBetParams({
            feedActionIndex: feedIndex, outcome: 0, amount: '2.00000000' }));
        expect(res.indexed.status, 'bet status').to.equal('valid');
        const betIndex = actionIndexOf(res);
        const betBlock = await blockIndexOfAction(betIndex);

        await jumpTo(deadline + 60, 2);
        const latched = await waitFeedStatus(feedIndex, 'closed');
        expect(latched.feed_status, 'feed latched').to.equal('closed');
        const latchBlock = Number(latched.closed_block);
        expect(latchBlock, 'closed_block stamped').to.be.greaterThan(0);
        // The latch is an END-OF-BLOCK pass, so it lands strictly after the bet.
        expect(latchBlock, 'latch is later than the bet it closes betting on')
            .to.be.greaterThan(betBlock);

        const miner = global.regtestMinerConnector;
        await miner.pauseMining();
        try {
            await reorgPast(latchBlock, 'bet-reorg-latch');
            expect(await waitIndexerPast(latchBlock + 1), 'indexer followed the reorg').to.equal(true);
            await sleep(8000);
        } finally {
            await miner.resumeMining();
        }

        // The clock is still past the deadline, so the pass re-latches on the new
        // branch. What must NOT survive is the old stamp: an unreset closed_block
        // would still name the orphaned block, which is precisely the un-rollback-able
        // in-place flip the pass-4 review flagged.
        let feed = null;
        for (let i = 0; i < 40; i++) {
            feed = await getFeed(feedIndex);
            if (feed && feed.feed_status === 'closed' && feed.closed_block !== null) break;
            await sleep(3000);
        }
        expect(feed.feed_status, 'feed is closed again after the reorg').to.equal('closed');
        expect(feed.closed_block, 'closed_block re-stamped').to.not.equal(null);

        // The decisive assertion: the stamp names a block the indexer still has,
        // i.e. one on the LIVE chain. Rollback deletes orphaned blocks, so a stamp
        // pointing at a block absent from `blocks` is a stamp pointing at an orphan.
        const stamped = Number(feed.closed_block);
        const live = await dbQuery('SELECT COUNT(*) AS n FROM blocks WHERE block_index = ?', [stamped]);
        expect(Number(live[0].n), 'closed_block names a block on the live chain').to.equal(1);
        expect(stamped, 'closed_block is within the indexed chain').to.be.at.most(await indexerTip());

        // The bet itself was in an earlier, surviving block and is still open: the
        // reorg reset the feed's status without disturbing the stakes under it.
        const rows = await getBets(feedIndex);
        expect(rows.length, 'bet row survived the reorg').to.equal(1);
        expect(rows[0].bet_status, 'the bet is still open on a merely-closed feed').to.equal('open');
    });
});
