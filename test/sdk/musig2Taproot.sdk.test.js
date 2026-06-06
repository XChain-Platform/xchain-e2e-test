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
 *
 * XChain Platform E2E - SDK MuSig2 taproot key-path spend (on-chain)
 *
 * The SDK's MuSig2 module (xchain-sdk/src/musig2.js) is the signing
 * primitive behind the xchain-wallet `taproot-musig2` multisig custody
 * scheme. Its unit tests only verify aggregate signatures against the
 * SDK's OWN BIP340 verifier — never against a real node. This suite
 * closes that gap: it aggregates real cosigner keys, derives the P2TR
 * address exactly as the wallet does (sdk.musig2.aggregateKeys ->
 * p2tr({ pubkey: aggXOnly }), key-path only, untweaked), funds it on the
 * live regtest node, builds a real spend, signs it with MuSig2, and
 * submits it via `sendrawtransaction`. Mempool acceptance == Bitcoin
 * Core ran full consensus Schnorr/taproot validation on the signature.
 *
 * It also pins the n-of-n invariant on-chain: a sub-threshold
 * aggregation (the shape a "T-of-N taproot-musig2" config would produce)
 * is REJECTED by the node — which is exactly why xchain-wallet must (and
 * now does) forbid T<N taproot-musig2 configs.
 *
 * Reuses the global connectors stood up by test/initialCheck.test.js
 * (regtestMinerConnector, nodeConnector). BTC-only — taproot is not
 * available on the DOGE regtest node, so the suite self-skips off BTC.
 *
 *     COIN=bitcoin NETWORK=regtest npm run test:sdk
 *
 ********************************************************************/

'use strict';

const crypto = require('crypto');
const { expect } = require('chai');
const { loadSDK } = require('./sdkHelper');

// bitcoinjs-lib + tiny-secp256k1 ship in this repo's node_modules.
const bitcoin = require('bitcoinjs-lib');
const ecc     = require('tiny-secp256k1');
bitcoin.initEccLib(ecc);
const { Transaction } = bitcoin;

const { XChainSDK } = loadSDK();

const isBitcoin = () => {
    const coin = String((typeof global.COIN !== 'undefined' && global.COIN) || process.env.COIN || 'bitcoin').toLowerCase();
    return coin.startsWith('bitcoin') || coin === 'btc';
};

function haveConnectors() {
    return global.regtestMinerConnector && global.nodeConnector;
}

// Aggregate `n` fresh cosigner keys via the SDK and derive the wallet's
// taproot-musig2 P2TR address (untweaked, key-path only).
function aggregate(musig, n) {
    const sks = Array.from({ length: n }, () => crypto.randomBytes(32));
    const pks = sks.map((sk) => Buffer.from(ecc.pointFromScalar(sk, true)));
    const ctx = musig.aggregateKeys(pks);
    const internalXOnly = Buffer.from(ctx.xOnlyPubkey);
    const p2tr = bitcoin.payments.p2tr({ pubkey: internalXOnly, network: bitcoin.networks.regtest });
    return { sks, pks, internalXOnly, p2tr };
}

// Fund an address on regtest and return its spendable UTXO {txid, vout, valueSats, spk}.
async function fundUtxo(address, amountBtc = 0.002) {
    const txid = await global.regtestMinerConnector.sendFunds(address, amountBtc);
    if (!txid) throw new Error('regtest miner sendFunds returned null for ' + address);
    const seen = await global.nodeConnector.waitForTx(txid, 30000);
    if (!seen) throw new Error('funding tx ' + txid + ' never appeared on-chain');
    try { await global.regtestMinerConnector.generateBlocks(1); } catch (e) { /* miner auto-mines anyway */ }
    const raw = await global.nodeConnector._rpc('getrawtransaction', [txid, true]);
    const out = raw.vout.find((v) => v.scriptPubKey && v.scriptPubKey.address === address);
    if (!out) throw new Error('no funding vout paying ' + address);
    return { txid, vout: out.n, valueSats: Math.round(out.value * 1e8), spk: Buffer.from(out.scriptPubKey.hex, 'hex') };
}

