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
 * XChain Platform E2E - SDK-driven encoding-method coverage
 *
 * Most ACTIONs exceed OP_RETURN's 76-byte limit and must ride a
 * larger encoding. P2SH / P2WSH are TWO-transaction patterns: the
 * SDK's LifecycleManager must build+sign+broadcast a funding tx, then
 * build+sign+broadcast a phase-2 reveal that spends it. This suite
 * forces each encoding through sdk.submitAction() so that two-phase
 * orchestration is exercised end-to-end (it has no other live-stack
 * coverage — the connector suites do the two-phase dance by hand).
 *
 ********************************************************************/

const { expect } = require('chai');
const { makeSdk, submit, fundedGasAddress, uniqueTick, submitOpts } = require('./sdkHelper');

// OP_RETURN + P2SH + P2WSH pass end-to-end through the SDK.
// PENDING (documented open bug — un-skip when fixed):
//   - MULTISIGN: encoder rejects the fake-pubkey outputs as "dust".
const ENCODINGS = ['OP_RETURN', 'MULTISIGN', 'P2SH', 'P2WSH'];
const PENDING_ENCODINGS = [];

describe('[sdk] encoding methods via submitAction', function () {
    this.timeout(0);

    let sdk, issuer;

    before(async function () {
        sdk = makeSdk();
        issuer = await fundedGasAddress(sdk, 1);
        console.log('    [sdk] issuer=' + issuer.address);
    });

    for (const encoding of ENCODINGS) {
        it('issues a token with ' + encoding + ' encoding', async function () {
            const tick = uniqueTick();
            const encoderOpts = { pubkey: issuer.address, change: issuer.address, encoding };
            // MULTISIGN requires the compressed pubkey to build the fake-pubkey chunks.
            if (encoding === 'MULTISIGN') encoderOpts.compressedPubKey = issuer.publicKeyHex;

            const res = await submit(sdk,
                {
                    action: 'ISSUE',
                    params: {
                        tick,
                        maxSupply:   1000000,
                        maxMint:     1000,
                        decimals:    0,
                        description: 'enc ' + encoding,
                        mintSupply:  1000,
                    },
                },
                encoderOpts,
                submitOpts({ wif: issuer.wif })
            );

            console.log('    [sdk] ' + encoding + ' -> encoding=' + res.encoding + ' txid=' + res.txid);
            expect(res.txid, 'txid').to.be.a('string');
            expect(res.encoding, 'chosen encoding').to.equal(encoding);
            expect(res.indexed, 'indexed action').to.be.an('object');
            expect(res.indexed.status).to.equal('valid');
        });
    }

    for (const encoding of PENDING_ENCODINGS) {
        it.skip('issues a token with ' + encoding + ' encoding (open bug — see header)', function () {});
    }
});
