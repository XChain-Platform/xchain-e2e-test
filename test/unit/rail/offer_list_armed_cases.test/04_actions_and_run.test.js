'use strict';

/*********************************************************************
 * Copyright (c) 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 * SPDX-License-Identifier: AGPL-3.0-or-later
 ********************************************************************/

const assert = require('assert');
const {
    ADDRESS_LIST_TYPE,
    OFFER_LIST_ARMED_CASES,
    armedListAction,
    armedOrderActions,
    planArmedCase,
    runArmedCase
} = require('../../../rail/offer_lists/helpers/armed_list_cases');

const order = {
    makerChain: 'BTC', takerChain: 'DOGE', makerTick: 'MK', takerTick: 'TK',
    amount: 10, makerGetAddress: 'dogemaker', expiration: 2000000000
};

function fakeIo(rows){
    const t = { seen: [], queries: [] };
    let next = 10;
    t.io = {
        submit: async (seat, act) => {
            t.seen.push(seat + ':' + act.action);
            next += 1;
            return next;
        },
        query: async (sql, params) => {
            t.queries.push(params);
            return rows;
        },
        sleep: async () => {},
        memberAddress: 'bcrt1qmember',
        outsiderAddress: 'bcrt1qoutsider',
        order,
        attempts: 2,
        intervalMs: 0
    };
    return t;
}

describe('offer list armed rail cases: order actions', function(){
    it('builds the maker and counter-order actions from a plan', function(){
        const seats = { listActionIndex: 7, memberAddress: 'bcrt1qmember', outsiderAddress: 'bcrt1qoutsider' };
        const allow = planArmedCase(OFFER_LIST_ARMED_CASES[1], seats);
        const block = planArmedCase(OFFER_LIST_ARMED_CASES[2], seats);
        const order = {
            makerChain: 'BTC', takerChain: 'DOGE', makerTick: 'MK', takerTick: 'TK',
            amount: 10, makerGetAddress: 'dogemaker', expiration: 2000000000
        };
        const pair = armedOrderActions(allow, order);
        assert.deepStrictEqual(pair.maker, {
            action: 'ORDER',
            params: {
                giveCoin: 'BTC', giveTick: 'MK', giveAmount: 10, getCoin: 'DOGE', getTick: 'TK',
                getAmount: 10, getAddress: 'dogemaker', expiration: 2000000000, allowList: '7', blockList: ''
            }
        });
        assert.deepStrictEqual(pair.taker, {
            action: 'ORDER',
            params: {
                giveCoin: 'DOGE', giveTick: 'TK', giveAmount: 10, getCoin: 'BTC', getTick: 'MK',
                getAmount: 10, getAddress: 'bcrt1qoutsider', expiration: 2000000000, allowList: '', blockList: ''
            }
        });
        const blocked = armedOrderActions(block, order);
        assert.deepStrictEqual([blocked.maker.params.allowList, blocked.maker.params.blockList], ['', '7']);
        assert.strictEqual(blocked.taker.params.getAddress, 'bcrt1qmember');
        assert.strictEqual(blocked.taker.params.blockList, '');
    });

    it('rejects invalid order and plan inputs for the order actions', function(){
        const seats = { listActionIndex: 7, memberAddress: 'bcrt1qmember', outsiderAddress: 'bcrt1qoutsider' };
        const plan = planArmedCase(OFFER_LIST_ARMED_CASES[0], seats);
        const order = {
            makerChain: 'BTC', takerChain: 'DOGE', makerTick: 'MK', takerTick: 'TK',
            amount: 10, makerGetAddress: 'dogemaker', expiration: 2000000000
        };
        const bad = [
            { makerChain: '' }, { makerChain: 5 }, { takerChain: '' }, { takerChain: 'BTC' },
            { makerTick: '' }, { takerTick: undefined }, { makerGetAddress: '' },
            { amount: 0 }, { amount: 1.5 }, { amount: '10' }, { amount: Number.MAX_SAFE_INTEGER + 1 },
            { expiration: 0 }, { expiration: 1.5 }, { expiration: -1 }
        ];
        for(const change of bad)
            assert.throws(() => armedOrderActions(plan, { ...order, ...change }), /must/);
        for(const change of [{ allowList: 7 }, { blockList: null }, { takerGetAddress: '' }])
            assert.throws(() => armedOrderActions({ ...plan, ...change }, order), /must/);
        assert.throws(() => armedOrderActions(undefined, order), /must/);
        assert.throws(() => armedOrderActions(plan, undefined), /must/);
    });
});

describe('offer list armed rail cases: list action', function(){
    it('builds the address list action for the member', function(){
        assert.strictEqual(ADDRESS_LIST_TYPE, 2);
        assert.deepStrictEqual(armedListAction('bcrt1qmember'), {
            action: 'LIST',
            params: { type: 2, item: 'bcrt1qmember' }
        });
        assert.throws(() => armedListAction(''), /memberAddress must be a non-empty string/);
        assert.throws(() => armedListAction(7), /memberAddress must be a non-empty string/);
        assert.throws(() => armedListAction(), /memberAddress must be a non-empty string/);
    });
});

describe('offer list armed rail cases: runArmedCase', function(){
    it('drives one armed case through injected submit and query', async function(){
        const t = fakeIo([{ status: 'finalized' }]);
        const outcome = await runArmedCase(OFFER_LIST_ARMED_CASES[0], 'armed', t.io);
        assert.strictEqual(outcome, 'matched');
        assert.deepStrictEqual(t.seen, ['maker:LIST', 'maker:ORDER', 'taker:ORDER']);
        assert.deepStrictEqual(t.queries, [['BTC', 12, 'DOGE', 13, 'DOGE', 13, 'BTC', 12]]);
    });

    it('returns unmatched after every attempt reads no row', async function(){
        const t = fakeIo([]);
        const outcome = await runArmedCase(OFFER_LIST_ARMED_CASES[2], 'armed', t.io);
        assert.strictEqual(outcome, 'unmatched');
        assert.strictEqual(t.queries.length, 2);
    });

    it('rejects an outcome that differs from the mode', async function(){
        const t = fakeIo([]);
        await assert.rejects(runArmedCase(OFFER_LIST_ARMED_CASES[1], 'inert', t.io), /expected matched/);
    });

    it('rejects a bad mode or io before any submit', async function(){
        const t = fakeIo([]);
        await assert.rejects(runArmedCase(OFFER_LIST_ARMED_CASES[0], 'bogus', t.io), /mode/);
        t.io.query = null;
        await assert.rejects(runArmedCase(OFFER_LIST_ARMED_CASES[0], 'armed', t.io), /query/);
        assert.strictEqual(t.seen.length, 0);
    });

    it('rejects a submit result that is not a positive integer', async function(){
        const t = fakeIo([]);
        t.io.submit = async () => '7';
        await assert.rejects(runArmedCase(OFFER_LIST_ARMED_CASES[0], 'armed', t.io), /LIST/);
    });
});
