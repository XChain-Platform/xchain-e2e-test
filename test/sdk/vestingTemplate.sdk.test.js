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
 * XChain Platform E2E - Contract Template Library: VESTING (on-chain)
 *
 * Drives the REAL vesting template through the live regtest pipeline:
 *
 *   1. DEPLOY vesting(grantor, beneficiary, tick, total, cliff, duration, revocable)
 *   2. BATCH( DEPOSIT(vesting, tick, total), EXECUTE(vesting, "fund") )
 *      fund() reads getBalance(self, tick) and starts the clock only if the
 *        deposited balance is visible (the getBalance-wiring proof).
 *   3. mine past `duration`, then the BENEFICIARY EXECUTEs claim() (the contract
 *      computes vested == total and emit.send()s the whole grant to them.
 *
 * Uses cliff=0 + a short duration and mines well past it, so the claim is fully
 * vested and the payout is exactly `total` (no fragile fractional-vesting timing).
 *
 * Run: COIN=bitcoin NETWORK=regtest npm run test:sdk
 *
 ********************************************************************/

'use strict';

const fs   = require('fs');
const path = require('path');
const { expect } = require('chai');
const { makeSdk, submit, fundedGasAddress, uniqueTick, mine, submitOpts } = require('./sdkHelper');

function loadTemplate(name) {
    const rel = path.join(name, name + '.js');
    const candidates = [
        path.resolve(__dirname, '_contracts', rel),
        process.env.XCHAIN_CONTRACTS_DIR && path.join(process.env.XCHAIN_CONTRACTS_DIR, rel),
        path.resolve(__dirname, '../../../xchain-contracts', rel),
        path.resolve(__dirname, '../../../../xchain-contracts', rel),
        process.env.HOME && path.join(process.env.HOME, 'xchain-modules-src/xchain-contracts', rel),
        process.env.HOME && path.join(process.env.HOME, 'Sites/XChain-Platform/xchain-contracts', rel),
    ].filter(Boolean);
    for (const c of candidates) {
        try { if (fs.existsSync(c)) return fs.readFileSync(c, 'utf8'); } catch (e) { /* keep trying */ }
    }
    throw new Error('Could not locate xchain-contracts/' + rel + '. Set XCHAIN_CONTRACTS_DIR.');
}

// Comment/whitespace strip (string-aware) so the DEPLOY payload fits the encoder
// MAX_DATA_BYTES cap (hex-encoded source is 2 bytes/char). See the escrow suite.
function compactSource(src) {
    let out = '', i = 0, n = src.length, state = 'code';
    while (i < n) {
        const c = src[i], d = src[i + 1];
        if (state === 'code') {
            if (c === '/' && d === '/') { state = 'line'; i += 2; continue; }
            if (c === '/' && d === '*') { state = 'block'; i += 2; continue; }
            if (c === "'") { state = 'sq'; out += c; i++; continue; }
            if (c === '"') { state = 'dq'; out += c; i++; continue; }
            if (c === '`') { state = 'tpl'; out += c; i++; continue; }
            out += c; i++; continue;
        }
        if (state === 'line') { if (c === '\n') { state = 'code'; out += c; } i++; continue; }
        if (state === 'block') { if (c === '*' && d === '/') { state = 'code'; i += 2; } else i++; continue; }
        if (c === '\\') { out += c + (d || ''); i += 2; continue; }
        if ((state === 'sq' && c === "'") || (state === 'dq' && c === '"') || (state === 'tpl' && c === '`')) state = 'code';
        out += c; i++;
    }
    return out.split('\n').map(l => l.replace(/^\s+/, '').replace(/\s+$/, '')).filter(l => l.length > 0).join('\n');
}

function balanceFor(balances, tick) {
    const list = balances && (Array.isArray(balances) ? balances : balances.data);
    if (!Array.isArray(list)) return 0;
    const row = list.find((b) => (b.tick || b.TICK) === tick);
    return row ? Number(row.amount ?? row.quantity ?? row.balance) : 0;
}

async function readState(sdk, contractIndex, key) {
    const state = await sdk.getContractState(contractIndex, key);
    const rows = (state && state.data) || [];
    const row = rows.find(r => r.state_key === key);
    return row ? JSON.parse(row.state_value) : undefined;
}

function contractIndexOf(indexed) {
    const list = indexed && Array.isArray(indexed.actions) ? indexed.actions : [];
    const deploy = list.find(a => (a.action === 'DEPLOY')) || list[0] || null;
    return deploy ? deploy.action_index : null;
}

function newAddress(sdk) {
    const kp = sdk.generateKeyPair();
    return { ...kp, address: sdk.deriveAddress(kp.publicKey, { type: 'p2pkh' }) };
}

function haveConnectors() {
    return global.regtestMinerConnector && global.utxoTrackerConnector && global.nodeConnector;
}

describe('[sdk] template:vesting (on-chain custody)', function () {
    this.timeout(0);

    let VESTING_SRC;              // loaded in before() so a missing xchain-contracts skips this suite instead of aborting the whole run
    const TOTAL = 1000;
    const CLIFF = 0;
    const DURATION = 5;   // blocks; we mine well past this so the claim is fully vested

    let sdk, grantor, beneficiary, tick, contractIndex;

    before(async function () {
        if (!haveConnectors()) this.skip();
        // Load lazily so a missing xchain-contracts checkout skips this suite
        // instead of aborting the whole run.
        try {
            VESTING_SRC = compactSource(loadTemplate('vesting'));
        } catch (e) {
            console.log('    [vesting] SKIP: ' + e.message.split('\n')[0]);
            this.skip();
        }
        sdk = makeSdk();

        grantor = await fundedGasAddress(sdk, 1);          // deploys + funds the grant
        beneficiary = await fundedGasAddress(sdk, 1);      // submits claim() (must be the caller)

        tick = uniqueTick('VST');
        const issue = await submit(sdk,
            { action: 'ISSUE', params: { tick, maxSupply: 1000000, maxMint: 100000, decimals: 0, description: 'vesting asset', mintSupply: TOTAL } },
            { pubkey: grantor.address, change: grantor.address }, submitOpts({ wif: grantor.wif }));
        expect(issue.indexed.status, 'ISSUE indexed').to.equal('valid');

        console.log('    [vesting] grantor=' + grantor.address + ' beneficiary=' + beneficiary.address);
        console.log('    [vesting] tick=' + tick + ' total=' + TOTAL + ' cliff=' + CLIFF + ' duration=' + DURATION);
    });

    it('DEPLOY vesting with the grant terms', async function () {
        const res = await submit(sdk,
            { action: 'DEPLOY', params: {
                code: VESTING_SRC,
                gasLimit: 400000,
                constructorParams: [grantor.address, beneficiary.address, tick, String(TOTAL), String(CLIFF), String(DURATION), 'false']
            } },
            { pubkey: grantor.address, change: grantor.address }, submitOpts({ wif: grantor.wif }));
        console.log('    [vesting] DEPLOY encoding=' + res.encoding + ' status=' + res.indexed.status);
        expect(res.indexed.status, 'DEPLOY indexed').to.equal('valid');
        contractIndex = contractIndexOf(res.indexed);
        expect(contractIndex, 'contract action_index').to.not.equal(null);

        await mine(1);
        expect(await readState(sdk, contractIndex, 'status'), 'initial status').to.equal('INIT');
        expect(await readState(sdk, contractIndex, 'total'), 'total recorded').to.equal(String(TOTAL));
        console.log('    [vesting] contractIndex=' + contractIndex);
    });

    it('BATCH(DEPOSIT, EXECUTE fund) starts the clock via getBalance', async function () {
        const built = await sdk.batch()
            .deposit({ contractActionIndex: contractIndex, tick, quantity: TOTAL })
            .execute({ contractActionIndex: contractIndex, method: 'fund', params: [] })
            .build();
        expect(built.actionString, 'DEPOSIT then EXECUTE').to.match(/^BATCH\|\d+\|DEPOSIT\|.*;EXECUTE\|/);

        const res = await submit(sdk,
            { action: 'BATCH', params: { command: built.fields.COMMAND } },
            { pubkey: grantor.address, change: grantor.address }, submitOpts({ wif: grantor.wif }));
        console.log('    [vesting] fund BATCH status=' + res.indexed.status);
        expect(res.indexed.status, 'fund BATCH indexed').to.equal('valid');

        await mine(1);
        expect(await readState(sdk, contractIndex, 'status'), 'status after fund').to.equal('ACTIVE');
        // Grantor moved the whole grant into the contract.
        expect(balanceFor(await sdk.getBalances(grantor.address), tick), 'grantor debited the grant').to.equal(0);
    });

    it('beneficiary claims the fully-vested grant after duration', async function () {
        // Advance well past `duration` so vested == total (deterministic payout).
        await mine(DURATION + 3);

        const res = await submit(sdk,
            { action: 'EXECUTE', params: { contractActionIndex: contractIndex, method: 'claim', params: [] } },
            { pubkey: beneficiary.address, change: beneficiary.address }, submitOpts({ wif: beneficiary.wif }));
        console.log('    [vesting] claim status=' + res.indexed.status);
        expect(res.indexed.status, 'claim indexed').to.equal('valid');

        await mine(1);
        // Fully vested: beneficiary received the entire grant, and the contract
        // recorded the full amount as claimed.
        expect(balanceFor(await sdk.getBalances(beneficiary.address), tick), 'beneficiary received the full grant').to.equal(TOTAL);
        expect(await readState(sdk, contractIndex, 'claimed'), 'claimed == total').to.equal(String(TOTAL));
    });
});
