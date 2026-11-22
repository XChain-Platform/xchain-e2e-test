'use strict'

/*********************************************************************
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 **********************************************************************/

async function internalWedgeSample () {
    const waits = require('../mirrorDrillWaits')
    let sample = null
    try { sample = await waits.standingTipProbe()() } catch (internal) { return null }

    const behind = sample && Number.isFinite(Number(sample.height)) &&
        Number.isFinite(Number(sample.decoder)) && Number(sample.height) < Number(sample.decoder)
    const rollcall = sample && String(sample.reason || '') === 'rollcall_proof_unavailable'
    return (behind && rollcall) ? sample : null
}

async function clearWedgeBefore (what) {
    const sample = await internalWedgeSample()
    if (!sample) return false

    const waits = require('../mirrorDrillWaits')
    console.log('mirrorDrillFixture: clearing the roll-call wedge before ' + what +
        ' (standing indexer at ' + sample.height + ' behind its decoder at ' + sample.decoder +
        ' on ' + sample.reason + '). Cleared BEFORE the broadcast because this step cannot ' +
        'safely be retried once its transaction is out.')
    await waits.mineDogeBlocks(waits.DOGE_NUDGE_BLOCKS)
    return true
}

async function withWedgeClear (what, fn) {
    await clearWedgeBefore(what)
    try {
        return await fn()
    } catch (err) {
        const waits = require('../mirrorDrillWaits')
        const sample = await internalWedgeSample()
        if (!sample) throw err

        console.log('mirrorDrillFixture: ' + what + ' failed with the standing indexer at ' +
            sample.height + ' behind its decoder at ' + sample.decoder + ' on ' + sample.reason +
            '. That is the roll-call wedge, not this step. Mining DOGE and retrying once.')
        await waits.mineDogeBlocks(waits.DOGE_NUDGE_BLOCKS)
        return await fn()
    }
}

module.exports = { clearWedgeBefore, withWedgeClear }
