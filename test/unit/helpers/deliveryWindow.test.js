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
 * The two halves of AT2b's delivery-window precondition, each proven to be
 * load-bearing on its own: a cumulative hold counter without a live clock, and a
 * live clock without a hold, must both read NOT ACTIVE.
 ********************************************************************/

const assert = require('assert')

const { delayedDeliveryWindow } = require('../../attestMirror/helpers/deliveryWindow')

describe('deliveryWindow: an injected mirror delay is only evidence while it is live', function () {
    it('rejects a window before the proxy has held anything', function () {
        const out = delayedDeliveryWindow(1000, 2000, 5000, { framesHeld: 0, snapshotRowsHeld: 0 })
        assert.strictEqual(out.ok, false)
        assert.strictEqual(out.injectionFired, false)
    })

    it('accepts a held row while the configured delay is active', function () {
        const out = delayedDeliveryWindow(1000, 5999, 5000, { framesHeld: 1, snapshotRowsHeld: 0 })
        assert.strictEqual(out.ok, true)
        assert.strictEqual(out.elapsedMs, 4999)
    })

    it('rejects a cumulative hold count after the delay has expired', function () {
        const out = delayedDeliveryWindow(1000, 6000, 5000, { framesHeld: 1, snapshotRowsHeld: 0 })
        assert.strictEqual(out.ok, false)
        assert.strictEqual(out.injectionFired, true)
    })

    it('counts a held snapshot row as a fired injection, not only a stream frame', function () {
        const out = delayedDeliveryWindow(1000, 2000, 5000, { framesHeld: 0, snapshotRowsHeld: 3 })
        assert.strictEqual(out.ok, true)
        assert.strictEqual(out.injectionFired, true)
    })

    it('rejects absent stats rather than reading a missing counter as a hold', function () {
        assert.strictEqual(delayedDeliveryWindow(1000, 2000, 5000, null).ok, false)
        assert.strictEqual(delayedDeliveryWindow(1000, 2000, 5000, {}).ok, false)
    })

    it('rejects an unusable clock instead of letting NaN arithmetic pass the window', function () {
        const out = delayedDeliveryWindow(undefined, 2000, 5000, { framesHeld: 1 })
        assert.strictEqual(out.ok, false)
    })
})
