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
 * XChain Platform E2E - BET latch atomicity and idempotence (spec §12 E17)
 *
 * The `closed` latch is the one BET write that mutates a row created in an
 * EARLIER block, and the platform has been burned by that class twice
 * (stateHash.js opens with the note that in-place mutations on surviving rows
 * are invisible to action-derived hashing, so a follower that silently fails to
 * apply one diverges with NO hash mismatch to flag it). `bet_feeds.closed_block`
 * is what makes the flip visible: it keys the state-hash class
 * (`WHERE closed_block BETWEEN ? AND ?`) and the reorg reset.
 *
 * That makes the stamp's VALUE consensus-relevant, not bookkeeping. If a replay
 * of a latch block could re-stamp `closed_block` with a different height, the
 * feed would silently move between state-hash class windows: it would leave the
 * block where every other node has it and appear in a block where nobody else
 * does. No error, no mismatch at the point of the bug, a fork later.
 *
 * The whole block, user transactions and every end-of-block pass, runs inside
 * one DB transaction and the height advances only after the commit
 * (XChainIndexer.js), so a crash mid-block rolls back and the block is
 * re-processed from scratch on restart. The latch write is ALSO guarded in its
 * own WHERE clause (`feed_status_id = open AND closed_block IS NULL`,
 * db.latchBetFeedClosed) precisely so a re-processed block cannot latch twice.
 * A crash-restart replay is not a reorg, and `DELETE WHERE block_index >= ?`
 * would not undo a column flip on a row whose block_index is below the rollback
 * height, so the guard is the only thing standing there.
 *
 * WHY THIS RUNS AGAINST THE REAL DATABASE. The guard lives in SQL. A stubbed
 * connection (xchain-indexer/test/unit/bet-pass-bounding.test.js) can only
 * assert that the pass calls latchBetFeedClosed once per due feed; it cannot
 * prove that MariaDB evaluates the WHERE clause the way the guard intends, and
 * that evaluation IS the property. This is the same reasoning the indexer's
 * hub-push-starvation integration test states for its own SQL predicate.
 *
 * WRITE SAFETY. This drill writes to the live indexer DB twice, and both writes
 * are inert by construction:
 *   - Leg 1 replays the REAL guarded statement, which the guard makes a no-op.
 *     The drill asserts affectedRows === 0 and then re-reads the row, so a write
 *     that somehow took effect fails the test rather than passing quietly.
 *   - Leg 2 runs the UNGUARDED statement inside an explicit transaction that is
 *     ALWAYS rolled back (try/finally on a dedicated connection). It exists to
 *     prove leg 1 is not vacuous: without the guard the same row IS reachable
 *     and the stamp DOES move, so leg 1's zero is the guard working rather than
 *     a WHERE clause that matches nothing.
 *
 * THE CRASH-REPLAY HALF IS AN OPERATOR STEP, not something this drill performs:
 * killing the indexer needs container control the SDK harness does not have, and
 * a drill that SIGKILLs a shared venue on every run is a bad neighbour. Run it by
 * hand, then re-run this drill, which asserts the invariants over the replayed
 * state:
 *
 *   1. note the last "Block Parsed" line in the indexer's log
 *   2. `docker kill -s KILL <indexer>` while it is mid-block
 *   3. `docker start <indexer>` and compare the first "Block Parsed" line after
 *      startup against the noted one; a value <= it means the block really was
 *      re-processed rather than skipped
 *   4. `npm run test:sdk:bet-latch`
 *
 * Two things that surprised on the first live run (devhost BTC regtest,
 * 2026-07-26) and will surprise the next operator:
 *   - A graceful `docker restart` proves NOTHING here. SIGTERM lets the in-flight
 *     block commit, so the indexer resumes at the next block and no replay
 *     happens. Only a SIGKILL rolls the transaction back.
 *   - The replay covered THREE already-parsed blocks (5360-5362), not one, and
 *     re-parsed them to byte-identical ledger/actions/contracts hashes. Do not
 *     assume the resume point is "last logged block + 1" when sizing the drill.
 *   - `unless-stopped` did NOT bring the container back on its own after the
 *     SIGKILL; it needed a manual `docker start`. Budget for that, and check the
 *     whole stack's health before walking away.
 *
 ********************************************************************/

