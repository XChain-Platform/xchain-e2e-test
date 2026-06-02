'use strict'

// Chaos Experiment 3: Hub Auto-Discovery Total Failure (@P1)
//
// Verifies that when all hub endpoints are unreachable, the hub connector
// returns null (not hangs), and bootstrap logic can detect the failure
// and produce a diagnostic error.

const assert = require('assert')
const sinon = require('sinon')
const axios = require('axios')
const XChainHubConnector = require('../../src/XChainHubConnector')

describe('Chaos Experiment 3 — Hub Auto-Discovery Total Failure @P1', function () {

    let savedEnv

    beforeEach(function () {
        savedEnv = {
            HUB_URL: process.env.HUB_URL,
            HUB_PORT: process.env.HUB_PORT,
            HUB_VALIDATORS: process.env.HUB_VALIDATORS,
            HUB_API_HOST: process.env.HUB_API_HOST,
        }
    })

    afterEach(function () {
        // Restore env vars
        for (const [k, v] of Object.entries(savedEnv)) {
            if (v === undefined) delete process.env[k]
            else process.env[k] = v
        }
        sinon.restore()
    })

    describe('_call returns null when all endpoints fail', function () {

        it('returns null when single endpoint rejects', async function () {
            sinon.stub(axios, 'post').rejects(new Error('ECONNREFUSED'))
            const hub = new XChainHubConnector('10.255.255.1', '9999')

            const result = await hub._call({ jsonrpc: '2.0', method: 'ping', id: 1 })

            assert.strictEqual(result, null)
            assert(axios.post.calledOnce)
        })

        it('returns null when multiple endpoints all reject', async function () {
            sinon.stub(axios, 'post').rejects(new Error('ECONNREFUSED'))
            const hub = new XChainHubConnector([
                'http://10.255.255.1:9999',
                'http://10.255.255.2:9999',
                'http://10.255.255.3:9999'
            ])

            const result = await hub._call({ jsonrpc: '2.0', method: 'ping', id: 1 })

            assert.strictEqual(result, null)
            assert.strictEqual(axios.post.callCount, 3, 'should try all 3 endpoints')
        })

        it('returns null when endpoints return invalid responses', async function () {
            sinon.stub(axios, 'post').resolves({ data: {} }) // missing result key
            const hub = new XChainHubConnector('10.255.255.1', '9999')

            const result = await hub._call({ jsonrpc: '2.0', method: 'getallconfigs', id: 1 })

            assert.strictEqual(result, null)
        })
    })

    describe('ping returns false when all endpoints fail', function () {

        it('ping returns false on ECONNREFUSED', async function () {
            sinon.stub(axios, 'post').rejects(new Error('ECONNREFUSED'))
            const hub = new XChainHubConnector('10.255.255.1', '9999')

            const result = await hub.ping()

            assert.strictEqual(result, false)
        })
    })

    describe('getAllConfig returns null when hub unreachable', function () {

        it('getAllConfig returns null when all endpoints fail', async function () {
            sinon.stub(axios, 'post').rejects(new Error('ETIMEDOUT'))
            const hub = new XChainHubConnector('10.255.255.1', '9999')

            const result = await hub.getAllConfig()

            assert.strictEqual(result, null)
        })
    })

    describe('reachable-but-degraded hub (HTTP 503) is distinguished from total failure', function () {

        // Axios throws on non-2xx but attaches the full response to err.response.
        // The hub's ping() returns HTTP 503 with a valid JSON-RPC "degraded" body
        // when its DB pool is down — a live hub, not an unreachable one.
        function degraded503Error() {
            const err = new Error('Request failed with status code 503')
            err.response = {
                status: 503,
                data: { jsonrpc: '2.0', id: 1, result: { status: 'degraded', db: false } }
            }
            return err
        }

        it('_call surfaces the degraded body rather than returning null', async function () {
            sinon.stub(axios, 'post').rejects(degraded503Error())
            const hub = new XChainHubConnector('10.255.255.1', '9999')

            const result = await hub._call({ jsonrpc: '2.0', method: 'ping', id: 1 })

            assert.deepStrictEqual(result, { status: 'degraded', db: false })
        })

        it('ping reports a degraded hub as reachable (true), not down (false)', async function () {
            sinon.stub(axios, 'post').rejects(degraded503Error())
            const hub = new XChainHubConnector('10.255.255.1', '9999')

            const result = await hub.ping()

            assert.strictEqual(result, true)
        })

        it('bootstrap no longer throws the "Can\'t connect" diagnostic for a degraded hub', async function () {
            sinon.stub(axios, 'post').rejects(degraded503Error())

            async function bootstrapFromHub() {
                const endpoints = ['http://10.255.255.1:9999', 'http://10.255.255.2:9999']
                const hub = new XChainHubConnector(endpoints)
                const pingResult = await hub.ping()
                if (!pingResult) {
                    throw new Error("Can't connect to the XChain Hub. Tried endpoints: " + endpoints.join(', '))
                }
                // A degraded hub is up but cannot serve config; getAllConfig
                // returns null so the caller takes the "couldn't get configs" path.
                return hub.getAllConfig()
            }

            const config = await bootstrapFromHub()
            assert.strictEqual(config, null)
        })
    })

    describe('parseEndpoints with invalid env vars', function () {

        it('returns localhost fallback when no env vars set', function () {
            delete process.env.HUB_VALIDATORS
            delete process.env.HUB_URL
            delete process.env.HUB_API_HOST
            delete process.env.HUB_PORT

            const endpoints = XChainHubConnector.parseEndpoints()

            assert(Array.isArray(endpoints))
            assert(endpoints.length >= 1)
            assert(endpoints[0].includes('localhost') || endpoints[0].includes('127.0.0.1'))
        })

        it('handles HUB_VALIDATORS with all empty entries', function () {
            process.env.HUB_VALIDATORS = ',,,  ,,'
            delete process.env.HUB_URL

            const endpoints = XChainHubConnector.parseEndpoints()

            // Should either return empty or fallback — not crash
            assert(Array.isArray(endpoints))
        })
    })

    describe('bootstrap failure scenario', function () {

        it('bootstrap detects hub failure and can throw diagnostic error', async function () {
            sinon.stub(axios, 'post').rejects(new Error('ECONNREFUSED'))

            async function bootstrapFromHub() {
                const endpoints = ['http://10.255.255.1:9999', 'http://10.255.255.2:9999']
                const hub = new XChainHubConnector(endpoints)
                const pingResult = await hub.ping()
                if (!pingResult) {
                    throw new Error("Can't connect to the XChain Hub. Tried endpoints: " + endpoints.join(', '))
                }
                return hub.getAllConfig()
            }

            await assert.rejects(
                bootstrapFromHub,
                /Can't connect to the XChain Hub/
            )
        })
    })
})