// Build a key-path spend of `utxo` and sign it with MuSig2 using exactly
// `signerCount` of the `n` cosigners (signerCount < n reproduces the
// sub-threshold aggregation a T-of-N config would attempt). Returns
// { accepted, reason, txid, localValid }.
async function spend(musig, agg, utxo, signerCount) {
    const { sks, pks, internalXOnly, p2tr } = agg;

    const tx = new Transaction();
    tx.version = 2;
    tx.addInput(Buffer.from(utxo.txid, 'hex').reverse(), utxo.vout);
    const destPk = Buffer.from(ecc.pointFromScalar(crypto.randomBytes(32), true));
    tx.addOutput(bitcoin.payments.p2wpkh({ pubkey: destPk, network: bitcoin.networks.regtest }).output, utxo.valueSats - 500);
    const sighash = tx.hashForWitnessV1(0, [utxo.spk], [utxo.valueSats], Transaction.SIGHASH_DEFAULT);

    const nonces = sks.map((sk, i) =>
        musig.generateNonce({ publicKey: pks[i], secretKey: sk, msg: sighash, xOnlyPublicKey: internalXOnly }));
    const aggNonce = musig.aggregateNonces(nonces.slice(0, signerCount));
    const session = musig.startSession(aggNonce, sighash, pks); // session bound to ALL n keys
    const partials = sks.slice(0, signerCount).map((sk, i) =>
        musig.partialSign({ secretKey: sk, publicNonce: nonces[i], sessionKey: session, verify: false }));
    const sig = Buffer.from(musig.aggregateSignatures(partials, session));

    tx.ins[0].witness = [sig];
    const localValid = ecc.verifySchnorr(sighash, Buffer.from(p2tr.pubkey), sig);
    try {
        const txid = await global.nodeConnector._rpc('sendrawtransaction', [tx.toHex()]);
        return { accepted: true, txid, localValid };
    } catch (e) {
        return { accepted: false, reason: e.message, localValid };
    }
}

describe('[sdk] musig2 taproot key-path spend (on-chain)', function () {
    this.timeout(0);

    let musig;

    before(function () {
        if (!isBitcoin()) this.skip();            // taproot is BTC-only on regtest
        if (!haveConnectors()) this.skip();        // requires the live stack (npm run test:sdk)
        musig = new XChainSDK({ network: 'bitcoin-regtest' }).musig2;
    });

    it('2-of-2 aggregate signature is accepted by Bitcoin Core', async function () {
        const agg = aggregate(musig, 2);
        const utxo = await fundUtxo(agg.p2tr.address);
        const r = await spend(musig, agg, utxo, 2);
        expect(r.localValid, 'sig verifies vs taproot output key').to.equal(true);
        expect(r.accepted, 'node accepted spend' + (r.reason ? ': ' + r.reason : '')).to.equal(true);
    });

    it('3-of-3 aggregate signature is accepted by Bitcoin Core', async function () {
        const agg = aggregate(musig, 3);
        const utxo = await fundUtxo(agg.p2tr.address);
        const r = await spend(musig, agg, utxo, 3);
        expect(r.localValid).to.equal(true);
        expect(r.accepted, 'node accepted spend' + (r.reason ? ': ' + r.reason : '')).to.equal(true);
    });

    it('sub-threshold (2-of-3) aggregation is REJECTED — pins the n-of-n invariant', async function () {
        const agg = aggregate(musig, 3);
        const utxo = await fundUtxo(agg.p2tr.address);
        const r = await spend(musig, agg, utxo, 2);            // sign with only 2 of the 3 keys
        expect(r.localValid, 'sub-threshold sig must NOT verify').to.equal(false);
        expect(r.accepted, 'node must reject a sub-threshold musig2 spend').to.equal(false);
        expect(r.reason || '').to.match(/Invalid Schnorr signature|script-verify/i);
    });
});
