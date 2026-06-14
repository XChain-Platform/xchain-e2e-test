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
 * XChain Platform E2E - Contract Template Library: ESCROW (on-chain)
 *
 * Drives the REAL escrow template from the xchain-contracts repo through
 * the live regtest pipeline (encoder → decoder → indexer VM), exercising
 * the value-custody model end-to-end:
 *
 *   1. DEPLOY escrow(buyer, seller, arbiter, tick, amount, deadline)
 *   2. BATCH( DEPOSIT(escrow, tick, amount), EXECUTE(escrow, "fund") )
 *      — fund() reads getBalance(self, tick) and arms the escrow ONLY if
 *        the just-deposited balance is visible. This is the proof that the
 *        indexer's getBalance/getTokenInfo wiring works in production shape.
 *   3. EXECUTE(escrow, "release") — settles the full held balance to the
 *      seller via emit.send.
 *
 * Run (on a host with the regtest stack + Node 22):
 *     COIN=bitcoin NETWORK=regtest npm run test:sdk
 *
 ********************************************************************/

'use strict';

const fs   = require('fs');
const path = require('path');
const { expect } = require('chai');
const { makeSdk, submit, fundedGasAddress, mintGas, uniqueTick, mine, submitOpts } = require('./sdkHelper');

// Load a template's REAL source from the xchain-contracts repo. That repo is
// a sibling of the platform monorepo (and, on test-host, a separate tree under
// ~/xchain-modules-src), so resolve it the way sdkHelper resolves the SDK:
// an explicit env override first, then layout-based candidates.
function loadTemplate(name) {
    const rel = path.join(name, name + '.js');
    const candidates = [
        path.resolve(__dirname, '_contracts', rel),                    // bundled copy (survives into the e2e-test container image)
        process.env.XCHAIN_CONTRACTS_DIR && path.join(process.env.XCHAIN_CONTRACTS_DIR, rel),
        path.resolve(__dirname, '../../../xchain-contracts', rel),     // platform/xchain-e2e-test/test/sdk -> platform/xchain-contracts
        path.resolve(__dirname, '../../../../xchain-contracts', rel),
        process.env.HOME && path.join(process.env.HOME, 'xchain-modules-src/xchain-contracts', rel),
        process.env.HOME && path.join(process.env.HOME, 'Sites/XChain-Platform/xchain-contracts', rel),
    ].filter(Boolean);
    for (const c of candidates) {
        try { if (fs.existsSync(c)) return fs.readFileSync(c, 'utf8'); } catch (e) { /* keep trying */ }
    }
    throw new Error('Could not locate xchain-contracts/' + rel +
        '. Set XCHAIN_CONTRACTS_DIR to the xchain-contracts checkout. Tried:\n  ' + candidates.join('\n  '));
}

function balanceFor(balances, tick) {
    const list = balances && (Array.isArray(balances) ? balances : balances.data);
    if (!Array.isArray(list)) return 0;
    const row = list.find((b) => (b.tick || b.TICK) === tick);
    return row ? Number(row.amount ?? row.quantity ?? row.balance) : 0;
}

// Contract custody balance via the explorer's /contract/:i/balance/:tick.
// Tolerant of the response shape (single row, {data:[...]}, or bare number).
async function contractBalance(sdk, contractIndex, tick) {
    const res = await sdk.getContractBalance(contractIndex, tick);
    if (res == null) return 0;
    if (typeof res === 'number' || typeof res === 'string') return Number(res);
    if (Array.isArray(res) || Array.isArray(res.data)) return balanceFor(res, tick);
    return Number(res.amount ?? res.quantity ?? res.balance ?? 0);
}

async function readState(sdk, contractIndex, key) {
    const state = await sdk.getContractState(contractIndex, key);
    const rows = (state && state.data) || [];
    const row = rows.find(r => r.state_key === key);
    return row ? JSON.parse(row.state_value) : undefined;
}

function contractIndexOf(indexed) {
    const a = indexed && Array.isArray(indexed.actions) ? indexed.actions[0] : null;
    return a ? a.action_index : null;
}

function newAddress(sdk) {
    const kp = sdk.generateKeyPair();
    return { ...kp, address: sdk.deriveAddress(kp.publicKey, { type: 'p2pkh' }) };
}

function haveConnectors() {
    return global.regtestMinerConnector && global.utxoTrackerConnector && global.nodeConnector;
}

