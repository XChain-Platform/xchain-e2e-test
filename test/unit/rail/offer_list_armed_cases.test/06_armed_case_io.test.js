'use strict';

/*********************************************************************
 * Copyright (c) 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 * SPDX-License-Identifier: AGPL-3.0-or-later
 ********************************************************************/

const assert = require('assert');
const {
    ARMED_SETTLE,
    OFFER_LIST_ARMED_CASES,
    armedCaseIo,
    runArmedCase
} = require('../../../rail/offer_lists/helpers/armed_list_cases');

const order = {
    makerChain: 'BTC', takerChain: 'DOGE', makerTick: 'MK', takerTick: 'TK',
    amount: 10, makerGetAddress: 'dogemaker', expiration: 2000000000
};

const parties = {
    maker: { sdk: 'SM', address: 'bcrt1qmaker', wif: 'WM' },
    taker: { sdk: 'ST', address: 'dogetaker', wif: 'WT' }
};

function stubs(){
    const t = { submitted: [], log: [] };
    let next = 20;
    t.base = {
        parties,
        submit: async (sdk, action) => {
            t.submitted.push(sdk + ':' + action.action);
            next += 1;
            return { indexed: { status: 'valid', actions: [{ action_index: next }] } };
        },
        submitOpts: (x) => ({ waitForIndexer: true, ...x }),
        getConnection: async () => ({
            query: async () => [{ status: 'finalized' }],
            release: async () => { t.log.push('release'); }
        }),
        memberAddress: 'bcrt1qmember',
        outsiderAddress: 'bcrt1qoutsider',
        order
    };
    return t;
}

describe('offer list armed rail cases: armedCaseIo', function(){
    it('assembles the driver io from parties and a connection', async function(){
        assert(Object.isFrozen(ARMED_SETTLE));
        assert.deepStrictEqual({ ...ARMED_SETTLE }, { attempts: 15, intervalMs: 2000 });
        const t = stubs();
        const io = armedCaseIo(t.base);
        assert.strictEqual(io.attempts, ARMED_SETTLE.attempts);
        assert.strictEqual(io.intervalMs, ARMED_SETTLE.intervalMs);
        assert.strictEqual(typeof io.sleep, 'function');
        const outcome = await runArmedCase(OFFER_LIST_ARMED_CASES[0], 'armed', io);
        assert.strictEqual(outcome, 'matched');
        assert.deepStrictEqual(t.submitted, ['SM:LIST', 'SM:ORDER', 'ST:ORDER']);
        assert.deepStrictEqual(t.log, ['release']);
    });

    it('keeps an injected sleep and settle window', function(){
        const sleep = async () => {};
        const io = armedCaseIo({ ...stubs().base, sleep, attempts: 3, intervalMs: 5 });
        assert.strictEqual(io.sleep, sleep);
        assert.deepStrictEqual([io.attempts, io.intervalMs], [3, 5]);
    });

    it('refuses a missing connection or equal addresses before any submit', function(){
        const t = stubs();
        assert.throws(() => armedCaseIo({ ...t.base, getConnection: undefined }), /getConnection/);
        assert.throws(
            () => armedCaseIo({ ...t.base, outsiderAddress: t.base.memberAddress }),
            /differ/
        );
        assert.throws(() => armedCaseIo(), /getConnection/);
        assert.strictEqual(t.submitted.length, 0);
    });
});
