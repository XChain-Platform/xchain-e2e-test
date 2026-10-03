'use strict'

const assert = require('assert')

const {
    PROVIDER_ENV,
    resolveAt5ResponseProvider,
    buildAt5DogeIndexerConfig,
    at5ResponseRedundancy,
} = require('../../attestMirror/helpers/at5ResponseProvider')

describe('AT5 response provider selection', function () {
    it('keeps llm as the default', function () {
        assert.strictEqual(resolveAt5ResponseProvider({}), 'llm')
        assert.strictEqual(resolveAt5ResponseProvider({ [PROVIDER_ENV]: '' }), 'llm')
    })

    it('selects http_get only through the explicit opt-in', function () {
        assert.strictEqual(resolveAt5ResponseProvider({ [PROVIDER_ENV]: 'http_get' }), 'http_get')
    })

    it('allows llm to be selected explicitly', function () {
        assert.strictEqual(resolveAt5ResponseProvider({ [PROVIDER_ENV]: 'llm' }), 'llm')
    })

    it('refuses an unknown provider instead of silently changing the drive', function () {
        assert.throws(
            () => resolveAt5ResponseProvider({ [PROVIDER_ENV]: 'HTTP' }),
            /AT5_RESPONSE_PROVIDER must be "llm" or "http_get"/
        )
    })

    it('builds the attached DOGE indexer config consumed by hub updateconfig', function () {
        assert.deepStrictEqual(buildAt5DogeIndexerConfig('http://127.0.0.1:63434', 'regtest'), {
            dogecoin: {
                regtest: {
                    'xchain-indexer': { host: '127.0.0.1', port: '63434' },
                },
            },
        })
    })

    it('refuses an indexer coordinate without an explicit port', function () {
        assert.throws(
            () => buildAt5DogeIndexerConfig('http://127.0.0.1', 'regtest'),
            /explicit port/
        )
    })

    it('uses every isolated HTTP validator while leaving LLM redundancy unchanged', function () {
        assert.strictEqual(at5ResponseRedundancy('http_get'), 5)
        assert.strictEqual(at5ResponseRedundancy('llm'), 3)
    })
})
