// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

'use strict'

// Guard the committed barrier-family corpus against reused venue labels.
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const { findReusedLabelBoots } = require('../../../../scripts/check-barrier-fresh-indexers')

describe('check-barrier-fresh-indexers repository', function () {
    it('keeps every barrier-family test on fresh indexers', function () {
        const directory = path.join(__dirname, '../../../attestMirror/barrier_family')
        const files = fs.readdirSync(directory).filter((file) => file.endsWith('.js')).sort()
        const findings = files.flatMap((file) => {
            const source = fs.readFileSync(path.join(directory, file), 'utf8')
            return findReusedLabelBoots(source).map((finding) => ({ file, ...finding }))
        })

        assert.ok(files.length >= 10, `expected at least 10 barrier-family files, found ${files.length}`)
        assert.deepStrictEqual(findings, [])
    })
})
