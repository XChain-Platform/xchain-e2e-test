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
 * XChain Platform E2E - BET TWO-NODE parity drill (spec §12 E8, second half)
 *
 * E8 asks for two things. `betReorgDrill.sdk.test.js` covers the first: one
 * node rolls back across a latch/settlement block and re-converges on itself.
 * This file covers the second, which is the one P4's verify line names:
 * "state hash equal across two nodes" over a full bet lifecycle.
 *
 * WHY A SECOND NODE IS A DIFFERENT TEST. Every other BET drill reads the node
 * that WROTE the state, so it can only prove that node is self-consistent. The
 * fork class the pass-4 review found is invisible to exactly that: the `closed`
 * latch and the terminal/settlement flips are in-place UPDATEs on rows written
 * in EARLIER blocks, so a node that mishandled one still agrees with itself. It
 * takes a second node, which never saw the first node's in-memory state and
 * arrives at each block cold, to show the state is a deterministic function of
 * the chain. That is what a real fleet does every block, and what a follower
 * halts on.
 *
 * THE VENUE. Node B is a second indexer container on the same regtest chain,
 * with its own database, provisioned by `scripts/bet-parity-node.sh up` (run on
 * the venue host). It is clone-forward, not a genesis replay: this chain's
 * history was created with every gate genesis-active, so re-indexing it from
 * block 0 mis-decodes it (drill-clone-forward-venue-recipe). Node B therefore
 * inherits a consistent snapshot of node A's database and independently indexes
 * every block from there, which covers the whole bet lifecycle this drill
 * drives. Without that container the file SKIPS, loudly, rather than passing
 * vacuously.
 *
 * WHAT IS COMPARED, AND WHY THAT SET:
 *
 *   1. ledger/actions/contract hash per block - the three CONSENSUS hashes.
 *      Two independently indexing nodes must agree on every one, on every block.
 *   2. state_hash per block - the fourth, replication-integrity hash, which is
 *      the ONLY one that can see an in-place flip (stateHash.js). This is where
 *      a dropped latch shows up at all.
 *   3. The BET state-hash CLASS ROWS themselves, read with the same keys
 *      stateHash.js hashes by (bet_feeds.closed_block / terminal_block,
 *      bets.settled_block), asserted equal across nodes AND non-empty exactly
 *      at the blocks where the flips happened. Hash equality alone would also
 *      hold if both nodes ignored betting entirely; this pins WHICH class is
 *      carrying the lifecycle.
 *   4. The settled ledger: feed row, per-bet terminal status, and balances.
 *
 * The state-hash leg does not stop at "the two hashes match". It recomputes
 * node B's committed state_hash from node B's own rows through the FOLLOWER's
 * implementation (xchain-sync's byte-aligned stateHash twin), and then
 * recomputes it a second time with the two BET keys stripped out of the
 * preimage. The first must match what node B committed; the second must NOT.
 * That is the sensitivity proof that the latch is genuinely inside the hash, so
 * a follower that silently dropped it HALTS instead of diverging quietly.
 *
 * A last comparison leg deliberately BREAKS node B (a corrupted ledger hash at
 * the latch block, inside a transaction that is rolled back) and requires the
 * same comparison to report it. A parity assertion that has never failed is
 * indistinguishable from one that cannot.
 *
 * THREE TRAPS, all paid for once already:
 *
 *   1. CONFIGURE NODE B EXACTLY LIKE NODE A. The first build launched it without
 *      HUB_API_URL, reasoning that a follower should not be able to write to the
 *      hub. But the hub is the CONFIG ORACLE: without it the indexer never gets
 *      a hub DB handle, silently falls back to its own database for oracle
 *      prices, finds none, and rejects every native-fee-priced action the source
 *      accepted. The two nodes then diverge for a reason that has nothing to do
 *      with consensus code (caught here as a real divergence on an unrelated
 *      ISSUE, "no current oracle price for BTC/USD"). See the script header.
 *   1b. AND FEED IT THE SAME ORACLE PRICES. Even with the hub reachable, this
 *      venue has no HUB_DB_NAME, so the indexer reads fee-oracle prices out of
 *      its OWN database - and the harness seeds them by writing there directly.
 *      Node B never sees those writes, and diverges on anyone else's
 *      native-fee/FIAT action. The drill mirrors the two price tables across for
 *      its duration, which is what hub_db_sync does in a real fleet
 *      (mirrorOracleTables below).
 *   2. THE VENUE OUT-MINES ITS OWN INDEXER. initialCheck sets the miner to one
 *      block per second while a near-empty block costs the indexer 1.5-3s to
 *      parse, and a second indexer doubles that. The source falls behind the
 *      chain and every submit dies on the SDK's 120s indexing wait. This file
 *      eases the cadence and levels both nodes before it starts.
 *   3. APPLY-TIME ONLY for the state-hash recompute, below.
 *
 * APPLY-TIME CONSTRAINT (the trap in this file): the state-hash preimage is
 * only reproducible at the tip. Its BET rows are selected by stamp column but
 * carry the row's CURRENT status, so once a latched feed later resolves, a
 * recompute of the latch block returns 'resolved' where the node hashed
 * 'closed'. The recompute leg therefore runs while the feed is still latched
 * and before any resolve is broadcast; do not move it later in the file.
 *
 * Run:
 *   # on the venue host, once:
 *   bash scripts/bet-parity-node.sh up
 *   # from the Mac:
 *   BET_PARITY_DB_NAME=XChain_BTC_DrillB_Indexer npm run test:sdk:bet-parity
 *
 ********************************************************************/

const { expect } = require('chai');
const Database   = require('../../src/db');
const { makeSdk, fundedGasAddress } = require('./sdkHelper');
const {
    MIN_REFUND_WINDOW, dbQuery, balanceOf, amtEq, actionIndexOf, blockTime,
    jumpTo, waitFeedStatus, issueWagerToken, submitBet
} = require('./betHelper');
const {
    state, haveConnectors, sleep, bQuery, tipOf, compareHashes, betClasses, waitNodeB,
    levelNodes, mirrorOracleTables
} = require('./betParity.sdk.test/support/bet_parity_support');

async function connectNodeB(context) {
    if (!haveConnectors()) context.skip();
    // Empty-competing-chain reorgs are a BTC/LTC mechanism; DOGE regtest's
    // fast-chain mining model differs, as the other reorg drills note.
    if (global.COIN_CODE === 'DOGE') context.skip();
    if (!process.env.BET_PARITY_DB_NAME) {
        console.log('BET_PARITY_DB_NAME unset: no second indexer node provisioned.');
        console.log('Provision one on the venue host with scripts/bet-parity-node.sh up, then re-run.');
        context.skip();
    }

    state.nodeB = new Database(
        process.env.DATABASE_URL || '127.0.0.1',
        parseInt(process.env.BET_PARITY_DB_PORT || process.env.DATABASE_PORT || '3306'),
        process.env.BET_PARITY_DB_NAME,
        process.env.BET_PARITY_DB_USER || process.env.INDEXER_DB_USER,
        process.env.BET_PARITY_DB_PASS || process.env.INDEXER_DB_PASS
    );
    // Bounded: the shared Database.getConnection RETRIES forever by design,
    // so an unreachable node B would hang the suite instead of skipping it.
    const reachable = await Promise.race([
        state.nodeB.ping().catch(() => false),
        sleep(20000).then(() => false)
    ]);
    if (!reachable) {
        console.log(`node B database ${process.env.BET_PARITY_DB_NAME} is not reachable; skipping`);
        context.skip();
    }
}

async function prepareParityVenue() {
    // Ease the miner off the harness's one-block-per-second cadence for the
    // duration of this file (see levelNodes above for why that cadence is
    // unsurvivable with two indexers on this venue). Both numbers matter:
    // max_time caps the idle cadence, tx_added_time caps how soon a block
    // follows a transaction, and it was the latter that kept blocks coming
    // every 1.5s through the funding burst. after() hands the miner back to
    // its defaults.
    await global.regtestMinerConnector.setMiningTime(6000, 4000);

    // Keep node B supplied with the same oracle prices the harness injects
    // into node A, for as long as this file runs. Started BEFORE anything is
    // submitted, because node B has to have the row by the time it parses
    // the block that needs it, and it parses a few seconds behind.
    await mirrorOracleTables();
    state.mirrorTimer = setInterval(() => { mirrorOracleTables().catch(() => {}); }, 1000);

    // Start level. Node A being behind the CHAIN when the drill opens is the
    // single most likely way this file fails for a reason that has nothing
    // to do with betting.
    const level = await levelNodes();
    if (level.nodeHeight - level.tipA > 2) {
        throw new Error(`the source indexer is ${level.nodeHeight - level.tipA} blocks behind the chain `
            + `(node ${level.nodeHeight}, indexer ${level.tipA}) and is not catching up; `
            + 'the venue cannot serve this drill until it does');
    }
}

async function fundParticipants() {
    // compactAddresses off: the SDK's ^id compaction outruns the indexer's
    // wire acceptance on this stack and would invalidate the setup SENDs.
    // Same stance as every other BET suite.
    state.sdk = makeSdk({ compactAddresses: false });

    // All funding happens before the first clock jump (funding a new address
    // after a jump fails in the encoder).
    state.oracle = await fundedGasAddress(state.sdk, 1);
    state.p1     = await fundedGasAddress(state.sdk, 1);
    state.p2     = await fundedGasAddress(state.sdk, 1);
    state.tick   = await issueWagerToken(state.sdk, state.oracle, [
        [state.p1.address, '10.00000000'], [state.p2.address, '5.00000000']
    ], 1000000, 'BP2');
}

describe('[sdk] BET two-node state-hash parity (§12 E8: the fleet leg)', function () {
    this.timeout(0);

    before(async function () {
        await connectNodeB(this);
        await prepareParityVenue();
        await fundParticipants();
    });

    it('node B is independently following the same chain', async function () {
        const { tipA, tipB } = await levelNodes();
        expect(tipB, `node B is stalled at ${tipB} while node A is at ${tipA}; `
            + 'check `docker logs xchain-bet-parity-indexer` on the venue host').to.be.at.least(tipA - 2);

        // Baseline: the two nodes already agree on the blocks BEFORE this drill
        // writes anything. Without it, a first-block mismatch later could be
        // blamed on betting when the venue was already divergent.
        const from = Math.max(0, Math.min(tipA, tipB) - 20);
        const diffs = await compareHashes(from, Math.min(tipA, tipB));
        expect(diffs, `nodes disagree BEFORE the drill starts:\n${JSON.stringify(diffs.slice(0, 5), null, 1)}`)
            .to.deep.equal([]);
        state.following = true;
    });
});

describe('[sdk] BET two-node state-hash parity (§12 E8: the fleet leg)', function () {
    it('a market, two bets and the deadline latch land identically on both nodes', async function () {
        if (!state.following) this.skip();
        const { sdk, oracle, p1, p2, tick } = state;
        const startBlock = state.startBlock = await tipOf(dbQuery);

        const now = await blockTime();
        const deadline = state.deadline = now + 900;
        let res = await submitBet(sdk, oracle, sdk.betting.createMarketParams({
            label: 'E8 two-node parity', outcomes: ['Yes', 'No'], tick,
            fee: '1.00', deadline, refundWindow: MIN_REFUND_WINDOW, now
        }));
        expect(res.indexed.status, 'create status').to.equal('valid');
        const feedIndex = state.feedIndex = actionIndexOf(res);

        res = await submitBet(sdk, p1, sdk.betting.placeBetParams({
            feedActionIndex: feedIndex, outcome: 0, amount: '10.00000000' }));
        expect(res.indexed.status, 'p1 bet status').to.equal('valid');
        res = await submitBet(sdk, p2, sdk.betting.placeBetParams({
            feedActionIndex: feedIndex, outcome: 1, amount: '5.00000000' }));
        expect(res.indexed.status, 'p2 bet status').to.equal('valid');

        await jumpTo(deadline + 60, 2);
        const latched = await waitFeedStatus(feedIndex, 'closed');
        expect(latched.feed_status, 'feed latched closed').to.equal('closed');
        const latchBlock = state.latchBlock = Number(latched.closed_block);
        expect(latchBlock, 'latch block stamped').to.be.a('number');

        const tipA = await tipOf(dbQuery);
        const tipB = await waitNodeB(tipA);
        expect(tipB, 'node B caught up to the latch').to.be.at.least(tipA);

        const diffs = await compareHashes(startBlock, tipA);
        expect(diffs, 'node A and node B diverged over the create/bet/latch span:\n'
            + JSON.stringify(diffs.slice(0, 8), null, 1)).to.deep.equal([]);

        // Same rows, same stamps, read through the class keys the hash uses.
        const [ca, cb] = [await betClasses(dbQuery, startBlock, tipA),
                          await betClasses(bQuery,  startBlock, tipA)];
        expect(cb, 'BET state-hash class rows differ across nodes').to.deep.equal(ca);

        // The latch is IN the class at its own block, on node B, which never saw
        // node A's write. This is the row-level statement of §12 E8's "the latch
        // class is non-empty at the latch block".
        const atLatch = cb.feeds.filter(r => r.closed_block === String(latchBlock));
        expect(atLatch.map(r => r.action_index), 'node B has the latch stamped at the latch block')
            .to.include(String(feedIndex));
        expect(atLatch.find(r => r.action_index === String(feedIndex)).feed_status,
            'node B latched it CLOSED, not something else').to.equal('closed');

        // ... and in no other block of the span. A latch that also appeared
        // elsewhere would mean a re-stamp, the silent relocation E17 guards.
        const strays = cb.feeds.filter(r => r.action_index === String(feedIndex)
            && r.closed_block !== String(latchBlock));
        expect(strays, 'the feed is stamped in exactly one block').to.deep.equal([]);

    });
});

require('./betParity.sdk.test/01_state_hash_recompute.test');
require('./betParity.sdk.test/02_resolve_and_settlement.test');
require('./betParity.sdk.test/03_reorg_across_settlement.test');
require('./betParity.sdk.test/04_sensitivity.test');
