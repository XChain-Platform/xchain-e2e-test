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
 * XCALL e2e — stake additional federation validators (standalone driver).
 *
 * For each Ed25519 pubkey passed as an argv, funds a FRESH address and
 * STAKEs 5000 XCHAIN for the cross_chain capability with that pubkey
 * (signingPubkey is 1:1 with the staking address, so each validator gets
 * its own funder). Mines past ACTIVATION_DELAY_BLOCKS at the end.
 *
 * Runs under the BTC regtest e2e env as a one-shot mocha spec (the sdk
 * helpers need the initialCheck bootstrap):
 *
 *   XCALL_STAKE_PUBKEYS=<hex>,<hex> npx mocha --timeout 0 --exit \
 *     --require ./test/initialCheck.test.js test/sdk/xcallStakeValidators.js
 *
 ********************************************************************/

const { makeSdk, submit, fundedGasAddress, mine, submitOpts } = require('./sdkHelper');

describe('[sdk] stake additional XCALL federation validators', function () {
    this.timeout(0);

    it('stakes every pubkey in XCALL_STAKE_PUBKEYS', async function () {
        const pubkeys = String(process.env.XCALL_STAKE_PUBKEYS || '').split(',').map(s => s.trim()).filter(Boolean);
        if (!pubkeys.length || pubkeys.some(p => !/^[0-9a-f]{64}$/.test(p)))
            throw new Error('XCALL_STAKE_PUBKEYS must be a comma-separated list of 64-hex pubkeys');

        const sdk = makeSdk();
        for (const pubkey of pubkeys) {
            const staker = await fundedGasAddress(sdk, 1);
            try {
                const res = await submit(sdk,
                    { action: 'STAKE', params: { amount: '5000.00000000', signingPubkey: pubkey } },
                    { pubkey: staker.address, change: staker.address },
                    submitOpts({ wif: staker.wif })
                );
                if (res.indexed.status !== 'valid') throw new Error('STAKE indexed ' + res.indexed.status);
                console.log('    [stake-validators] ' + pubkey.substring(0, 16) + '... staked by ' + staker.address);
            } catch (e) {
                if (/SIGNING_PUBKEY \(already in use\)/.test(String(e.message))) {
                    console.log('    [stake-validators] ' + pubkey.substring(0, 16) + '... already staked — skipping');
                } else {
                    throw e;
                }
            }
        }
        await mine(8); // past ACTIVATION_DELAY_BLOCKS (6)
        console.log('    [stake-validators] done (' + pubkeys.length + ' pubkeys, activation mined)');
    });
});
