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
const path = require('path')

const { MIRROR_SQL, readDDL } = require('../../helpers/hubDbMirrorSchema')
const registry = require(path.resolve(__dirname,
    '../../../../xchain-indexer/src/hub/hub_db_sync/mirror_tables.js'))

describe('hub DB mirror integration schema', () => {
    it('creates every table the sibling indexer mirror bootstraps', () => {
        assert.deepStrictEqual(Object.keys(MIRROR_SQL).sort(), registry.MIRRORED_TABLES.slice().sort())
    })

    it('gives every guarded mirror id an auto-incrementing local surrogate', () => {
        for (const table of registry.AUTO_INCREMENT_ID_TABLES) {
            const ddl = readDDL(MIRROR_SQL[table])
            assert.match(ddl, /\bid\b[^,\n]*\bAUTO_INCREMENT\b/i,
                table + ' must satisfy the indexer mirror startup guard')
        }
    })
})
