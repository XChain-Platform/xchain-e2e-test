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

const XChainDecoderConnector = require('../../../src/XChainDecoderConnector');

// A readiness poll checks its deadline only between requests, so a decoder that
// accepts the socket and never answers must not leave ping/health pending forever.
describe('XChainDecoderConnector probe timeouts', function () {
    let connector;
    let post;
    beforeEach(function () {
        post = sinon.stub(axios, 'post');
        connector = new XChainDecoderConnector('localhost', 4001);
    });
    afterEach(function () { sinon.restore(); });

    it('bounds ping and health', async function () {
        post.resolves({ data: { result: { ok: true } } });
        assert.strictEqual(await connector.ping(), true);
        assert.deepStrictEqual(await connector.health(), { ok: true });
        assert.ok(post.firstCall.args[2].timeout > 0, 'ping posted with no timeout');
        assert.ok(post.secondCall.args[2].timeout > 0, 'health posted with no timeout');
    });

    it('maps a timed-out probe to its false/null sentinel', async function () {
        post.rejects(Object.assign(new Error('timeout of 5000ms exceeded'), { code: 'ECONNABORTED' }));
        const info = sinon.stub(console, 'info');
        try {
            assert.strictEqual(await connector.ping(), false);
            assert.strictEqual(await connector.health(), null);
        } finally { info.restore(); }
    });
});
