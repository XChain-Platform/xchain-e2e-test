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
const { getFeed } = require('../betHelper');
const {
    ACTIVATION_DELAY_BLOCKS, SyncUtility, state, syncBuildStateHashData, bQuery,
    hashesOf
} = require('./support/bet_parity_support');

async function buildNodeBPreimage() {
    // The preimage builder needs the two reads the indexer's own db exposes:
    // doQuery, and the index_statuses lookup it resolves 'completed' through.
    const adapter = {
        doQuery: (sql, params) => bQuery(sql, params),
        getStatusId: async (status) => {
            const rows = await bQuery('SELECT id FROM index_statuses WHERE status = ? LIMIT 1', [status]);
            return rows.length ? Number(rows[0].id) : null;
        }
    };
    return syncBuildStateHashData(adapter, state.latchBlock, {
        activationDelay: ACTIVATION_DELAY_BLOCKS,
        gasTick:         undefined,          // defaults to the consensus GAS symbol
        network:         global.NETWORK,
        coin:            global.COIN_CODE
    });
}

describe('[sdk] BET two-node state-hash parity (§12 E8: the fleet leg)', function () {
    it('node B\'s committed state hash is reproducible from its own rows, and the BET class is load-bearing in it',
        async function () {
        if (!state.following) this.skip();
        const { feedIndex, latchBlock } = state;
        if (!syncBuildStateHashData || !SyncUtility) {
            console.log('xchain-sync sibling absent; skipping the state-hash recompute leg');
            this.skip();
        }

        // APPLY-TIME ONLY. The class rows carry their CURRENT status, so this has
        // to run while the feed is still `closed`. Once it resolves, a recompute
        // of the latch block returns 'resolved' and can never match again.
        const feed = await getFeed(feedIndex);
        expect(feed.feed_status, 'still latched (the recompute leg must precede the resolve)')
            .to.equal('closed');

        const util = new SyncUtility();
        const preimage = await buildNodeBPreimage();
        const committed = (await hashesOf(bQuery, latchBlock, latchBlock)).get(latchBlock);
        expect(committed && committed.state_hash, 'node B committed a state hash for the latch block')
            .to.be.a('string');
        expect(util.getDataHash(preimage),
            'the follower recompute must reproduce what node B committed at the latch block')
            .to.equal(committed.state_hash);

        // The BET class is genuinely present at this block...
        expect(preimage.bet_feed_status, 'bet_feed_status class present in the preimage').to.be.an('array');
        expect(preimage.bet_feed_status.map(r => String(r.action_index)),
            'the latched feed is in the hashed class').to.include(String(feedIndex));

        // ...and load-bearing in two distinct senses, because only the second
        // one rules out a class that is present but empty:
        //
        //   (a) a follower that never learned about the BET keys at all drops
        //       them from the preimage, and
        //   (b) a follower that HAS the keys but failed to apply the latch
        //       hashes them empty.
        //
        // Both must move the hash. If (b) did not, a node could silently miss
        // the latch and still agree - the fork class §8 was written against.
        const dropped = Object.assign({}, preimage);
        delete dropped.bet_feed_status;
        delete dropped.bet_status;
        expect(util.getDataHash(dropped),
            'dropping the BET keys left the state hash unchanged: the class is NOT in the preimage')
            .to.not.equal(committed.state_hash);

        const emptied = Object.assign({}, preimage, { bet_feed_status: [], bet_status: [] });
        expect(util.getDataHash(emptied),
            'an EMPTY BET class hashes the same as the real one: the latch itself is not covered')
            .to.not.equal(committed.state_hash);
    });
});
