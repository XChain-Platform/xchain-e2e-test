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

const chainRail = require('../../../helpers/chainRail')

describe('chainRail: DOGE indexer port', function () {
    it('uses port 3004 by default', function () {
        assert.strictEqual(chainRail.DEFAULT_PORTS.DOGE.indexer, 3004)
    })
})
