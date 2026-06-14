/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available —
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * E2E integration — capability config hot-reload across a hub federation
 *
 * Boots N=3 in-process XChainHub validators and drives a governance
 * parameter change end-to-end:
 *   - one hub PROPOSEs CAPABILITY_PRICE_MIN_STAKE (1000 → 1200)
 *   - all three hubs VOTE approve
 *   - the deterministic tally leader tallies and broadcasts GOV_RESULT
 *   - every hub processes the result and hot-reloads its capability config
 *
 * Regression guard: tallying is single-leader, so only the leader runs
 * _tallyProposal() and emits proposal:finalized directly. Followers learn
 * the outcome solely via the GOV_RESULT broadcast (Governance._handleResult).
 * If _handleResult does not emit proposal:finalized on a passed proposal,
 * follower hubs update the DB row but never hot-reload capConfig — so they
 * keep serving the OLD MIN_STAKE while the leader serves the new one. Since
 * each hub feeds its own getMinStake() to the indexer when locking the
 * quorum validator set, that split makes the federation compute different
 * qualified sets for the same block and breaks PBFT agreement.
 *
 * This test asserts ALL hubs — not just the leader — converge on the new
 * getMinStake('price') after the proposal passes.
 *
 * Skips when HUB_DB_USER/HUB_DB_PASS are unset (same gate as multiHub).
 ********************************************************************/

'use strict';

const dotenv = require('dotenv');
dotenv.config();

const assert = require('assert');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const { MultiValidatorHub } = require('../helpers/multiValidatorHubHelper');

const COUNT = 3;
const PEER_WAIT_MS = 8000;

const OLD_MIN_STAKE = '1000.00000000';
const NEW_MIN_STAKE = '1200.00000000'; // +20% — within Governance MAX_INCREASE (50%)

const CAPS = {
    CAPABILITIES: {
        price:          { MIN_STAKE: OLD_MIN_STAKE },
        cross_chain:    { MIN_STAKE: '1000.00000000' },
        oracle_publish: { MIN_STAKE: '500.00000000'  },
        attestation:    { MIN_STAKE: '1000.00000000' }
    },
    price:          { sources: ['coingecko'], fiats: ['USD'] },
    cross_chain:    { chains: { BTC: { rpc: 'http://node:8332' } } },
    oracle_publish: { doge_address: 'D8vFz4p1L37jdg47kT9V9j1Z2nGw6Lp9aT', doge_wallet: '/data/.dogecoin/wallet.dat' }
};

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

