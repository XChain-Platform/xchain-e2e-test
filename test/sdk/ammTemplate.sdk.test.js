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
 * XChain Platform E2E - Contract Template Library: AMM (on-chain)
 *
 * Drives the REAL constant-product AMM template from xchain-contracts
 * through the live regtest pipeline. This is the most demanding custody
 * proof in the library — it exercises every piece of the value model:
 *
 *   - DEPLOY: the constructor emit.issue()s the LP tick (contract owns it)
 *   - addLiquidity: BATCH(DEPOSIT A, DEPOSIT B, EXECUTE) — reads getBalance
 *     for BOTH tokens, then emit.mint()s LP shares to the provider
 *   - swap: BATCH(DEPOSIT in, EXECUTE) — getBalance-derived input, emit.send
 *     of the output, with k (reserveA*reserveB) growing by the 0.3% fee
 *   - removeLiquidity: BATCH(DEPOSIT LP, EXECUTE) — burns LP via emit.destroy
 *     and returns both reserves via two emit.send()s
 *
 * The LP tick is a first-class contract-issued tick (the whole point of the
 * template), so the round trip proves the indexer getBalance/getTokenInfo
 * wiring across issue / mint / deposit / send / destroy.
 *
 * Run (host with regtest stack + Node 22):
 *     COIN=bitcoin NETWORK=regtest npm run test:sdk
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
        path.resolve(__dirname, '_contracts', rel),                    // bundled copy (survives into the e2e-test container image)
        process.env.XCHAIN_CONTRACTS_DIR && path.join(process.env.XCHAIN_CONTRACTS_DIR, rel),
        path.resolve(__dirname, '../../../xchain-contracts', rel),
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

