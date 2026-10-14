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
const fs = require('fs')
const path = require('path')

// stageDogeSigner lives in the AT5 parts directory and funds the publisher through fundPublisher.
const LEG = path.resolve(__dirname, '../attestMirror/at5_batch_replay.test/signer.test.js')

function functionBody (source, name) {
    const start = source.indexOf('async function ' + name + ' ')
    assert.notStrictEqual(start, -1, name + ' is missing from the AT5 leg')

    const bodyStart = source.indexOf('{', start)
    const bodyEnd = source.indexOf('\n}\n', bodyStart)
    assert.notStrictEqual(bodyEnd, -1, 'could not isolate the ' + name + ' body')
    return source.slice(bodyStart + 1, bodyEnd)
}

describe('AT5 publisher funding', function () {
    it('funds native DOGE without seeding bridged gas', function () {
        const source = fs.readFileSync(LEG, 'utf8')
        assert.match(functionBody(source, 'stageDogeSigner'), /fundPublisher\(/, 'stageDogeSigner must fund through fundPublisher')
        const body = functionBody(source, 'fundPublisher')
        const calls = [...body.matchAll(/cryptoHelper\.getNewFundedAddress\s*\(([^)]*)\)/g)]

        assert.strictEqual(calls.length, 1,
            'fundPublisher must contain exactly one getNewFundedAddress call')
        const args = calls[0][1].split(',').map(arg => arg.trim())
        assert.strictEqual(args.length, 8, 'publisher funding must pass all eight arguments')
        assert.strictEqual(args[7], 'false', 'publisher funding must disable bridged gas seeding')
    })
})
