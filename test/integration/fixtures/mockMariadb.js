'use strict'

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available —
// contact legal@dankest.llc.

// Shared mariadb mock injection for integration tests.
//
// mariadb is an ESM package that cannot be require()'d directly.
// This module injects a synthetic CJS module into require.cache so that
// any subsequent require('mariadb') returns our mock.
//
// MUST be required before any module that depends on mariadb (e.g., db.js).

const sinon = require('sinon')
const Module = require('module')

const mariadbPath = require.resolve('mariadb')

// Only inject once per process
if (!require.cache[mariadbPath] || !require.cache[mariadbPath]._isMock) {
    const mockMariadb = {
        createPool: sinon.stub().returns({
            getConnection: sinon.stub().resolves({
                query: sinon.stub().resolves([]),
                release: sinon.stub().resolves(),
            })
        })
    }

    const mariadbModule = new Module(mariadbPath, module)
    mariadbModule.exports = mockMariadb
    mariadbModule.loaded = true
    mariadbModule._isMock = true
    require.cache[mariadbPath] = mariadbModule
}

module.exports = require.cache[mariadbPath].exports
