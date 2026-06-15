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
 * XChain Platform E2E - SDK-driven messaging
 *
 * MESSAGE v3 (plaintext via submitAction) and v2 (real ECIES messaging.send())
 * standalone, to characterize the messaging path independently of BATCH/gated-FILE.
 *
 ********************************************************************/

const { expect } = require('chai');
const { makeSdk, submit, fundedGasAddress, submitOpts, isTransientStackError, mine } = require('./sdkHelper');

const COIN = (typeof global.COIN_CODE !== 'undefined' && global.COIN_CODE) || 'BTC';

describe('[sdk] messaging', function () {
    this.timeout(0);

    let sdk, sender;

    before(async function () {
        sdk = makeSdk();
        sender = await fundedGasAddress(sdk, 1);
        console.log('    [sdk] sender=' + sender.address);
    });

    it('MESSAGE v3 (plaintext) to self', async function () {
        const res = await submit(sdk,
            { action: 'MESSAGE', params: { version: 3, coin: COIN, destination: sender.address, plaintextMessage: 'hello from the sdk' } },
            { pubkey: sender.address, change: sender.address },
            submitOpts({ wif: sender.wif })
        );
        console.log('    [sdk] MESSAGE v3 status=' + res.indexed.status);
        expect(res.indexed.status).to.equal('valid');
    });

    it('MESSAGE v2 (encrypted) via messaging.send() to self', async function () {
        // Real ECIES send — no stub ciphertext, no explicit version. send() resolves
        // the recipient pubkey, ECIES-encrypts a binary payload, and lets the format
        // selector pick v2 (which carries no ENCRYPTION_METHOD on the wire). This
        // exercises the full encode path that the version:2 stub used to bypass.
        // The sender revealed its pubkey by signing the funding-spend + gas MINT, so
        // the to-self ECIES recipient-pubkey lookup resolves.
        const payload = Buffer.from('gated-key-handoff payload from the sdk');

        let sendRes;
        for (let i = 1; i <= 6; i++) {
            try {
                await global.utxoTrackerConnector.quiesce({ timeoutMs: 20000, pollMs: 250, regtestMiner: global.regtestMinerConnector });
            } catch (e) { /* best effort */ }
            try {
                sendRes = await sdk.sendMessage({
                    wif:         sender.wif,
                    coin:        COIN,
                    destination: sender.address,
                    message:     payload,
                    method:      1, // ECIES
                    encoder:     { pubkey: sender.address, change: sender.address, unconfirmed: false },
                });
                break;
            } catch (err) {
                if (i < 6 && isTransientStackError(err)) continue;
                throw err;
            }
        }
        expect(sendRes && sendRes.txid, 'send() returned a txid').to.be.a('string');
        console.log('    [sdk] MESSAGE v2 sent txid=' + sendRes.txid + ' action=' + sendRes.actionString);
        // send() must have produced a v2 action with no ENCRYPTION_METHOD field
        expect(sendRes.actionString.split('|').slice(0, 2).join('|')).to.equal('MESSAGE|2');

        // Wait for the indexer to record the message, then confirm it decrypts and
        // that the v2 row carries the inferred ECIES method (1).
        let received = [], found = null;
        for (let i = 1; i <= 40 && !found; i++) {
            await mine(1);
            received = await sdk.getMessagesForAddress(sender.address, { wif: sender.wif, type: 'received' });
            found = received.find(m => m.txid === sendRes.txid) || null;
            if (!found) await new Promise(r => setTimeout(r, 1500));
        }
        expect(found, 'sent MESSAGE v2 was indexed').to.exist;
        console.log('    [sdk] MESSAGE v2 indexed method=' + found.method);
        expect(found.method).to.equal(1);
        expect(Buffer.isBuffer(found.bytes)).to.equal(true);
        expect(found.bytes.equals(payload)).to.equal(true);
    });
});
