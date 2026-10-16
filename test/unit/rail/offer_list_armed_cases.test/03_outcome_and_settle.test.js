'use strict';

/*********************************************************************
 * Copyright (c) 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 * SPDX-License-Identifier: AGPL-3.0-or-later
 ********************************************************************/

const assert = require('assert');
const {
    OFFER_LIST_ARMED_CASES,
    checkArmedOutcome,
    observedOutcome,
    pairMatchQuery,
    settlePairOutcome
} = require('../../../rail/offer_lists/helpers/armed_list_cases');

describe('offer list armed rail cases: pair outcome', function(){
    it('reads the pair match outcome from cross_chain_matches rows', function(){
        const pair = { makerChain: 'BTC', makerIndex: 11, takerChain: 'DOGE', takerIndex: 7 };
        const q = pairMatchQuery(pair);
        assert.deepStrictEqual(q.params, ['BTC', 11, 'DOGE', 7, 'DOGE', 7, 'BTC', 11]);
        assert(/cross_chain_matches/.test(q.sql));
        assert(/match_id, status/.test(q.sql));
        for(const bad of ['', undefined, 5])
            assert.throws(() => pairMatchQuery({ ...pair, makerChain: bad }), /makerChain/);
        for(const bad of ['', null])
            assert.throws(() => pairMatchQuery({ ...pair, takerChain: bad }), /takerChain/);
        for(const bad of [0, -1, 1.5, '7', Number.MAX_SAFE_INTEGER + 1])
            assert.throws(() => pairMatchQuery({ ...pair, makerIndex: bad }), /makerIndex/);
        for(const bad of [0, NaN, undefined])
            assert.throws(() => pairMatchQuery({ ...pair, takerIndex: bad }), /takerIndex/);
        assert.throws(() => pairMatchQuery(undefined), /makerChain/);

        assert.strictEqual(observedOutcome([]), 'unmatched');
        assert.strictEqual(observedOutcome([{ status: 'retracted' }]), 'unmatched');
        assert.strictEqual(observedOutcome([{ status: 'finalized' }]), 'matched');
        assert.strictEqual(observedOutcome([{ status: 'retracted' }, { status: 'finalized' }]), 'matched');
        assert.throws(() => observedOutcome(null), /array/);
        assert.throws(() => observedOutcome({}), /array/);
        assert.throws(() => observedOutcome([{ status: 'pending' }]), /pending/);
        assert.throws(() => observedOutcome([{ status: 'finalized' }, {}]), /status/);

        const [first, second] = OFFER_LIST_ARMED_CASES;
        checkArmedOutcome(first, 'armed', 'matched');
        checkArmedOutcome(second, 'inert', 'matched');
        checkArmedOutcome(second, 'armed', 'unmatched');
        assert.throws(
            () => checkArmedOutcome(second, 'armed', 'matched'),
            (err) => err instanceof Error
                && err.message.includes(second.name)
                && err.message.includes('armed')
                && err.message.includes('unmatched (taker not on allow list)')
                && err.message.includes('observed matched')
        );
        assert.throws(() => checkArmedOutcome(first, 'armed', 'unmatched'), /expected matched but/);
        assert.throws(() => checkArmedOutcome(first, 'bogus', 'matched'), /mode/);
    });
});

describe('offer list armed rail cases: settling', function(){
    it('settles the pair outcome by bounded polling', async function(){
        let reads = 0;
        let sleeps = 0;
        const sleep = async () => { sleeps++; };
        const rows = [[], [{ status: 'finalized' }]];
        const early = await settlePairOutcome({ read: async () => rows[reads++], sleep, attempts: 5, intervalMs: 0 });
        assert.deepStrictEqual([early, reads, sleeps], ['matched', 2, 1]);

        reads = 0;
        sleeps = 0;
        const read = async () => { reads++; return [{ status: 'retracted' }]; };
        const late = await settlePairOutcome({ read, sleep, attempts: 3, intervalMs: 5 });
        assert.deepStrictEqual([late, reads, sleeps], ['unmatched', 3, 2]);

        const bad = async () => [{ status: 'pending' }];
        await assert.rejects(settlePairOutcome({ read: bad, sleep, attempts: 2, intervalMs: 0 }), /pending/);
        const failing = async () => { throw new Error('read failed'); };
        await assert.rejects(settlePairOutcome({ read: failing, sleep, attempts: 2, intervalMs: 0 }), /read failed/);
    });

    it('rejects invalid settle arguments before any read', async function(){
        let reads = 0;
        const read = async () => { reads++; return []; };
        const sleep = async () => {};
        const ok = { read, sleep, attempts: 1, intervalMs: 0 };
        for(const attempts of [0, -1, 1.5, '2', undefined])
            await assert.rejects(settlePairOutcome({ ...ok, attempts }), /attempts/);
        for(const intervalMs of [-1, 0.5, '1', undefined, Infinity])
            await assert.rejects(settlePairOutcome({ ...ok, intervalMs }), /intervalMs/);
        await assert.rejects(settlePairOutcome({ ...ok, read: null }), /read/);
        await assert.rejects(settlePairOutcome({ ...ok, sleep: null }), /sleep/);
        await assert.rejects(settlePairOutcome(undefined), /attempts/);
        assert.strictEqual(reads, 0);
    });
});
