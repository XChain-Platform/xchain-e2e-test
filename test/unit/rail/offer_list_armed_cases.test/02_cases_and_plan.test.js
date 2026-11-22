'use strict';

/*********************************************************************
 * Copyright (c) 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 * SPDX-License-Identifier: AGPL-3.0-or-later
 ********************************************************************/

const assert = require('assert');
const {
    OFFER_LIST_ARMED_CASES,
    planArmedCase
} = require('../../../rail/offer_lists/helpers/armed_list_cases');

describe('offer list armed rail cases: case table', function(){
    it('pins the ordered cases', function(){
        assert.deepStrictEqual(OFFER_LIST_ARMED_CASES, [
            {
                name: 'allow list, counter-order GET_ADDRESS is a member',
                list: 'allow_list',
                member: true,
                armed: { outcome: 'matched' },
                inert: { outcome: 'matched' }
            },
            {
                name: 'allow list, counter-order GET_ADDRESS is not a member',
                list: 'allow_list',
                member: false,
                armed: { outcome: 'unmatched', reason: 'taker not on allow list' },
                inert: { outcome: 'matched' }
            },
            {
                name: 'block list, counter-order GET_ADDRESS is a member',
                list: 'block_list',
                member: true,
                armed: { outcome: 'unmatched', reason: 'taker on block list' },
                inert: { outcome: 'matched' }
            },
            {
                name: 'block list, counter-order GET_ADDRESS is not a member',
                list: 'block_list',
                member: false,
                armed: { outcome: 'matched' },
                inert: { outcome: 'matched' }
            }
        ]);
    });

    it('freezes the table, entries and outcomes', function(){
        assert(Object.isFrozen(OFFER_LIST_ARMED_CASES));
        for(const testCase of OFFER_LIST_ARMED_CASES){
            assert(Object.isFrozen(testCase));
            assert(Object.isFrozen(testCase.armed));
            assert(Object.isFrozen(testCase.inert));
        }
    });
});

describe('offer list armed rail cases: case planning', function(){
    it('plans the list fields and counter-order address for every case', function(){
        const plan = { listActionIndex: 7, memberAddress: 'bcrt1qmember', outsiderAddress: 'bcrt1qoutsider' };
        const expected = [
            { allowList: '7', blockList: '', takerGetAddress: 'bcrt1qmember' },
            { allowList: '7', blockList: '', takerGetAddress: 'bcrt1qoutsider' },
            { allowList: '', blockList: '7', takerGetAddress: 'bcrt1qmember' },
            { allowList: '', blockList: '7', takerGetAddress: 'bcrt1qoutsider' }
        ];
        assert.strictEqual(OFFER_LIST_ARMED_CASES.length, expected.length);
        OFFER_LIST_ARMED_CASES.forEach((testCase, i) => {
            assert.deepStrictEqual(planArmedCase(testCase, plan), expected[i]);
        });

        const c = OFFER_LIST_ARMED_CASES[0];
        for(const bad of [0, -1, 1.5, '7', NaN, undefined])
            assert.throws(() => planArmedCase(c, { ...plan, listActionIndex: bad }), /listActionIndex/);
        for(const bad of ['', undefined])
            assert.throws(() => planArmedCase(c, { ...plan, memberAddress: bad }), /memberAddress/);
        for(const bad of ['', undefined])
            assert.throws(() => planArmedCase(c, { ...plan, outsiderAddress: bad }), /outsiderAddress/);
        assert.throws(() => planArmedCase(c, { ...plan, outsiderAddress: plan.memberAddress }), /differ/);
    });
});
