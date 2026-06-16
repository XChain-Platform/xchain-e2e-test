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
 **********************************************************************
 *
 * XChain Platform E2E - SDK-driven foundation actions
 *
 * Drives the bread-and-butter ACTIONs through sdk.submitAction() on a
 * freshly issued token: MINT, SEND (with memo), DESTROY, BROADCAST,
 * ADDRESS. Each asserts the action indexes valid. Balance movement is
 * cross-checked through the SDK explorer reads.
 *
 ********************************************************************/

const { expect } = require('chai');
const { makeSdk, submit, fundedSdkAddress, fundedGasAddress, mine, uniqueTick, submitOpts } = require('./sdkHelper');

function balanceFor(balances, tick) {
    let list = balances && (Array.isArray(balances) ? balances : balances.data);
    if (!Array.isArray(list)) return null;
    const row = list.find(b => (b.tick || b.TICK) === tick);
    return row ? Number(row.amount ?? row.quantity ?? row.balance) : null;
}

describe('[sdk] foundation actions', function () {
    this.timeout(0);

    let sdk, issuer, recipient, tick;

    before(async function () {
        sdk = makeSdk();
        issuer = await fundedGasAddress(sdk, 1);
        recipient = await fundedSdkAddress(sdk, 1);
        tick = uniqueTick();
        // Issue the working token: 1000 minted to issuer, headroom to MINT more.
        const res = await submit(sdk,
            { action: 'ISSUE', params: { tick, maxSupply: 1000000, maxMint: 100000, decimals: 0, description: 'foundation', mintSupply: 1000 } },
            { pubkey: issuer.address, change: issuer.address },
            submitOpts({ wif: issuer.wif })
        );
        expect(res.indexed.status, 'ISSUE status').to.equal('valid');
        console.log('    [sdk] issuer=' + issuer.address + ' tick=' + tick);
    });

    it('MINT adds supply to the issuer', async function () {
        const res = await submit(sdk,
            { action: 'MINT', params: { tick, amount: 500, destination: issuer.address } },
            { pubkey: issuer.address, change: issuer.address },
            submitOpts({ wif: issuer.wif })
        );
        expect(res.indexed.status).to.equal('valid');
    });

    it('SEND with a memo transfers to a recipient', async function () {
        const res = await submit(sdk,
            { action: 'SEND', params: { tick, amount: 100, destination: recipient.address, memo: 'sdk-foundation' } },
            { pubkey: issuer.address, change: issuer.address },
            submitOpts({ wif: issuer.wif })
        );
        expect(res.indexed.status).to.equal('valid');
    });

    it('DESTROY burns issuer balance', async function () {
        const res = await submit(sdk,
            { action: 'DESTROY', params: { tick, amount: 200, memo: 'burn' } },
            { pubkey: issuer.address, change: issuer.address },
            submitOpts({ wif: issuer.wif })
        );
        expect(res.indexed.status).to.equal('valid');
    });

    it('BROADCAST publishes a message', async function () {
        const res = await submit(sdk,
            { action: 'BROADCAST', params: { message: 'hello from the sdk harness', value: 0 } },
            { pubkey: issuer.address, change: issuer.address },
            submitOpts({ wif: issuer.wif })
        );
        expect(res.indexed.status).to.equal('valid');
    });

    it('ADDRESS sets address preferences', async function () {
        const res = await submit(sdk,
            { action: 'ADDRESS', params: { feePreference: 2, requireMemo: 1 } },
            { pubkey: issuer.address, change: issuer.address },
            submitOpts({ wif: issuer.wif })
        );
        expect(res.indexed.status).to.equal('valid');
    });

    it('issuer + recipient balances reflect MINT/SEND/DESTROY', async function () {
        await mine(1);
        const issuerBal = balanceFor(await sdk.getBalances(issuer.address), tick);
        const recipBal = balanceFor(await sdk.getBalances(recipient.address), tick);
        console.log('    [sdk] issuer ' + tick + '=' + issuerBal + ' recipient=' + recipBal);
        // 1000 minted + 500 MINT - 100 SEND - 200 DESTROY = 1200
        expect(issuerBal, 'issuer balance').to.equal(1200);
        expect(recipBal, 'recipient balance').to.equal(100);
    });
});
