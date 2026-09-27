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
 * Unit coverage for the public settlement drill's DOGE counter-order leg.
 *
 ********************************************************************/

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { placeDogeCounterOrder } = require('../lib/testnetSettleCounterLeg');

function fixture() {
    const dogeSdk = { network: 'dogecoin-testnet' };
    const maker = { address: 'doge-maker', wif: 'maker-wif' };
    const events = [];
    const submissions = [];
    const submitFn = async (sdk, action, encoderOptions, signerOptions) => {
        submissions.push({ sdk, action, encoderOptions, signerOptions });
        events.push(action.action);
        return action.action === 'ISSUE'
            ? { signed: { txid: 'issue-txid' } }
            : { txid: 'order-txid' };
    };
    const waitBlocks = async (count) => events.push('wait:' + count);
    const uniqueTick = (prefix) => prefix + 'SETTLE';
    return { dogeSdk, maker, events, submissions, submitFn, waitBlocks, uniqueTick };
}

async function runFixture(overrides) {
    const f = fixture();
    const result = await placeDogeCounterOrder(Object.assign({
        dogeSdk: f.dogeSdk,
        submitFn: f.submitFn,
        maker: f.maker,
        amount: 100,
        btcRecv: 'btc-receive-address',
        waitBlocks: f.waitBlocks,
        uniqueTick: f.uniqueTick,
        log: () => {}
    }, overrides || {}));
    return { f, result };
}

describe('testnet DOGE counter-order leg', function () {
    it('submits ISSUE before ORDER and waits after every submission', async function () {
        const { f } = await runFixture();
        assert.deepStrictEqual(f.events, ['ISSUE', 'wait:1', 'ORDER', 'wait:1']);
    });

    it('uses the injected SDK and maker for both submissions', async function () {
        const { f } = await runFixture();
        assert.strictEqual(f.submissions.length, 2);
        for (const submission of f.submissions) {
            assert.strictEqual(submission.sdk, f.dogeSdk);
            assert.deepStrictEqual(submission.encoderOptions,
                { pubkey: f.maker.address, change: f.maker.address });
            assert.deepStrictEqual(submission.signerOptions, {
                waitForIndexer: true,
                timeout: 120000,
                pollInterval: 1500,
                wif: f.maker.wif
            });
        }
    });

    it('composes the DOGE token and mirroring cross-chain order', async function () {
        const savedNow = Date.now;
        Date.now = () => 1700000000000;
        let f;
        try {
            ({ f } = await runFixture());
        } finally {
            Date.now = savedNow;
        }
        assert.deepStrictEqual(f.submissions[0].action, {
            action: 'ISSUE',
            params: {
                tick: 'DOGESETTLE', maxSupply: 1000000, maxMint: 100000,
                decimals: 0, description: 'dex-settle', mintSupply: 1000
            }
        });
        assert.deepStrictEqual(f.submissions[1].action, {
            action: 'ORDER',
            params: {
                giveCoin: 'DOGE', giveTick: 'DOGESETTLE', giveAmount: 100,
                getCoin: 'BTC', getTick: 'BTCSETTLE', getAmount: 100,
                getAddress: 'btc-receive-address', expiration: 1707776000
            }
        });
    });
});

describe('testnet DOGE counter-order leg dependencies', function () {
    it('returns the DOGE ticker, order transaction id, and BTC receive address', async function () {
        const { result } = await runFixture();
        assert.deepStrictEqual(result, {
            dogeTick: 'DOGESETTLE',
            orderTxid: 'order-txid',
            btcRecv: 'btc-receive-address'
        });
    });

    it('has no database, SDK-helper, or local block-production dependency', function () {
        const source = fs.readFileSync(path.join(__dirname, '../lib/testnetSettleCounterLeg.js'), 'utf8');
        assert.strictEqual(source.includes('maria' + 'db'), false);
        assert.strictEqual(source.includes('sdk' + 'Helper'), false);
        assert.strictEqual(source.includes('mi' + 'ne'), false);
        assert.strictEqual(source.includes('process' + '.env'), false);
        assert.strictEqual(source.includes('read' + 'File'), false);
        assert.strictEqual(source.includes('std' + 'in'), false);
    });
});
