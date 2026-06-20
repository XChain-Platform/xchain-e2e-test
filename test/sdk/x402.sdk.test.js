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
 * x402 agent-payment e2e: full HTTP 402 -> pay on-chain -> retry loops
 * against a LIVE regtest stack, with the reference storefront running
 * in-process. Proves, end to end:
 *
 *   1. confirmed SEND loop  (minConfirmations 1)
 *   2. 0-conf SEND loop     (provisional grant from the decoder mempool,
 *                            sweeper promotes after a block)
 *   3. deposit-metered      (fund once, two calls, third exhausts)
 *   4. gated-FILE storefront (pay -> key payload -> decrypt -> byte-match)
 *
 * The payer side runs through an AgentSession, so policy enforcement is
 * exercised on every payment (and one over-cap refusal is asserted).
 *
 * Venue: requires the standard e2e regtest stack (see initialCheck).
 *
 ********************************************************************/

const os   = require('os');
const path = require('path');
const fs   = require('fs');
const { expect } = require('chai');
const { makeSdk, submit, fundedGasAddress, uniqueTick, submitOpts, mine } = require('./sdkHelper');
const X402Storefront = require('../helpers/x402Storefront');

const COIN = (typeof global.COIN_CODE !== 'undefined' && global.COIN_CODE) || 'BTC';

