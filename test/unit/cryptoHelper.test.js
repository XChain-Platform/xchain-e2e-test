'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const assert = require('assert');
const sinon  = require('sinon');

// cryptoHelper.js sets `global.wallets = {}` at module load time and references
// global.regtestMinerConnector, global.nodeConnector, global.utxoTrackerConnector.
// We set up stubs for these globals before requiring the module.

// Set up the required globals before the first require
global.wallets                = {};
global.regtestMinerConnector  = { sendFunds: async () => {} };
global.nodeConnector          = { waitForTx: async () => true };
global.utxoTrackerConnector   = { waitForUtxos: async () => true };

const cryptoHelper = require('../../test/cryptoHelper');

describe('cryptoHelper', function () {

    beforeEach(function () {
        // Reset the wallet cache between tests
        global.wallets = {};
    });

    afterEach(function () {
        sinon.restore();
        global.wallets = {};
    });

    // ── getWallet ─────────────────────────────────────────────────────────

    describe('getWallet', function () {
        it('creates a new wallet skeleton on first call', async function () {
            const wallet = await cryptoHelper.getWallet('alice');
            assert.strictEqual(wallet.mnemonic, null);
            assert.strictEqual(wallet.seed,     null);
            assert.strictEqual(wallet.coin,     null);
            assert.strictEqual(wallet.network,  null);
            assert.deepStrictEqual(wallet.addresses, []);
        });

        it('returns the same object on repeated calls with the same label', async function () {
            const first  = await cryptoHelper.getWallet('alice');
            const second = await cryptoHelper.getWallet('alice');
            assert.strictEqual(first, second);
        });

        it('returns different objects for different labels', async function () {
            const alice = await cryptoHelper.getWallet('alice');
            const bob   = await cryptoHelper.getWallet('bob');
            assert.notStrictEqual(alice, bob);
        });

        it('caches the wallet in global.wallets', async function () {
            await cryptoHelper.getWallet('alice');
            assert.ok('alice' in global.wallets);
        });
    });

    // ── getNewAddress ─────────────────────────────────────────────────────

    describe('getNewAddress', function () {
        it('returns an object with mnemonic, privateKey, publicKey, address', async function () {
            const result = await cryptoHelper.getNewAddress('alice', 'bitcoin', 'regtest');
            assert.ok(typeof result.mnemonic    === 'string', 'mnemonic should be a string');
            assert.ok(Buffer.isBuffer(result.privateKey),     'privateKey should be a Buffer');
            assert.ok(Buffer.isBuffer(result.publicKey),      'publicKey should be a Buffer');
            assert.ok(typeof result.address     === 'string', 'address should be a string');
            assert.ok(result.address.length > 0,              'address should not be empty');
        });

        it('generates a BIP39 mnemonic when none is supplied', async function () {
            const bip39 = require('bip39');
            const result = await cryptoHelper.getNewAddress('alice', 'bitcoin', 'regtest');
            assert.ok(bip39.validateMnemonic(result.mnemonic), 'should be a valid BIP39 mnemonic');
        });

        it('uses the supplied mnemonic instead of generating one', async function () {
            const mnemonic = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
            const result   = await cryptoHelper.getNewAddress('alice', 'bitcoin', 'regtest', mnemonic);
            assert.strictEqual(result.mnemonic, mnemonic);
        });

        it('does not overwrite the cached wallet mnemonic on a second call for the same label', async function () {
            // Both calls happen within the same test (beforeEach already cleared wallets).
            const first = await cryptoHelper.getNewAddress('alice', 'bitcoin', 'regtest');
            const firstMnemonic = global.wallets['alice'].mnemonic;
            assert.ok(firstMnemonic, 'mnemonic should be set after first call');

            // Second call: wallet.mnemonic is already set, so the code skips
            // mnemonic generation and keeps the existing seed.
            await cryptoHelper.getNewAddress('alice', 'bitcoin', 'regtest');

            assert.strictEqual(global.wallets['alice'].mnemonic, firstMnemonic,
                'wallet mnemonic must not change after second call');
        });

        it('caches the wallet in global.wallets with correct coin/network', async function () {
            await cryptoHelper.getNewAddress('alice', 'bitcoin', 'regtest');
            const wallet = global.wallets['alice'];
            assert.strictEqual(wallet.coin, 'bitcoin');
            assert.ok(wallet.network !== null, 'network should be set');
        });

        it('appends the address entry to wallet.addresses array', async function () {
            await cryptoHelper.getNewAddress('alice', 'bitcoin', 'regtest');
            const wallet = global.wallets['alice'];
            assert.strictEqual(wallet.addresses.length, 1);
            assert.ok('address'    in wallet.addresses[0]);
            assert.ok('publicKey'  in wallet.addresses[0]);
            assert.ok('privateKey' in wallet.addresses[0]);
        });

        it('appends a second entry when called with a different addressIndex', async function () {
            await cryptoHelper.getNewAddress('alice', 'bitcoin', 'regtest', null, 'legacy', 0);
            await cryptoHelper.getNewAddress('alice', 'bitcoin', 'regtest', null, 'legacy', 1);
            const wallet = global.wallets['alice'];
            assert.strictEqual(wallet.addresses.length, 2);
        });

        it('derives a different address for different addressIndex values', async function () {
            const r0 = await cryptoHelper.getNewAddress('alice', 'bitcoin', 'regtest', null, 'legacy', 0);
            // Use a fresh label to avoid seed caching
            const r1 = await cryptoHelper.getNewAddress('bob', 'bitcoin', 'regtest', r0.mnemonic, 'legacy', 1);
            // Same mnemonic but different index → different address
            assert.notStrictEqual(r0.address, r1.address);
        });
    });

    // ── getNewFundedAddress ───────────────────────────────────────────────

    describe('getNewFundedAddress', function () {
        const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

        it('calls regtestMinerConnector.sendFunds with the new address and amount', async function () {
            const sendFundsStub   = sinon.stub(global.regtestMinerConnector, 'sendFunds').resolves('txid-abc');
            const waitForTxStub   = sinon.stub(global.nodeConnector, 'waitForTx').resolves(true);
            const waitForUtxosStub = sinon.stub(global.utxoTrackerConnector, 'waitForUtxos').resolves(true);

            const result = await cryptoHelper.getNewFundedAddress(
                'alice', 'bitcoin', 'regtest', MNEMONIC, 'legacy', 0, 1.0
            );

            assert.ok(sendFundsStub.calledOnce, 'sendFunds should be called once');
            const [addr, amount] = sendFundsStub.firstCall.args;
            assert.strictEqual(typeof addr, 'string');
            assert.ok(addr.length > 0);
            assert.strictEqual(amount, 1.0);
        });

        it('calls nodeConnector.waitForTx with the txId returned by sendFunds', async function () {
            sinon.stub(global.regtestMinerConnector, 'sendFunds').resolves('txid-xyz');
            const waitForTxStub = sinon.stub(global.nodeConnector, 'waitForTx').resolves(true);
            sinon.stub(global.utxoTrackerConnector, 'waitForUtxos').resolves(true);

            await cryptoHelper.getNewFundedAddress(
                'alice', 'bitcoin', 'regtest', MNEMONIC, 'legacy', 0, 1.0
            );

            assert.ok(waitForTxStub.calledOnce);
            assert.strictEqual(waitForTxStub.firstCall.args[0], 'txid-xyz');
        });

        it('calls utxoTrackerConnector.waitForUtxos with the new address', async function () {
            sinon.stub(global.regtestMinerConnector, 'sendFunds').resolves('txid-abc');
            sinon.stub(global.nodeConnector, 'waitForTx').resolves(true);
            const waitForUtxosStub = sinon.stub(global.utxoTrackerConnector, 'waitForUtxos').resolves(true);

            const result = await cryptoHelper.getNewFundedAddress(
                'alice', 'bitcoin', 'regtest', MNEMONIC, 'legacy', 0, 1.0
            );

            assert.ok(waitForUtxosStub.calledOnce);
            assert.strictEqual(waitForUtxosStub.firstCall.args[0], result.address);
        });

        it('returns the address info on success', async function () {
            sinon.stub(global.regtestMinerConnector, 'sendFunds').resolves('txid-abc');
            sinon.stub(global.nodeConnector, 'waitForTx').resolves(true);
            sinon.stub(global.utxoTrackerConnector, 'waitForUtxos').resolves(true);

            const result = await cryptoHelper.getNewFundedAddress(
                'alice', 'bitcoin', 'regtest', MNEMONIC, 'legacy', 0, 1.0
            );

            assert.ok(typeof result.address === 'string');
            assert.ok(result.mnemonic === MNEMONIC);
        });

        it('throws when waitForTx returns false', async function () {
            sinon.stub(global.regtestMinerConnector, 'sendFunds').resolves('txid-abc');
            sinon.stub(global.nodeConnector, 'waitForTx').resolves(false);
            sinon.stub(global.utxoTrackerConnector, 'waitForUtxos').resolves(true);

            await assert.rejects(
                () => cryptoHelper.getNewFundedAddress(
                    'alice', 'bitcoin', 'regtest', MNEMONIC, 'legacy', 0, 1.0
                ),
                /didn't appear in the blockchain/
            );
        });

        it('throws when waitForUtxos returns false', async function () {
            sinon.stub(global.regtestMinerConnector, 'sendFunds').resolves('txid-abc');
            sinon.stub(global.nodeConnector, 'waitForTx').resolves(true);
            sinon.stub(global.utxoTrackerConnector, 'waitForUtxos').resolves(false);

            await assert.rejects(
                () => cryptoHelper.getNewFundedAddress(
                    'alice', 'bitcoin', 'regtest', MNEMONIC, 'legacy', 0, 1.0
                ),
                /utxo tracker couldn't parse/
            );
        });
    });
});
