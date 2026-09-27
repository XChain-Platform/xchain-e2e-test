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

const LEG = path.resolve(__dirname, '../attestMirror/at5_batch_replay.test.js')

function stageDogeSignerBody (source) {
    const start = source.indexOf('async function stageDogeSigner ')
    assert.notStrictEqual(start, -1, 'stageDogeSigner is missing from the AT5 leg')

    const bodyStart = source.indexOf('{', start)
    const bodyEnd = source.indexOf('\n}\n\ndescribe(', bodyStart)
    assert.notStrictEqual(bodyEnd, -1, 'could not isolate the stageDogeSigner body')
    return source.slice(bodyStart + 1, bodyEnd)
}

describe('AT5 publisher funding', function () {
    it('funds native DOGE without seeding bridged gas', function () {
        const source = fs.readFileSync(LEG, 'utf8')
        const body = stageDogeSignerBody(source)
        const calls = [...body.matchAll(/cryptoHelper\.getNewFundedAddress\s*\(([^)]*)\)/g)]

        assert.strictEqual(calls.length, 1,
            'stageDogeSigner must contain exactly one getNewFundedAddress call')
        const args = calls[0][1].split(',').map(arg => arg.trim())
        assert.strictEqual(args.length, 8, 'publisher funding must pass all eight arguments')
        assert.strictEqual(args[7], 'false', 'publisher funding must disable bridged gas seeding')
    })
})
