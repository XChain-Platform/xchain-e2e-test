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

// Chaos Experiment 6: Teardown Failure (@P0)
//
// Verifies that when pool.end() throws during teardown, the process continues,
// wallet keys can still be cleared, and no resources are leaked.

const assert = require('assert')
const sinon = require('sinon')
const { saveGlobals, restoreGlobals, GLOBAL_KEYS } = require('./chaos-helpers')

// Replicate the afterAll teardown logic from initialCheck.test.js
async function runTeardown(regtestMinerConnector, indexerDatabase, wallets) {
    try {
        await regtestMinerConnector.setDefaultMiningTime()
    } catch (err) {
        console.log('There was a problem resetting mining time:', err.message)
    }

    try {
        if (wallets) {
            for (const label of Object.keys(wallets)) {
                const w = wallets[label]
                if (w.seed && Buffer.isBuffer(w.seed)) w.seed.fill(0)
                if (w.addresses) {
                    for (const addr of w.addresses) {
                        if (addr.privateKey && Buffer.isBuffer(addr.privateKey)) {
                            addr.privateKey.fill(0)
                        }
                    }
                }
            }
        }
    } catch (err) {
        console.log('Problem clearing wallet keys:', err.message)
    }

    try {
        if (indexerDatabase && indexerDatabase.pool) {
            await indexerDatabase.pool.end()
        }
    } catch (err) {
        console.log('Pool close failed during teardown:', err.message)
    }
}

describe('Chaos Experiment 6: Teardown Failure @P0', function () {

    let saved

    beforeEach(function () {
        saved = saveGlobals(GLOBAL_KEYS)
    })

    afterEach(function () {
        restoreGlobals(saved)
        sinon.restore()
    })

    it('swallows pool.end() rejection without crashing', async function () {
        const mockMiner = { setDefaultMiningTime: sinon.stub().resolves(true) }
        const mockDb = { pool: { end: sinon.stub().rejects(new Error('Pool already destroyed')) } }

        await assert.doesNotReject(
            () => runTeardown(mockMiner, mockDb, {})
        )
        assert(mockDb.pool.end.calledOnce)
    })

    it('clears wallet keys even when pool.end() throws', async function () {
        const seed = Buffer.alloc(64, 0xAA)
        const privKey = Buffer.alloc(32, 0xBB)
        const wallets = {
            'CHAOS.TEST': {
                seed: seed,
                addresses: [{ privateKey: privKey, publicKey: Buffer.alloc(33, 0xCC), address: 'addr1' }]
            }
        }
        const mockMiner = { setDefaultMiningTime: sinon.stub().resolves(true) }
        const mockDb = { pool: { end: sinon.stub().rejects(new Error('Pool destroyed')) } }

        await runTeardown(mockMiner, mockDb, wallets)

        assert(seed.every(b => b === 0), 'seed should be zeroed')
        assert(privKey.every(b => b === 0), 'privateKey should be zeroed')
    })

    it('clears wallet keys even when setDefaultMiningTime throws', async function () {
        const seed = Buffer.alloc(64, 0xDD)
        const privKey = Buffer.alloc(32, 0xEE)
        const wallets = {
            'CHAOS.MINER': {
                seed: seed,
                addresses: [{ privateKey: privKey, publicKey: Buffer.alloc(33, 0xFF), address: 'addr2' }]
            }
        }
        const mockMiner = { setDefaultMiningTime: sinon.stub().rejects(new Error('ECONNREFUSED')) }
        const mockDb = { pool: { end: sinon.stub().resolves() } }

        await runTeardown(mockMiner, mockDb, wallets)

        assert(seed.every(b => b === 0), 'seed should be zeroed')
        assert(privKey.every(b => b === 0), 'privateKey should be zeroed')
    })

    it('handles multiple wallet labels during cleanup', async function () {
        const wallets = {}
        for (let i = 0; i < 5; i++) {
            wallets[`WALLET.${i}`] = {
                seed: Buffer.alloc(64, i + 1),
                addresses: [
                    { privateKey: Buffer.alloc(32, i + 10), publicKey: Buffer.alloc(33), address: `addr${i}` },
                    { privateKey: Buffer.alloc(32, i + 20), publicKey: Buffer.alloc(33), address: `addr${i}b` }
                ]
            }
        }
        const mockMiner = { setDefaultMiningTime: sinon.stub().resolves(true) }
        const mockDb = { pool: { end: sinon.stub().resolves() } }

        await runTeardown(mockMiner, mockDb, wallets)

        for (const label of Object.keys(wallets)) {
            const w = wallets[label]
            assert(w.seed.every(b => b === 0), `${label} seed should be zeroed`)
            for (const addr of w.addresses) {
                assert(addr.privateKey.every(b => b === 0), `${label} privateKey should be zeroed`)
            }
        }
    })

    it('handles null/undefined wallet fields gracefully', async function () {
        const wallets = {
            'NO.SEED': { seed: null, addresses: [] },
            'NO.ADDR': { seed: Buffer.alloc(64, 1), addresses: null },
            'EMPTY': {}
        }
        const mockMiner = { setDefaultMiningTime: sinon.stub().resolves(true) }
        const mockDb = { pool: { end: sinon.stub().resolves() } }

        await assert.doesNotReject(
            () => runTeardown(mockMiner, mockDb, wallets)
        )
    })

    it('completes when all three phases fail', async function () {
        const mockMiner = { setDefaultMiningTime: sinon.stub().rejects(new Error('Miner down')) }
        const mockDb = { pool: { end: sinon.stub().rejects(new Error('Pool error')) } }

        await assert.doesNotReject(
            () => runTeardown(mockMiner, mockDb, null)
        )
        assert(mockMiner.setDefaultMiningTime.calledOnce)
        assert(mockDb.pool.end.calledOnce)
    })
})
