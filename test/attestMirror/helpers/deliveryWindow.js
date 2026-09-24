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
 * Was a mirror-delivery fault still live when a leg mined the block it judges?
 *
 * A leg that injects a delivery delay and then waits for a barrier is only measuring
 * that barrier while the injection is BOTH fired and unexpired. AT2b went red on
 * 2026-09-18 with neither condition checked: the delayed indexer spent the window
 * clearing an older block backlog, the configured delay ran out, and the assertion
 * then read a node that had nothing left to wait for.
 *
 * The proxy's hold counters are CUMULATIVE, so `framesHeld > 0` proves the injection
 * fired at some point and says nothing about now. The elapsed clock is what carries
 * "now", and the two are only evidence together.
 ********************************************************************/

/**
 * @param {number} armedAtMs   wall clock when the delay was armed
 * @param {number} nowMs       wall clock at the read
 * @param {number} delayMs     the configured delay ceiling
 * @param {object} stats       the mirror proxy's cumulative hold counters
 * @returns {{ok: boolean, elapsedMs: number, injectionFired: boolean}}
 */
function delayedDeliveryWindow (armedAtMs, nowMs, delayMs, stats) {
    const elapsedMs = Number(nowMs) - Number(armedAtMs)
    const injectionFired = Number(stats && stats.framesHeld) > 0 ||
        Number(stats && stats.snapshotRowsHeld) > 0
    return {
        ok: injectionFired && Number.isFinite(elapsedMs) && elapsedMs >= 0 && elapsedMs < Number(delayMs),
        elapsedMs: elapsedMs,
        injectionFired: injectionFired,
    }
}

module.exports = { delayedDeliveryWindow }
