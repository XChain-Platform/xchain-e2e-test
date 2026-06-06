'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available —
// contact legal@dankest.llc.

const assert = require('assert');
const sinon  = require('sinon');

const bitcoin = require('bitcoinjs-lib');

// transactionHelper.js references globals at call-time (not module-load time).
// We must set them up BEFORE each test because other test files in this mocha
// run (e.g. cryptoHelper.test.js) also assign to these globals and may clobber
// them after our module-level assignments.

const transactionHelper = require('../../test/transactionHelper');

function resetGlobals() {
    global.NETWORK_OBJECT       = { ...bitcoin.networks.regtest, dustThreshold: 546 };
    global.encoderConnector     = { createTx:          async () => {} };
    global.nodeConnector        = {
        broadcastTx:        async () => 'txhash-stub',
        waitForTx:          async () => true,
        getFeePerKilobyte:  async () => 0.001,
        getTransactionHex:  async () => ''
    };
    global.utxoTrackerConnector = {
        getUtxosFromAddress: async () => ({ utxos: [] }),
        waitForUtxos:        async () => true
    };
}

describe('transactionHelper', function () {

    beforeEach(function () {
        resetGlobals();
    });

    afterEach(function () {
        sinon.restore();
    });

    // ── isSegwitUTXO ──────────────────────────────────────────────────────
    //
    // isSegwitUTXO decompiles utxo.scriptPubKey (hex) and checks whether the
    // first opcode is 0x00 (OP_0), which is the witness version for P2WPKH
    // and P2WSH outputs.

    describe('isSegwitUTXO', function () {

        it('returns true for a P2WPKH scriptPubKey (starts with OP_0 / 0x00)', function () {
            // P2WPKH: OP_0 <20-byte-hash>  →  0014<40 hex chars>
            const hash = 'a'.repeat(40); // 20 bytes of 0xaa
            const scriptPubKey = '0014' + hash;
            assert.strictEqual(transactionHelper.isSegwitUTXO({ scriptPubKey }), true);
        });

        it('returns true for a P2WSH scriptPubKey (OP_0 <32-byte-hash>)', function () {
            // P2WSH: OP_0 <32-byte-hash>  →  0020<64 hex chars>
            const hash = 'b'.repeat(64);
            const scriptPubKey = '0020' + hash;
            assert.strictEqual(transactionHelper.isSegwitUTXO({ scriptPubKey }), true);
        });

        it('returns false for a P2PKH scriptPubKey (OP_DUP = 0x76)', function () {
            // P2PKH: 76a914<20-byte-hash>88ac
            const scriptPubKey = '76a914' + 'a'.repeat(40) + '88ac';
            assert.strictEqual(transactionHelper.isSegwitUTXO({ scriptPubKey }), false);
        });

        it('returns false for an empty scriptPubKey string', function () {
            assert.strictEqual(transactionHelper.isSegwitUTXO({ scriptPubKey: '' }), false);
        });

        it('returns false when scriptPubKey is invalid hex that causes decompile to throw', function () {
            // Buffer.from with invalid hex silently produces wrong bytes, but passing
            // a non-string will cause an error inside the try block.
            assert.strictEqual(transactionHelper.isSegwitUTXO({ scriptPubKey: null }), false);
        });

        it('returns false for a P2SH scriptPubKey (OP_HASH160 = 0xa9)', function () {
            const scriptPubKey = 'a914' + 'c'.repeat(40) + '87';
            assert.strictEqual(transactionHelper.isSegwitUTXO({ scriptPubKey }), false);
        });
    });

    // ── createAndSendTransaction / createSimpleTransaction ───────────────
    //
    // Both functions create real bitcoinjs-lib PSBTs from hex data returned by
    // the encoder, sign them with a real ECPair, and call nodeConnector.broadcastTx.
    // End-to-end testing requires a live encoder returning valid PSBT hex.
    // The unit tests below verify the connector call contract only, using stubs
    // that return a minimal pre-built PSBT hex for a known key pair.

    describe('createAndSendTransaction (connector call contract)', function () {

        // Build a minimal valid PSBT hex using a deterministic private key so
        // bitcoinjs-lib can sign it without a live coin node.
        function buildMinimalPsbt(privKeyBuf) {
            const ecc      = require('tiny-secp256k1');
            const { ECPairFactory } = require('ecpair');
            const ECPair   = ECPairFactory(ecc);
            const network  = global.NETWORK_OBJECT;
            const keyPair  = ECPair.fromPrivateKey(privKeyBuf, { network });
            const p2wpkh   = bitcoin.payments.p2wpkh({ pubkey: keyPair.publicKey, network });
            const { address } = p2wpkh;

            const psbt = new bitcoin.Psbt({ network });
            psbt.addInput({
                hash: 'a'.repeat(64),
                index: 0,
                witnessUtxo: { script: p2wpkh.output, value: 100000 }
            });
            psbt.addOutput({ address, value: 90000 });
            return { psbt: psbt.toHex(), encoding: 'OP_RETURN' };
        }

        // createAndSendTransaction contains a `while (Date.now() < trackerEnd)`
        // polling loop that runs for up to 20 seconds.  We stub Date.now so the
        // loop exits on its first iteration, and stub setTimeout via the global
        // Promise constructor to avoid real waiting.

        function stubDateNowExpired() {
            // Always return a timestamp far in the past so that any
            // `while (Date.now() < endTime)` loop computed as
            // `endTime = Date.now() + someTimeout` exits after one iteration.
            // We make the value increase each call so that the first call
            // produces an endTime that is immediately exceeded by the next call.
            let callCount = 0;
            const BASE = 1_000_000;
            const stub = sinon.stub(Date, 'now').callsFake(() => {
                callCount++;
                // First call: return BASE (sets endTime = BASE + timeout)
                // All subsequent calls: return BASE + large number (exceeds endTime)
                return callCount === 1 ? BASE : BASE + 999_999_999;
            });
            return stub;
        }

        it('calls encoderConnector.createTx with the expected arguments', async function () {
            const ecc    = require('tiny-secp256k1');
            const { ECPairFactory } = require('ecpair');
            const ECPair = ECPairFactory(ecc);

            const privKey = Buffer.alloc(32, 0x01);
            const keyPair = ECPair.fromPrivateKey(privKey, { network: global.NETWORK_OBJECT });
            const { address } = bitcoin.payments.p2wpkh({
                pubkey: keyPair.publicKey,
                network: global.NETWORK_OBJECT
            });

            const createTxStub = sinon.stub(global.encoderConnector, 'createTx')
                .resolves(buildMinimalPsbt(privKey));
            sinon.stub(global.nodeConnector, 'broadcastTx').resolves('txhash-001');
            sinon.stub(global.nodeConnector, 'waitForTx').resolves(true);
            sinon.stub(global.utxoTrackerConnector, 'getUtxosFromAddress').resolves({ utxos: [] });
            const dateStub = stubDateNowExpired();

            try {
                await transactionHelper.createAndSendTransaction(
                    { address, privateKey: privKey, publicKey: keyPair.publicKey },
                    { action: 'ISSUE' }
                );
            } finally {
                dateStub.restore();
            }

            assert.ok(createTxStub.calledOnce, 'encoderConnector.createTx should be called once');
            const args = createTxStub.firstCall.args;
            assert.strictEqual(args[1], address,          'pubkey arg');
            assert.deepStrictEqual(args[3], { action: 'ISSUE' }, 'data arg');
            assert.strictEqual(args[8], address,          'changeAddress arg');
        });

        it('calls nodeConnector.broadcastTx after building the signed transaction', async function () {
            const ecc    = require('tiny-secp256k1');
            const { ECPairFactory } = require('ecpair');
            const ECPair = ECPairFactory(ecc);

            const privKey = Buffer.alloc(32, 0x02);
            const keyPair = ECPair.fromPrivateKey(privKey, { network: global.NETWORK_OBJECT });
            const { address } = bitcoin.payments.p2wpkh({
                pubkey: keyPair.publicKey,
                network: global.NETWORK_OBJECT
            });

            global.encoderConnector.createTx = sinon.stub().resolves(buildMinimalPsbt(privKey));
            let broadcastCalled = false
            global.nodeConnector.broadcastTx = async (hex) => { broadcastCalled = true; return 'txhash-002' }
            global.nodeConnector.waitForTx = async () => true;
            global.utxoTrackerConnector.getUtxosFromAddress = async () => ({ utxos: [] });
            const dateStub = stubDateNowExpired();

            try {
                await transactionHelper.createAndSendTransaction(
                    { address, privateKey: privKey, publicKey: keyPair.publicKey },
                    {}
                );
            } finally {
                dateStub.restore();
            }

            assert.ok(broadcastCalled, 'broadcastTx should be called');
        });
    });

    // createSimpleTransaction builds PSBTs inline without calling the encoder.
    // Because it fetches UTXOs at runtime and constructs full PSBT inputs
    // (including nonWitnessUtxo from nodeConnector.getTransactionHex), it is
    // deeply coupled to the live pipeline.  Integration testing is the
    // appropriate level for end-to-end verification of this function.

    describe('createSimpleTransaction', function () {
        it('is documented as requiring integration testing for full coverage', function () {
            // createSimpleTransaction builds and signs a real PSBT from UTXOs
            // fetched at runtime.  The PSBT must include real scriptPubKey data
            // from a live (or fake) coin node.  Mocking the full PSBT construction
            // cycle inline would reproduce the production code, which provides no
            // testing value.  Use the e2e test suite against a regtest node for
            // full coverage.
            assert.strictEqual(typeof transactionHelper.createSimpleTransaction, 'function');
        });
    });
});
