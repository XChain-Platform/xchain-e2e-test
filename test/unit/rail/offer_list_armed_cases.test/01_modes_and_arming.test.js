'use strict';

/*********************************************************************
 * Copyright (c) 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 * SPDX-License-Identifier: AGPL-3.0-or-later
 ********************************************************************/

const assert = require('assert');
const {
    armedSuiteMode,
    expectMode,
    requireArmingVariables
} = require('../../../rail/offer_lists/helpers/armed_list_cases');

describe('offer list armed rail cases: suite mode', function(){
    it('reads the suite mode and refuses an unarmed armed run', function(){
        const both = {
            XC_OFFER_LIST_REGTEST_ACTIVATION: '1',
            EXACT_INTEGER_WIRE_FIELDS_REGTEST_TIME: '1700000000'
        };
        assert.strictEqual(armedSuiteMode(both), 'armed');
        assert.strictEqual(armedSuiteMode({ ...both, XC_OFFER_LIST_EXPECT: 'armed' }), 'armed');
        assert.throws(
            () => armedSuiteMode({ EXACT_INTEGER_WIRE_FIELDS_REGTEST_TIME: '1' }),
            /XC_OFFER_LIST_REGTEST_ACTIVATION/
        );
        assert.throws(
            () => armedSuiteMode({ XC_OFFER_LIST_REGTEST_ACTIVATION: '1' }),
            /EXACT_INTEGER_WIRE_FIELDS_REGTEST_TIME/
        );
        assert.throws(() => armedSuiteMode(undefined), /XC_OFFER_LIST_REGTEST_ACTIVATION/);
        assert.strictEqual(armedSuiteMode({ XC_OFFER_LIST_EXPECT: 'inert' }), 'inert');
        assert.throws(() => armedSuiteMode({ ...both, XC_OFFER_LIST_EXPECT: 'on' }), /XC_OFFER_LIST_EXPECT/);
    });
});

describe('offer list armed rail cases: arming variables', function(){
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
});