const { expect } = require('chai');
const { makeSdk, fundedGasAddress } = require('./sdkHelper');
const {
    MIN_REFUND_WINDOW, getFeed, blockTime, jumpTo, releaseClock,
    waitFeedStatus, issueWagerToken, submitBet, actionIndexOf
} = require('./betHelper');

// Status-id indirection, resolved once. The pass passes ids as query args
// (db.js createStatus), so the replayed statement must too.
async function statusId(status) {
    const connection = await global.indexerDatabase.getConnection();
    try {
        const rows = await connection.query(
            'SELECT id FROM index_statuses WHERE status = ? LIMIT 1', [status]);
        return rows.length ? Number(rows[0].id) : null;
    } finally { await connection.release(); }
}

// Byte-for-byte the statement db.latchBetFeedClosed issues, guard included.
const GUARDED_LATCH = `UPDATE
                        bet_feeds
                    SET
                        feed_status_id=?,
                        closed_block=?
                    WHERE
                        action_index=? AND
                        feed_status_id=? AND
                        closed_block IS NULL`;

// The same write with the idempotence guard removed. Only ever executed inside
// a rolled-back transaction (leg 2).
const UNGUARDED_LATCH = `UPDATE
                        bet_feeds
                    SET
                        feed_status_id=?,
                        closed_block=?
                    WHERE
                        action_index=?`;

async function affectedRows(sql, params) {
    const connection = await global.indexerDatabase.getConnection();
    try {
        const res = await connection.query(sql, params);
        return Number(res.affectedRows);
    } finally { await connection.release(); }
}

