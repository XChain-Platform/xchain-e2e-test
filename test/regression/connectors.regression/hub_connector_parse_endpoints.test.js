const assert = require('assert')
const { XChainHubConnector } = require('./support/environment')

void describe('XChainHubConnector', function () {

    it('[regression:p0] R-CONN-009c : parseEndpoints parses HUB_VALIDATORS', function () {
        const orig = process.env.HUB_VALIDATORS
        try {
            process.env.HUB_VALIDATORS = 'hub1:10000, http://hub2:10000'
            const endpoints = XChainHubConnector.parseEndpoints()
            assert.strictEqual(endpoints.length, 2)
            assert.strictEqual(endpoints[0], 'http://hub1:10000')
            assert.strictEqual(endpoints[1], 'http://hub2:10000')
        } finally {
            if (orig !== undefined) process.env.HUB_VALIDATORS = orig
            else delete process.env.HUB_VALIDATORS
        }
    })

    it('[regression:p0] R-CONN-009d : parseEndpoints falls back to HUB_URL+HUB_PORT', function () {
        const origV = process.env.HUB_VALIDATORS
        const origU = process.env.HUB_URL
        const origP = process.env.HUB_PORT
        try {
            delete process.env.HUB_VALIDATORS
            process.env.HUB_URL = 'myhub'
            process.env.HUB_PORT = '9999'
            const endpoints = XChainHubConnector.parseEndpoints()
            assert.deepStrictEqual(endpoints, ['http://myhub:9999'])
        } finally {
            if (origV !== undefined) process.env.HUB_VALIDATORS = origV
            else delete process.env.HUB_VALIDATORS
            if (origU !== undefined) process.env.HUB_URL = origU
            else delete process.env.HUB_URL
            if (origP !== undefined) process.env.HUB_PORT = origP
            else delete process.env.HUB_PORT
        }
    })
})
