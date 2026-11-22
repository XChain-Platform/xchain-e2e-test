'use strict';

/*********************************************************************
 * Copyright (c) 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 * SPDX-License-Identifier: AGPL-3.0-or-later
 ********************************************************************/

const assert = require('assert');
const {
    connectionQuery,
    indexedActionIndex,
    seatSubmitter
} = require('../../../rail/offer_lists/helpers/armed_list_cases');

describe('offer list armed rail cases: connectionQuery', function(){
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

describe('offer list armed rail cases: seat submit adapter', function(){
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
