/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 * XChain Platform E2E - SDK-driven multi-leg SEND
 *
 * SEND v1/v2/v3 repeat AMOUNT|DESTINATION (v1), TICK|AMOUNT|DESTINATION
 * (v2) and TICK|AMOUNT|DESTINATION|MEMO (v3) on the wire. The SDK builds
 * these from a `legs` array; previously it walked the format list
 * against a flat field map and every repetition echoed leg 1, producing a
 * VALID action that paid one recipient twice.
 *
 * This suite is the live half of that fix: each version is built by the
 * SDK, broadcast on regtest, and every leg must be credited EXACTLY once
 * with its own amount, tick and memo.
 *
 *     npm run test:sdk:multileg
 *
 ********************************************************************/

const { expect } = require('chai');
const { makeSdk, submit, fundedGasAddress, fundedSdkAddress, uniqueTick, submitOpts } = require('./sdkHelper');

function haveConnectors() {
    return !!(global.regtestMinerConnector && global.utxoTrackerConnector && global.nodeConnector);
}

function balanceFor(balances, tick) {
    const list = balances && (Array.isArray(balances) ? balances : balances.data);
    if (!Array.isArray(list)) return null;
    const row = list.find(b => (b.tick || b.TICK) === tick);
    return row ? Number(row.amount ?? row.quantity ?? row.balance) : 0;
}

// A recipient only needs an address: it never spends in this suite.
function newRecipient(sdk) {
    const kp = sdk.generateKeyPair();
    return { ...kp, address: sdk.deriveAddress(kp.publicKey, { type: 'p2pkh' }) };
}

// Every destination segment appears exactly once in the action string: the
// previous serializer emitted leg 1's destination in every repetition.
function assertDistinctLegs(actionString, addresses) {
    const segs = actionString.split('|');
    for (const address of addresses)
        expect(segs.filter(s => s === address).length, address + ' appears once in ' + actionString).to.equal(1);
}

describe('[sdk] multi-leg SEND', function () {
    this.timeout(0);

    let sdk, issuer, tickA, tickB;

    before(async function () {
        if (!haveConnectors()) this.skip();
        sdk = makeSdk();
        issuer = await fundedGasAddress(sdk, 1);
        tickA = uniqueTick('MLA');
        tickB = uniqueTick('MLB');
        for (const tick of [tickA, tickB]) {
            const res = await submit(sdk,
                { action: 'ISSUE', params: { tick, maxSupply: 1000000, maxMint: 100000, decimals: 0, description: 'multi-leg send', mintSupply: 1000 } },
                { pubkey: issuer.address, change: issuer.address },
                submitOpts({ wif: issuer.wif }));
            expect(res.indexed.status, 'ISSUE ' + tick).to.equal('valid');
        }
        console.log('    [sdk] issuer=' + issuer.address + ' ticks=' + tickA + ',' + tickB);
    });

    it('v1: three legs on one tick credit three recipients their own amounts', async function () {
        const r = [newRecipient(sdk), newRecipient(sdk), newRecipient(sdk)];
        const amounts = [10, 20, 30];

        const res = await submit(sdk,
            {
                action: 'SEND',
                params: {
                    tick: tickA,
                    memo: 'xc712 v1',
                    legs: r.map((recipient, i) => ({ amount: amounts[i], destination: recipient.address })),
                }
            },
            { pubkey: issuer.address, change: issuer.address },
            submitOpts({ wif: issuer.wif }));

        expect(res.version, 'shared tick + shared memo selects v1').to.equal(1);
        assertDistinctLegs(res.actionString, r.map(x => x.address));
        expect(res.indexed.status, 'SEND v1 indexed').to.equal('valid');

        for (let i = 0; i < r.length; i++)
            expect(balanceFor(await sdk.getBalances(r[i].address), tickA), 'leg ' + i + ' credited once').to.equal(amounts[i]);
        expect(balanceFor(await sdk.getBalances(issuer.address), tickA), 'issuer debited the exact total').to.equal(1000 - 60);
    });

    it('v2: two legs on two different ticks credit each recipient its own tick', async function () {
        const r1 = newRecipient(sdk);
        const r2 = newRecipient(sdk);

        const res = await submit(sdk,
            {
                action: 'SEND',
                params: {
                    memo: 'xc712 v2',
                    legs: [
                        { tick: tickA, amount: 11, destination: r1.address },
                        { tick: tickB, amount: 22, destination: r2.address },
                    ]
                }
            },
            { pubkey: issuer.address, change: issuer.address },
            submitOpts({ wif: issuer.wif }));

        expect(res.version, 'per-leg tick selects v2').to.equal(2);
        assertDistinctLegs(res.actionString, [r1.address, r2.address]);
        expect(res.indexed.status, 'SEND v2 indexed').to.equal('valid');

        expect(balanceFor(await sdk.getBalances(r1.address), tickA), 'r1 got tickA').to.equal(11);
        expect(balanceFor(await sdk.getBalances(r1.address), tickB), 'r1 got no tickB').to.equal(0);
        expect(balanceFor(await sdk.getBalances(r2.address), tickB), 'r2 got tickB').to.equal(22);
        expect(balanceFor(await sdk.getBalances(r2.address), tickA), 'r2 got no tickA').to.equal(0);
    });

    it('v3: two legs carry their own memos and are recorded per leg', async function () {
        const r1 = newRecipient(sdk);
        const r2 = newRecipient(sdk);

        const res = await submit(sdk,
            {
                action: 'SEND',
                params: {
                    legs: [
                        { tick: tickA, amount: 13, destination: r1.address, memo: 'xc712 leg one' },
                        { tick: tickB, amount: 26, destination: r2.address, memo: 'xc712 leg two' },
                    ]
                }
            },
            { pubkey: issuer.address, change: issuer.address },
            submitOpts({ wif: issuer.wif }));

        expect(res.version, 'per-leg memo selects v3').to.equal(3);
        assertDistinctLegs(res.actionString, [r1.address, r2.address]);
        expect(res.indexed.status, 'SEND v3 indexed').to.equal('valid');

        expect(balanceFor(await sdk.getBalances(r1.address), tickA)).to.equal(13);
        expect(balanceFor(await sdk.getBalances(r2.address), tickB)).to.equal(26);

        // The indexer must have written one sends row per leg, each with its
        // own memo (not leg 1's memo repeated).
        if (global.indexerDatabase) {
            const leg1 = await global.indexerDatabase.waitForSend({
                source: issuer.address, destination: r1.address, tick: tickA,
                amount: 13, txHash: res.txid, memo: 'xc712 leg one', status: 'valid'
            });
            const leg2 = await global.indexerDatabase.waitForSend({
                source: issuer.address, destination: r2.address, tick: tickB,
                amount: 26, txHash: res.txid, memo: 'xc712 leg two', status: 'valid'
            });
            expect(leg1, 'leg 1 sends row').to.not.equal(null);
            expect(leg2, 'leg 2 sends row').to.not.equal(null);
        }
    });

    it('forcing a multi-leg version with a flat field map is refused, not silently doubled', async function () {
        let err = null;
        try {
            await sdk.send({ version: 1, tick: tickA, amount: 5, destination: issuer.address, memo: 'flat' });
        } catch (e) { err = e; }
        expect(err, 'flat map against SEND v1 must throw').to.not.equal(null);
        expect(err.code).to.equal('REPEATED_FORMAT_REQUIRES_LEGS');
    });

});
