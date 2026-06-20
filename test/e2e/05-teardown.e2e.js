// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const assert = require('assert')
const cryptoHelper = require('../cryptoHelper')

// MANUAL VERIFICATION REQUIRED:
// E2E-TEAR-002 (DB pool shutdown): After `npm run test:e2e` exits, run
//   mysql -u root -e "SHOW PROCESSLIST" and verify no test connections remain
// E2E-TEAR-003 (teardown resilience): Kill the miner container before tests
//   finish, verify afterAll completes without crashing Mocha

describe('E2E: Teardown & Resource Cleanup', () => {
    describe('E2E-TEAR-001: Mining time configuration round-trip', () => {
        it('should confirm mining is active by successfully funding an address', async () => {
            const start = Date.now()
            const addr = await cryptoHelper.getNewFundedAddress('E2E.TEAR.MINE', COIN, NETWORK, null, 'legacy', 0, 1)
            const elapsed = Date.now() - start

            assert(addr.address, 'Address should be funded (mining is working)')
            assert(elapsed < 30000, 'Funding should complete within 30s with 1s mining configured')
        })

        it('should successfully call setDefaultMiningTime and then re-apply test config', async () => {
            const resetResult = await regtestMinerConnector.setDefaultMiningTime()
            assert(resetResult !== undefined, 'setDefaultMiningTime should return without error')

            // Re-apply test mining config so subsequent tests still work
            const reapply = await regtestMinerConnector.setMiningTime(1000, 1000)
            assert(reapply !== undefined, 'setMiningTime should return without error after reset')
        })

        it('should still be able to mine blocks after mining time round-trip', async () => {
            const addr = await cryptoHelper.getNewAddress('E2E.TEAR.POST', COIN, NETWORK, null, 'legacy', 0)

            const txId = await regtestMinerConnector.sendFunds(addr.address, 1)
            assert(txId, 'sendFunds should return a transaction ID after mining time round-trip')

            const txExists = await nodeConnector.waitForTx(txId, 30000)
            assert(txExists, 'Transaction should be mined after mining time round-trip')
        })
    })

    describe('Database connection pool health across test lifetime', () => {
        it('should successfully query the database at the end of the test run', async () => {
            const ping = await indexerDatabase.ping()
            assert(ping, 'Database ping should succeed at end of test run')

            // Perform an actual read query
            let connection = await indexerDatabase.getConnection()
            try {
                const rows = await connection.query('SELECT COUNT(*) AS cnt FROM issues')
                assert(rows.length > 0, 'Query should return a result')
                assert(Number(rows[0].cnt) >= 1, 'At least one issue (XCHAIN) should exist')
            } finally {
                await connection.release()
            }
        })
    })
})
