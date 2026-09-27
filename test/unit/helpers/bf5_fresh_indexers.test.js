'use strict'

/*********************************************************************
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 ********************************************************************/

const assert = require('assert')
const fs = require('fs')
const path = require('path')

const BF5_PATH = path.resolve(__dirname, '..', '..', 'attestMirror', 'barrier_family', 'bf5_flag_day.test.js')

describe('BF5 fresh indexers', function () {
    it('passes freshIndexers through the bootFamilyVenue venue options', function () {
        const source = fs.readFileSync(BF5_PATH, 'utf8')
        const call = source.match(/bootFamilyVenue\s*\(\s*\{([\s\S]*?)\}\s*\)/)

        assert.ok(call, 'BF5 must call bootFamilyVenue with an options object')
        assert.match(call[1], /venue\s*:\s*\{\s*freshIndexers\s*:\s*true\s*,?\s*\}/)
    })
})
