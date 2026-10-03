'use strict';

/*********************************************************************
 * Copyright (c) 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 * SPDX-License-Identifier: AGPL-3.0-or-later
 ********************************************************************/

function archiveCountCases(matchesLength, { active = true } = {}){
    if(!Number.isInteger(matchesLength) || matchesLength <= 0)
        throw new TypeError('matchesLength must be a positive integer');
    if(typeof active !== 'boolean')
        throw new TypeError('active must be a boolean');

    const cases = [
        { name: 'honest', matchCount: matchesLength, expect: 'valid' },
        { name: 'one over', matchCount: matchesLength + 1,
            expect: active ? 'invalid_archive' : 'valid' }
    ];
    if(matchesLength > 1)
        cases.push({ name: 'one under', matchCount: matchesLength - 1,
            expect: active ? 'invalid_archive' : 'valid' });
    return cases;
}

module.exports = { archiveCountCases };
