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
 * The chain-hold half of the barrier-family drive, against a stub rail and a
 * stub venue: the miner is paused BEFORE the baseline tip is read, the leg's
 * pre-hold work (funding the marker) runs while the miner still mines, every
 * indexer is levelled at the held tip, a drill block can leave the miner paused
 * or resume it, and the after-hook release never throws.
 *
 * The stub miner TICKS: while it is not paused, it lands a block right after
 * every tip read, which is the adaptive regtest miner at its worst. BF1 went red
 * six times on 2026-09-17 because a block landed between its baseline and its
 * walker block; a read-then-pause hold fails the level case here the same way.
 ********************************************************************/

const assert = require('assert')

const drive = require('../../attestMirror/helpers/barrierFamilyDrive')
const rows = require('../../attestMirror/helpers/barrierFamilyRows')
const fixture = require('../../attestMirror/helpers/barrierFamilyFixture')

/** A rail whose miner lands a block after any tip read it is not paused for. */
function stubRail (opts) {
    const o = opts || {}
    const state = { tip: o.tip === undefined ? 100 : o.tip, paused: false, ticking: o.ticking !== false }
    const log = []
    const miner = {
        pauseMining: async () => { log.push('pause'); state.paused = true; return 'ok' },
        resumeMining: async () => {
            log.push('resume')
            if (o.resumeThrows) throw new Error('miner unreachable')
            state.paused = false
            return 'ok'
        },
        setMockTime: async (t) => { log.push('mock:' + t); return 'ok' },
        generateBlocks: async (n) => { log.push('generate:' + n); state.tip += Number(n); return { count: n } },
    }
    const node = {
        getBlockCount: async () => {
            const t = state.tip
            log.push('count:' + t)
            if (state.ticking && !state.paused) state.tip += 1
            return t
        },
        getBlockHash: async (h) => 'h' + h,
        getBlock: async (hash) => ({ time: 1_800_000_000 + Number(String(hash).slice(1)), mediantime: 1_799_999_000 }),
    }
    return { rail: { globals: { regtestMinerConnector: miner, nodeConnector: node } }, state, log }
}

/** A venue whose indexers commit whatever the chain holds, instantly. */
function stubVenue (state) {
    return {
        indexers: [{ index: 0 }, { index: 1 }],
        statusOf: async () => ({ httpStatus: 200, body: { indexerBlock: state.tip, decoderBlock: state.tip } }),
    }
}

const FAST = { levelTimeoutMs: 400, intervalMs: 10 }

describe('barrierFamilyDrive: the chain is held before a leg keys anything on the next block', function () {
    it('pauses the miner before it reads the baseline tip', async function () {
        const s = stubRail()
        const held = await drive.holdChain(s.rail)
        const pauseAt = s.log.indexOf('pause')
        const firstRead = s.log.findIndex((x) => x.startsWith('count:'))
        assert.ok(pauseAt >= 0 && firstRead > pauseAt, 'the tip was read before the pause: ' + JSON.stringify(s.log))
        assert.strictEqual(held.tip, 100)
        assert.strictEqual(s.state.tip, 100, 'a block landed after the baseline read')
        assert.strictEqual(held.stamp.height, 100)
    })

    it('runs the pre-hold work with the miner running, then holds, levels and proves the tip did not move', async function () {
        const s = stubRail()
        const venue = stubVenue(s.state)
        let pausedDuringFunding = null
        const held = await drive.holdBaseline(s.rail, venue, Object.assign({
            label: 'unit',
            // Funding mines its own blocks: the funding transaction and the gas mint.
            beforeHold: async () => {
                pausedDuringFunding = s.state.paused
                await s.rail.globals.regtestMinerConnector.generateBlocks(2)
                return { address: 'marker' }
            },
        }, FAST))
        assert.strictEqual(pausedDuringFunding, false, 'the marker was funded with the miner paused, so its blocks could not land')
        assert.deepStrictEqual(held.before, { address: 'marker' })
        assert.strictEqual(held.tip, 102, 'the baseline is not the tip after the funding blocks')
        assert.strictEqual(s.state.tip, 102, 'the chain moved past the held baseline')
        assert.strictEqual(s.state.paused, true, 'holdBaseline must leave the miner paused for the drill block')
        assert.ok(s.log.indexOf('generate:2') < s.log.indexOf('pause'), 'the funding blocks were mined inside the hold')
        assert.ok(!s.log.includes('resume'), 'holdBaseline resumed the miner; only mineStamped or releaseChain may')
    })

    it('fails loudly when the venue never levels at the held tip', async function () {
        const s = stubRail({ ticking: false })
        const venue = { indexers: [{ index: 0 }], statusOf: async () => ({ httpStatus: 200, body: { indexerBlock: 99, decoderBlock: 100 } }) }
        await assert.rejects(drive.holdBaseline(s.rail, venue, FAST), /never committed the held baseline 100/)
    })

    it('names a block that landed while the chain was held', async function () {
        const s = stubRail({ ticking: false })
        await drive.holdChain(s.rail)
        s.state.tip += 1
        await assert.rejects(drive.assertChainHeld(s.rail, 100, 'the BTC chain'), /the BTC chain moved from 100 to 101/)
        assert.strictEqual(await drive.assertChainHeld(s.rail, 101), 101)
    })
})

