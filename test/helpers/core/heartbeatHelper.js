// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

'use strict'

module.exports = function createHeartbeatController(defaultIntervalMs){
    // The boot interval recorded before this run first touches each miner URL.
    const baselines = new Map()

    async function noteHeartbeatBaseline(miner){
        if (baselines.has(miner.url)) return
        let ms = null
        try {
            ms = await miner.getIdleMineIntervalBoot()
            if (ms === null) ms = await miner.getIdleMineInterval()
        } catch (err) {
            console.log('[gasHelper] could not read ' + miner.url + ' idle heartbeat: ' + err.message)
        }
        baselines.set(miner.url, { miner, ms })
    }

    async function pinHeartbeatOff(miner){
        await noteHeartbeatBaseline(miner)
        await miner.setIdleMineInterval(0)
    }

    async function restoreHeartbeatBaselines(){
        const failures = []
        for (const [url, { miner, ms }] of baselines) {
            if (ms === null) continue
            try { await miner.setIdleMineInterval(ms) }
            catch (err) { failures.push(url + ': ' + err.message) }
        }
        baselines.clear()
        return failures
    }

    // The suite counts blocks, so leave every touched miner off until teardown
    // restores its recorded boot value. Restore failures never mask fn's error.
    async function withIdleMining(miners, fn, intervalMs = defaultIntervalMs){
        for (const miner of miners) {
            await noteHeartbeatBaseline(miner)
            await miner.setIdleMineInterval(intervalMs)
        }
        let fnFailed = false
        try {
            return await fn()
        } catch (err) {
            fnFailed = true
            throw err
        } finally {
            let restoreError = null
            for (const miner of miners) {
                try { await miner.setIdleMineInterval(0) }
                catch (err) { if (!restoreError) restoreError = err }
            }
            if (restoreError && !fnFailed) throw restoreError
        }
    }

    return {
        noteHeartbeatBaseline,
        pinHeartbeatOff,
        restoreHeartbeatBaselines,
        withIdleMining,
        resetHeartbeatBaselines(){ baselines.clear() },
    }
}
