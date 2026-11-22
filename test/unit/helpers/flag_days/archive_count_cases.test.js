'use strict';

/*********************************************************************
 * Copyright (c) 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 * SPDX-License-Identifier: AGPL-3.0-or-later
 ********************************************************************/

const assert = require('assert');
const { archiveCountCases } = require('../../../helpers/flag_days/archive_count_cases');

describe('archiveCountCases', function () {
    it('pins the length-one cases without a zero-count one-under case', function () {
        assert.deepStrictEqual(archiveCountCases(1), [
            { name: 'honest', matchCount: 1, expect: 'valid' },
            { name: 'one over', matchCount: 2, expect: 'invalid_archive' }
        ]);
    });

    it('pins the ordered length-three cases', function () {
        assert.deepStrictEqual(archiveCountCases(3), [
            { name: 'honest', matchCount: 3, expect: 'valid' },
            { name: 'one over', matchCount: 4, expect: 'invalid_archive' },
            { name: 'one under', matchCount: 2, expect: 'invalid_archive' }
        ]);
    });

    it('rejects non-positive and non-integer lengths', function () {
        for(const value of [0, -1, 1.5, NaN, '3', null])
            assert.throws(() => archiveCountCases(value), /positive integer/);
    });

    it('expects every case to be valid while the gate is inactive', function () {
        for(const matchesLength of [1, 3])
            assert.ok(archiveCountCases(matchesLength, { active: false })
                .every((testCase) => testCase.expect === 'valid'));
    });

    it('rejects a non-boolean active option', function () {
        for(const active of [0, 1, 'false', null, {}, []])
            assert.throws(() => archiveCountCases(3, { active }), /boolean/);
    });
});