describe('barrierFamilyDrive: the drill block ends the hold, or keeps it for the next height', function () {
    it('resumes the miner after the block by default, and releases the clock pin', async function () {
        const s = stubRail({ ticking: false })
        await drive.holdChain(s.rail)
        const b = await drive.mineStamped(s.rail, 1_800_000_500)
        assert.strictEqual(b.height, 101)
        assert.deepStrictEqual(s.log.slice(-3), ['mock:0', 'resume', 'count:101'])
        assert.strictEqual(s.state.paused, false)
    })

    it('leaves the miner paused with resume false, and still releases the clock pin', async function () {
        const s = stubRail({ ticking: false })
        await drive.holdChain(s.rail)
        const b = await drive.mineStamped(s.rail, 1_800_000_500, { resume: false })
        assert.strictEqual(b.height, 101)
        assert.ok(s.log.includes('mock:0'), 'the clock pin was not released')
        assert.ok(!s.log.includes('resume'), 'resume false resumed the miner')
        assert.strictEqual(s.state.paused, true)
    })

    it('releaseChain resumes a paused miner and never throws out of an after hook', async function () {
        const s = stubRail({ ticking: false })
        await drive.holdChain(s.rail)
        assert.strictEqual(await drive.releaseChain(s.rail), true)
        assert.strictEqual(s.state.paused, false)
        const broken = stubRail({ resumeThrows: true })
        assert.strictEqual(await drive.releaseChain(broken.rail), false)
        assert.strictEqual(await drive.releaseChain(null), false)
        assert.strictEqual(await drive.releaseChain({}), false)
    })
})

describe('barrierFamilyDrive: the level budget covers the longest grace a leg configured', function () {
    it('outlasts BF1\'s top rung by the margin, at the default step and a short one', function () {
        for (const step of [90, 30]) {
            const ladder = rows.graceLadder(step)
            const top = Math.max(...Object.values(ladder))
            const budget = drive.levelBudgetMs(ladder, 1000, 1000)
            assert.strictEqual(budget, (top + drive.LEVEL_MARGIN_S) * 1000)
            assert.ok(budget > top * 1000, 'the budget does not outlast the ' + top + ' s rung')
        }
        assert.ok(drive.LEVEL_MARGIN_S >= 3 * fixture.BARRIER_CYCLE_S, 'the margin is under three barrier cycles')
    })

    it('adds a stamp that sits ahead of wall clock, and ignores one behind it', function () {
        assert.strictEqual(drive.levelBudgetMs({ a: 100 }, 1600, 1000), (100 + 600 + drive.LEVEL_MARGIN_S) * 1000)
        assert.strictEqual(drive.levelBudgetMs({ a: 100 }, 400, 1000), (100 + drive.LEVEL_MARGIN_S) * 1000)
        assert.strictEqual(drive.levelBudgetMs(undefined, undefined, 1000), drive.LEVEL_MARGIN_S * 1000)
    })
})
