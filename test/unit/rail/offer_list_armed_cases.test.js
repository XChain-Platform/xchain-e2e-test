'use strict';

/*********************************************************************
 * Copyright (c) 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 * SPDX-License-Identifier: AGPL-3.0-or-later
 ********************************************************************/

const assert = require('assert');
const {
    ADDRESS_LIST_TYPE,
    OFFER_LIST_ARMED_CASES,
    armedListAction,
    armedOrderActions,
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
} = require('../../rail/offer_lists/helpers/armed_list_cases');

describe('offer list armed rail cases', function(){
    it('pins the ordered cases', function(){
        assert.deepStrictEqual(OFFER_LIST_ARMED_CASES, [
            {
                name: 'allow list, counter-order GET_ADDRESS is a member',
                list: 'allow_list',
                member: true,
                armed: { outcome: 'matched' },
                inert: { outcome: 'matched' }
            },
            {
                name: 'allow list, counter-order GET_ADDRESS is not a member',
                list: 'allow_list',
                member: false,
                armed: { outcome: 'unmatched', reason: 'taker not on allow list' },
                inert: { outcome: 'matched' }
            },
            {
                name: 'block list, counter-order GET_ADDRESS is a member',
                list: 'block_list',
                member: true,
                armed: { outcome: 'unmatched', reason: 'taker on block list' },
                inert: { outcome: 'matched' }
            },
            {
                name: 'block list, counter-order GET_ADDRESS is not a member',
                list: 'block_list',
                member: false,
                armed: { outcome: 'matched' },
                inert: { outcome: 'matched' }
            }
        ]);
    });

    it('freezes the table, entries and outcomes', function(){
        assert(Object.isFrozen(OFFER_LIST_ARMED_CASES));
        for(const testCase of OFFER_LIST_ARMED_CASES){
            assert(Object.isFrozen(testCase));
            assert(Object.isFrozen(testCase.armed));
            assert(Object.isFrozen(testCase.inert));
        }
    });

    it('selects armed mode by default and accepts explicit modes', function(){
        assert.strictEqual(expectMode(undefined), 'armed');
        assert.strictEqual(expectMode(''), 'armed');
        assert.strictEqual(expectMode('armed'), 'armed');
        assert.strictEqual(expectMode('inert'), 'inert');
    });

    it('rejects an unknown mode', function(){
        assert.throws(() => expectMode('sometimes'), /XC_OFFER_LIST_EXPECT must be armed or inert/);
    });

    it('accepts an environment with both arming variables set', function(){
        requireArmingVariables({
            XC_OFFER_LIST_REGTEST_ACTIVATION: '1',
            EXACT_INTEGER_WIRE_FIELDS_REGTEST_TIME: '1'
        });
    });

    it('names XC_OFFER_LIST_REGTEST_ACTIVATION when it is unset', function(){
        assert.throws(
            () => requireArmingVariables({ EXACT_INTEGER_WIRE_FIELDS_REGTEST_TIME: '1' }),
            /XC_OFFER_LIST_REGTEST_ACTIVATION/
        );
        assert.throws(
            () => requireArmingVariables({
                XC_OFFER_LIST_REGTEST_ACTIVATION: '',
                EXACT_INTEGER_WIRE_FIELDS_REGTEST_TIME: '1'
            }),
            /XC_OFFER_LIST_REGTEST_ACTIVATION/
        );
    });

    it('names EXACT_INTEGER_WIRE_FIELDS_REGTEST_TIME when it is unset', function(){
        assert.throws(
            () => requireArmingVariables({ XC_OFFER_LIST_REGTEST_ACTIVATION: '1' }),
            /EXACT_INTEGER_WIRE_FIELDS_REGTEST_TIME/
        );
        assert.throws(() => requireArmingVariables({}), /REGTEST/);
    });

    it('plans the list fields and counter-order address for every case', function(){
        const plan = { listActionIndex: 7, memberAddress: 'bcrt1qmember', outsiderAddress: 'bcrt1qoutsider' };
        const expected = [
            { allowList: '7', blockList: '', takerGetAddress: 'bcrt1qmember' },
            { allowList: '7', blockList: '', takerGetAddress: 'bcrt1qoutsider' },
            { allowList: '', blockList: '7', takerGetAddress: 'bcrt1qmember' },
            { allowList: '', blockList: '7', takerGetAddress: 'bcrt1qoutsider' }
        ];
        assert.strictEqual(OFFER_LIST_ARMED_CASES.length, expected.length);
        OFFER_LIST_ARMED_CASES.forEach((testCase, i) => {
            assert.deepStrictEqual(planArmedCase(testCase, plan), expected[i]);
        });

        const c = OFFER_LIST_ARMED_CASES[0];
        for(const bad of [0, -1, 1.5, '7', NaN, undefined])
            assert.throws(() => planArmedCase(c, { ...plan, listActionIndex: bad }), /listActionIndex/);
        for(const bad of ['', undefined])
            assert.throws(() => planArmedCase(c, { ...plan, memberAddress: bad }), /memberAddress/);
        for(const bad of ['', undefined])
            assert.throws(() => planArmedCase(c, { ...plan, outsiderAddress: bad }), /outsiderAddress/);
        assert.throws(() => planArmedCase(c, { ...plan, outsiderAddress: plan.memberAddress }), /differ/);
    });

    it('reads the pair match outcome from cross_chain_matches rows', function(){
        const pair = { makerChain: 'BTC', makerIndex: 11, takerChain: 'DOGE', takerIndex: 7 };
        const q = pairMatchQuery(pair);
        assert.deepStrictEqual(q.params, ['BTC', 11, 'DOGE', 7, 'DOGE', 7, 'BTC', 11]);
        assert(/cross_chain_matches/.test(q.sql));
        assert(/match_id, status/.test(q.sql));
        for(const bad of ['', undefined, 5])
            assert.throws(() => pairMatchQuery({ ...pair, makerChain: bad }), /makerChain/);
        for(const bad of ['', null])
            assert.throws(() => pairMatchQuery({ ...pair, takerChain: bad }), /takerChain/);
        for(const bad of [0, -1, 1.5, '7', Number.MAX_SAFE_INTEGER + 1])
            assert.throws(() => pairMatchQuery({ ...pair, makerIndex: bad }), /makerIndex/);
        for(const bad of [0, NaN, undefined])
            assert.throws(() => pairMatchQuery({ ...pair, takerIndex: bad }), /takerIndex/);
        assert.throws(() => pairMatchQuery(undefined), /makerChain/);

        assert.strictEqual(observedOutcome([]), 'unmatched');
        assert.strictEqual(observedOutcome([{ status: 'retracted' }]), 'unmatched');
        assert.strictEqual(observedOutcome([{ status: 'finalized' }]), 'matched');
        assert.strictEqual(observedOutcome([{ status: 'retracted' }, { status: 'finalized' }]), 'matched');
        assert.throws(() => observedOutcome(null), /array/);
        assert.throws(() => observedOutcome({}), /array/);
        assert.throws(() => observedOutcome([{ status: 'pending' }]), /pending/);
        assert.throws(() => observedOutcome([{ status: 'finalized' }, {}]), /status/);

        const [first, second] = OFFER_LIST_ARMED_CASES;
        checkArmedOutcome(first, 'armed', 'matched');
        checkArmedOutcome(second, 'inert', 'matched');
        checkArmedOutcome(second, 'armed', 'unmatched');
        assert.throws(
            () => checkArmedOutcome(second, 'armed', 'matched'),
            (err) => err instanceof Error
                && err.message.includes(second.name)
                && err.message.includes('armed')
                && err.message.includes('unmatched (taker not on allow list)')
                && err.message.includes('observed matched')
        );
        assert.throws(() => checkArmedOutcome(first, 'armed', 'unmatched'), /expected matched but/);
        assert.throws(() => checkArmedOutcome(first, 'bogus', 'matched'), /mode/);
    });

    it('settles the pair outcome by bounded polling', async function(){
        let reads = 0;
        let sleeps = 0;
        const sleep = async () => { sleeps++; };
        const rows = [[], [{ status: 'finalized' }]];
        const early = await settlePairOutcome({ read: async () => rows[reads++], sleep, attempts: 5, intervalMs: 0 });
        assert.deepStrictEqual([early, reads, sleeps], ['matched', 2, 1]);

        reads = 0;
        sleeps = 0;
        const read = async () => { reads++; return [{ status: 'retracted' }]; };
        const late = await settlePairOutcome({ read, sleep, attempts: 3, intervalMs: 5 });
        assert.deepStrictEqual([late, reads, sleeps], ['unmatched', 3, 2]);

        const bad = async () => [{ status: 'pending' }];
        await assert.rejects(settlePairOutcome({ read: bad, sleep, attempts: 2, intervalMs: 0 }), /pending/);
        const failing = async () => { throw new Error('read failed'); };
        await assert.rejects(settlePairOutcome({ read: failing, sleep, attempts: 2, intervalMs: 0 }), /read failed/);
    });

    it('rejects invalid settle arguments before any read', async function(){
        let reads = 0;
        const read = async () => { reads++; return []; };
        const sleep = async () => {};
        const ok = { read, sleep, attempts: 1, intervalMs: 0 };
        for(const attempts of [0, -1, 1.5, '2', undefined])
            await assert.rejects(settlePairOutcome({ ...ok, attempts }), /attempts/);
        for(const intervalMs of [-1, 0.5, '1', undefined, Infinity])
            await assert.rejects(settlePairOutcome({ ...ok, intervalMs }), /intervalMs/);
        await assert.rejects(settlePairOutcome({ ...ok, read: null }), /read/);
        await assert.rejects(settlePairOutcome({ ...ok, sleep: null }), /sleep/);
        await assert.rejects(settlePairOutcome(undefined), /attempts/);
        assert.strictEqual(reads, 0);
    });

    it('builds the maker and counter-order actions from a plan', function(){
        const seats = { listActionIndex: 7, memberAddress: 'bcrt1qmember', outsiderAddress: 'bcrt1qoutsider' };
        const allow = planArmedCase(OFFER_LIST_ARMED_CASES[1], seats);
        const block = planArmedCase(OFFER_LIST_ARMED_CASES[2], seats);
        const order = {
            makerChain: 'BTC', takerChain: 'DOGE', makerTick: 'MK', takerTick: 'TK',
            amount: 10, makerGetAddress: 'dogemaker', expiration: 2000000000
        };
        const pair = armedOrderActions(allow, order);
        assert.deepStrictEqual(pair.maker, {
            action: 'ORDER',
            params: {
                giveCoin: 'BTC', giveTick: 'MK', giveAmount: 10, getCoin: 'DOGE', getTick: 'TK',
                getAmount: 10, getAddress: 'dogemaker', expiration: 2000000000, allowList: '7', blockList: ''
            }
        });
        assert.deepStrictEqual(pair.taker, {
            action: 'ORDER',
            params: {
                giveCoin: 'DOGE', giveTick: 'TK', giveAmount: 10, getCoin: 'BTC', getTick: 'MK',
                getAmount: 10, getAddress: 'bcrt1qoutsider', expiration: 2000000000, allowList: '', blockList: ''
            }
        });
        const blocked = armedOrderActions(block, order);
        assert.deepStrictEqual([blocked.maker.params.allowList, blocked.maker.params.blockList], ['', '7']);
        assert.strictEqual(blocked.taker.params.getAddress, 'bcrt1qmember');
        assert.strictEqual(blocked.taker.params.blockList, '');
    });

    it('rejects invalid order and plan inputs for the order actions', function(){
        const seats = { listActionIndex: 7, memberAddress: 'bcrt1qmember', outsiderAddress: 'bcrt1qoutsider' };
        const plan = planArmedCase(OFFER_LIST_ARMED_CASES[0], seats);
        const order = {
            makerChain: 'BTC', takerChain: 'DOGE', makerTick: 'MK', takerTick: 'TK',
            amount: 10, makerGetAddress: 'dogemaker', expiration: 2000000000
        };
        const bad = [
            { makerChain: '' }, { makerChain: 5 }, { takerChain: '' }, { takerChain: 'BTC' },
            { makerTick: '' }, { takerTick: undefined }, { makerGetAddress: '' },
            { amount: 0 }, { amount: 1.5 }, { amount: '10' }, { amount: Number.MAX_SAFE_INTEGER + 1 },
            { expiration: 0 }, { expiration: 1.5 }, { expiration: -1 }
        ];
        for(const change of bad)
            assert.throws(() => armedOrderActions(plan, { ...order, ...change }), /must/);
        for(const change of [{ allowList: 7 }, { blockList: null }, { takerGetAddress: '' }])
            assert.throws(() => armedOrderActions({ ...plan, ...change }, order), /must/);
        assert.throws(() => armedOrderActions(undefined, order), /must/);
        assert.throws(() => armedOrderActions(plan, undefined), /must/);
    });

    it('builds the address list action for the member', function(){
        assert.strictEqual(ADDRESS_LIST_TYPE, 2);
        assert.deepStrictEqual(armedListAction('bcrt1qmember'), {
            action: 'LIST',
            params: { type: 2, item: 'bcrt1qmember' }
        });
        assert.throws(() => armedListAction(''), /memberAddress must be a non-empty string/);
        assert.throws(() => armedListAction(7), /memberAddress must be a non-empty string/);
        assert.throws(() => armedListAction(), /memberAddress must be a non-empty string/);
    });

    describe('runArmedCase', function(){
        const order = {
            makerChain: 'BTC', takerChain: 'DOGE', makerTick: 'MK', takerTick: 'TK',
            amount: 10, makerGetAddress: 'dogemaker', expiration: 2000000000
        };

        function fakeIo(rows){
            const t = { seen: [], queries: [] };
            let next = 10;
            t.io = {
                submit: async (seat, act) => {
                    t.seen.push(seat + ':' + act.action);
                    next += 1;
                    return next;
                },
                query: async (sql, params) => {
                    t.queries.push(params);
                    return rows;
                },
                sleep: async () => {},
                memberAddress: 'bcrt1qmember',
                outsiderAddress: 'bcrt1qoutsider',
                order,
                attempts: 2,
                intervalMs: 0
            };
            return t;
        }

        it('drives one armed case through injected submit and query', async function(){
            const t = fakeIo([{ status: 'finalized' }]);
            const outcome = await runArmedCase(OFFER_LIST_ARMED_CASES[0], 'armed', t.io);
            assert.strictEqual(outcome, 'matched');
            assert.deepStrictEqual(t.seen, ['maker:LIST', 'maker:ORDER', 'taker:ORDER']);
            assert.deepStrictEqual(t.queries, [['BTC', 12, 'DOGE', 13, 'DOGE', 13, 'BTC', 12]]);
        });

        it('returns unmatched after every attempt reads no row', async function(){
            const t = fakeIo([]);
            const outcome = await runArmedCase(OFFER_LIST_ARMED_CASES[2], 'armed', t.io);
            assert.strictEqual(outcome, 'unmatched');
            assert.strictEqual(t.queries.length, 2);
        });

        it('rejects an outcome that differs from the mode', async function(){
            const t = fakeIo([]);
            await assert.rejects(runArmedCase(OFFER_LIST_ARMED_CASES[1], 'inert', t.io), /expected matched/);
        });

        it('rejects a bad mode or io before any submit', async function(){
            const t = fakeIo([]);
            await assert.rejects(runArmedCase(OFFER_LIST_ARMED_CASES[0], 'bogus', t.io), /mode/);
            t.io.query = null;
            await assert.rejects(runArmedCase(OFFER_LIST_ARMED_CASES[0], 'armed', t.io), /query/);
            assert.strictEqual(t.seen.length, 0);
        });

        it('rejects a submit result that is not a positive integer', async function(){
            const t = fakeIo([]);
            t.io.submit = async () => '7';
            await assert.rejects(runArmedCase(OFFER_LIST_ARMED_CASES[0], 'armed', t.io), /LIST/);
        });
    });

    describe('connectionQuery', function(){
        function fakeConnection(log, fail) {
            return {
                query: async (sql, params) => {
                    log.push(['query', sql, params]);
                    if (fail) throw fail;
                    const rows = [{ status: 'finalized' }];
                    rows.meta = [1];
                    return rows;
                },
                release: async () => { log.push(['release']); }
            };
        }

        it('reads rows through an injected connection and always releases it', async function(){
            const log = [];
            const read = connectionQuery(async () => { log.push(['acquire']); return fakeConnection(log); });
            const rows = await read('SELECT 1', [1, 2]);
            assert.deepStrictEqual(rows, [{ status: 'finalized' }]);
            assert.strictEqual(rows.meta, undefined);
            assert.deepStrictEqual(log, [['acquire'], ['query', 'SELECT 1', [1, 2]], ['release']]);
        });

        it('releases after a throwing query and propagates its error', async function(){
            const log = [];
            const boom = new Error('boom');
            const read = connectionQuery(async () => fakeConnection(log, boom));
            await assert.rejects(read('SELECT 1', []), err => err === boom);
            assert.deepStrictEqual(log[log.length - 1], ['release']);
        });

        it('throws at construction when getConnection is not a function', function(){
            assert.throws(() => connectionQuery(null), /getConnection/);
            assert.throws(() => connectionQuery('pool'), /getConnection/);
        });
    });

    describe('seat submit adapter', function(){
        const reply = (index) => ({ indexed: { status: 'valid', actions: [{ action_index: index }] } });
        const submitOpts = (x) => ({ waitForIndexer: true, ...x });
        const parties = {
            maker: { sdk: 'SM', address: 'bcrt1qmaker', wif: 'WM' },
            taker: { sdk: 'ST', address: 'dogetaker', wif: 'WT' }
        };

        it('submits each seat through the injected sdk submit', async function(){
            const calls = [];
            const replies = ['12', 13];
            const submit = async (sdk, action, eo, opts) => {
                calls.push([sdk, action.action, eo, opts]);
                return reply(replies[calls.length - 1]);
            };
            const send = seatSubmitter(parties, { submit, submitOpts });
            assert.strictEqual(await send('maker', { action: 'LIST' }), 12);
            assert.strictEqual(await send('taker', { action: 'ORDER' }), 13);
            assert.deepStrictEqual(calls, [
                ['SM', 'LIST', { pubkey: 'bcrt1qmaker', change: 'bcrt1qmaker' }, { waitForIndexer: true, wif: 'WM' }],
                ['ST', 'ORDER', { pubkey: 'dogetaker', change: 'dogetaker' }, { waitForIndexer: true, wif: 'WT' }]
            ]);
            await assert.rejects(send('bystander', { action: 'LIST' }), /seat/);
            assert.strictEqual(calls.length, 2);
        });

        it('rejects replies without a usable first action index', function(){
            const bad = (status, actions) => () => indexedActionIndex({ indexed: { status, actions } });
            assert.throws(bad('invalid: bad list', [{ action_index: 5 }]), /invalid: bad list/);
            assert.throws(bad('valid', []), /no indexed actions/);
            assert.throws(() => indexedActionIndex(null), /no indexed actions/);
            assert.throws(() => indexedActionIndex({}), /no indexed actions/);
            assert.throws(bad('valid', [{ action_index: '0' }]), /positive/);
            assert.throws(bad('valid', [{ action_index: '1e3' }]), /positive/);
            assert.throws(bad('valid', [{ action_index: 1.5 }]), /positive/);
            assert.strictEqual(indexedActionIndex(reply('7')), 7);
        });

        it('throws on each bad construction', function(){
            const submit = async () => reply(1);
            const make = (p, io) => () => seatSubmitter(p, io);
            const noWif = { ...parties, taker: { ...parties.taker, wif: '' } };
            const noSdk = { ...parties, maker: { address: 'a', wif: 'w' } };
            assert.throws(make(parties, { submitOpts }), /submit/);
            assert.throws(make(parties, { submit }), /submitOpts/);
            assert.throws(make({ maker: parties.maker }, { submit, submitOpts }), /taker/);
            assert.throws(make({ taker: parties.taker }, { submit, submitOpts }), /maker/);
            assert.throws(make(noSdk, { submit, submitOpts }), /sdk/);
            assert.throws(make(noWif, { submit, submitOpts }), /wif/);
            assert.throws(make({ ...parties, maker: { ...parties.maker, address: 5 } }, { submit, submitOpts }), /address/);
        });
    });
});
