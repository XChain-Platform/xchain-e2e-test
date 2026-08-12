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
 * XChain Platform E2E - ticker NAME vs TICK_ID (^id) equivalence
 *
 * Proves end-to-end, through the full stack (encoder -> broadcast ->
 * decoder -> indexer -> explorer), that referencing a token by its full
 * name and by its numeric id with a caret prefix (^1234) are interchangeable
 * and produce identical on-chain state:
 *
 *   ISSUE (by name, defines the token)
 *   -> SEND by NAME   to recipient A
 *   -> SEND by ^id    to recipient B
 *   -> assert A and B hold identical balances of the same token
 *   -> MINT by ^id    (id form works for minting too)
 *   -> explorer serves the token by ^id (read-side symmetry)
 *
 * Compaction is turned OFF on this SDK instance so the reference form we
 * pass is exactly what lands on-chain: a name-send genuinely carries the
 * name and an id-send genuinely carries the ^id (otherwise default
 * compaction would rewrite the name to ^id and we'd test ^id twice).
 *
 ********************************************************************/

const { expect } = require('chai');
const { makeSdk, submit, fundedSdkAddress, fundedGasAddress, mine, uniqueTick, submitOpts } = require('./sdkHelper');

function balanceFor(balances, tick) {
    if (!balances) return null;
    let list = Array.isArray(balances) ? balances
        : Array.isArray(balances.data) ? balances.data
        : Array.isArray(balances.balances) ? balances.balances
        : null;
    if (!list) return null;
    const row = list.find(b => (b.tick || b.TICK || b.ticker) === tick);
    if (!row) return null;
    return Number(row.quantity ?? row.amount ?? row.balance ?? row.value);
}

describe('[sdk] ticker NAME vs TICK_ID (^id) equivalence', function () {
    this.timeout(0);

    let sdk, issuer, recipName, recipId, tick, tickId;

    before(async function () {
        // compactTickers:false => the reference form we pass is the form emitted.
        sdk = makeSdk({ compactTickers: false });
        issuer = await fundedGasAddress(sdk, 1);
        tick = uniqueTick();
        console.log('    [sdk] issuer=' + issuer.address + ' tick=' + tick);
    });

    it('ISSUE creates the token (defined by name)', async function () {
        const res = await submit(sdk,
            {
                action: 'ISSUE',
                params: {
                    tick,
                    maxSupply:   1000000000,
                    maxMint:     1000000,
                    decimals:    0,
                    description: 'ticker-id equivalence token',
                    mintSupply:  1000000,
                },
            },
            { pubkey: issuer.address, change: issuer.address },
            submitOpts({ wif: issuer.wif })
        );
        expect(res.indexed, 'indexed action').to.be.an('object');
        expect(res.indexed.status).to.equal('valid');
    });

    it('resolves the immutable tick_id and the explorer serves the token by ^id', async function () {
        await mine(1);
        const byName = await sdk.getToken(tick);
        tickId = byName.info.tick_id;
        console.log('    [sdk] ' + tick + ' => tick_id ' + tickId);
        expect(tickId, 'tick_id').to.be.a('number');

        // Read-side symmetry: looking the token up by ^id returns the same token.
        const byId = await sdk.getToken('^' + tickId);
        expect(byId.info.tick).to.equal(tick);
    });

    it('SEND by NAME credits recipient A', async function () {
        recipName = await fundedSdkAddress(sdk, 1);
        const res = await submit(sdk,
            { action: 'SEND', params: { tick, amount: 1000, destination: recipName.address } },
            { pubkey: issuer.address, change: issuer.address },
            submitOpts({ wif: issuer.wif })
        );
        expect(res.indexed.status).to.equal('valid');
        // The on-chain action genuinely carried the NAME.
        expect(res.actionString).to.include('|' + tick + '|');
    });

    it('SEND by ^id credits recipient B', async function () {
        recipId = await fundedSdkAddress(sdk, 1);
        const res = await submit(sdk,
            { action: 'SEND', params: { tick: '^' + tickId, amount: 1000, destination: recipId.address } },
            { pubkey: issuer.address, change: issuer.address },
            submitOpts({ wif: issuer.wif })
        );
        expect(res.indexed.status).to.equal('valid');
        // The on-chain action genuinely carried the ^id (not the name).
        expect(res.actionString).to.include('|^' + tickId + '|');
    });

    it('both recipients hold identical balances of the same token', async function () {
        await mine(1);
        const a = balanceFor(await sdk.getBalances(recipName.address), tick);
        const b = balanceFor(await sdk.getBalances(recipId.address), tick);
        console.log('    [sdk] name-send balance=' + a + '  id-send balance=' + b);
        expect(a, 'name-send recipient balance').to.equal(1000);
        expect(b, 'id-send recipient balance').to.equal(1000);
        expect(a).to.equal(b);
    });

    it('MINT by ^id is valid (id form works for minting too)', async function () {
        const res = await submit(sdk,
            { action: 'MINT', params: { tick: '^' + tickId, amount: 500, destination: issuer.address } },
            { pubkey: issuer.address, change: issuer.address },
            submitOpts({ wif: issuer.wif })
        );
        expect(res.indexed.status).to.equal('valid');
        expect(res.actionString).to.include('|^' + tickId + '|');
    });
});
