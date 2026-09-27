'use strict'

/*********************************************************************
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *********************************************************************/

const assert = require('assert')
const fs = require('fs')
const path = require('path')

const {
    BARRIER_REASON,
    PARKED_CLASSES,
    isAttributedPark,
} = require('../attestMirror/helpers/barrierAttribution')

describe('attest mirror barrier attribution', function () {
    it('accepts the barrier reason with each parked class', function () {
        assert.strictEqual(BARRIER_REASON, 'attest_response_sync_barrier')
        assert.deepStrictEqual(PARKED_CLASSES, ['barrier_defer', 'wedged', 'future_block_wait'])
        for (const klass of PARKED_CLASSES) {
            assert.strictEqual(isAttributedPark({ reason: BARRIER_REASON, klass: klass }), true)
        }
    })

    it('rejects none and null classes for the barrier reason', function () {
        assert.strictEqual(isAttributedPark({ reason: BARRIER_REASON, klass: 'none' }), false)
        assert.strictEqual(isAttributedPark({ reason: BARRIER_REASON, klass: null }), false)
    })

    it('rejects a different barrier reason with a parked class', function () {
        assert.strictEqual(isAttributedPark({
            reason: 'anchor_attest_barrier',
            klass: 'barrier_defer',
        }), false)
    })

    it('rejects a null reason', function () {
        assert.strictEqual(isAttributedPark({ reason: null, klass: 'barrier_defer' }), false)
    })

    it('wires at0b to the shared helper without a local parked-class constant', function () {
        const source = fs.readFileSync(path.join(
            __dirname,
            '..',
            'attestMirror',
            'at0b-barrier-attribution.test.js'
        ), 'utf8')
        assert.ok(source.includes("require('./helpers/barrierAttribution')"))
        assert.strictEqual(/^const PARKED_CLASSES\s*=/m.test(source), false)
    })
})
