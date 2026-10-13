'use strict';

/*********************************************************************
 * Copyright (c) 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 * SPDX-License-Identifier: AGPL-3.0-or-later
 ********************************************************************/

const assert = require('assert');
const {
    OFFER_LIST_ARMED_CASES,
    expectMode,
    planArmedCase,
    requireArmingVariables
} = require('../../rail/offer_lists/helpers/armed_list_cases');

describe('offer list armed rail cases', function(){
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

    it('selects armed mode by default and accepts explicit modes', function(){
        assert.strictEqual(expectMode(undefined), 'armed');
        assert.strictEqual(expectMode(''), 'armed');
        assert.strictEqual(expectMode('armed'), 'armed');
        assert.strictEqual(expectMode('inert'), 'inert');
    });

    it('rejects an unknown mode', function(){
        assert.throws(() => expectMode('sometimes'), /XC_OFFER_LIST_EXPECT must be armed or inert/);
    });

    it('accepts an environment with both arming variables set', function(){
        requireArmingVariables({
            XC_OFFER_LIST_REGTEST_ACTIVATION: '1',
            EXACT_INTEGER_WIRE_FIELDS_REGTEST_TIME: '1'
        });
    });

    it('names XC_OFFER_LIST_REGTEST_ACTIVATION when it is unset', function(){
        assert.throws(
            () => requireArmingVariables({ EXACT_INTEGER_WIRE_FIELDS_REGTEST_TIME: '1' }),
            /XC_OFFER_LIST_REGTEST_ACTIVATION/
        );
        assert.throws(
            () => requireArmingVariables({
                XC_OFFER_LIST_REGTEST_ACTIVATION: '',
                EXACT_INTEGER_WIRE_FIELDS_REGTEST_TIME: '1'
            }),
            /XC_OFFER_LIST_REGTEST_ACTIVATION/
        );
    });

    it('names EXACT_INTEGER_WIRE_FIELDS_REGTEST_TIME when it is unset', function(){
        assert.throws(
            () => requireArmingVariables({ XC_OFFER_LIST_REGTEST_ACTIVATION: '1' }),
            /EXACT_INTEGER_WIRE_FIELDS_REGTEST_TIME/
        );
        assert.throws(() => requireArmingVariables({}), /REGTEST/);
    });

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
