'use strict'

// Copyright © 2025–2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const assert = require('assert')
const { replayDbNames } = require('../../helpers/oracleBatchReplay')

// The platform hub account's grant on the rail, `XChain\_%\_MVH\_%`, as MariaDB's LIKE
// reads it: literal "XChain_", anything, literal "_MVH_", anything.
const HUB_GRANT = /^XChain_.*_MVH_.*$/

describe('oracleBatchReplay replayDbNames', function () {
    it('names all three replay databases inside the hub account grant (MariaDB 1044 otherwise)', function () {
        for (const label of ['anchorfirst', 'anchorreplay', 'replay']) {
            const names = replayDbNames(label, '4012345_mg7x2k9a')
            for (const name of Object.values(names)) {
                assert.match(name, HUB_GRANT)
                assert.ok(name.length <= 64, name + ' fits a MariaDB database name')
            }
            assert.deepStrictEqual(Object.keys(names), ['hub', 'indexer', 'mirror'])
            assert.ok(names.mirror.endsWith('_HubMirror'))
        }
    })

    it('refuses a name MariaDB would reject instead of failing at CREATE DATABASE', function () {
        assert.throws(() => replayDbNames('x'.repeat(60), '1_a'), /at most 64 characters/)
        assert.throws(() => replayDbNames('bad-label', '1_a'), /plain identifier/)
    })
})
