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

// The suite gate: reads the expectation and only an armed run needs the arming variables.
function armedSuiteMode(env){
    const source = env !== null && typeof env === 'object' ? env : {};
    const mode = expectMode(source.XC_OFFER_LIST_EXPECT);
    if(mode === 'armed') requireArmingVariables(source);
    return mode;
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

function requireText(name, value){
    if(typeof value !== 'string' || value === '')
        throw new Error(name + ' must be a non-empty string');
}

function requirePositive(name, value){
    if(!Number.isSafeInteger(value) || value <= 0)
        throw new Error(name + ' must be a positive safe integer');
}

function requireOrderInputs(plan, order){
    const o = order || {};
    const p = plan || {};
    requireText('makerChain', o.makerChain);
    requireText('takerChain', o.takerChain);
    if(o.makerChain === o.takerChain) throw new Error('makerChain and takerChain must differ');
    requireText('makerTick', o.makerTick);
    requireText('takerTick', o.takerTick);
    requireText('makerGetAddress', o.makerGetAddress);
    requirePositive('amount', o.amount);
    requirePositive('expiration', o.expiration);
    if(typeof p.allowList !== 'string') throw new Error('allowList must be a string');
    if(typeof p.blockList !== 'string') throw new Error('blockList must be a string');
    requireText('takerGetAddress', p.takerGetAddress);
}

// Builds the maker order carrying the list and the list-free counter-order. The
// counter-order GET_ADDRESS is the maker-chain payout address the hub checks
// against the maker's list members.
function armedOrderActions(plan, order){
    requireOrderInputs(plan, order);
    const o = order;
    const maker = {
        action: 'ORDER',
        params: {
            giveCoin: o.makerChain,
            giveTick: o.makerTick,
            giveAmount: o.amount,
            getCoin: o.takerChain,
            getTick: o.takerTick,
            getAmount: o.amount,
            getAddress: o.makerGetAddress,
            expiration: o.expiration,
            allowList: plan.allowList,
            blockList: plan.blockList
        }
    };
    const taker = {
        action: 'ORDER',
        params: {
            giveCoin: o.takerChain,
            giveTick: o.takerTick,
            giveAmount: o.amount,
            getCoin: o.makerChain,
            getTick: o.makerTick,
            getAmount: o.amount,
            getAddress: plan.takerGetAddress,
            expiration: o.expiration,
            allowList: '',
            blockList: ''
        }
    };
    return { maker, taker };
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

// Reads the pair rows up to attempts times. An unmatched pair cannot be told apart
// from one the hub has not matched yet, so only the last read decides unmatched.
async function settlePairOutcome({ read, sleep, attempts, intervalMs } = {}){
    if(!Number.isSafeInteger(attempts) || attempts <= 0)
        throw new Error('attempts must be a positive integer');
    if(!Number.isSafeInteger(intervalMs) || intervalMs < 0)
        throw new Error('intervalMs must be a non-negative integer');
    if(typeof read !== 'function') throw new Error('read must be a function');
    if(typeof sleep !== 'function') throw new Error('sleep must be a function');
    for(let attempt = 1; attempt <= attempts; attempt++){
        if(observedOutcome(await read()) === 'matched') return 'matched';
        if(attempt < attempts) await sleep(intervalMs);
    }
    return 'unmatched';
}

// The protocol LIST type for an address list.
const ADDRESS_LIST_TYPE = 2;

// Builds the LIST action that creates the address list the maker's ALLOW_LIST or
// BLOCK_LIST names, in the shape the sdk tests broadcast.
function armedListAction(memberAddress){
    requireText('memberAddress', memberAddress);
    return { action: 'LIST', params: { type: ADDRESS_LIST_TYPE, item: memberAddress } };
}

function parseActionIndex(value){
    const n = typeof value === 'string' && /^[0-9]+$/.test(value) ? Number(value) : value;
    if(!Number.isSafeInteger(n) || n <= 0)
        throw new Error('indexed action_index must be a positive safe integer');
    return n;
}

// Reads the first indexed action's index from an sdk submit reply that waited for
// the indexer.
function indexedActionIndex(res){
    const indexed = res && res.indexed;
    const actions = indexed && indexed.actions;
    if(!Array.isArray(actions) || actions.length === 0) throw new Error('no indexed actions');
    if(indexed.status !== 'valid') throw new Error('indexed status is ' + indexed.status);
    return parseActionIndex(actions[0].action_index);
}

function requireSeatParty(seat, party){
    if(!party || typeof party !== 'object' || !party.sdk)
        throw new Error(seat + ' party must have an sdk');
    requireText(seat + ' address', party.address);
    requireText(seat + ' wif', party.wif);
}

// Adapts the sdk submit to the (seat, action) io.submit that runArmedCase takes.
function seatSubmitter(parties, { submit, submitOpts } = {}){
    if(typeof submit !== 'function') throw new Error('submit must be a function');
    if(typeof submitOpts !== 'function') throw new Error('submitOpts must be a function');
    const seats = parties || {};
    requireSeatParty('maker', seats.maker);
    requireSeatParty('taker', seats.taker);
    return async function submitSeat(seat, action){
        if(seat !== 'maker' && seat !== 'taker') throw new Error('seat must be maker or taker');
        const party = seats[seat];
        const to = { pubkey: party.address, change: party.address };
        return indexedActionIndex(await submit(party.sdk, action, to, submitOpts({ wif: party.wif })));
    };
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

function requireDriverIo(mode, io){
    if(mode !== 'armed' && mode !== 'inert') throw new Error('mode must be armed or inert');
    const source = io || {};
    for(const name of ['submit', 'query', 'sleep']){
        if(typeof source[name] !== 'function') throw new Error(name + ' must be a function');
    }
}

async function submitIndexed(io, seat, label, action){
    const index = await io.submit(seat, action);
    if(!Number.isSafeInteger(index) || index <= 0)
        throw new Error(label + ' action index must be a positive safe integer');
    return index;
}

// Drives one case through injected submit and query so the rail test only hands it
// real broadcast and database calls. Resolves to the observed outcome.
async function runArmedCase(testCase, mode, io){
    requireDriverIo(mode, io);
    const { memberAddress, outsiderAddress, order, attempts, intervalMs } = io;
    const listActionIndex = await submitIndexed(io, 'maker', 'LIST', armedListAction(memberAddress));
    const plan = planArmedCase(testCase, { listActionIndex, memberAddress, outsiderAddress });
    const { maker, taker } = armedOrderActions(plan, order);
    const makerIndex = await submitIndexed(io, 'maker', 'maker ORDER', maker);
    const takerIndex = await submitIndexed(io, 'taker', 'taker ORDER', taker);
    const { sql, params } = pairMatchQuery({
        makerChain: order.makerChain, makerIndex, takerChain: order.takerChain, takerIndex
    });
    const outcome = await settlePairOutcome({
        read: () => io.query(sql, params), sleep: io.sleep, attempts, intervalMs
    });
    checkArmedOutcome(testCase, mode, outcome);
    return outcome;
}

// Read adapter for runArmedCase's io.query: acquire, query, release, and hand
// back a plain array so a driver result's meta never reaches observedOutcome.
function connectionQuery(getConnection) {
    if (typeof getConnection !== 'function') {
        throw new TypeError('connectionQuery needs a getConnection function');
    }
    return async function query(sql, params) {
        const connection = await getConnection();
        try {
            return Array.from(await connection.query(sql, params));
        } finally {
            await connection.release();
        }
    };
}

module.exports = {
    ADDRESS_LIST_TYPE,
    ARMING_VARIABLES,
    OFFER_LIST_ARMED_CASES,
    armedListAction,
    armedOrderActions,
    armedSuiteMode,
    checkArmedOutcome,
    connectionQuery,
    expectMode,
    indexedActionIndex,
    observedOutcome,
    pairMatchQuery,
    planArmedCase,
    requireArmingVariables,
    runArmedCase,
    seatSubmitter,
    settlePairOutcome
};
