'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const assert = require('assert');
const sinon  = require('sinon');
const axios  = require('axios');

const XChainEncoderConnector = require('../../../src/XChainEncoderConnector');

describe('XChainEncoderConnector', function () {

    const URL  = 'localhost';
    const PORT = 8080;
    // The third positional arg is the optional encoder API key, so nothing stale
    // may be passed here: a leftover rpcUser string would silently become the key
    // and be sent as x-api-key on every request.
    const API_KEY = 'encoder-key';

    let connector;
    let axiosPostStub;

    beforeEach(function () {
        axiosPostStub = sinon.stub(axios, 'post');
        connector = new XChainEncoderConnector(URL, PORT);
    });

    afterEach(function () {
        sinon.restore();
    });

    describe('constructor', function () {
        it('builds the URL as http://{url}:{port}', function () {
            assert.strictEqual(connector.url, `http://${URL}:${PORT}`);
        });

        it('stores port', function () {
            assert.strictEqual(connector.port, PORT);
        });

        it('does NOT store rpcUser or rpcPassword', function () {
            assert.strictEqual(connector.rpcUser, undefined);
            assert.strictEqual(connector.rpcPassword, undefined);
        });

        it('defaults to no api key and an empty request config', function () {
            assert.strictEqual(connector.apiKey, null);
            assert.deepStrictEqual(connector.reqConfig, {});
        });

        it('builds an x-api-key request config when a key is supplied', function () {
            const keyed = new XChainEncoderConnector(URL, PORT, API_KEY);
            assert.strictEqual(keyed.apiKey, API_KEY);
            assert.deepStrictEqual(keyed.reqConfig, { headers: { 'x-api-key': API_KEY } });
        });

        it('treats an empty-string key as no key', function () {
            const unkeyed = new XChainEncoderConnector(URL, PORT, '');
            assert.strictEqual(unkeyed.apiKey, null);
            assert.deepStrictEqual(unkeyed.reqConfig, {});
        });
    });

    // The encoder 401s every JSON-RPC method when it is deployed with API_KEY set,
    // ping included, so each request has to carry the header or the harness dies at
    // bootstrap. These assert the third axios.post argument, which is where a
    // regression would show up as undefined.
    describe('api key header', function () {
        const methods = [
            ['ping', (c) => c.ping()],
            ['createTx', (c) => c.createTx([], 'pk', [], {}, '', 1, false, 'OP_RETURN', 'chg', null, null, null)],
            ['createEnvelopeCancelTx', (c) => c.createEnvelopeCancelTx({
                commitTxid: 'tx', commitVout: 0, commitValue: 1000,
                internalPubkey: 'ipk', tapleafHash: 'tlh', destination: 'dest'
            })]
        ];

        methods.forEach(function ([name, invoke]) {
            it(`${name} sends x-api-key when a key is configured`, async function () {
                axiosPostStub.resolves({ data: { result: 'ok' } });
                const keyed = new XChainEncoderConnector(URL, PORT, API_KEY);
                await invoke(keyed);
                const [, , config] = axiosPostStub.firstCall.args;
                assert.deepStrictEqual(config, { headers: { 'x-api-key': API_KEY } });
            });

            it(`${name} sends an empty config when no key is configured`, async function () {
                axiosPostStub.resolves({ data: { result: 'ok' } });
                await invoke(connector);
                const [, , config] = axiosPostStub.firstCall.args;
                assert.deepStrictEqual(config, {});
            });
        });
    });

    describe('ping', function () {
        it('returns true when response.data.result is truthy', async function () {
            axiosPostStub.resolves({ data: { result: 'pong' } });
            const result = await connector.ping();
            assert.strictEqual(result, true);
        });

        it('returns false when response.data.result is falsy', async function () {
            axiosPostStub.resolves({ data: { result: null } });
            const result = await connector.ping();
            assert.strictEqual(result, false);
        });

        it('returns false when axios throws', async function () {
            axiosPostStub.rejects(new Error('ECONNREFUSED'));
            const result = await connector.ping();
            assert.strictEqual(result, false);
        });
    });

    describe('createTx', function () {
        const utxosList       = [{ txid: 'abc', vout: 0, value: 10000 }];
        const pubkey          = 'mypubkey';
        const customOutputs   = [{ address: 'addr1', value: 500 }];
        const data            = { action: 'ISSUE' };
        const rawData         = 'deadbeef';
        const exactFee        = 1000;
        const rbf             = false;
        const outputType      = 'OP_RETURN';
        const changeAddress   = 'changeaddr';
        const p2shHash        = 'p2shHashHex';
        const p2shHex         = 'p2shHexValue';
        const compressedPubKey = 'compressedKey';

        const fakeResult = { psbt: 'psbtHex', encoding: 'OP_RETURN' };

        async function callCreateTx() {
            return connector.createTx(
                utxosList, pubkey, customOutputs, data, rawData,
                exactFee, rbf, outputType, changeAddress,
                p2shHash, p2shHex, compressedPubKey
            );
        }

        it('posts to the correct URL', async function () {
            axiosPostStub.resolves({ data: { result: fakeResult } });
            await callCreateTx();
            const [url] = axiosPostStub.firstCall.args;
            assert.strictEqual(url, connector.url);
        });

        it('sends method create_tx', async function () {
            axiosPostStub.resolves({ data: { result: fakeResult } });
            await callCreateTx();
            const [, payload] = axiosPostStub.firstCall.args;
            assert.strictEqual(payload.method, 'create_tx');
        });

        it('maps all 12 parameters to the correct param keys', async function () {
            axiosPostStub.resolves({ data: { result: fakeResult } });
            await callCreateTx();

            const [, payload] = axiosPostStub.firstCall.args;
            const p = payload.params;

            assert.deepStrictEqual(p.utxos,            utxosList,      'utxos');
            assert.strictEqual(p.pubkey,               pubkey,         'pubkey');
            assert.deepStrictEqual(p.customOutputs,    customOutputs,  'customOutputs');
            assert.deepStrictEqual(p.data,             data,           'data');
            assert.strictEqual(p.rawData,              rawData,        'rawData');
            assert.strictEqual(p.fee,                  exactFee,       'fee');
            assert.strictEqual(p.rbf,                  rbf,            'rbf');
            assert.strictEqual(p.encoding,             outputType,     'encoding');
            assert.strictEqual(p.change,               changeAddress,  'change');
            assert.strictEqual(p.p2shHash,             p2shHash,       'p2shHash');
            assert.strictEqual(p.p2shHex,              p2shHex,        'p2shHex');
            assert.strictEqual(p.compressedPubKey,     compressedPubKey, 'compressedPubKey');
        });

        it('returns result on success', async function () {
            axiosPostStub.resolves({ data: { result: fakeResult } });
            const result = await callCreateTx();
            assert.deepStrictEqual(result, fakeResult);
        });

        it('throws when axios rejects', async function () {
            axiosPostStub.rejects(new Error('network error'));
            await assert.rejects(callCreateTx, /Error trying to create a tx/);
        });

        it('throws when result is falsy', async function () {
            axiosPostStub.resolves({ data: { result: null } });
            await assert.rejects(callCreateTx, /Error trying to create a tx/);
        });
    });
});
