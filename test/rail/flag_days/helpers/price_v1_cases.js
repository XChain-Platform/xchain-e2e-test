'use strict';

// Copyright © 2025-2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const PRICE_V1_CASES = Object.freeze([
    Object.freeze({ name: 'honest control', value: '1.5', fee: '0.01', expect: 'valid' }),
    Object.freeze({
        name: 'leading-zero value',
        value: '01.5',
        fee: '0.01',
        expect: 'invalid: VALUE (format)'
    }),
    Object.freeze({
        name: 'leading-zero fee',
        value: '1.5',
        fee: '00.01',
        expect: 'invalid: FEE (format)'
    })
]);

module.exports = { PRICE_V1_CASES };
