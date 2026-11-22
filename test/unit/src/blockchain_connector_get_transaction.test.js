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

// getTransaction reads null only from the node's "no such transaction" answer (-5);
// every other failure throws, so a negative reorg assertion cannot pass on a dead node.

const assert = require('assert');
const sinon = require('sinon');
const axios = require('axios');

const BlockchainConnector = require('../../../src/blockchain_connector');

// Build the rejection axios raises for a non-2xx reply carrying `data` as its body.
function makeHttpError(status, data = {}) {
    const err = new Error(`Request failed with status code ${status}`);
    err.response = { status, statusText: 'Error', data };
    return err;
}

describe('BlockchainConnector getTransaction failure handling', function () {
    let connector;
    let axiosPostStub;

    beforeEach(function () {
        axiosPostStub = sinon.stub(axios, 'post');
        connector = new BlockchainConnector('localhost', 8332, 'rpcuser', 'rpcpass');
    });
    afterEach(function () {
        sinon.restore();
    });

    it('throws when a failed request carries no not-found answer', async function () {
        axiosPostStub.rejects(makeHttpError(500));
        await assert.rejects(() => connector.getTransaction('boom'), /status code 500/);
    });

    it('throws on bad RPC credentials instead of reading the tx as unseen', async function () {
        axiosPostStub.rejects(makeHttpError(401, ''));
        await assert.rejects(() => connector.getTransaction('boom'), /status code 401/);
    });

    it('throws when the node is unreachable instead of reading the tx as unseen', async function () {
        axiosPostStub.rejects(Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:8332'), { code: 'ECONNREFUSED' }));
        await assert.rejects(() => connector.getTransaction('boom'), /ECONNREFUSED/);
    });

    it('throws on any other node error in the HTTP 200 reply shape', async function () {
        axiosPostStub.resolves({ status: 200, data: { error: { code: -28, message: 'Loading block index...' } } });
        await assert.rejects(() => connector.getTransaction('boom'), /getrawtransaction RPC error/);
    });

    it('throws on any other node error in the legacy HTTP 500 reply shape', async function () {
        axiosPostStub.rejects(makeHttpError(500, JSON.stringify({ error: { code: -28, message: 'Loading block index...' } })));
        await assert.rejects(() => connector.getTransaction('boom'), /status code 500/);
    });

    it('reads a legacy not-found answer sent as a JSON string body', async function () {
        axiosPostStub.rejects(makeHttpError(500, JSON.stringify({ result: null, error: { code: -5, message: 'No such mempool or blockchain transaction' } })));
        assert.strictEqual(await connector.getTransaction('gone'), null);
    });
});