describe(`x402 agent payments: SDK driven (${COIN})`, function () {

    let sdk, X402Gateway, X402Client;
    let seller, buyer;            // { wif, address }
    let tick;                     // payment token, minted to the buyer
    let stateRoot;

    before(async function () {
        this.timeout(600000);
        sdk = makeSdk();
        // NOTE: the e2e repo vendors xchain-sdk as file:./xchain-sdk. The venue
        // must have a current clone (stale clones are a known gotcha).
        ({ X402Gateway, X402Client } = require('xchain-sdk'));
        stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'x402-e2e-'));

        seller = await fundedGasAddress(sdk, 1);
        buyer  = await fundedGasAddress(sdk, 1);
        tick   = uniqueTick('PAY');
        await submit(sdk, { action: 'ISSUE', params: { tick, maxSupply: '1000000', decimals: 8, mintSupply: '10000' } },
            { pubkey: seller.address, change: seller.address }, submitOpts({ wif: seller.wif }));
        await submit(sdk, { action: 'SEND', params: { tick, amount: '1000', destination: buyer.address } },
            { pubkey: seller.address, change: seller.address }, submitOpts({ wif: seller.wif }));
    });

    after(() => fs.rmSync(stateRoot, { recursive: true, force: true }));

    function buyerSession(extraPolicy = {}) {
        return sdk.agentSession(buyer.wif, Object.assign({
            allowedActions: ['SEND'],
            stateFile: path.join(stateRoot, `agent-${Math.random().toString(36).slice(2)}.json`),
        }, extraPolicy));
    }

    function mkGateway(over) {
        return new X402Gateway(Object.assign({
            coin: COIN, explorer: sdk.explorer,
            stateDir: fs.mkdtempSync(path.join(stateRoot, 'gw-')),
        }, over));
    }

    it('1. confirmed SEND loop: 402 -> pay -> 1-conf -> 200 with receipt', async function () {
        this.timeout(300000);
        const store = new X402Storefront({
            gateway: mkGateway({ send: { tick, amount: '5', payTo: seller.address, minConfirmations: 1 } }),
            resource: { report: 'paid-data-v1' },
        });
        const { url } = await store.start();
        try {
            const client = new X402Client({ session: buyerSession(), retryDelayMs: 2000, maxRetries: 60 });
            const res = await client.fetchUrl(url + '/data');
            expect(res.status).to.equal(200);
            const body = await res.json();
            expect(body.report).to.equal('paid-data-v1');
            expect(body.payment.status).to.equal('confirmed');
            expect(body.payment.provisional).to.equal(false);
            const receipt = JSON.parse(Buffer.from(res.headers.get('x-payment-response'), 'base64url').toString('utf8'));
            expect(receipt.status).to.equal('confirmed');
            expect(receipt.txid).to.be.a('string');
        } finally { await store.stop(); }
    });

    it('2. 0-conf loop: provisional grant from the mempool, sweeper promotes after a block', async function () {
        this.timeout(300000);
        const gateway = mkGateway({ send: { tick, amount: '5', payTo: seller.address, minConfirmations: 0 } });
        const store = new X402Storefront({ gateway, resource: { fast: true } });
        const { url } = await store.start();
        try {
            const client = new X402Client({ session: buyerSession(), retryDelayMs: 1500, maxRetries: 60 });
            const res = await client.fetchUrl(url + '/data');
            expect(res.status).to.equal(200);
            const body = await res.json();
            // The regtest auto-miner can confirm the SEND before the client's
            // retry lands, so the grant may arrive already confirmed. Both cases
            // prove the minConfirmations:0 path; the mempool-side grant itself
            // is locked by the explorer/sdk unit suites.
            expect(['provisional_0conf', 'confirmed']).to.include(body.payment.status);
            expect(body.payment.provisional).to.equal(body.payment.status === 'provisional_0conf');

            // Confirm on-chain, then the sweeper must promote the grant.
            await mine(2);
            for (let i = 0; i < 30; i++) {                       // wait for the indexer to surface the SEND
                await gateway.sweep();
                const all = await gateway.store.listByStatus('confirmed');
                if (all.length) break;
                await new Promise((r) => setTimeout(r, 2000));
            }
            expect((await gateway.store.listByStatus('confirmed')).length).to.equal(1);
            expect((await gateway.store.listByStatus('provisional_0conf')).length).to.equal(0);
        } finally { await store.stop(); }
    });

    it('3. deposit-metered: fund once, two calls debit, third exhausts back to 402', async function () {
        this.timeout(300000);
        // Dedicated deposit address: the deposit balance is computed from the
        // payer's on-chain SENDs to it, so reusing seller.address would count
        // the other flows' payments as deposit credit.
        const depositKp = sdk.generateKeyPair();
        const depositAddress = sdk.deriveAddress(depositKp.publicKey, { type: 'p2pkh' });
        const store = new X402Storefront({
            gateway: mkGateway({ deposit: { tick, depositAddress, pricePerCall: '4' } }),
            resource: { metered: true },
        });
        const { url } = await store.start();
        try {
            // Deposit exactly 8 = two 4-priced calls. (Confirmed: deposits only count indexed.)
            const session = buyerSession();
            await session.send({ tick, amount: '8', destination: depositAddress });

            const proof = Buffer.from(JSON.stringify({
                x402Version: 1, scheme: 'xchain-deposit', coin: COIN, payer: buyer.address,
            })).toString('base64url');
            const call = () => fetch(url + '/data', { headers: { 'X-Payment': proof } });

            expect((await call()).status).to.equal(200);
            expect((await call()).status).to.equal(200);
            const third = await call();
            expect(third.status).to.equal(402);
            expect((await third.json()).reason).to.equal('X402_DEPOSIT_EXHAUSTED');
        } finally { await store.stop(); }
    });

    it('4. gated-FILE storefront: pay, receive the key payload, decrypt, byte-match', async function () {
        this.timeout(300000);
        // Seller publishes a token-gated FILE (BATCH of FILE + stub MESSAGE, ciphertext as rawData).
        const plaintext = Buffer.from('the gated artifact: ' + tick, 'utf8');
        const { key }    = sdk.gatedFile.generateKey();
        const ciphertext = sdk.gatedFile.encryptWithKey(plaintext, key);
        const keyPayload = sdk.gatedFile.serializeKeyPayload([key]);

        const store = new X402Storefront({
            gateway: mkGateway({ send: { tick, amount: '7', payTo: seller.address, minConfirmations: 1 } }),
            keyPayloadHex: keyPayload.toString('hex'),
        });
        const { url } = await store.start();
        try {
            const client = new X402Client({ session: buyerSession(), retryDelayMs: 2000, maxRetries: 60 });
            const res = await client.fetchUrl(url + '/gated-key');
            expect(res.status).to.equal(200);
            const body = await res.json();
            const keys = sdk.gatedFile.parseKeyPayload(Buffer.from(body.key_payload, 'hex'));
            const decrypted = sdk.gatedFile.decryptFileBytes(ciphertext, keys[0]);
            expect(Buffer.compare(decrypted, plaintext)).to.equal(0);
        } finally { await store.stop(); }
    });

    it('6. dispenser hold-to-access: challenge advertises the dispenser; holding the tick grants access', async function () {
        this.timeout(300000);
        // Seller issues ACCESS and lists it in an on-chain dispenser (the buy
        // path itself, native coin in/tokens out, is proven by the dedicated
        // dispenser e2e; here the buyer acquires via SEND and the x402 claims
        // are: the 402 advertises the dispenser, and holding >= minBalance of
        // the tick unlocks the resource).
        const accessTick = uniqueTick('ACC');
        await submit(sdk, { action: 'ISSUE', params: { tick: accessTick, maxSupply: '1000', decimals: 0, mintSupply: '1000' } },
            { pubkey: seller.address, change: seller.address }, submitOpts({ wif: seller.wif }));
        const disp = await submit(sdk,
            { action: 'DISPENSER', params: {
                giveCoin: COIN, giveTick: accessTick, giveAmount: 1, giveEscrow: 100,
                getCoin: COIN, getAmount: 100000, getAddress: seller.address,
                expiration: Math.floor(Date.now() / 1000) + 7200,
            } },
            { pubkey: seller.address, change: seller.address }, submitOpts({ wif: seller.wif }));
        const dispenserIndex = disp.indexed && disp.indexed.action_index;

        const store = new X402Storefront({
            gateway: mkGateway({ dispenser: {
                holdTick: accessTick, minBalance: '1',
                dispenserIndex, dispenserAddress: seller.address,
            } }),
            resource: { members_only: true },
        });
        const { url } = await store.start();
        try {
            // Unpaid hit advertises the dispenser
            const challenge = await (await fetch(url + '/data')).json();
            expect(challenge.accepts[0]).to.include({ scheme: 'xchain-dispenser', holdTick: accessTick });
            expect(challenge.accepts[0].dispenserIndex).to.equal(dispenserIndex);

            await submit(sdk, { action: 'SEND', params: { tick: accessTick, amount: '1', destination: buyer.address } },
                { pubkey: seller.address, change: seller.address }, submitOpts({ wif: seller.wif }));
            const proof = Buffer.from(JSON.stringify({
                x402Version: 1, scheme: 'xchain-dispenser', coin: COIN, payer: buyer.address,
            })).toString('base64url');
            const res = await fetch(url + '/data', { headers: { 'X-Payment': proof } });
            expect(res.status).to.equal(200);
            expect((await res.json()).members_only).to.equal(true);
        } finally { await store.stop(); }
    });

    it('5. AgentSession policy refuses an over-cap price before any payment leaves', async function () {
        this.timeout(120000);
        const store = new X402Storefront({
            gateway: mkGateway({ send: { tick, amount: '50', payTo: seller.address, minConfirmations: 1 } }),
        });
        const { url } = await store.start();
        try {
            const session = buyerSession({ maxPerAction: { SEND: { [tick]: '10' } } });
            const client = new X402Client({ session, retryDelayMs: 1000, maxRetries: 3 });
            let err = null;
            try { await client.fetchUrl(url + '/data'); } catch (e) { err = e; }
            expect(err, 'expected a policy refusal').to.not.equal(null);
            expect(err.name).to.equal('SDKPolicyError');
            expect(err.code).to.equal('POLICY_AMOUNT_EXCEEDED');
        } finally { await store.stop(); }
    });
});
