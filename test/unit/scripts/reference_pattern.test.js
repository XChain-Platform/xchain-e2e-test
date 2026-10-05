// SPDX-License-Identifier: AGPL-3.0-or-later

'use strict'

const assert = require('assert')
const { spawnSync } = require('child_process')

const { referencePattern } = require('../../../bin/reference-pattern')

function grepCount(pattern, lines) {
    const result = spawnSync('grep', ['-E', '-c', pattern], {
        encoding: 'utf8',
        input: `${lines.join('\n')}\n`,
    })
    assert.notStrictEqual(result.status, 2, result.stderr)
    return Number(result.stdout.trim())
}

function assertLineCounts(pattern, expected, lines) {
    for (const line of lines) {
        assert.strictEqual(grepCount(pattern, [line]), expected, line)
    }
}

describe('referencePattern', () => {
    const pattern = referencePattern('src/coins/BTC.js')

    it('matches quoted module and path references', () => {
        assertLineCounts(pattern, 1, [
            "require('./coins/BTC')",
            'require("../src/coins/BTC.js")',
            "import b from '../../xchain-e2e-test/src/coins/BTC.js'",
            "path.join(ROOT, 'xchain-e2e-test/src/coins/BTC.js')",
            'const modulePath = `./coins/BTC`',
            'source map: ./coins/BTC.js:12',
            './coins/BTC.js',
        ])
    })

    it('rejects bare words, prose, other extensions, and longer names', () => {
        assertLineCounts(pattern, 0, [
            "if (coin === 'BTC') return 1",
            "'BTC:regtest'",
            "require('./coins/BTC.json')",
            "require('./coins/BTCX')",
            "require('./coins/xBTC.js')",
            'see BTC.js for the table',
            "require('./coins/BTC_helpers.js')",
        ])
    })

    it('matches index files through their parent directory shorthand', () => {
        const indexPattern = referencePattern('src/rail/index.js')
        assertLineCounts(indexPattern, 1, ["require('./rail')", "require('./rail/')"])
        assertLineCounts(indexPattern, 0, ["require('./railway')", "require('./railing')"])
    })

    it('treats ERE metacharacters in file and directory names literally', () => {
        const special = referencePattern('src/a+b[1]/coin.(x)+?.js')
        assert.strictEqual(grepCount(special, ["require('./coin.(x)+?')"]), 1)
        assert.strictEqual(grepCount(special, ["require('./coinZZx')"]), 0)

        const specialIndex = referencePattern('src/a+b[1]/index.js')
        assert.strictEqual(grepCount(specialIndex, ["require('./a+b[1]')"]), 1)
        assert.strictEqual(grepCount(specialIndex, ["require('./ab1')"]), 0)
    })
})