describe('MultiValidatorHub — governance capability hot-reload', function () {
    this.timeout(180_000);

    let mvh;
    let capsPath;
    let savedVotingPeriod;
    let savedTallyInterval;

    before(async function () {
        if (!process.env.HUB_DB_USER || !process.env.HUB_DB_PASS) {
            console.log('Skipping governance hot-reload test — HUB_DB_USER/HUB_DB_PASS not set');
            this.skip();
        }
        capsPath = path.join(os.tmpdir(), 'mvh_gov_caps_' + process.pid + '.json');
        fs.writeFileSync(capsPath, JSON.stringify(CAPS));

        // Comfortable voting window (votes must be cast before voting_end); the
        // proposal is force-expired in the DB before the manual tally so the test
        // never waits real-world voting time. Stretch the auto-tally timer well
        // past the run so it can't race the deterministic manual trigger.
        savedVotingPeriod  = process.env.GOV_VOTING_PERIOD;
        savedTallyInterval = process.env.GOVERNANCE_TALLY_INTERVAL;
        process.env.GOV_VOTING_PERIOD        = '60000';
        process.env.GOVERNANCE_TALLY_INTERVAL = '3600000';

        mvh = new MultiValidatorHub({ count: COUNT, basePort: 30200, startAttestation: false });
        await mvh.start();

        // Production wiring order: governance must exist before startAttestation,
        // which registers the proposal:finalized → capability hot-reload listener.
        // capabilityRegistry (read by that listener) is seeded by startCapabilities.
        for (const hub of mvh.hubs) {
            await hub.startGovernance();
            await hub.startCapabilities(capsPath);
            await hub.startAttestation();
            // Quiet the live stake poll / recheck so they can't perturb capConfig.
            if (hub._stakePollTimer)         clearInterval(hub._stakePollTimer);
            if (hub._capabilityRecheckTimer) clearInterval(hub._capabilityRecheckTimer);
        }

        await sleep(PEER_WAIT_MS); // let peers connect + gossip settle
    });

    after(async function () {
        if (mvh) { await mvh.stop(); await mvh.dropDatabases(); }
        if (capsPath) { try { fs.unlinkSync(capsPath); } catch (_) {} }
        if (savedVotingPeriod === undefined) delete process.env.GOV_VOTING_PERIOD;
        else                                 process.env.GOV_VOTING_PERIOD = savedVotingPeriod;
        if (savedTallyInterval === undefined) delete process.env.GOVERNANCE_TALLY_INTERVAL;
        else                                  process.env.GOVERNANCE_TALLY_INTERVAL = savedTallyInterval;
    });

    it('seeds every hub with the same starting MIN_STAKE', function () {
        const stakes = mvh.hubs.map(h => h.capabilityRegistry.getMinStake('price'));
        assert.ok(stakes.every(s => String(s) === OLD_MIN_STAKE),
            'all hubs should start at ' + OLD_MIN_STAKE + ' — got ' + stakes.join(','));
    });

    it('hot-reloads capConfig on EVERY hub (not just the tally leader) after a passed proposal', async function () {
        const proposer = mvh.hubs[0];

        // 1) Propose the parameter change and let the GOV_PROPOSE broadcast land
        //    on the followers so they have a row to vote on.
        const { proposalId } = await proposer.propose(
            'CAPABILITY_PRICE_MIN_STAKE', OLD_MIN_STAKE, NEW_MIN_STAKE, 'raise price min stake');
        assert.ok(proposalId, 'propose should return a proposalId');
        await sleep(1500);

        // 2) Every hub votes approve (each vote is gossiped to the leader).
        for (const hub of mvh.hubs) {
            await hub.vote(proposalId, 'approve');
        }
        await sleep(2500); // let votes propagate to the tally leader's DB

        // 3) Find the deterministic tally leader for this proposal. All hubs share
        //    the same validator set, so exactly one matches.
        const leader = mvh.hubs.find(h => h.governance._isTallyLeader(proposalId));
        assert.ok(leader, 'a deterministic tally leader should exist for the proposal');

        // 4) Force-expire the proposal on the leader so its tally pass picks it up
        //    immediately, then trigger the tally. The leader applies + broadcasts
        //    GOV_RESULT; followers learn the outcome only via that broadcast.
        await leader.db.doQuery(
            "UPDATE governance_proposals SET voting_end = DATE_SUB(NOW(), INTERVAL 1 HOUR) WHERE proposal_id = ?",
            [proposalId]
        );
        await leader.governance._checkExpiredProposals();

        // 5) Let GOV_RESULT reach the followers + _handleResult emit + hot-reload.
        await sleep(2500);

        // The proposal must actually have PASSED (quorum + 2/3 approval).
        const leaderRow = (await leader.db.doQuery(
            "SELECT status FROM governance_proposals WHERE proposal_id = ? LIMIT 1", [proposalId]))[0];
        assert.strictEqual(leaderRow && leaderRow.status, 'passed',
            'proposal should pass with 3/3 approvals');

        // 6) Every hub — leader AND followers — must serve the NEW threshold.
        const stakes = mvh.hubs.map(h => String(h.capabilityRegistry.getMinStake('price')));
        assert.ok(stakes.every(s => s === stakes[0]),
            'all hubs must converge on a single MIN_STAKE — got ' + stakes.join(','));
        assert.notStrictEqual(stakes[0], OLD_MIN_STAKE,
            'MIN_STAKE must have moved off its startup value on every hub (followers stayed stale)');
        assert.strictEqual(stakes[0], NEW_MIN_STAKE,
            'every hub should serve the governance-approved threshold ' + NEW_MIN_STAKE);
    });
});
