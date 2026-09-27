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
 * Unit coverage for the public settlement drill's BTC order leg.
 *
 ********************************************************************/

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { placeBtcCrossOrder } = require('../lib/testnetSettleOrderLeg');

const MAKER = { address: 'btc-maker-address', wif: 'maker-wif' };

function harness() {
    const calls = [];
    const submitFn = async (sdk, action, encoder, options) => {
        calls.push({ kind: 'submit', sdk, action, encoder, options });
        if (action.action === 'ISSUE') return { txid: 'issue-txid' };
        return { signed: { txid: 'order-txid' } };
    };
    const waitBlocks = async (count) => calls.push({ kind: 'wait', count });
    return { calls, submitFn, waitBlocks };
}

async function runLeg(h) {
    return placeBtcCrossOrder({
        sdk: 'btc-sdk',
        submitFn: h.submitFn,
        maker: MAKER,
        amount: 100,
        dogeTick: 'DOGESETTLE',
        dogeMakerBtcRecv: 'doge-receive-address',
        waitBlocks: h.waitBlocks,
        uniqueTick: (prefix) => prefix + 'SETTLE',
        log: () => {}
    });
}

describe('testnet settlement BTC order leg', function () {
    it('submits ISSUE before ORDER and waits one block after each', async function () {
        const h = harness();
        const result = await runLeg(h);

        assert.deepStrictEqual(h.calls.map((call) =>
            call.kind === 'submit' ? 'submit:' + call.action.action : 'wait:' + call.count), [
            'submit:ISSUE', 'wait:1', 'submit:ORDER', 'wait:1'
        ]);
        assert.deepStrictEqual(result, {
            tick: 'BTCSETTLE', issueTxid: 'issue-txid', orderTxid: 'order-txid'
        });
    });

    it('composes the same ISSUE and crossing ORDER fields as the live harness', async function () {
        const h = harness();
        const savedNow = Date.now;
        Date.now = () => 1700000000000;
        try {
            await runLeg(h);
        } finally {
            Date.now = savedNow;
        }

        const submits = h.calls.filter((call) => call.kind === 'submit');
        assert.deepStrictEqual(submits[0].action, {
            action: 'ISSUE',
            params: {
                tick: 'BTCSETTLE', maxSupply: 1000000, maxMint: 100000,
                decimals: 0, description: 'dex-settle', mintSupply: 1000
            }
        });
        assert.deepStrictEqual(submits[1].action, {
            action: 'ORDER',
            params: {
                giveCoin: 'BTC', giveTick: 'BTCSETTLE', giveAmount: 100,
                getCoin: 'DOGE', getTick: 'DOGESETTLE', getAmount: 100,
                getAddress: 'doge-receive-address', expiration: 1707776000
            }
        });
    });
});

describe('testnet settlement BTC order leg dependencies', function () {
    it('submits both actions from the injected maker', async function () {
        const h = harness();
        await runLeg(h);
        const submits = h.calls.filter((call) => call.kind === 'submit');

        for (const call of submits) {
            assert.strictEqual(call.sdk, 'btc-sdk');
            assert.deepStrictEqual(call.encoder, {
                pubkey: 'btc-maker-address', change: 'btc-maker-address'
            });
            assert.deepStrictEqual(call.options, {
                waitForIndexer: true, timeout: 120000, pollInterval: 1500, wif: 'maker-wif'
            });
        }
    });

    it('has no database, SDK-helper, or block-production dependency', function () {
        const sourcePath = path.join(__dirname, '../lib/testnetSettleOrderLeg.js');
        const source = fs.readFileSync(sourcePath, 'utf8');
        assert.doesNotMatch(source, /mariadb/);
        assert.doesNotMatch(source, /sdkHelper/);
        assert.doesNotMatch(source, /\bmine\s*\(/);
        assert.doesNotMatch(source, /process\.env|readFile|stdin/);
    });
});
