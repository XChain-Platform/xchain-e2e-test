'use strict'

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const assert = require('assert')
const helper = require('../../helpers/gasHelper')

function fakeMiner(name, liveInterval, bootInterval){
    return {
        url: name,
        interval: liveInterval,
        intervals: [],
        async getIdleMineInterval(){ return this.interval },
        async getIdleMineIntervalBoot(){ return bootInterval },
        async setIdleMineInterval(ms){
            this.intervals.push(ms)
            this.interval = ms
        },
    }
}

describe('gasHelper idle-mining baseline capture', () => {
    beforeEach(() => helper['_resetHeartbeatBaselines']())
    afterEach(() => helper['_resetHeartbeatBaselines']())

    it('restores an untouched shared miner to its boot heartbeat', async () => {
        const miner = fakeMiner('btc', 60000, 60000)
        await helper.withIdleMining([miner], async () => {})
        assert.deepStrictEqual(miner.intervals, [helper.IDLE_MINE_INTERVAL_MS, 0])

        assert.deepStrictEqual(await helper.restoreHeartbeatBaselines(), [])
        assert.deepStrictEqual(miner.intervals, [helper.IDLE_MINE_INTERVAL_MS, 0, 60000])
    })

    it('heals a shared miner an earlier run left at zero', async () => {
        const miner = fakeMiner('btc', 0, 60000)
        await helper.withIdleMining([miner], async () => {})
        await helper.restoreHeartbeatBaselines()
        assert.deepStrictEqual(miner.intervals, [helper.IDLE_MINE_INTERVAL_MS, 0, 60000])
    })
})
