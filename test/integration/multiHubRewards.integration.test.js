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
 * L2 integration: validator reward distribution against a real DB
 *
 * Boots in-process XChainHub validators on a disposable MariaDB and exercises
 * RewardTracker.distributeRewards against the REAL validator_rewards table
 * (created at hub startup). Asserts:
 *   - the per-round reward is split equally and persisted, one row per
 *     participant;
 *   - re-running the same round is IDEMPOTENT (the INSERT IGNORE on the
 *     UNIQUE KEY (validator_pubkey, round_number, reward_type) collapses
 *     concurrent/duplicate writes (multiple hubs finalizing the same round
 *     must not multiply payouts).
 *
 * Pairs with the pure guard xchain-hub/test/regression/slashing-rewards.
 * Skips when no DB/Docker is available.
 ********************************************************************/

'use strict';

const dotenv = require('dotenv');
dotenv.config();

const path   = require('path');
const assert = require('assert');
const { MultiValidatorHub }    = require('../helpers/multiValidatorHubHelper');
const { startDisposableHubDb } = require('../helpers/disposableHubDb');

const RewardTracker = require(path.resolve(__dirname, '../../../xchain-hub/src/RewardTracker.js'));

const COUNT = 2;
const PK = (c) => c.repeat(64);

describe('MultiValidatorHub: reward distribution (L2)', function () {
    this.timeout(180_000);

    let db, mvh;

    before(async function () {
        db = await startDisposableHubDb();
        if (!db) { console.log('Skipping reward L2: no env DB and Docker unavailable'); this.skip(); }
        mvh = new MultiValidatorHub({ count: COUNT, basePort: 34000 });
        await mvh.start();
    });

    after(async function () {
        if (mvh) { await mvh.stop(); await mvh.dropDatabases(); }
        if (db)  { await db.stop(); }
    });

    it('persists an equal split to validator_rewards and is idempotent on re-run', async function () {
        const hub = mvh.hubs[0];
        const rt = new RewardTracker(hub);
        rt._pushRewardsToBtcIndexer = async () => {};   // no indexer in-harness

        const round = 5000;
        const participants = [PK('a'), PK('b'), PK('c'), PK('d')];   // 10 / 4 = 2.5 each

        await rt.distributeRewards(round, participants);

        const q = 'SELECT validator_pubkey, amount FROM validator_rewards WHERE round_number = ?';
        let rows = await hub.db.doQuery(q, [round]);
        assert.strictEqual(rows.length, 4, 'expected one reward row per participant');
        for (const r of rows) {
            assert.strictEqual(Number(r.amount), 2.5, 'reward not an equal 10/4 split');
        }
        assert.deepStrictEqual(rows.map((r) => r.validator_pubkey).sort(), participants.slice().sort());

        // Idempotency: a second distribution for the same round must not duplicate.
        await rt.distributeRewards(round, participants);
        rows = await hub.db.doQuery(q, [round]);
        assert.strictEqual(rows.length, 4, 'INSERT IGNORE failed: duplicate reward rows for the same round');
    });
});
