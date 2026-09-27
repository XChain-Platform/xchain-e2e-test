'use strict';

// Copyright © 2025-2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const assert = require('assert');
const { PRICE_V1_CASES } = require('../../rail/flag_days/price_v1_cases');

describe('PRICE v1 canonical-bound rail cases', function () {
    it('pins the ordered case list', function () {
        assert.deepStrictEqual(PRICE_V1_CASES, [
            { name: 'honest control', value: '1.5', fee: '0.01', expect: 'valid' },
            {
                name: 'leading-zero value',
                value: '01.5',
                fee: '0.01',
                expect: 'invalid: VALUE (format)'
            },
            {
                name: 'leading-zero fee',
                value: '1.5',
                fee: '00.01',
                expect: 'invalid: FEE (format)'
            }
        ]);
        assert.strictEqual(Object.isFrozen(PRICE_V1_CASES), true);
        assert.strictEqual(PRICE_V1_CASES.every(Object.isFrozen), true);
    });

    it('changes exactly one input by prepending one zero in each invalid case', function () {
        const control = PRICE_V1_CASES[0];
        for (const testCase of PRICE_V1_CASES.slice(1)) {
            const changed = ['value', 'fee'].filter(field => testCase[field] !== control[field]);
            assert.strictEqual(changed.length, 1, testCase.name + ' must change one input field');
            assert.strictEqual(testCase[changed[0]], '0' + control[changed[0]],
                testCase.name + ' must prepend exactly one zero');
        }
    });
});
