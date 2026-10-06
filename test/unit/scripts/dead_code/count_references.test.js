// SPDX-License-Identifier: AGPL-3.0-or-later

'use strict'

const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')

const { countReferences } = require('../../../../bin/count-references')

describe('countReferences', () => {
    let fixtureRoot

    beforeEach(() => {
        fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'count-references-'))
    })

    afterEach(() => {
        fs.rmSync(fixtureRoot, { recursive: true, force: true })
    })

    it('counts matching lines per repository and skips excluded directories', () => {
        const alpha = path.join(fixtureRoot, 'alpha')
        const beta = path.join(fixtureRoot, 'beta')
        const dependency = path.join(alpha, 'node_modules', 'dependency')
        const metadata = path.join(alpha, '.git', 'objects')
        const requireLine = "const coin = require('./coins/BTC')"

        for (const directory of [alpha, beta, dependency, metadata]) {
            fs.mkdirSync(directory, { recursive: true })
        }
        fs.writeFileSync(path.join(alpha, 'source.js'), [
            requireLine,
            requireLine,
            "if (ticker === 'BTC') return true",
            'see BTC.js for the table',
        ].join('\n'))
        fs.writeFileSync(path.join(dependency, 'ignored.js'), `${requireLine}\n`)
        fs.writeFileSync(path.join(metadata, 'ignored.js'), `${requireLine}\n`)
        fs.writeFileSync(path.join(beta, 'notes.md'), "BTC and BTC.js are documented here\n")

        const counts = countReferences('src/coins/BTC.js', { alpha, beta })

        assert.deepStrictEqual(counts, { alpha: 2, beta: 0 })
        assert.deepStrictEqual(Object.keys(counts), ['alpha', 'beta'])
    })

    it('throws when a repository root is missing', () => {
        const missing = path.join(fixtureRoot, 'missing')
        assert.throws(
            () => countReferences('src/coins/BTC.js', { missing }),
            /not an existing directory/
        )
    })
})
