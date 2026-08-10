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
 * L2 integration: MultiValidatorHub consensus-subsystem bring-up 
 *
 * The harness gained opt-in startOracle / startReorgHandler / startGovernance
 * toggles so L2 can drive every consensus subsystem through the same in-process
 * mesh, not just attestation. This test stands up N hubs with all three enabled
 * against a real (disposable/env) MariaDB and asserts each hub's live subsystem
 * objects exist and are reachable through the harness getters. It is the
 * live-DB companion to the DB-free ordering guard in
 * test/unit/helpers/multiValidatorHubSubsystems.test.js.
 *
 * Skips (not fails) when no hub DB is available, matching every sibling L2 test.
 *
 ********************************************************************/

'use strict';

const dotenv = require('dotenv');
dotenv.config();

const assert = require('assert');
const { MultiValidatorHub } = require('../helpers/multiValidatorHubHelper');
const { startDisposableHubDb } = require('../helpers/disposableHubDb');

const COUNT = 3;

describe('MultiValidatorHub consensus-subsystem bring-up ', function () {
    // 3 hubs × (DB init + schema migrations + P2P bind) plus oracle/governance/
    // reorg start each add tables/timers; teardown drops the DBs. Generous budget.
    this.timeout(180_000);

    let mvh, db;

    // Was gated on HUB_DB_USER/HUB_DB_PASS being set, which nothing in CI sets,
    // so this suite skipped itself on every venue and the live tier reported it
    // as covered . startDisposableHubDb self-provisions a throwaway
    // MariaDB in Docker exactly as the rest of the L2 suites do, so the only
    // remaining skip is a host with no Docker at all.
    before(async function () {
        db = await startDisposableHubDb();
        if (!db) { console.log('Skipping subsystem bring-up L2: no env DB and Docker unavailable'); this.skip(); }
    });

    after(async function () {
        if (mvh) {
            await mvh.stop();
            await mvh.dropDatabases();
        }
        if (db) await db.stop();
    });

    it('brings up oracle + reorg + governance on every hub, reachable via getters', async function () {
        mvh = new MultiValidatorHub({
            count: COUNT,
            basePort: 34500,
            startOracle: true,
            startReorgHandler: true,
            startGovernance: true,
            // Keep the run lean: attestation off, we only assert the three new
            // consensus subsystems here.
            startAttestation: false
        });
        await mvh.start();

        assert.strictEqual(mvh.hubs.length, COUNT, 'expected ' + COUNT + ' running hubs');

        // Per-hub live objects.
        for (let i = 0; i < mvh.hubs.length; i++) {
            const hub = mvh.hubs[i];
            assert.ok(hub.oracle,           'hub ' + i + ' must have an OracleRound (startOracle)');
            assert.ok(hub.oracleConsensus,  'hub ' + i + ' must have an OracleConsensus (startOracle)');
            assert.ok(hub.reorgHandler,     'hub ' + i + ' must have a ReorgHandler (startReorgHandler)');
            assert.ok(hub.governance,       'hub ' + i + ' must have a Governance (startGovernance)');
            // Attestation was disabled for this run.
            assert.ok(!hub.attestationRound, 'hub ' + i + ' must NOT have attestation started');
        }

        // Harness getters surface the same objects, one per hub, none null.
        const oracles = mvh.getOracles();
        const govs    = mvh.getGovernances();
        const reorgs  = mvh.getReorgHandlers();
        assert.strictEqual(oracles.length, COUNT);
        assert.ok(oracles.every(o => o), 'getOracles() returns a live oracle per hub');
        assert.ok(govs.every(g => g),    'getGovernances() returns a live governance per hub');
        assert.ok(reorgs.every(r => r),  'getReorgHandlers() returns a live reorg handler per hub');
    });
});
