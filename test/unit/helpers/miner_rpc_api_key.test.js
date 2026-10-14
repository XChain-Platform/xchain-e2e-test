/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 *********************************************************************/

'use strict'

// minerRpc against a miner started with MINER_API_KEY: the key rides as x-api-key and a 401 names it.

const assert = require('assert')
const sinon = require('sinon')
const axios = require('axios')

const { minerRpc, resolveMinerApiKey } = require('../../helpers/minerRpc')

const URL = 'http://miner.invalid:18444'
const KEYS = ['MINER_API_KEY', 'DOGE_MINER_API_KEY']

function unauthorized () {
    const err = new Error('Request failed with status code 401')
    err.response = { status: 401, data: { error: 'Unauthorized: missing or invalid X-API-Key' } }
    return err
}

describe('minerRpc with a keyed miner', function () {
    let post
    const savedEnv = {}
    beforeEach(function () {
        for (const k of KEYS) { savedEnv[k] = process.env[k]; delete process.env[k] }
        post = sinon.stub(axios, 'post').resolves({ data: { result: 'ok' } })
    })
    afterEach(function () {
        sinon.restore()
        for (const k of KEYS) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k] }
    })

    it('sends an explicit apiKey as x-api-key beside the timeout', async function () {
        await minerRpc(URL, 'generate_blocks', { count: 1 }, { apiKey: 'k1' })
        assert.deepStrictEqual(post.firstCall.args[2], { headers: { 'x-api-key': 'k1' }, timeout: 20000 })
    })

    it('falls back to MINER_API_KEY when no apiKey or coin is given', async function () {
        process.env.MINER_API_KEY = 'generic'
        await minerRpc(URL, 'send_funds', { address: 'x', amount: 1 })
        assert.strictEqual(post.firstCall.args[2].headers['x-api-key'], 'generic')
    })

    it('prefers the per-chain key over MINER_API_KEY when a coin is given', async function () {
        process.env.MINER_API_KEY = 'generic'
        process.env.DOGE_MINER_API_KEY = 'doge'
        await minerRpc(URL, 'generate_blocks', {}, { coin: 'DOGE' })
        assert.strictEqual(post.firstCall.args[2].headers['x-api-key'], 'doge')
    })

    it('sends no header for apiKey null even when the env holds a key', async function () {
        process.env.MINER_API_KEY = 'generic'
        await minerRpc(URL, 'generate_blocks', {}, { apiKey: null, timeout: 0 })
        assert.deepStrictEqual(post.firstCall.args[2], { timeout: 0 })
    })

    it('rejects a 401 with the method and the key to check, not a bare status line', async function () {
        post.rejects(unauthorized())
        await assert.rejects(minerRpc(URL, 'generate_blocks', { count: 1 }),
            /refused generate_blocks: .*MINER_API_KEY/)
    })

    it('passes a transport error with no response through unchanged', async function () {
        const refused = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })
        post.rejects(refused)
        await assert.rejects(minerRpc(URL, 'generate_blocks', {}), (e) => e === refused)
    })
})

describe('resolveMinerApiKey', function () {
    const savedEnv = {}
    beforeEach(function () { for (const k of KEYS) { savedEnv[k] = process.env[k]; delete process.env[k] } })
    afterEach(function () { for (const k of KEYS) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k] } })

    it('reads the per-chain key, then MINER_API_KEY, then null', function () {
        assert.strictEqual(resolveMinerApiKey('DOGE'), null)
        process.env.MINER_API_KEY = 'generic'
        assert.strictEqual(resolveMinerApiKey('DOGE'), 'generic')
        assert.strictEqual(resolveMinerApiKey(), 'generic')
        process.env.DOGE_MINER_API_KEY = 'doge'
        assert.strictEqual(resolveMinerApiKey('DOGE'), 'doge')
    })
})
