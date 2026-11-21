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
const path = require('path')
const XChainHubConnector = require('../../../../src/XChainHubConnector')
const { hubCredential } = require('../../../helpers/hub_config/credential')

describe('hub config credential fallback', function () {
    it('keeps an unredacted hub credential', function () {
        assert.strictEqual(hubCredential('hub-secret', 'env-secret', 'test credential'), 'hub-secret')
    })

    it('uses the explicit environment credential for a redacted value', function () {
        assert.strictEqual(hubCredential(XChainHubConnector.REDACTED, 'env-secret', 'test credential'),
            'env-secret')
    })

    it('rejects a redacted value when no environment credential exists', function () {
        for (const envValue of [undefined, '']) {
            assert.throws(() => hubCredential(XChainHubConnector.REDACTED, envValue, 'test credential'),
                /test credential/)
        }
    })

    it('uses the documented credential names in initial setup', function () {
        const source = fs.readFileSync(path.join(__dirname, '../../../initial_check.test.js'), 'utf8')
        assert.match(source, /hubCredential\(\s*coinNet\.node\.pass\s*,\s*process\.env\.NODE_PASSWORD\b/)
        assert.match(source, /hubCredential\([\s\S]*?process\.env\.INDEXER_DB_PASS\s*,\s*'the indexer database password \(INDEXER_DB_PASS\)'/)
        assert.doesNotMatch(source, /process\.env\.NODE_PASS\b/)
        assert.doesNotMatch(source, /process\.env\.INDEXER_DATABASE_PASS\b/)
    })
})