describe('[sdk] template:escrow (on-chain custody)', function () {
    this.timeout(0);

    const ESCROW_SRC = loadTemplate('escrow');
    const AMOUNT = 1000;          // escrowed quantity (decimals 0 token)
    const DEADLINE_BLOCKS = 100;  // far enough out that timeout() is irrelevant here

    let sdk, buyer, seller, arbiter, tick, contractIndex, contractAddr;

    before(async function () {
        if (!haveConnectors()) this.skip();
        sdk = makeSdk();

        // Buyer deploys, funds, and releases — needs native coin + gas.
        buyer = await fundedGasAddress(sdk, 1);
        // Seller + arbiter only need to exist on-chain as destinations / roles.
        seller  = newAddress(sdk);
        arbiter = newAddress(sdk);

        // Buyer issues the escrowed token and mints itself the full amount.
        tick = uniqueTick('ESC');
        const issue = await submit(sdk,
            { action: 'ISSUE', params: { tick, maxSupply: 1000000, maxMint: 100000, decimals: 0, description: 'escrow asset', mintSupply: AMOUNT } },
            { pubkey: buyer.address, change: buyer.address },
            submitOpts({ wif: buyer.wif }));
        expect(issue.indexed.status, 'ISSUE indexed').to.equal('valid');
        expect(balanceFor(await sdk.getBalances(buyer.address), tick), 'buyer holds the minted supply').to.equal(AMOUNT);

        console.log('    [escrow] buyer=' + buyer.address);
        console.log('    [escrow] seller=' + seller.address + ' arbiter=' + arbiter.address);
        console.log('    [escrow] tick=' + tick + ' amount=' + AMOUNT);
    });

    it('DEPLOY escrow with the contract terms', async function () {
        const res = await submit(sdk,
            { action: 'DEPLOY', params: {
                code: ESCROW_SRC,
                gasLimit: 300000,
                constructorParams: [buyer.address, seller.address, arbiter.address, tick, String(AMOUNT), String(DEADLINE_BLOCKS)]
            } },
            { pubkey: buyer.address, change: buyer.address },
            submitOpts({ wif: buyer.wif }));
        console.log('    [escrow] DEPLOY encoding=' + res.encoding + ' status=' + res.indexed.status);
        expect(res.indexed.status, 'DEPLOY indexed').to.equal('valid');
        contractIndex = contractIndexOf(res.indexed);
        expect(contractIndex, 'contract action_index').to.not.equal(null);

        // The contract's derived custody address (C:<CHAIN>:<index>), for logging.
        try {
            const info = await sdk.getContract(contractIndex);
            contractAddr = (info && (info.address || (info.data && info.data.address))) || null;
        } catch (e) { /* address is informational only */ }
        expect(await readState(sdk, contractIndex, 'status'), 'initial status').to.equal('INIT');
        console.log('    [escrow] contractIndex=' + contractIndex + ' address=' + contractAddr);
    });

    it('BATCH(DEPOSIT, EXECUTE fund) arms the escrow via getBalance', async function () {
        // The whole point: fund() calls getBalance(self, tick) and reverts unless
        // the same-BATCH deposit is visible. A "valid" index here == the wiring works.
        const built = await sdk.batch()
            .deposit({ contractActionIndex: contractIndex, tick, quantity: AMOUNT })
            .execute({ contractActionIndex: contractIndex, method: 'fund', params: [] })
            .build();
        expect(built.action, 'built a BATCH').to.equal('BATCH');
        expect(built.actionString, 'DEPOSIT then EXECUTE').to.match(/^BATCH\|\d+\|DEPOSIT\|.*;EXECUTE\|/);

        const res = await submit(sdk,
            { action: 'BATCH', params: { command: built.fields.COMMAND } },
            { pubkey: buyer.address, change: buyer.address },
            submitOpts({ wif: buyer.wif }));
        console.log('    [escrow] fund BATCH status=' + res.indexed.status);
        expect(res.indexed.status, 'fund BATCH indexed').to.equal('valid');

        await mine(1);
        expect(await readState(sdk, contractIndex, 'status'), 'status after fund').to.equal('FUNDED');
        expect(await contractBalance(sdk, contractIndex, tick), 'escrow custodies the deposit').to.equal(AMOUNT);
        // Buyer spent the whole balance into the escrow.
        expect(balanceFor(await sdk.getBalances(buyer.address), tick), 'buyer debited the deposit').to.equal(0);
    });

    it('EXECUTE release pays the seller the full held balance', async function () {
        const res = await submit(sdk,
            { action: 'EXECUTE', params: { contractActionIndex: contractIndex, method: 'release', params: [] } },
            { pubkey: buyer.address, change: buyer.address },
            submitOpts({ wif: buyer.wif }));
        console.log('    [escrow] release status=' + res.indexed.status);
        expect(res.indexed.status, 'release indexed').to.equal('valid');

        await mine(1);
        expect(await readState(sdk, contractIndex, 'status'), 'status after release').to.equal('RELEASED');
        expect(balanceFor(await sdk.getBalances(seller.address), tick), 'seller received the escrow').to.equal(AMOUNT);
        expect(await contractBalance(sdk, contractIndex, tick), 'escrow drained to zero').to.equal(0);
    });
});
