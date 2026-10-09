'use strict'

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const assert = require('assert')
const sinon = require('sinon')
const axios = require('axios')

const { minerRpc } = require('../../helpers/minerRpc')

const URL = 'http://miner.invalid:18444'

describe('minerRpc', function () {
    let post
    beforeEach(function () { post = sinon.stub(axios, 'post') })
    afterEach(function () { sinon.restore() })

    it('rejects a refusal the miner returns inside result, naming the method', async function () {
        post.resolves({ data: { result: { error: 'There was a problem generating blocks: mining is disabled' } } })
        await assert.rejects(minerRpc(URL, 'generate_blocks', { count: 1 }),
            /^Error: generate_blocks: There was a problem generating blocks: mining is disabled$/)
    })

    it('rejects a top-level JSON-RPC error', async function () {
        post.resolves({ data: { error: { message: 'Method not found' } } })
        await assert.rejects(minerRpc(URL, 'send_funds', {}), /^Error: send_funds: Method not found$/)
    })

    it('rejects a reply with no result', async function () {
        post.resolves({ data: {} })
        await assert.rejects(minerRpc(URL, 'generate_blocks', {}), /^Error: generate_blocks: .*no result/)
    })

    it('returns a successful result unchanged', async function () {
        post.resolves({ data: { result: { count: 2, hashes: ['a', 'b'] } } })
        assert.deepStrictEqual(await minerRpc(URL, 'generate_blocks', { count: 2 }), { count: 2, hashes: ['a', 'b'] })
        post.resolves({ data: { result: 'txid123' } })
        assert.strictEqual(await minerRpc(URL, 'send_funds', { address: 'x', amount: 1 }), 'txid123')
    })

    it('posts a JSON-RPC 2.0 body with the default 20 s timeout', async function () {
        post.resolves({ data: { result: 'ok' } })
        await minerRpc(URL, 'generate_blocks', { count: 3 })
        assert.deepStrictEqual(post.firstCall.args, [URL,
            { jsonrpc: '2.0', method: 'generate_blocks', params: { count: 3 }, id: 1 }, { timeout: 20000 }])
    })

    it('passes an explicit timeout through, 0 included', async function () {
        post.resolves({ data: { result: 'ok' } })
        await minerRpc(URL, 'generate_blocks', {}, { timeout: 0 })
        assert.deepStrictEqual(post.firstCall.args[2], { timeout: 0 })
    })
})
