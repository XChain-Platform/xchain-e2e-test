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
 * MESSAGE v3 (plaintext) and v2 (encrypted, stub envelope) standalone,
 * to characterize the messaging path independently of BATCH/gated-FILE.
 *
 ********************************************************************/

const { expect } = require('chai');
const { makeSdk, submit, fundedGasAddress, submitOpts } = require('./sdkHelper');

const COIN = (typeof global.COIN_CODE !== 'undefined' && global.COIN_CODE) || 'BTC';

function stubEncryptedMessage() {
    const blob = Buffer.alloc(94);
    for (let i = 0; i < blob.length; i++) blob[i] = (i * 7 + 3) & 0xff;
    return blob.toString('hex');
}

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

    it('MESSAGE v2 (encrypted envelope) to self', async function () {
        const res = await submit(sdk,
            { action: 'MESSAGE', params: { version: 2, coin: COIN, destination: sender.address, encryptedMessage: stubEncryptedMessage() } },
            { pubkey: sender.address, change: sender.address },
            submitOpts({ wif: sender.wif })
        );
        console.log('    [sdk] MESSAGE v2 status=' + res.indexed.status);
        expect(res.indexed.status).to.equal('valid');
    });
});
