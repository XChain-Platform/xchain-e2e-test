'use strict';

/*********************************************************************
 * Copyright (c) 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 * SPDX-License-Identifier: AGPL-3.0-or-later
 ********************************************************************/

const assert = require('assert');
const {
    BROADCAST_FEE_CASES,
    MAX_BROADCAST_FEE_LENGTH
} = require('../../rail/flag_days/helpers/broadcast_fee_cases');

describe('broadcast fee length rail cases', function(){
    it('pins the ordered cases', function(){
        assert.deepStrictEqual(BROADCAST_FEE_CASES, [
            {
                name: 'format 1 accepts an 11-character FEE',
                format: 1,
                fee: '0.123456789',
                expect: 'valid'
            },
            {
                name: 'format 1 rejects a 12-character FEE',
                format: 1,
                fee: '0.1234567891',
                expect: 'invalid: FEE (length)'
            },
            {
                name: 'format 0 carries no FEE',
                format: 0,
                fee: null,
                expect: 'valid'
            }
        ]);
    });

    it('pins the boundary lengths', function(){
        assert.strictEqual(MAX_BROADCAST_FEE_LENGTH, 11);
        assert.strictEqual(BROADCAST_FEE_CASES[0].fee.length, 11);
        assert.strictEqual(BROADCAST_FEE_CASES[1].fee.length, 12);
    });

    it('freezes the list and its entries', function(){
        assert(Object.isFrozen(BROADCAST_FEE_CASES));
        for(const testCase of BROADCAST_FEE_CASES)
            assert(Object.isFrozen(testCase));
    });
});