describe('[sdk] BET latch atomicity and idempotence (§12 E17)', function () {
    this.timeout(0);

    let sdk, oracle, punter, tick, openId, closedId;

    before(async function () {
        // See bet.sdk.test.js: ^id compaction outruns the indexer's wire acceptance.
        sdk = makeSdk({ compactAddresses: false });
        oracle = await fundedGasAddress(sdk, 1);
        punter = await fundedGasAddress(sdk, 1);
        tick = await issueWagerToken(sdk, oracle, [[punter.address, '10.00000000']], 1000000, 'B17');
        openId   = await statusId('open');
        closedId = await statusId('closed');
        expect(openId, 'open status id resolved').to.be.a('number');
        expect(closedId, 'closed status id resolved').to.be.a('number');
    });

    after(async function () {
        await releaseClock();
    });

    it('replaying the latch write cannot re-stamp closed_block or latch twice', async function () {
        const now = await blockTime();
        const deadline = now + 900;

        const res = await submitBet(sdk, oracle, sdk.betting.createMarketParams({
            label: 'E17 latch replay', outcomes: ['Yes', 'No'], tick,
            fee: '1.00', deadline, refundWindow: MIN_REFUND_WINDOW, now
        }));
        expect(res.indexed.status, 'create status').to.equal('valid');
        const feedIndex = actionIndexOf(res);

        // A real stake, so the feed is not a degenerate empty row.
        const bet = await submitBet(sdk, punter, sdk.betting.placeBetParams({
            feedActionIndex: feedIndex, outcome: 0, amount: '3.00000000' }));
        expect(bet.indexed.status, 'the pre-deadline bet is valid').to.equal('valid');

        // Cross the deadline so the end-of-block pass writes the latch.
        await jumpTo(deadline + 120, 2);
        const latched = await waitFeedStatus(feedIndex, 'closed');
        expect(latched.feed_status, 'feed latched closed').to.equal('closed');

        const stamp = Number(latched.closed_block);
        expect(stamp, 'closed_block stamped').to.be.greaterThan(0);

        // REPLAY 1: the same block re-processed after a crash-restart. The pass
        // would call latchBetFeedClosed with the identical arguments.
        const same = await affectedRows(GUARDED_LATCH, [closedId, stamp, feedIndex, openId]);
        expect(same, 'replaying the identical latch write touches no row').to.equal(0);

        // REPLAY 2: the sharp one. A LATER block re-running the latch would carry
        // a different height, and an unguarded write would move the stamp there,
        // silently relocating the feed between state-hash class windows.
        const later = stamp + 5;
        const moved = await affectedRows(GUARDED_LATCH, [closedId, later, feedIndex, openId]);
        expect(moved, 'a later block cannot re-latch an already-closed feed').to.equal(0);

        // The row is what it was. Read back rather than trusting affectedRows,
        // so a write that landed some other way still fails here.
        const after = await getFeed(feedIndex);
        expect(Number(after.closed_block), 'closed_block unmoved').to.equal(stamp);
        expect(after.feed_status, 'status still closed').to.equal('closed');

        this.test.feedIndex = feedIndex;
        this.test.stamp = stamp;
    });

    it('without the guard the same write WOULD move the stamp (rolled back)', async function () {
        // Proves the previous leg's zeroes are the guard working rather than a
        // predicate that matches nothing. Everything here is undone: the
        // transaction is rolled back in a finally, and the row is re-read after.
        const rows = await global.indexerDatabase.getConnection().then(async (connection) => {
            try {
                const found = await connection.query(
                    `SELECT action_index, closed_block FROM bet_feeds
                      WHERE closed_block IS NOT NULL
                      ORDER BY action_index DESC LIMIT 1`);
                return { connection, found };
            } catch (e) { await connection.release(); throw e; }
        });
        const connection = rows.connection;
        try {
            if (!rows.found.length) {
                console.log('      [bet-latch] SKIPPED: no latched feed on this venue');
                this.skip();
                return;
            }
            const feedIndex = Number(rows.found[0].action_index);
            const stamp     = Number(rows.found[0].closed_block);
            const later     = stamp + 5;

            await connection.beginTransaction();
            const res = await connection.query(UNGUARDED_LATCH, [closedId, later, feedIndex]);
            expect(Number(res.affectedRows),
                'the unguarded write reaches the row, so the guard is what stops it').to.equal(1);
            const dirty = await connection.query(
                'SELECT closed_block FROM bet_feeds WHERE action_index = ?', [feedIndex]);
            expect(Number(dirty[0].closed_block),
                'and it really does move the stamp inside the transaction').to.equal(later);
            await connection.rollback();

            const restored = await getFeed(feedIndex);
            expect(Number(restored.closed_block),
                'rollback restored the original stamp').to.equal(stamp);
        } finally {
            try { await connection.rollback(); } catch (e) { /* already rolled back */ }
            await connection.release();
        }
    });

    it('every feed on the venue agrees between its status column and its latch stamp', async function () {
        // The other half of E17: the status column and the durable stamp are two
        // writes in one statement, so a partially-applied latch shows up here as
        // a row where exactly one of them landed. Swept across the WHOLE venue,
        // not just this drill's feed, because a single mis-latched feed anywhere
        // is a fork waiting for the next state-hash comparison.
        const connection = await global.indexerDatabase.getConnection();
        try {
            const stampedButOpen = await connection.query(
                `SELECT f.action_index, f.closed_block
                   FROM bet_feeds f
                   INNER JOIN index_statuses s ON s.id = f.feed_status_id
                  WHERE s.status = 'open' AND f.closed_block IS NOT NULL`);
            expect(stampedButOpen.map(r => Number(r.action_index)),
                'no feed carries a latch stamp while still reading open').to.deep.equal([]);

            const closedButUnstamped = await connection.query(
                `SELECT f.action_index
                   FROM bet_feeds f
                   INNER JOIN index_statuses s ON s.id = f.feed_status_id
                  WHERE s.status = 'closed' AND f.closed_block IS NULL`);
            expect(closedButUnstamped.map(r => Number(r.action_index)),
                'no feed reads closed without the stamp that keys its rollback and hash class')
                .to.deep.equal([]);

            // A terminal feed legitimately may have NO closed_block: an oracle may
            // resolve in the very block that crosses the deadline, before the
            // end-of-block pass latches. So the terminal check is the stamp's
            // ordering, not its presence.
            const stampAfterTerminal = await connection.query(
                `SELECT action_index, closed_block, terminal_block
                   FROM bet_feeds
                  WHERE closed_block IS NOT NULL
                    AND terminal_block IS NOT NULL
                    AND closed_block > terminal_block`);
            expect(stampAfterTerminal.map(r => Number(r.action_index)),
                'no feed latched closed after it had already reached a terminal status')
                .to.deep.equal([]);
        } finally { await connection.release(); }
    });
});
