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
 ********************************************************************/

const { expect } = require('chai');
const {
    dbQuery, waitFeedStatus, balanceOf, amtEq, actionIndexOf,
    resumeMiningAtFrozenClock, submitBet
} = require('../betHelper');
const {
    state, bQuery, tipOf, compareHashes, betClasses, waitNodeB, blockIndexOfAction
} = require('./support/bet_parity_support');

describe('[sdk] BET two-node state-hash parity (§12 E8: the fleet leg)', function () {
    it('the resolve and the settlement land identically on both nodes', async function () {
        if (!state.following) this.skip();
        const { sdk, oracle, p1, p2, tick, feedIndex, startBlock } = state;
        await resumeMiningAtFrozenClock();
        const res = await submitBet(sdk, oracle, sdk.betting.resolveMarketParams({
            feedActionIndex: feedIndex, outcome: 0 }));
        expect(res.indexed.status, 'resolve status').to.equal('valid');
        const resolveIndex = state.resolveIndex = actionIndexOf(res);

        const settled = await waitFeedStatus(feedIndex, 'resolved');
        expect(settled.feed_status, 'market resolved on node A').to.equal('resolved');
        const resolveBlock = state.resolveBlock = await blockIndexOfAction(resolveIndex);

        // T = 15, W = 10, fee = floor(15 * 1/100, 8) = 0.15, pot = 14.85,
        // p1 = floor(10 * 14.85 / 10, 8) = 14.85, dust = 0.
        amtEq(await balanceOf(p1.address, tick), '14.85', 'winner payout on node A');

        const endBlock = state.endBlock = await tipOf(dbQuery);
        const tipB = await waitNodeB(endBlock);
        expect(tipB, 'node B caught up past the settlement').to.be.at.least(endBlock);

        const diffs = await compareHashes(startBlock, endBlock);
        expect(diffs, 'node A and node B diverged over the full lifecycle:\n'
            + JSON.stringify(diffs.slice(0, 8), null, 1)).to.deep.equal([]);

        const [ca, cb] = [await betClasses(dbQuery, startBlock, endBlock),
                          await betClasses(bQuery,  startBlock, endBlock)];
        expect(cb, 'BET state-hash class rows differ across nodes after settlement').to.deep.equal(ca);
        expect(cb.bets.length, 'both bets settled in the class').to.equal(2);
        expect(new Set(cb.bets.map(r => r.settled_block)).size,
            'both bets settled in the SAME block').to.equal(1);

        // The settled ledger itself, not just its hash: node B credits the same
        // winner the same amount, from rows it derived on its own.
        const bBalance = await bQuery(
            'SELECT b.amount FROM balances b ' +
            '  JOIN index_addresses ia ON ia.id = b.address_id ' +
            '  JOIN index_tickers   it ON it.id = b.tick_id ' +
            ' WHERE ia.address = ? AND it.tick = ?', [p1.address, tick]);
        amtEq(bBalance.length ? String(bBalance[0].amount) : '0', '14.85',
            'node B credits the winner identically');
        amtEq(await balanceOf(p2.address, tick), '0', 'loser keeps nothing on node A');
    });
});
