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

// Plans the sendOrderV0 ALLOW_LIST and BLOCK_LIST positions and the counter-order
// GET_ADDRESS for one case. xchain-hub attachedListIds treats only a nonzero value
// as attached, so the unused list position is an empty string.
function planArmedCase(testCase, plan){
    const { listActionIndex, memberAddress, outsiderAddress } = plan || {};
    if(!Number.isSafeInteger(listActionIndex) || listActionIndex <= 0)
        throw new Error('listActionIndex must be a positive integer');
    if(typeof memberAddress !== 'string' || memberAddress === '')
        throw new Error('memberAddress must be a non-empty string');
    if(typeof outsiderAddress !== 'string' || outsiderAddress === '')
        throw new Error('outsiderAddress must be a non-empty string');
    if(memberAddress === outsiderAddress)
        throw new Error('memberAddress and outsiderAddress must differ');
    if(!testCase || (testCase.list !== 'allow_list' && testCase.list !== 'block_list'))
        throw new Error('case list must be allow_list or block_list');
    const index = String(listActionIndex);
    return {
        allowList: testCase.list === 'allow_list' ? index : '',
        blockList: testCase.list === 'block_list' ? index : '',
        takerGetAddress: testCase.member === true ? memberAddress : outsiderAddress
    };
}

function requireChain(name, value){
    if(typeof value !== 'string' || value === '')
        throw new Error(name + ' must be a non-empty string');
}

function requireIndex(name, value){
    if(!Number.isSafeInteger(value) || value <= 0)
        throw new Error(name + ' must be a positive integer');
}

// Selects the pair in either seat. The hub only gates a pair through a boolean,
// so a cross_chain_matches row is the one observable the rail can read.
function pairMatchQuery(pair){
    const { makerChain, makerIndex, takerChain, takerIndex } = pair || {};
    requireChain('makerChain', makerChain);
    requireIndex('makerIndex', makerIndex);
    requireChain('takerChain', takerChain);
    requireIndex('takerIndex', takerIndex);
    const sql = 'SELECT match_id, status FROM cross_chain_matches WHERE '
        + '(a_chain = ? AND a_action_index = ? AND b_chain = ? AND b_action_index = ?) OR '
        + '(a_chain = ? AND a_action_index = ? AND b_chain = ? AND b_action_index = ?)';
    return {
        sql,
        params: [makerChain, makerIndex, takerChain, takerIndex, takerChain, takerIndex, makerChain, makerIndex]
    };
}

function observedOutcome(rows){
    if(!Array.isArray(rows)) throw new Error('rows must be an array');
    for(const row of rows){
        const status = row && row.status;
        if(status !== 'finalized' && status !== 'retracted')
            throw new Error('unexpected match status: ' + status);
    }
    return rows.some((row) => row.status === 'finalized') ? 'matched' : 'unmatched';
}

function checkArmedOutcome(testCase, mode, outcome){
    if(mode !== 'armed' && mode !== 'inert')
        throw new Error('mode must be armed or inert');
    const expected = testCase[mode];
    if(outcome === expected.outcome) return;
    const reason = expected.reason ? ' (' + expected.reason + ')' : '';
    throw new Error('case "' + testCase.name + '" in ' + mode + ' mode expected '
        + expected.outcome + reason + ' but observed ' + outcome);
}

module.exports = {
    ARMING_VARIABLES,
    OFFER_LIST_ARMED_CASES,
    checkArmedOutcome,
    expectMode,
    observedOutcome,
    pairMatchQuery,
    planArmedCase,
    requireArmingVariables
};
