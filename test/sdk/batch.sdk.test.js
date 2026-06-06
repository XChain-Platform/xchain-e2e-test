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
 * XChain Platform E2E - SDK BatchBuilder (on-chain)
 *
 * The SDK's fluent BatchBuilder (sdk.batch().send().mint().build()) has only
 * unit coverage — nothing drives a real BATCH built by it through the live
 * pipeline (encoder BATCH encoding → decoder → indexer BATCH expansion). This
 * suite builds a multi-SEND BATCH via the SDK, submits it on regtest, and
 * verifies every sub-action took effect (balances moved for each recipient and
 * the issuer was debited the full total in a single transaction).
 *
 * NOTE: BatchBuilder.build() is async (it wraps the SDK's async createAction) —
 * the unit tests await it, but the README/JSDoc show it without `await`. We
 * await here, the correct usage.
 *
 *     COIN=bitcoin NETWORK=regtest npm run test:sdk
 *
 ********************************************************************/

'use strict';

const { expect } = require('chai');
const { makeSdk, submit, fundedGasAddress, uniqueTick, submitOpts } = require('./sdkHelper');

function balanceFor(balances, tick) {
    const list = balances && (Array.isArray(balances) ? balances : balances.data);
    if (!Array.isArray(list)) return 0;
    const row = list.find((b) => (b.tick || b.TICK) === tick);
    return row ? Number(row.amount ?? row.quantity ?? row.balance) : 0;
}

function newRecipient(sdk) {
    const kp = sdk.generateKeyPair();
    return { ...kp, address: sdk.deriveAddress(kp.publicKey, { type: 'p2pkh' }) };
}

function haveConnectors() {
    return global.regtestMinerConnector && global.utxoTrackerConnector && global.nodeConnector;
}

describe('[sdk] BatchBuilder multi-action (on-chain)', function () {
    this.timeout(0);

    let sdk, issuer, tick;

    before(async function () {
        if (!haveConnectors()) this.skip();
        sdk = makeSdk();
        issuer = await fundedGasAddress(sdk, 1);
        tick = uniqueTick('BAT');
        const res = await submit(sdk,
            { action: 'ISSUE', params: { tick, maxSupply: 1000000, maxMint: 100000, decimals: 0, description: 'batch', mintSupply: 1000 } },
            { pubkey: issuer.address, change: issuer.address },
            submitOpts({ wif: issuer.wif }));
        expect(res.indexed.status, 'ISSUE indexed').to.equal('valid');
    });

    it('a BATCH of two SENDs built via the SDK indexes and applies every sub-action', async function () {
        const r1 = newRecipient(sdk);
        const r2 = newRecipient(sdk);

        // Build the BATCH through the fluent SDK API (async — must await).
        const built = await sdk.batch()
            .send({ tick, amount: 100, destination: r1.address })
            .send({ tick, amount: 200, destination: r2.address })
            .build();
        expect(built.action, 'built a BATCH').to.equal('BATCH');
        expect(built.actionString, 'two sub-actions joined').to.match(/^BATCH\|\d+\|SEND\|.*;SEND\|/);

        const res = await submit(sdk,
            { action: 'BATCH', params: { command: built.fields.COMMAND } },
            { pubkey: issuer.address, change: issuer.address },
            submitOpts({ wif: issuer.wif }));
        expect(res.indexed.status, 'BATCH indexed').to.equal('valid');

        // Every sub-action must have applied: both recipients credited, issuer debited the total.
        expect(balanceFor(await sdk.getBalances(r1.address), tick), 'r1 received 100').to.equal(100);
        expect(balanceFor(await sdk.getBalances(r2.address), tick), 'r2 received 200').to.equal(200);
        expect(balanceFor(await sdk.getBalances(issuer.address), tick), 'issuer debited 300 (1000-300)').to.equal(700);
    });
});
