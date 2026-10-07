'use strict'

// Copyright © 2025–2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const assert = require('assert')
const path = require('path')
const drillKeys = require('../../../helpers/rail/drill_keys_dir')

describe('drill_keys_dir', function () {
    it('uses drill-keys beside a primary checkout', function () {
        const root = path.resolve('/repos/xchain-e2e-test')
        assert.strictEqual(
            drillKeys.resolveDrillKeysDir({ repoRoot: root }),
            path.join(root, 'drill-keys'))
    })

    it('uses the linked lane checkout instead of its primary checkout', function () {
        const primary = path.resolve('/repos/xchain-e2e-test')
        const lane = path.resolve('/repos/tmp/lanes/lane-1/xchain-e2e-test')
        const resolved = drillKeys.resolveDrillKeysDir({ repoRoot: lane })
        assert.strictEqual(resolved, path.join(lane, 'drill-keys'))
        assert.notStrictEqual(resolved, path.join(primary, 'drill-keys'))
    })

    it('resolves this checkout without following shared Git metadata', function () {
        assert.strictEqual(drillKeys.DRILL_KEYS_DIR, path.join(drillKeys.REPO_ROOT, 'drill-keys'))
    })
})
