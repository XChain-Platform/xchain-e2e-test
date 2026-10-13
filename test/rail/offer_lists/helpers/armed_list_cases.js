'use strict';

/*********************************************************************
 * Copyright (c) 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 * SPDX-License-Identifier: AGPL-3.0-or-later
 ********************************************************************/

const ARMING_VARIABLES = Object.freeze([
    'XC_OFFER_LIST_REGTEST_ACTIVATION',
    'EXACT_INTEGER_WIRE_FIELDS_REGTEST_TIME'
]);

// Reasons are the verdicts from xchain-hub offerListVerdict.
const NOT_ON_ALLOW_LIST = 'taker not on allow list';
const ON_BLOCK_LIST = 'taker on block list';

const OFFER_LIST_ARMED_CASES = Object.freeze([
    Object.freeze({
        name: 'allow list, counter-order GET_ADDRESS is a member',
        list: 'allow_list',
        member: true,
        armed: Object.freeze({ outcome: 'matched' }),
        inert: Object.freeze({ outcome: 'matched' })
    }),
    Object.freeze({
        name: 'allow list, counter-order GET_ADDRESS is not a member',
        list: 'allow_list',
        member: false,
        armed: Object.freeze({ outcome: 'unmatched', reason: NOT_ON_ALLOW_LIST }),
        inert: Object.freeze({ outcome: 'matched' })
    }),
    Object.freeze({
        name: 'block list, counter-order GET_ADDRESS is a member',
        list: 'block_list',
        member: true,
        armed: Object.freeze({ outcome: 'unmatched', reason: ON_BLOCK_LIST }),
        inert: Object.freeze({ outcome: 'matched' })
    }),
    Object.freeze({
        name: 'block list, counter-order GET_ADDRESS is not a member',
        list: 'block_list',
        member: false,
        armed: Object.freeze({ outcome: 'matched' }),
        inert: Object.freeze({ outcome: 'matched' })
    })
]);

function expectMode(value){
    if(value === undefined || value === '' || value === 'armed') return 'armed';
    if(value === 'inert') return 'inert';
    throw new Error('XC_OFFER_LIST_EXPECT must be armed or inert');
}

function requireArmingVariables(env){
    const source = env || {};
    for(const name of ARMING_VARIABLES){
        const value = source[name];
        if(value === undefined || value === null || value === '')
            throw new Error(name + ' must be set to arm the offer list rail cases');
    }
}

module.exports = {
    ARMING_VARIABLES,
    OFFER_LIST_ARMED_CASES,
    expectMode,
    requireArmingVariables
};
