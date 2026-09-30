'use strict';

/*********************************************************************
 * Copyright (c) 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 * SPDX-License-Identifier: AGPL-3.0-or-later
 ********************************************************************/

const MAX_BROADCAST_FEE_LENGTH = 11;

const BROADCAST_FEE_CASES = Object.freeze([
    Object.freeze({
        name: 'format 1 accepts an 11-character FEE',
        format: 1,
        fee: '0.123456789',
        expect: 'valid'
    }),
    Object.freeze({
        name: 'format 1 rejects a 12-character FEE',
        format: 1,
        fee: '0.1234567891',
        expect: 'invalid: FEE (length)'
    }),
    Object.freeze({
        name: 'format 0 carries no FEE',
        format: 0,
        fee: null,
        expect: 'valid'
    })
]);

module.exports = { BROADCAST_FEE_CASES, MAX_BROADCAST_FEE_LENGTH };
