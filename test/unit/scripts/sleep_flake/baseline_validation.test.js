'use strict'

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { readBaseline } = require('../../../../bin/lib/sleep_flake_baseline')

const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sleep-flake-baseline-'))
let fixtureSequence = 0

function fixture(contents) {
    fixtureSequence += 1
    const file = path.join(fixtureDir, 'baseline-' + fixtureSequence + '.json')
    fs.writeFileSync(file, contents)
    return file
}

describe('sleep-flake baseline validation', function () {
    it('accepts non-negative integer counts', function () {
        assert.deepStrictEqual(readBaseline(fixture('{"count":27}'), 'baseline.json'),
            { ok: true, count: 27 })
        assert.deepStrictEqual(readBaseline(fixture('{"count":0}'), 'baseline.json'),
            { ok: true, count: 0 })
    })

    it('rejects missing or non-integer counts', function () {
        const invalid = [
            '{}', '{"total":27}', '{"count":"27"}', '{"count":null}',
            '{"count":-1}', '{"count":1.5}', '{"count":{"value":1}}', '[1,2]', 'null',
        ]
        for (const contents of invalid) {
            const result = readBaseline(fixture(contents), 'baseline.json')
            assert.strictEqual(result.ok, false, contents)
            assert.match(result.error, /valid non-negative integer "count"/)
        }
    })

    it('rejects invalid JSON with a useful error', function () {
        const result = readBaseline(fixture('not json'), 'baseline.json')
        assert.strictEqual(result.ok, false)
        assert.match(result.error, /baseline\.json is not valid JSON/)
    })
})