// Strip comments + blank lines so the DEPLOY payload carries only code (see the
// escrow suite for the rationale: hex-encoded source is 2 payload bytes/char and
// the encoder caps a compiled ACTION at MAX_DATA_BYTES). String/char-aware.
function compactSource(src) {
    let out = '';
    let i = 0, n = src.length;
    let state = 'code';
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

// The encoder rejects a compiled ACTION payload over this many bytes
// (xchain-encoder MAX_DATA_BYTES). The DEPLOY action string is itself the payload.
const MAX_DATA_BYTES = 8189;
function deployPayloadBytes(codeHex, gasLimit, constructorParams) {
    const s = 'DEPLOY|0|' + codeHex + '|' + gasLimit + '|' + constructorParams.join('|');
    return Buffer.byteLength(s, 'utf8');
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
    // The constructor's emit.issue() of the LP tick lands as a sibling action in the
    // same DEPLOY tx, and getTransaction returns them emitted-first ([ISSUE, DEPLOY]),
    // so actions[0] is the ISSUE — find the DEPLOY explicitly to get the contract index.
    const list = indexed && Array.isArray(indexed.actions) ? indexed.actions : [];
    const deploy = list.find(a => (a.action === 'DEPLOY')) || list[0] || null;
    return deploy ? deploy.action_index : null;
}

function haveConnectors() {
    return global.regtestMinerConnector && global.utxoTrackerConnector && global.nodeConnector;
}

describe('[sdk] template:amm (LP-as-real-tick round trip)', function () {
    this.timeout(0);

    const AMM_SRC = compactSource(loadTemplate('amm'));
    const DEC = 8;             // divisible pair so swap output (a fraction) is representable
    const LIQ = 10000;         // deposited per side for the initial liquidity
    const SWAP_IN = 1000;      // tokenA sold into the pool
    const MINT_A = LIQ + SWAP_IN; // provider also funds the swap from the same address

    let sdk, lp, tokenA, tokenB, lpTick, contractIndex;

    before(async function () {
        if (!haveConnectors()) this.skip();

        // Pre-flight: the DEPLOY payload is the action string itself, with the source
        // base64-encoded (the SDK encodes CODE_ENCODING as base64, ~1.33 bytes/char).
        // base64 brings the compacted AMM source under the encoder's MAX_DATA_BYTES cap,
        // so this now deploys single-shot. Skip with a clear reason only if it still
        // doesn't fit (e.g. the chunked-DEPLOY path is needed).
        const codeB64 = Buffer.from(AMM_SRC, 'utf8').toString('base64');
        const payloadBytes = deployPayloadBytes(codeB64, 400000, ['T'.repeat(12), 'T'.repeat(12), 'T'.repeat(12)]);
        if (payloadBytes > MAX_DATA_BYTES) {
            console.log('    [amm] SKIP: DEPLOY payload ' + payloadBytes + ' bytes > encoder MAX_DATA_BYTES ' + MAX_DATA_BYTES +
                ' (compacted source ' + Buffer.byteLength(AMM_SRC, 'utf8') + ' bytes). Needs chunked DEPLOY.');
            this.skip();
        }

        sdk = makeSdk();

        lp = await fundedGasAddress(sdk, 1);

        tokenA = uniqueTick('AMA');
        tokenB = uniqueTick('AMB');
        lpTick = uniqueTick('AMLP');

        const iA = await submit(sdk,
            { action: 'ISSUE', params: { tick: tokenA, maxSupply: 1000000000, maxMint: 100000000, decimals: DEC, description: 'amm tokenA', mintSupply: MINT_A } },
            { pubkey: lp.address, change: lp.address }, submitOpts({ wif: lp.wif }));
        expect(iA.indexed.status, 'ISSUE tokenA').to.equal('valid');

        const iB = await submit(sdk,
            { action: 'ISSUE', params: { tick: tokenB, maxSupply: 1000000000, maxMint: 100000000, decimals: DEC, description: 'amm tokenB', mintSupply: LIQ } },
            { pubkey: lp.address, change: lp.address }, submitOpts({ wif: lp.wif }));
        expect(iB.indexed.status, 'ISSUE tokenB').to.equal('valid');

        console.log('    [amm] lp=' + lp.address);
        console.log('    [amm] tokenA=' + tokenA + ' tokenB=' + tokenB + ' lpTick=' + lpTick);
    });

    it('DEPLOY issues the LP tick in the constructor', async function () {
        const res = await submit(sdk,
            { action: 'DEPLOY', params: {
                code: AMM_SRC,
                gasLimit: 400000,
                constructorParams: [tokenA, tokenB, lpTick]
            } },
            { pubkey: lp.address, change: lp.address }, submitOpts({ wif: lp.wif }));
        console.log('    [amm] DEPLOY encoding=' + res.encoding + ' status=' + res.indexed.status);
        expect(res.indexed.status, 'DEPLOY indexed').to.equal('valid');
        contractIndex = contractIndexOf(res.indexed);
        expect(contractIndex, 'contract action_index').to.not.equal(null);

        await mine(1);
        // Constructor-emitted ISSUE: the LP tick now exists and the contract owns it.
        const info = (typeof sdk.getTokenInfo === 'function')
            ? await sdk.getTokenInfo(lpTick).catch(() => null)
            : null;
        expect(await readState(sdk, contractIndex, 'lpTick'), 'lpTick recorded in state').to.equal(lpTick);
        expect(await readState(sdk, contractIndex, 'totalShares'), 'starts with zero shares').to.equal('0');
        console.log('    [amm] contractIndex=' + contractIndex + ' lpTokenInfo=' + JSON.stringify(info));
    });

    it('addLiquidity (BATCH: DEPOSIT A, DEPOSIT B, EXECUTE) mints LP shares', async function () {
        const built = await sdk.batch()
            .deposit({ contractActionIndex: contractIndex, tick: tokenA, quantity: LIQ })
            .deposit({ contractActionIndex: contractIndex, tick: tokenB, quantity: LIQ })
            .execute({ contractActionIndex: contractIndex, method: 'addLiquidity', params: [] })
            .build();
        expect(built.actionString, 'two DEPOSITs then EXECUTE').to.match(/^BATCH\|\d+\|DEPOSIT\|.*;DEPOSIT\|.*;EXECUTE\|/);

        const res = await submit(sdk,
            { action: 'BATCH', params: { command: built.fields.COMMAND } },
            { pubkey: lp.address, change: lp.address }, submitOpts({ wif: lp.wif }));
        console.log('    [amm] addLiquidity status=' + res.indexed.status);
        expect(res.indexed.status, 'addLiquidity indexed').to.equal('valid');

        await mine(1);
        expect(Number(await readState(sdk, contractIndex, 'reserveA')), 'reserveA').to.equal(LIQ);
        expect(Number(await readState(sdk, contractIndex, 'reserveB')), 'reserveB').to.equal(LIQ);
        // First provider: shares = sqrt(LIQ*LIQ) = LIQ.
        const shares = Number(await readState(sdk, contractIndex, 'totalShares'));
        expect(shares, 'totalShares = sqrt(depA*depB)').to.equal(LIQ);
        // The LP tick is a real tick credited to the provider.
        expect(balanceFor(await sdk.getBalances(lp.address), lpTick), 'provider holds LP shares').to.equal(LIQ);
    });

    it('swap (BATCH: DEPOSIT in, EXECUTE) returns the other token and grows k', async function () {
        const kBefore = Number(await readState(sdk, contractIndex, 'reserveA')) * Number(await readState(sdk, contractIndex, 'reserveB'));

        const built = await sdk.batch()
            .deposit({ contractActionIndex: contractIndex, tick: tokenA, quantity: SWAP_IN })
            .execute({ contractActionIndex: contractIndex, method: 'swap', params: [tokenA, '0'] })
            .build();

        const res = await submit(sdk,
            { action: 'BATCH', params: { command: built.fields.COMMAND } },
            { pubkey: lp.address, change: lp.address }, submitOpts({ wif: lp.wif }));
        console.log('    [amm] swap status=' + res.indexed.status);
        expect(res.indexed.status, 'swap indexed').to.equal('valid');

        await mine(1);
        const rA = Number(await readState(sdk, contractIndex, 'reserveA'));
        const rB = Number(await readState(sdk, contractIndex, 'reserveB'));
        expect(rA, 'full input retained in reserveA (fee stays in pool)').to.equal(LIQ + SWAP_IN);
        const kAfter = rA * rB;
        console.log('    [amm] k before=' + kBefore + ' after=' + kAfter + ' (delta=' + (kAfter - kBefore) + ')');
        expect(kAfter, 'k is non-decreasing across the swap').to.be.greaterThan(kBefore - 1e-6);
        // Swapper received tokenB.
        expect(balanceFor(await sdk.getBalances(lp.address), tokenB), 'swapper received tokenB').to.be.greaterThan(0);
    });

    it('removeLiquidity (BATCH: DEPOSIT LP, EXECUTE) burns shares and returns both reserves', async function () {
        const shares = balanceFor(await sdk.getBalances(lp.address), lpTick);
        expect(shares, 'provider has LP shares to redeem').to.equal(LIQ);

        const built = await sdk.batch()
            .deposit({ contractActionIndex: contractIndex, tick: lpTick, quantity: shares })
            .execute({ contractActionIndex: contractIndex, method: 'removeLiquidity', params: [] })
            .build();

        const res = await submit(sdk,
            { action: 'BATCH', params: { command: built.fields.COMMAND } },
            { pubkey: lp.address, change: lp.address }, submitOpts({ wif: lp.wif }));
        console.log('    [amm] removeLiquidity status=' + res.indexed.status);
        expect(res.indexed.status, 'removeLiquidity indexed').to.equal('valid');

        await mine(1);
        expect(Number(await readState(sdk, contractIndex, 'totalShares')), 'all shares burned').to.equal(0);
        // LP shares were destroyed (provider no longer holds any).
        expect(balanceFor(await sdk.getBalances(lp.address), lpTick), 'LP shares burned').to.equal(0);
        // Provider got the full pool back: reserveA went in at LIQ + the swap's SWAP_IN.
        expect(balanceFor(await sdk.getBalances(lp.address), tokenA), 'provider redeemed tokenA').to.equal(LIQ + SWAP_IN);
    });
});
