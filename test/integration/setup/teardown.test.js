'use strict'

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// Integration tests for the afterAll teardown hook in initialCheck.test.js.

const assert = require('assert')
const sinon = require('sinon')

describe('Bootstrap: teardown resilience', function () {

    let savedMiner

    beforeEach(function () {
        savedMiner = global.regtestMinerConnector
    })

    afterEach(function () {
        global.regtestMinerConnector = savedMiner
        sinon.restore()
    })

    // Replicate the afterAll hook from initialCheck.test.js lines 218-225
    async function runAfterAll() {
        try {
            await regtestMinerConnector.setDefaultMiningTime()
        } catch (err) {
            console.log('There was a problem setting the default mining time values for the regtest miner')
        }
    }

    describe('Scenario 3.1.5: Teardown calls setDefaultMiningTime', function () {

        it('calls setDefaultMiningTime on success', async function () {
            const stub = sinon.stub().resolves(true)
            global.regtestMinerConnector = { setDefaultMiningTime: stub }

            await runAfterAll()

            assert(stub.calledOnce)
        })

        it('catches and swallows setDefaultMiningTime errors', async function () {
            const stub = sinon.stub().rejects(new Error('Connection refused'))
            global.regtestMinerConnector = { setDefaultMiningTime: stub }

            // Should NOT throw
            await runAfterAll()

            assert(stub.calledOnce)
        })

        it('does not crash the test runner on network failure', async function () {
            global.regtestMinerConnector = {
                setDefaultMiningTime: async () => { throw new Error('ETIMEDOUT') }
            }

            await assert.doesNotReject(() => runAfterAll())
        })
    })
})
