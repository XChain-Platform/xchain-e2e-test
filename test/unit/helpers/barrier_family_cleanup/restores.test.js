'use strict'

/*********************************************************************
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available.
 ********************************************************************/

const assert = require('assert')

const drive = require('../../../attestMirror/helpers/barrierFamilyDrive')

function stubRail (opts) {
    const o = opts || {}
    const state = { tip: 100, paused: false }
    const log = []
    const miner = {
        pauseMining: async () => { log.push('pause'); state.paused = true },
        setMockTime: async (stamp) => {
            log.push('mock:' + stamp)
            if (stamp === 0 && o.releaseError) throw o.releaseError
        },
        generateBlocks: async (count) => {
            log.push('generate:' + count)
            if (o.generateError) throw o.generateError
            state.tip += Number(count)
        },
        resumeMining: async () => {
            log.push('resume')
            if (o.resumeError) throw o.resumeError
            state.paused = false
        },
    }
    const node = {
        getBlockCount: async () => state.tip,
        getBlockHash: async (height) => 'h' + height,
        getBlock: async () => ({ time: 1_800_000_000, mediantime: 1_799_999_000 }),
    }
    return { rail: { globals: { regtestMinerConnector: miner, nodeConnector: node } }, state, log }
}

describe('barrierFamilyDrive mineStamped restore failures', function () {
    it('mineStamped rejects a failed clock release after still attempting resume', async function () {
        const releaseError = new Error('clock release failed')
        const s = stubRail({ releaseError })

        await assert.rejects(drive.mineStamped(s.rail, 1_800_000_500), /clock release failed/)

        assert.ok(s.log.includes('resume'), 'resume was skipped after the release failure')
    })

    it('mineStamped rejects a failed resume after releasing the clock', async function () {
        const s = stubRail({ resumeError: new Error('resume failed') })

        await assert.rejects(drive.mineStamped(s.rail, 1_800_000_500), /resume failed/)

        assert.ok(s.log.includes('mock:0'), 'clock release was skipped before resume')
    })

    it('mineStamped keeps its body failure primary when clock release also fails', async function () {
        const bodyError = new Error('generate failed')
        const s = stubRail({ generateError: bodyError, releaseError: new Error('clock release failed') })

        await assert.rejects(drive.mineStamped(s.rail, 1_800_000_500), (err) => err === bodyError)

        assert.ok(s.log.includes('resume'), 'resume was skipped after both failures')
    })

    it('mineStamped does not release an unpinned clock', async function () {
        const s = stubRail({ releaseError: new Error('must not run') })

        const block = await drive.mineStamped(s.rail, null)

        assert.strictEqual(block.height, 101)
        assert.ok(!s.log.includes('mock:0'))
    })

    it('mineStamped surfaces release failure without resuming when resume is false', async function () {
        const s = stubRail({ releaseError: new Error('clock release failed') })

        await assert.rejects(
            drive.mineStamped(s.rail, 1_800_000_500, { resume: false }),
            /clock release failed/,
        )

        assert.ok(!s.log.includes('resume'))
    })
})

describe('barrierFamilyDrive mineSpacedRun restore failures', function () {
    it('mineSpacedRun rejects release failure after still attempting resume', async function () {
        const s = stubRail({ releaseError: new Error('clock release failed') })

        await assert.rejects(drive.mineSpacedRun(s.rail, 3, 1_800_000_500), /clock release failed/)

        assert.ok(s.log.includes('resume'), 'resume was skipped after the release failure')
    })

    it('mineSpacedRun rejects resume failure after releasing the clock', async function () {
        const s = stubRail({ resumeError: new Error('resume failed') })

        await assert.rejects(drive.mineSpacedRun(s.rail, 3, 1_800_000_500), /resume failed/)

        assert.ok(s.log.includes('mock:0'), 'clock release was skipped before resume')
    })

    it('mineSpacedRun keeps its body failure primary when both restores fail', async function () {
        const bodyError = new Error('generate failed')
        const s = stubRail({
            generateError: bodyError,
            releaseError: new Error('clock release failed'),
            resumeError: new Error('resume failed'),
        })

        await assert.rejects(drive.mineSpacedRun(s.rail, 3, 1_800_000_500), (err) => err === bodyError)

        assert.ok(s.log.includes('mock:0'))
        assert.ok(s.log.includes('resume'))
    })
})
