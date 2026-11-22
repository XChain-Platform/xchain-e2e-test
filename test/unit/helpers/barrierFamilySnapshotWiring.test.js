'use strict'

/*********************************************************************
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 **********************************************************************
 * Every barrier-family leg that seeds joined rows uses the burial-aware drive
 * helper to seed capability snapshots before member rows, and never hand-seeds
 * an inert capability row.
 ********************************************************************/

const assert = require('assert')
const fs = require('fs')
const path = require('path')

const LEG_DIR = path.join(__dirname, '..', '..', 'attestMirror', 'barrier_family')
const LEGS = [
    'bf1_red_baseline',
    'bf2_armed_fix', 'bf3_bound_is_real', 'bf4_boundary', 'bf5_flag_day', 'bf8_second_coin',
]

function source (leg) {
    return fs.readFileSync(path.join(LEG_DIR, leg + '.test.js'), 'utf8')
}

describe('barrier family legs: capability snapshots come from stake weights', function () {
    for (const leg of LEGS) {
        describe(leg, function () {
            const src = source(leg)

            it('never seeds an unstaked inert capability_snapshots row', function () {
                assert.ok(!/inertRow\(\s*'capability_snapshots'/.test(src))
            })

            it('seeds burial-aware snapshots from the indexer stake weights', function () {
                assert.ok(src.includes('drive.seedSnapshotsFromStake('))
            })

            it('does not duplicate snapshot derivation or coverage checks', function () {
                assert.ok(!src.includes('rows.requiredSnapshotSeeds('))
                assert.ok(!src.includes('rows.snapshotCapabilityCoverage('))
            })

            it('seeds snapshots before the member rows', function () {
                const snapshots = src.indexOf('drive.seedSnapshotsFromStake(')
                const members = src.indexOf('drive.seedMirrors(', snapshots)
                assert.ok(snapshots !== -1 && members > snapshots)
            })
        })
    }
})
