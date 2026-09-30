'use strict';

/*********************************************************************
 * Copyright (c) 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 * SPDX-License-Identifier: AGPL-3.0-or-later
 ********************************************************************/

function archiveCountCases(matchesLength){
    if(!Number.isInteger(matchesLength) || matchesLength <= 0)
        throw new TypeError('matchesLength must be a positive integer');

    const cases = [
        { name: 'honest', matchCount: matchesLength, expect: 'valid' },
        { name: 'one over', matchCount: matchesLength + 1, expect: 'invalid_archive' }
    ];
    if(matchesLength > 1)
        cases.push({ name: 'one under', matchCount: matchesLength - 1, expect: 'invalid_archive' });
    return cases;
}

module.exports = { archiveCountCases };
