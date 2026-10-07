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
 * Every barrier-family leg that seeds joined rows takes its capability
 * snapshots from the stake weights through requiredSnapshotSeeds, checks the
 * coverage before seeding, and never hand-seeds an inert capability row.
 ********************************************************************/

const assert = require('assert')
const fs = require('fs')
const path = require('path')

const LEG_DIR = path.join(__dirname, '..', '..', 'attestMirror', 'barrier_family')
const LEGS = [
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

            it('derives its snapshots from the indexer stake weights at the reached tip', function () {
                assert.ok(/rows\.requiredSnapshotSeeds\([^)]*,[^)]*drive\.stakeWeightsAt\(/.test(src))
            })

            it('refuses incomplete snapshot coverage before seeding the mirrors', function () {
                const cover = src.indexOf('rows.snapshotCapabilityCoverage(')
                const ok = src.indexOf('coverage.satisfied', cover)
                const seed = src.indexOf('drive.seedMirrors(', ok)
                assert.ok(cover > 0 && ok > cover && seed > ok)
            })

            it('seeds the snapshots together with the member rows', function () {
                assert.ok(/seedMirrors\(ctx\.venue, (snapshots\.concat\(|seeds)/.test(src))
            })
        })
    }
})
