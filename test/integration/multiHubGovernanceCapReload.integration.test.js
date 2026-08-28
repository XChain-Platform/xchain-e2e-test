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
 * E2E integration: CAPABILITY_*_MIN_STAKE governance pin (#4352)
 *
 * Boots N=3 in-process XChainHub validators and asserts the pre-launch
 * pin holds across a real hub federation: governance can NOT move a
 * capability MIN_STAKE threshold.
 *
 * Background: the indexer re-derives the qualified validator set from a
 * FROZEN configs/<COIN>.js consensus constant, so a hub-side governance
 * MIN_STAKE change would fork the federation from the chain. #4352 pins
 * the parameter off governance pre-launch; thresholds move only via a
 * coordinated fleet upgrade of configs/<COIN>.js + HUB_CAPABILITY_CONFIG.
 *
 * Two enforcement points, both exercised here at federation scale:
 *   1. propose() refuses to CREATE a CAPABILITY_*_MIN_STAKE proposal
 *      (Governance.js #4352 guard), so an honest proposer can't even
 *      start a round.
 *   2. _handlePropose() DROPS an inbound CAPABILITY_*_MIN_STAKE proposal
 *      gossiped by a malicious or pre-#4352 peer, so no honest hub records
 *      a row. With no local row a later GOV_RESULT UPDATE matches 0 rows
 *      and never emits proposal:finalized, so every hub's getMinStake()
 *      stays pinned and the federation can't split.
 *
 * (Historical note: this suite previously drove a CAPABILITY_PRICE_MIN_STAKE
 * change end-to-end and asserted all hubs hot-reloaded capConfig. #4352
 * removed that governance path; the follower-applies-GOV_RESULT regression
 * it guarded is now covered at unit scale in xchain-hub Governance.test.js
 * `_handleResult()` using a still-governable parameter.)
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
const { startDisposableHubDb } = require('../helpers/disposableHubDb');
const { waitForMesh } = require('../helpers/consensusWait');

const COUNT = 3;
// A deadline, not a settle: waitForMesh returns the moment every hub holds an open
// socket to every other, so the bound only decides when to give up.
const PEER_WAIT_MS = 60_000;

const OLD_MIN_STAKE = '1000.00000000';
const NEW_MIN_STAKE = '1200.00000000'; // the (rejected) target a proposer/peer would try to set

const CAPS = {
    CAPABILITIES: {
        price:          { MIN_STAKE: OLD_MIN_STAKE },
        cross_chain:    { MIN_STAKE: '1000.00000000' },
        oracle_publish: { MIN_STAKE: '500.00000000'  },
        attestation:    { MIN_STAKE: '1000.00000000' }
    },
    price:          { sources: ['coingecko'], fiats: ['USD'] },
    cross_chain:    { chains: { BTC: { rpc: 'http://node:8332' } } },
    // A REGTEST-format DOGE address ('n' prefix, 34 chars). The hub's oracle_publish
    // self-test validates doge_address against HUB_NETWORK, so a mainnet 'D' address
    // fails closed on the regtest hubs this harness stands up.
    oracle_publish: { doge_address: 'nsTake195wjCuVwLHf26EsZnRjwpm2LJtb', doge_wallet: '/data/.dogecoin/wallet.dat' }
};

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

describe('MultiValidatorHub: governance capability MIN_STAKE pin (#4352)', function () {
    this.timeout(180_000);

    let mvh;
    let capsPath;
    let db;

    // Was gated on HUB_DB_USER/HUB_DB_PASS being set, which nothing in CI sets,
    // so this suite skipped itself on every venue and the live tier reported it
    // as covered. startDisposableHubDb self-provisions a throwaway
    // MariaDB in Docker exactly as the rest of the L2 suites do, so the only
    // remaining skip is a host with no Docker at all.
    before(async function () {
        db = await startDisposableHubDb();
        if (!db) { console.log('Skipping governance MIN_STAKE pin test: no env DB and Docker unavailable'); this.skip(); }
        capsPath = path.join(os.tmpdir(), 'mvh_gov_caps_' + process.pid + '.json');
        fs.writeFileSync(capsPath, JSON.stringify(CAPS));

        mvh = new MultiValidatorHub({ count: COUNT, basePort: 30200, startAttestation: false });
        await mvh.start();

        // Production wiring order: governance must exist before startAttestation,
        // which registers the proposal:finalized -> capability hot-reload listener.
        // capabilityRegistry (read by that listener) is seeded by startCapabilities.
        for (const hub of mvh.hubs) {
            await hub.startGovernance();
            await hub.startCapabilities(capsPath);
            await hub.startAttestation();
            // Quiet the live stake poll / recheck so they can't perturb capConfig.
            if (hub._stakePollTimer)         clearInterval(hub._stakePollTimer);
            if (hub._capabilityRecheckTimer) clearInterval(hub._capabilityRecheckTimer);
        }

        await waitForMesh(mvh, { timeoutMs: PEER_WAIT_MS }); // peers ARE connected
    });

    after(async function () {
        if (mvh) { await mvh.stop(); await mvh.dropDatabases(); }
        if (capsPath) { try { fs.unlinkSync(capsPath); } catch (_) {} }
        if (db) await db.stop();
    });

    it('seeds every hub with the same starting MIN_STAKE', function () {
        const stakes = mvh.hubs.map(h => h.capabilityRegistry.getMinStake('price'));
        assert.ok(stakes.every(s => String(s) === OLD_MIN_STAKE),
            'all hubs should start at ' + OLD_MIN_STAKE + ', got ' + stakes.join(','));
    });

    it('refuses to CREATE a CAPABILITY_*_MIN_STAKE proposal on the proposer (#4352)', async function () {
        const proposer = mvh.hubs[0];

        // propose() must reject before any row is written or gossiped.
        await assert.rejects(
            () => proposer.propose('CAPABILITY_PRICE_MIN_STAKE', OLD_MIN_STAKE, NEW_MIN_STAKE, 'raise price min stake'),
            /#4352/,
            'propose() must reject a pinned CAPABILITY_*_MIN_STAKE change'
        );

        for (const hub of mvh.hubs) {
            const rows = await hub.db.doQuery(
                'SELECT proposal_id FROM governance_proposals WHERE parameter = ?',
                ['CAPABILITY_PRICE_MIN_STAKE']);
            assert.strictEqual(rows.length, 0,
                'no CAPABILITY_*_MIN_STAKE proposal row should exist after a refused propose()');
        }
    });

    it('every follower DROPS an inbound CAPABILITY_*_MIN_STAKE proposal; threshold stays pinned', async function () {
        const proposer = mvh.hubs[0];
        const proposerPubkey = proposer.getIdentity().getPubkeyHex();

        // Simulate a malicious or pre-#4352 peer that bypasses propose()'s guard
        // and gossips a CAPABILITY_*_MIN_STAKE proposal directly onto the mesh.
        // GOV_PROPOSE is the governance proposal message type (Governance.js).
        const rogueId = 'gov:CAPABILITY_PRICE_MIN_STAKE:rogue-' + Date.now();
        proposer.peerManager.broadcast('GOV_PROPOSE', {
            proposalId:      rogueId,
            parameter:       'CAPABILITY_PRICE_MIN_STAKE',
            currentValue:    OLD_MIN_STAKE,
            proposedValue:   NEW_MIN_STAKE,
            rationale:       'rogue inbound proposal',
            proposerPubkey,
            votingEnd:       new Date(Date.now() + 60_000).toISOString(),
            activationBlock: null
        });
        await sleep(2500); // let the gossip reach every follower + _handlePropose run
        for (const hub of mvh.hubs) {
            const rows = await hub.db.doQuery(
                'SELECT proposal_id FROM governance_proposals WHERE proposal_id = ? OR parameter = ?',
                [rogueId, 'CAPABILITY_PRICE_MIN_STAKE']);
            assert.strictEqual(rows.length, 0,
                'follower must drop the inbound CAPABILITY_*_MIN_STAKE proposal (no row recorded)');
        }

        const stakes = mvh.hubs.map(h => String(h.capabilityRegistry.getMinStake('price')));
        assert.ok(stakes.every(s => s === OLD_MIN_STAKE),
            'every hub must still serve the pinned MIN_STAKE ' + OLD_MIN_STAKE + ', got ' + stakes.join(','));
    });
});
