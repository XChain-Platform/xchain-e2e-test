'use strict';

/*********************************************************************
 * Copyright (c) 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 * SPDX-License-Identifier: AGPL-3.0-or-later
 ********************************************************************/

const assert = require('assert');
const {
    CALLBACK_TARGET_SOURCE,
    USABLE_METHOD_CASES,
    expectMode
} = require('../../rail/vote_binding/usable_method_cases');

describe('VOTE callback binding usable method rail cases', function(){
    it('pins the ordered cases', function(){
        assert.deepStrictEqual(USABLE_METHOD_CASES, [
            {
                name: 'available callback method',
                method: 'onPoll',
                armed: 'valid',
                inert: 'valid'
            },
            {
                name: 'unavailable callback method',
                method: 'noSuchMethod',
                armed: 'invalid: CALLBACK_METHOD (unavailable)',
                inert: 'valid'
            }
        ]);
    });

    it('freezes the list and its entries', function(){
        assert(Object.isFrozen(USABLE_METHOD_CASES));
        for(const testCase of USABLE_METHOD_CASES)
            assert(Object.isFrozen(testCase));
    });

    it('defines only the available callback method', function(){
        assert.match(CALLBACK_TARGET_SOURCE, /\bonPoll\s*:/);
        assert.doesNotMatch(CALLBACK_TARGET_SOURCE, /\bnoSuchMethod\b/);
    });

    it('selects armed mode by default and accepts explicit modes', function(){
        assert.strictEqual(expectMode(undefined), 'armed');
        assert.strictEqual(expectMode(''), 'armed');
        assert.strictEqual(expectMode('armed'), 'armed');
        assert.strictEqual(expectMode('inert'), 'inert');
    });

    it('rejects an unknown mode', function(){
        assert.throws(
            () => expectMode('sometimes'),
            /XC_VOTE_CALLBACK_BINDING_EXPECT must be armed or inert/
        );
    });
});
