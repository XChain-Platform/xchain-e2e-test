// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// The encoder refuses a build whose tracker view has no UTXOs yet with -32010 and
// data.reason NO_UTXOS. The connector carries that reason on the error it throws,
// and the three stale-UTXO retry predicates key on it, never on message text or on
// the generic -32603 "Internal encoder error" an unrelated encoder fault returns.

'use strict';

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');
const sinon  = require('sinon');
const axios  = require('axios');

const XChainEncoderConnector = require('../../../src/XChainEncoderConnector');
const { isNoUtxosRefusal } = require('../../helpers/core/no_utxos_refusal');

const ROOT = path.resolve(__dirname, '../../..');
const NO_UTXOS_BODY = { error: { code: -32010, message: 'no utxos were provided and no utxos found on the blockchain', data: { reason: 'NO_UTXOS' } } };
const GENERIC_BODY  = { error: { code: -32603, message: 'Internal encoder error' } };

function connector() {
    return new XChainEncoderConnector('http://encoder', 8080);
}

function createTx(c) {
    return c.createTx([], 'pubkey', [], 'data', null, null, false, 'p2pkh', null, null, null, null, false);
}

async function rejection(promise) {
    try { await promise; } catch (err) { return err; }
    throw new Error('expected a rejection');
}

function registerConnectorTests() {
    afterEach(() => sinon.restore());

    it('createTx surfaces the NO_UTXOS reason code and the encoder message', async function () {
        sinon.stub(axios, 'post').resolves({ data: NO_UTXOS_BODY });
        const err = await rejection(createTx(connector()));
        assert.strictEqual(err.rpcReason, 'NO_UTXOS');
        assert.strictEqual(err.rpcCode, -32010);
        assert.deepStrictEqual(err.rpcData, { reason: 'NO_UTXOS' });
        assert.strictEqual(err.message,
            'Error trying to create a tx with the encoder module: no utxos were provided and no utxos found on the blockchain');
        assert.strictEqual(isNoUtxosRefusal(err), true);
    });

    it('createTx leaves the reason empty for a generic -32603', async function () {
        sinon.stub(axios, 'post').resolves({ data: GENERIC_BODY });
        const err = await rejection(createTx(connector()));
        assert.strictEqual(err.rpcCode, -32603);
        assert.strictEqual(err.rpcReason, null);
        assert.strictEqual(isNoUtxosRefusal(err), false);
    });

    it('createTx still names a body with neither result nor error', async function () {
        sinon.stub(axios, 'post').resolves({ data: {} });
        const err = await rejection(createTx(connector()));
        assert.match(err.message, /no result and no error returned$/);
        assert.strictEqual(err.rpcCode, null);
        assert.strictEqual(err.rpcReason, null);
    });

    it('the envelope cancel builder carries the reason too', async function () {
        sinon.stub(axios, 'post').resolves({ data: NO_UTXOS_BODY });
        const err = await rejection(connector().createEnvelopeCancelTx({ commitTxid: 'aa', vout: 0 }));
        assert.match(err.message, /^Error trying to create an envelope cancel tx: no utxos were provided/);
        assert.strictEqual(err.rpcReason, 'NO_UTXOS');
    });
}

function registerHelperTests() {
    it('recognises all three shapes that carry NO_UTXOS', function () {
        assert.strictEqual(isNoUtxosRefusal(Object.assign(new Error('x'), { rpcReason: 'NO_UTXOS' })), true);
        assert.strictEqual(isNoUtxosRefusal(Object.assign(new Error('x'), { code: 'NO_UTXOS' })), true);
        assert.strictEqual(isNoUtxosRefusal(Object.assign(new Error('x'),
            { code: 'ENCODER_RPC', details: { context: { reason: 'NO_UTXOS' } } })), true);
    });

    it('never matches on wording or on the generic internal error', function () {
        assert.strictEqual(isNoUtxosRefusal(new Error('no utxos were provided and no utxos found')), false);
        assert.strictEqual(isNoUtxosRefusal(new Error('Internal encoder error')), false);
        assert.strictEqual(isNoUtxosRefusal(Object.assign(new Error('x'), { rpcReason: 'UTXO_TRACKER_STALE' })), false);
        assert.strictEqual(isNoUtxosRefusal(null), false);
        assert.strictEqual(isNoUtxosRefusal('NO_UTXOS'), false);
    });
}

function registerPredicateTests() {
    afterEach(() => sinon.restore());

    it('the SDK suite retries a NO_UTXOS refusal and not a generic -32603', function () {
        const { isTransientStackError } = require('../../sdk/helpers/sdkHelper');
        assert.strictEqual(isTransientStackError(Object.assign(new Error('x'),
            { details: { context: { reason: 'NO_UTXOS' } } })), true);
        assert.strictEqual(isTransientStackError(Object.assign(new Error('x'), { code: 'NO_UTXOS' })), true);
        assert.strictEqual(isTransientStackError(new Error('Encoder RPC error: Internal encoder error (code -32603)')), false);
        assert.strictEqual(isTransientStackError(new Error('bad-txns-inputs-missingorspent')), true, 'node-side races still retry');
    });

    it('the relay drill retries a NO_UTXOS refusal and rethrows a generic -32603 at once', async function () {
        const { resilientSend } = require('../../sdk/attestation_relay_loop_drill.test/support/rail');
        const rail = { globals: { utxoTrackerConnector: { quiesce: sinon.stub().resolves() }, regtestMinerConnector: {} } };
        sinon.stub(console, 'log');
        const flaky = sinon.stub();
        flaky.onFirstCall().rejects(Object.assign(new Error('Error trying to create a tx'), { rpcReason: 'NO_UTXOS' }));
        flaky.onSecondCall().resolves('txid');
        assert.strictEqual(await resilientSend('send', rail, flaky, 3), 'txid');

        const broken = sinon.stub().rejects(Object.assign(new Error('Internal encoder error'), { rpcCode: -32603 }));
        await assert.rejects(resilientSend('send', rail, broken, 3), /Internal encoder error/);
        assert.strictEqual(broken.callCount, 1, 'a generic internal error is not retried');
    });

    it('the connector suite\x27s stale-UTXO predicate keys on the reason, not the generic error', function () {
        const src = fs.readFileSync(path.join(ROOT, 'test/helpers/core/transactionHelper/lib/01_create_and_send_transaction.js'), 'utf8');
        const body = src.slice(src.indexOf('function internalIsStaleUtxoError'), src.indexOf('module.exports'));
        assert.match(body, /return isNoUtxosRefusal\(err\) \|\|/);
        assert.doesNotMatch(body, /Internal encoder error\|/);
        assert.doesNotMatch(body, /no utxos\.\*no utxos/);
    });
}

describe('XChainEncoderConnector NO_UTXOS reason @regression', function () {
    describe('connector', registerConnectorTests);
    describe('isNoUtxosRefusal', registerHelperTests);
    describe('stale-UTXO retry predicates', registerPredicateTests);
});
