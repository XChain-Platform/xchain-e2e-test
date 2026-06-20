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
 * XChain Platform E2E - divisible-token amount precision (on-chain)
 *
 * XChain allows up to 18 decimals (MAX_DECIMALS). 18 significant digits exceed
 * what a JS double (parseFloat) can hold, and very small amounts round-trip
 * through doubles as scientific notation ("1e-18"). This suite issues an
 * 18-decimal token and sends full-precision amounts through the live pipeline
 * (SDK → encoder → decoder → indexer → explorer), asserting every balance is
 * EXACT: compared as decimal strings, never via Number() (which would itself
 * lose precision and mask a bug).
 *
 * Regression guard for the SDK setNumberFormats fix: previously the SDK ran
 * amounts through parseFloat, so "1.123456789012345678" was broadcast as
 * "1.1234567890123457" and "0.000000000000000001" as "1e-18", corrupting the
 * on-chain ACTION before it ever reached the (precision-correct) indexer.
 *
 *     COIN=bitcoin NETWORK=regtest npm run test:sdk
 *
 ********************************************************************/

'use strict';

const { expect } = require('chai');
const { makeSdk, submit, fundedGasAddress, uniqueTick, submitOpts } = require('./sdkHelper');

// Expand scientific notation to a plain fixed-decimal string, no floats.
// The explorer can return very small balances as e.g. "1e-18". The VALUE is
// correct, just formatted in scientific notation. "1e-18" -> "0.000000000000000001".
function sciToFixed(x) {
    const s = String(x).trim();
    const m = /^(-?)(\d+)(?:\.(\d+))?[eE]([+-]?\d+)$/.exec(s);
    if (!m) return s; // already plain decimal/integer
    const sign = m[1], digits = m[2] + (m[3] || ''), exp = parseInt(m[4], 10);
    const point = m[2].length + exp; // decimal-point index within `digits`
    let out;
    if (point <= 0)              out = '0.' + '0'.repeat(-point) + digits;
    else if (point >= digits.length) out = digits + '0'.repeat(point - digits.length);
    else                         out = digits.slice(0, point) + '.' + digits.slice(point);
    return sign + out;
}

// Normalise a decimal string for value-equality comparison without floats:
// expand any scientific notation, then trim trailing fractional zeros.
function normAmt(x) {
    let s = sciToFixed(x);
    if (s.indexOf('.') >= 0) {
        s = s.replace(/0+$/, '');
        if (s.endsWith('.')) s = s.slice(0, -1);
    }
    return s;
}

function rawBalance(balances, tick) {
    const list = balances && (Array.isArray(balances) ? balances : balances.data);
    if (!Array.isArray(list)) return null;
    const row = list.find((b) => (b.tick || b.TICK) === tick);
    if (!row) return null;
    return String(row.amount ?? row.quantity ?? row.balance);
}

function newRecipient(sdk) {
    const kp = sdk.generateKeyPair();
    return { ...kp, address: sdk.deriveAddress(kp.publicKey, { type: 'p2pkh' }) };
}

function haveConnectors() {
    return global.regtestMinerConnector && global.utxoTrackerConnector && global.nodeConnector;
}

describe('[sdk] divisible-token amount precision (18 decimals, on-chain)', function () {
    this.timeout(0);

    let sdk, issuer, tick;
    const MINT = '1000.123456789012345678';

    before(async function () {
        if (!haveConnectors()) this.skip();
        sdk = makeSdk();
        issuer = await fundedGasAddress(sdk, 1);
        tick = uniqueTick('DIV');
        const res = await submit(sdk,
            { action: 'ISSUE', params: { tick, maxSupply: '1000000', maxMint: '100000', decimals: 18, description: 'divisible', mintSupply: MINT } },
            { pubkey: issuer.address, change: issuer.address },
            submitOpts({ wif: issuer.wif }));
        expect(res.indexed.status, 'ISSUE(18-decimal) indexed').to.equal('valid');
        expect(normAmt(rawBalance(await sdk.getBalances(issuer.address), tick)), 'issuer holds exact mintSupply')
            .to.equal(normAmt(MINT));
    });

    it('a full-precision 18-decimal SEND lands exactly', async function () {
        const r1 = newRecipient(sdk);
        const SEND1 = '1.123456789012345678';
        const res = await submit(sdk,
            { action: 'SEND', params: { tick, amount: SEND1, destination: r1.address } },
            { pubkey: issuer.address, change: issuer.address },
            submitOpts({ wif: issuer.wif }));
        expect(res.indexed.status, 'SEND(18-dp) indexed').to.equal('valid');
        expect(normAmt(rawBalance(await sdk.getBalances(r1.address), tick)), 'r1 got exact 18-dp amount')
            .to.equal(normAmt(SEND1));
    });

    it('the smallest representable unit (1e-18) sends without scientific-notation corruption', async function () {
        const r2 = newRecipient(sdk);
        const SEND2 = '0.000000000000000001';
        const res = await submit(sdk,
            { action: 'SEND', params: { tick, amount: SEND2, destination: r2.address } },
            { pubkey: issuer.address, change: issuer.address },
            submitOpts({ wif: issuer.wif }));
        expect(res.indexed.status, 'SEND(1e-18) indexed').to.equal('valid');
        expect(normAmt(rawBalance(await sdk.getBalances(r2.address), tick)), 'r2 got the 1e-18 smallest unit')
            .to.equal(normAmt(SEND2));
    });
});
