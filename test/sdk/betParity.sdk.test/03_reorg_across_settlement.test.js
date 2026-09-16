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
const cryptoHelper = require('../../cryptoHelper');
const { dbQuery, getFeed, getBets, balanceOf, amtEq } = require('../betHelper');
const {
    state, sleep, bQuery, tipOf, hashesOf, compareHashes, waitNodeB, reorgPast
} = require('./support/bet_parity_support');

async function reindexReplacementBranch(resolveBlock) {
    const miner = global.regtestMinerConnector;
    await miner.pauseMining();
    try {
        await reorgPast(resolveBlock, 'bet-parity-reorg');
        // The orphaned resolve returns to the mempool; give it blocks to be
        // re-mined and both nodes room to roll back and replay.
        for (let i = 0; i < 4; i++) await global.nodeConnector.generateBlock(
            (await cryptoHelper.getNewAddress('bet-parity-reorg2', global.COIN, global.NETWORK, null, 'legacy', 0)).address, []);
        // Hand the miner back only once node A's indexer has reached the
        // competing branch tip, so the rollback and replay are observable
        // instead of merely likely after a fixed settle.
        const branchTip = Number(await global.nodeConnector.getBlockCount());
        for (let i = 0; i < 30; i++) {
            if (await tipOf(dbQuery) >= branchTip) break;
            await sleep(1000);
        }
    } finally {
        await miner.resumeMining();
    }
}

async function waitForChangedHash(q, resolveBlock, before) {
    for (let i = 0; i < 60; i++) {
        const current = (await hashesOf(q, resolveBlock, resolveBlock)).get(resolveBlock);
        if (current && current.ledger_hash && current.ledger_hash !== before.ledger_hash) return current;
        await sleep(3000);
    }
    return null;
}

async function waitForResolvedFeed(feedIndex) {
    let feed = null;
    for (let i = 0; i < 40; i++) {
        feed = await getFeed(feedIndex);
        if (feed && feed.feed_status === 'resolved') break;
        await sleep(3000);
    }
    return feed;
}

async function terminalHistory(feedIndex) {
    const history = [];
    for (const [label, q] of [['node A', dbQuery], ['node B', bQuery]]) {
        const rows = await q(
            'SELECT b.action_index, COUNT(*) AS terminal_rows ' +
            '  FROM bets b ' +
            // bet_statuses.action_index is the CAUSING action; the bet is
            // keyed by bet_action_index. Joining on the wrong one counts
            // nothing and passes for the wrong reason.
            '  JOIN bet_statuses bs ON bs.bet_action_index = b.action_index ' +
            '  JOIN index_statuses s ON s.id = bs.status_id ' +
            ' WHERE b.feed_action_index = ? AND s.status IN (\'won\', \'lost\', \'refunded\') ' +
            ' GROUP BY b.action_index', [feedIndex]);
        history.push([label, rows]);
    }
    return history;
}

describe('[sdk] BET two-node state-hash parity (§12 E8: the fleet leg)', function () {
    it('a reorg across the settlement block re-converges both nodes', async function () {
        if (!state.following) this.skip();
        const { resolveBlock, feedIndex, startBlock, p1, tick } = state;
        expect(resolveBlock, 'resolve block located').to.be.a('number');

        // Pin what each node currently holds AT the doomed height. The orphaned
        // block is replaced by a different one, so both nodes must end up with a
        // different ledger hash there. Without this the drill could read the
        // pre-reorg state, find the market already 'resolved', and pass without
        // either node having rolled back anything.
        const preA = (await hashesOf(dbQuery, resolveBlock, resolveBlock)).get(resolveBlock);
        const preB = (await hashesOf(bQuery,  resolveBlock, resolveBlock)).get(resolveBlock);
        expect(preB, 'node B had indexed the block that is about to be orphaned').to.not.equal(undefined);
        expect(preB.ledger_hash, 'both nodes agreed on it beforehand').to.equal(preA.ledger_hash);

        await reindexReplacementBranch(resolveBlock);

        // Both nodes must actually roll back and re-index the replacement block
        // at that height, not merely still be sitting on the old answer.
        const postA = await waitForChangedHash(dbQuery, resolveBlock, preA);
        expect(postA, 'node A rolled back and re-indexed the orphaned height').to.not.equal(null);

        // Node A re-settles (proved on its own by betReorgDrill); here the point
        // is that node B, rolling back independently, lands on the same state.
        const feed = await waitForResolvedFeed(feedIndex);
        expect(feed.feed_status, 'market re-settled on node A after the reorg').to.equal('resolved');

        const postB = await waitForChangedHash(bQuery, resolveBlock, preB);
        expect(postB, 'node B rolled back and re-indexed the orphaned height on its own').to.not.equal(null);

        const tipA = await tipOf(dbQuery);
        const tipB = await waitNodeB(tipA);
        expect(tipB, 'node B caught up after the reorg').to.be.at.least(tipA);

        const diffs = await compareHashes(startBlock, tipA);
        expect(diffs, 'the two nodes did not re-converge after the reorg:\n'
            + JSON.stringify(diffs.slice(0, 8), null, 1)).to.deep.equal([]);

        // No double credit on EITHER node: exactly one terminal status per bet,
        // read from history rather than inferred from a balance (a compensating
        // pair of errors satisfies a sum).
        for (const [label, rows] of await terminalHistory(feedIndex)) {
            expect(rows.length, `${label} has both bets in history`).to.equal(2);
            for (const r of rows)
                expect(Number(r.terminal_rows),
                    `${label} credited bet ${r.action_index} exactly once`).to.equal(1);
        }
        const bets = await getBets(feedIndex);
        expect(bets.map(r => r.bet_status).sort(), 'terminal statuses on node A after replay')
            .to.deep.equal(['lost', 'won']);
        amtEq(await balanceOf(p1.address, tick), '14.85', 'winner payout unchanged after the reorg');
    });
});
