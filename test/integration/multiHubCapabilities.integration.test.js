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
 * E2E integration — capability staking across a multi-validator hub set
 *
 * Boots N=3 in-process XChainHub validators (MultiValidatorHub) and drives
 * the capability subsystem end-to-end:
 *   - startCapabilities() loads a HUB_CAPABILITY_CONFIG-shaped JSON
 *   - per-capability self-tests pass once the config blocks are present
 *   - qualification gates strictly at each capability's MIN_STAKE threshold
 *   - a zero-stake validator fails closed (qualifies for nothing)
 *
 * Guards against the regressions fixed in xchain-hub:
 *   - startCapabilities being unwired (capability subsystem dormant)
 *   - self-tests failing "config missing" with no config source
 *   - qualification defaulting to a 0 threshold instead of failing closed
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

// MIN_STAKE thresholds used by the test config.
const CAPS = {
    CAPABILITIES: {
        price:          { MIN_STAKE: '1000.00000000' },
        cross_chain:    { MIN_STAKE: '1000.00000000' },
        oracle_publish: { MIN_STAKE: '500.00000000'  },
        attestation:    { MIN_STAKE: '1000.00000000' }
    },
    price:          { sources: ['coingecko'], fiats: ['USD'] },
    cross_chain:    { chains: { BTC: { rpc: 'http://node:8332' } } },
    oracle_publish: { doge_address: 'D8vFz4p1L37jdg47kT9V9j1Z2nGw6Lp9aT', doge_wallet: '/data/.dogecoin/wallet.dat' }
};

describe('MultiValidatorHub — capability staking', function () {
    this.timeout(180_000);

    let mvh;
    let capsPath;

    before(function () {
        if (!process.env.HUB_DB_USER || !process.env.HUB_DB_PASS) {
            console.log('Skipping capability staking test — HUB_DB_USER/HUB_DB_PASS not set');
            this.skip();
        }
        capsPath = path.join(os.tmpdir(), 'mvh_caps_' + process.pid + '.json');
        fs.writeFileSync(capsPath, JSON.stringify(CAPS));
    });

    after(async function () {
        if (mvh) { await mvh.stop(); await mvh.dropDatabases(); }
        if (capsPath) { try { fs.unlinkSync(capsPath); } catch (_) {} }
    });

    it('boots ' + COUNT + ' validators that peer-connect', async function () {
        mvh = new MultiValidatorHub({ count: COUNT, basePort: 30000 });
        await mvh.start();
        await new Promise(r => setTimeout(r, PEER_WAIT_MS));
        const peerCounts = mvh.hubs.map(h => h.peerManager ? h.peerManager.peers.size : 0);
        assert.ok(peerCounts.every(c => c >= COUNT - 1),
            'each hub should see ' + (COUNT - 1) + ' peers — got ' + peerCounts.join(','));
    });

    it('runs startCapabilities and passes every self-test once config is present', async function () {
        for (const hub of mvh.hubs) {
            await hub.startCapabilities(capsPath);
            // Stop the live stake poll so it can't overwrite the deterministic
            // stake levels asserted below.
            if (hub._stakePollTimer) clearInterval(hub._stakePollTimer);
            if (hub._capabilityRecheckTimer) clearInterval(hub._capabilityRecheckTimer);
        }
        await new Promise(r => setTimeout(r, 2000)); // let the one-shot initial poll settle

        const pubkey = mvh.getPubkeys()[0];
        const state = await mvh.hubs[0].capabilityRegistry.getOwnState(pubkey);
        for (const cap of ['price', 'cross_chain', 'oracle_publish', 'attestation']) {
            const row = state.find(r => r.capability === cap);
            assert.ok(row && Number(row.self_test_ok) === 1, cap + ' self-test should pass with config present');
        }
    });

    it('gates qualification strictly at each capability MIN_STAKE', async function () {
        const hub = mvh.hubs[0];
        const pubkey = mvh.getPubkeys()[0];
        const q = async () => {
            const rows = await hub.capabilityRegistry.getOwnState(pubkey);
            const m = {};
            for (const r of rows) m[r.capability] = Number(r.qualified) === 1;
            return m;
        };

        await hub.refreshOwnQualification('1500', 100);
        let m = await q();
        assert.ok(m.price && m.cross_chain && m.oracle_publish && m.attestation,
            'stake 1500 should qualify every capability');

        await hub.refreshOwnQualification('700', 101);
        m = await q();
        assert.ok(m.oracle_publish, 'stake 700 should qualify oracle_publish (>=500)');
        assert.ok(!m.price && !m.cross_chain && !m.attestation, 'stake 700 should NOT qualify the >=1000 capabilities');

        await hub.refreshOwnQualification('0', 102);
        m = await q();
        assert.ok(!m.price && !m.cross_chain && !m.oracle_publish && !m.attestation,
            'stake 0 should fail closed — no capability qualified');
    });
});
