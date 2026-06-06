'use strict'

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available —
// contact legal@dankest.llc.

const assert = require('assert')
const sinon  = require('sinon')

// Set up globals before requiring cryptoHelper (it references them at module load)
global.wallets               = {}
global.regtestMinerConnector = { sendFunds: async () => 'txid-stub' }
global.nodeConnector         = { waitForTx: async () => true }
global.utxoTrackerConnector  = { waitForUtxos: async () => true }

const cryptoHelper  = require('../cryptoHelper')
const CryptoNetworks = require('../../src/CryptoNetworks')

// ═══════════════════════════════════════════════════════════════════════════
// P0 — Crypto & Wallet Management Regression Tests
// ═══════════════════════════════════════════════════════════════════════════

describe('[regression:p0] Crypto & Wallet Management', function () {

    beforeEach(function () {
        global.wallets = {}
    })

    afterEach(function () {
        sinon.restore()
        global.wallets = {}
    })

    // ── R-CRYP-001 ──────────────────────────────────────────────────────

    it('[regression:p0] R-CRYP-001 — getWallet creates new wallet with valid structure', async function () {
        const wallet = await cryptoHelper.getWallet('test-label')
        assert.strictEqual(wallet.mnemonic, null)
        assert.strictEqual(wallet.seed, null)
        assert.strictEqual(wallet.coin, null)
        assert.strictEqual(wallet.network, null)
        assert.deepStrictEqual(wallet.addresses, [])
    })

    // ── R-CRYP-002 ──────────────────────────────────────────────────────

    it('[regression:p0] R-CRYP-002 — getWallet returns cached wallet on subsequent calls', async function () {
        const first  = await cryptoHelper.getWallet('alice')
        const second = await cryptoHelper.getWallet('alice')
        assert.strictEqual(first, second, 'same object reference expected')
    })

    // ── R-CRYP-003 ──────────────────────────────────────────────────────

    it('[regression:p0] R-CRYP-003 — getNewAddress derives valid BIP32 address for BTC regtest', async function () {
        const result = await cryptoHelper.getNewAddress('alice', 'bitcoin', 'regtest')
        assert.ok(typeof result.mnemonic === 'string', 'mnemonic should be a string')
        assert.ok(Buffer.isBuffer(result.privateKey), 'privateKey should be a Buffer')
        assert.ok(Buffer.isBuffer(result.publicKey), 'publicKey should be a Buffer')
        assert.ok(typeof result.address === 'string', 'address should be a string')
        assert.ok(result.address.length > 0, 'address should not be empty')

        // Validate BIP39 mnemonic
        const bip39 = require('bip39')
        assert.ok(bip39.validateMnemonic(result.mnemonic), 'should be valid BIP39 mnemonic')
    })

    // ── R-CRYP-004 ──────────────────────────────────────────────────────

    it('[regression:p0] R-CRYP-004a — getNewAddress derives address for LTC regtest', async function () {
        const result = await cryptoHelper.getNewAddress('ltc-test', 'litecoin', 'regtest')
        assert.ok(typeof result.address === 'string')
        assert.ok(result.address.length > 0)
    })

    it('[regression:p0] R-CRYP-004b — getNewAddress derives address for DOGE regtest', async function () {
        const result = await cryptoHelper.getNewAddress('doge-test', 'dogecoin', 'regtest')
        assert.ok(typeof result.address === 'string')
        assert.ok(result.address.length > 0)
    })

    // ── R-CRYP-005 ──────────────────────────────────────────────────────

    it('[regression:p0] R-CRYP-005 — getNewFundedAddress calls sendFunds, waitForTx, waitForUtxos', async function () {
        const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'

        const sendFundsStub  = sinon.stub(global.regtestMinerConnector, 'sendFunds').resolves('txid-fund')
        const waitForTxStub  = sinon.stub(global.nodeConnector, 'waitForTx').resolves(true)
        const waitUtxosStub  = sinon.stub(global.utxoTrackerConnector, 'waitForUtxos').resolves(true)

        const result = await cryptoHelper.getNewFundedAddress(
            'funded-test', 'bitcoin', 'regtest', MNEMONIC, 'legacy', 0, 1.0
        )

        assert.ok(sendFundsStub.calledOnce, 'sendFunds should be called')
        assert.strictEqual(sendFundsStub.firstCall.args[1], 1.0)
        assert.ok(waitForTxStub.calledOnce, 'waitForTx should be called')
        assert.strictEqual(waitForTxStub.firstCall.args[0], 'txid-fund')
        assert.ok(waitUtxosStub.calledOnce, 'waitForUtxos should be called')
        assert.ok(typeof result.address === 'string')
    })

    // ── R-CRYP-006 ──────────────────────────────────────────────────────

    it('[regression:p0] R-CRYP-006 — different labels produce different wallets', async function () {
        const a = await cryptoHelper.getWallet('label-A')
        const b = await cryptoHelper.getWallet('label-B')
        assert.notStrictEqual(a, b)
        assert.ok('label-A' in global.wallets)
        assert.ok('label-B' in global.wallets)
    })

    // ── R-CRYP-007 (wallet teardown) ────────────────────────────────────

    it('[regression:p0] R-CRYP-007 — wallet seeds can be zeroed from memory', async function () {
        const result = await cryptoHelper.getNewAddress('teardown-test', 'bitcoin', 'regtest')
        const wallet = global.wallets['teardown-test']

        // Simulate the teardown logic from initialCheck.test.js afterAll
        if (wallet.seed && Buffer.isBuffer(wallet.seed)) wallet.seed.fill(0)
        for (const addr of wallet.addresses) {
            if (addr.privateKey && Buffer.isBuffer(addr.privateKey)) addr.privateKey.fill(0)
        }

        // Verify zeroed
        assert.ok(wallet.seed.every(b => b === 0), 'seed should be zeroed')
        assert.ok(wallet.addresses[0].privateKey.every(b => b === 0), 'privateKey should be zeroed')
    })

    // ── Additional wallet caching regression tests ──────────────────────

    it('[regression:p0] R-CRYP-003b — same mnemonic is preserved on second getNewAddress call', async function () {
        const first = await cryptoHelper.getNewAddress('persist-test', 'bitcoin', 'regtest')
        const firstMnemonic = global.wallets['persist-test'].mnemonic
        assert.ok(firstMnemonic, 'mnemonic should be set')

        await cryptoHelper.getNewAddress('persist-test', 'bitcoin', 'regtest')
        assert.strictEqual(global.wallets['persist-test'].mnemonic, firstMnemonic,
            'mnemonic must not change after second call')
    })

    it('[regression:p0] R-CRYP-003c — different addressIndex produces different address', async function () {
        const r0 = await cryptoHelper.getNewAddress('idx-test', 'bitcoin', 'regtest', null, 'legacy', 0)
        const r1 = await cryptoHelper.getNewAddress('idx-test2', 'bitcoin', 'regtest', r0.mnemonic, 'legacy', 1)
        assert.notStrictEqual(r0.address, r1.address)
    })

    it('[regression:p0] R-CRYP-005b — getNewFundedAddress throws when waitForTx returns false', async function () {
        const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
        sinon.stub(global.regtestMinerConnector, 'sendFunds').resolves('txid')
        sinon.stub(global.nodeConnector, 'waitForTx').resolves(false)
        sinon.stub(global.utxoTrackerConnector, 'waitForUtxos').resolves(true)

        await assert.rejects(
            () => cryptoHelper.getNewFundedAddress('fail-test', 'bitcoin', 'regtest', MNEMONIC, 'legacy', 0, 1.0),
            /didn't appear in the blockchain/
        )
    })

    it('[regression:p0] R-CRYP-005c — getNewFundedAddress throws when waitForUtxos returns false', async function () {
        const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
        sinon.stub(global.regtestMinerConnector, 'sendFunds').resolves('txid')
        sinon.stub(global.nodeConnector, 'waitForTx').resolves(true)
        sinon.stub(global.utxoTrackerConnector, 'waitForUtxos').resolves(false)

        await assert.rejects(
            () => cryptoHelper.getNewFundedAddress('fail-test2', 'bitcoin', 'regtest', MNEMONIC, 'legacy', 0, 1.0),
            /utxo tracker couldn't parse/
        )
    })
})
