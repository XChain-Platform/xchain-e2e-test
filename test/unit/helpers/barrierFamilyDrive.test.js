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

describe('barrierFamilyDrive: an armed leg mines only once the hub has published its heights', function () {
    // A venue whose indexer 0 reports a heights map that the test swaps between reads.
    function heightsVenue (seq) {
        let n = 0
        return {
            indexers: [{ index: 0 }],
            statusOf: async () => {
                const heights = seq[Math.min(n, seq.length - 1)]
                n += 1
                return { httpStatus: 200, body: { indexerBlock: 103, decoderBlock: 103, hubMirror: { heights } } }
            },
            reads: () => n,
        }
    }
    const TABLES = ['cross_chain_matches', 'attestation_responses', 'anchor_reward_attestations']
    const READY = { cross_chain_matches: { BTC: 103 }, attestation_responses: { BTC: 103 }, anchor_reward_attestations: { BTC: 103 } }

    it('returns the snapshot as soon as every member\'s height is at its line', async function () {
        const venue = heightsVenue([READY])
        const s = await drive.waitForAdmissionHeights(venue, 0, TABLES, 'BTC', 104, 1000)
        assert.deepStrictEqual(s.heights, READY)
        assert.strictEqual(venue.reads(), 1)
    })

    it('fails naming the height the hub never published, with the indexer\'s own margin', async function () {
        // One failed poll still sleeps the drive's 2 s interval before the deadline is re-read.
        this.timeout(6000)
        const venue = heightsVenue([{ cross_chain_matches: { BTC: 103 }, attestation_responses: { BTC: 103 } }])
        await assert.rejects(drive.waitForAdmissionHeights(venue, 0, TABLES, 'BTC', 104, 50),
            /never published the admission heights drill block B=104 needs on indexer 0 inside 50 ms: admission height anchor_reward_attestations\.BTC at none, needs -40$/)
    })

    it('reads the margin from the indexer gate, so a member one block short is not ready', async function () {
        this.timeout(6000)
        assert.strictEqual(fixture.admitMarginBlocks('cross_chain_matches'), 4)
        const venue = heightsVenue([Object.assign({}, READY, { cross_chain_matches: { BTC: 99 } })])
        await assert.rejects(drive.waitForAdmissionHeights(venue, 0, TABLES, 'BTC', 104, 50),
            /cross_chain_matches\.BTC at 99, needs 100/)
    })
})

describe('barrierFamilyDrive: heldAdmissionCeiling clamps a held chain\'s wait target to B-2', function () {
    it('clamps a margin-0 member to B-2', function () {
        assert.strictEqual(drive.heldAdmissionCeiling(105, 0), 103)
    })

    it('clamps a margin-1 member to B-2, not the unclamped B-1', function () {
        assert.strictEqual(drive.heldAdmissionCeiling(105, 1), 103)
    })

    it('passes a margin-2 member through unclamped, exactly at the ceiling', function () {
        assert.strictEqual(drive.heldAdmissionCeiling(105, 2), 103)
    })

    it('leaves a margin-3 member at its own B-3, already under the held ceiling', function () {
        assert.strictEqual(drive.heldAdmissionCeiling(105, 3), 102)
    })
})

describe('barrierFamilyDrive: waitForHeldAdmissionHeights waits at the height a held chain can publish', function () {
    // A venue whose indexer 0 reports one constant heights map for every poll.
    function heightsVenue (heights) {
        let n = 0
        return {
            indexers: [{ index: 0 }],
            statusOf: async () => {
                n += 1
                return { httpStatus: 200, body: { indexerBlock: 103, decoderBlock: 103, hubMirror: { heights } } }
            },
            reads: () => n,
        }
    }

    it('resolves a margin-1 member at B-2, the height a chain held at B-1 can publish', async function () {
        // attestation_responses (margin 1) would need height 104 at B=105 on the plain line;
        // held at B-2=103 it never reaches 104, so only the clamp lets this resolve.
        assert.strictEqual(fixture.admitMarginBlocks('attestation_responses'), 1)
        const venue = heightsVenue({ cross_chain_matches: { BTC: 101 }, attestation_responses: { BTC: 103 } })
        const s = await drive.waitForHeldAdmissionHeights(venue, 0, ['cross_chain_matches', 'attestation_responses'], 'BTC', 105, 1000)
        assert.strictEqual(s.heights.attestation_responses.BTC, 103)
    })

    it('still asks a margin-4 member for its own unclamped B - margin line', async function () {
        this.timeout(6000)
        assert.strictEqual(fixture.admitMarginBlocks('cross_chain_matches'), 4)
        const venue = heightsVenue({ cross_chain_matches: { BTC: 100 }, attestation_responses: { BTC: 103 } })
        await assert.rejects(drive.waitForHeldAdmissionHeights(venue, 0, ['cross_chain_matches', 'attestation_responses'], 'BTC', 105, 50),
            /cross_chain_matches\.BTC at 100, needs 101/)
    })
})

describe('barrierFamilyDrive: an indexer whose API is not listening yet is not level, and not a failure', function () {
    it('keeps polling past a refused connection and levels once the API answers', async function () {
        this.timeout(10000)
        let refused = 0
        const venue = {
            indexers: [{ index: 0 }, { index: 1 }],
            statusOf: async (i) => {
                if (i === 1 && refused < 1) { refused += 1; throw new Error('connect ECONNREFUSED 127.0.0.1:62104') }
                return { httpStatus: 200, body: { indexerBlock: 100, decoderBlock: 100 } }
            },
        }
        const all = await drive.levelIndexers(venue, 8000)
        assert.strictEqual(refused, 1, 'the refused read never happened, so the case proves nothing')
        assert.deepStrictEqual(all.map((s) => s.height), [100, 100])
    })
})

describe('barrierFamilyDrive: a level chain is not a ready hub mirror', function () {
    /** A venue whose indexers are always level, and whose mirror flags come from `plan` per read. */
    function mirrorVenue (plan) {
        const reads = []
        const venue = {
            indexers: [{ index: 0 }, { index: 1 }],
            statusOf: async (i) => {
                const turn = reads.filter((r) => r === i).length
                reads.push(i)
                const hubMirror = plan(i, turn)
                return { httpStatus: 200, body: { indexerBlock: 100, decoderBlock: 100, hubMirror } }
            },
        }
        return { venue, reads }
    }

    it('does not release the baseline on a level chain whose mirror has not bootstrapped', async function () {
        this.timeout(10000)
        const ready = { configured: true, connected: true, bootstrapped: true }
        const { venue, reads } = mirrorVenue((i, turn) => (i === 1 && turn < 1
            ? { configured: true, connected: true, bootstrapped: false }
            : ready))
        const all = await drive.levelIndexers(venue, 8000, { requireMirrorReady: true })
        assert.ok(reads.filter((r) => r === 1).length > 1,
            'indexer 1 was read once, so the withheld bootstrap never held anything')
        assert.deepStrictEqual(all.map((s) => s.mirrorBootstrapped), [true, true])
    })

    it('releases on the same withheld bootstrap when the gate was not asked for', async function () {
        this.timeout(10000)
        const { venue } = mirrorVenue(() => ({ configured: true, connected: true, bootstrapped: false }))
        const all = await drive.levelIndexers(venue, 8000)
        assert.deepStrictEqual(all.map((s) => s.height), [100, 100])
    })

    it('treats an indexer with no mirror configured as ready, and an absent flag as not ready', function () {
        assert.strictEqual(drive.mirrorReady({ mirrorConfigured: false }).ok, true)
        assert.strictEqual(drive.mirrorReady({}).ok, false)
        assert.strictEqual(drive.mirrorReady({ mirrorConfigured: true, mirrorConnected: false, mirrorBootstrapped: true }).ok, false)
        assert.strictEqual(drive.mirrorReady({ mirrorConfigured: true, mirrorConnected: true, mirrorBootstrapped: false }).ok, false)
        assert.strictEqual(drive.mirrorReady({ mirrorConfigured: true, mirrorConnected: true, mirrorBootstrapped: true }).ok, true)
    })
})

describe('barrierFamilyDrive: the AT4 corpus coordinates and the VM link a copied tree breaks', function () {
    const fs = require('fs')
    const os = require('os')
    const path = require('path')

    function tree (link) {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'at4-vmlink-'))
        fs.mkdirSync(path.join(root, 'xchain-vm'))
        fs.writeFileSync(path.join(root, 'xchain-vm', 'package.json'), '{}')
        fs.mkdirSync(path.join(root, 'xchain-indexer', 'node_modules'), { recursive: true })
        fs.symlinkSync('../xchain-vm', path.join(root, 'xchain-indexer', 'node_modules', 'xchain-vm'))
        fs.symlinkSync(link, path.join(root, 'xchain-indexer', 'xchain-vm'))
        return root
    }

    it('passes a tree whose indexer link resolves to the sibling VM', function () {
        const root = tree('../xchain-vm')
        try { assert.strictEqual(drive.vmLinkProblem(root), null) } finally { fs.rmSync(root, { recursive: true, force: true }) }
    })

    it('names both hops and the re-link when the link points at a path this host lacks', function () {
        const root = tree('/srv/other-host/Sites/XChain-Platform/xchain-indexer/xchain-vm')
        try {
            const why = drive.vmLinkProblem(root)
            assert.match(String(why), /xchain-indexer\/node_modules\/xchain-vm -> \.\.\/xchain-vm/)
            assert.match(String(why), /xchain-indexer\/xchain-vm -> \/srv\/other-host\/Sites/)
            assert.ok(String(why).endsWith('ln -sfn ../xchain-vm ' + path.join(root, 'xchain-indexer', 'xchain-vm')), why)
        } finally { fs.rmSync(root, { recursive: true, force: true }) }
    })

    it('reads the corpus coordinates off the venue with the password named, never carried', function () {
        const venue = {
            coin: 'bitcoin', network: 'regtest', _live: { decoder: { name: 'XChain_BTC_Regtest_Decoder', host: '127.0.0.1', port: 57400, pass: 'secret' } },
            hubDb: { host: '127.0.0.1', port: '57400', user: 'root', pass: 'secret', disposable: false },
            indexers: [{ index: 0, mirrorDbName: 'XChain_AM_MVH_at4corpus_Mirror0' }],
        }
        const c = drive.corpusCoordinates(venue, 0, 'BTC')
        assert.deepStrictEqual(c, {
            coin: 'BTC', network: 'regtest', decoderDb: 'XChain_BTC_Regtest_Decoder', decoderServer: { host: '127.0.0.1', port: 57400 },
            mirrorDb: 'XChain_AM_MVH_at4corpus_Mirror0', db: { host: '127.0.0.1', port: '57400', user: 'root' },
            passEnv: 'HUB_DB_PASS', hubDbDisposable: false,
        })
        assert.ok(!JSON.stringify(c).includes('secret'))
        assert.throws(() => drive.corpusCoordinates(venue, 1, 'BTC'), /no indexer 1/)
    })

    it('reads each mirror\'s rows for the request with the admission column the coin binds on', async function () {
        const seen = []
        const mariadb = { createConnection: async (o) => ({
            query: async (sql, params) => { seen.push({ db: o.database, sql, params }); return [{ id: 1, admit_block_btc: 276 }] },
            end: async () => {},
        }) }
        const venue = { hubDb: { host: '127.0.0.1', port: '57400', user: 'root', pass: 'p' }, indexers: [{ mirrorDbName: 'M0' }, { mirrorDbName: 'M1' }] }
        const got = await drive.readAdmissionRows(venue, 'c24bfe588b4c7e52', 'LTC', { mariadb })
        assert.strictEqual(got.column, 'admit_block_btc')
        assert.deepStrictEqual(got.rows, [[{ id: 1, admit_block_btc: 276 }], [{ id: 1, admit_block_btc: 276 }]])
        assert.deepStrictEqual(seen.map((q) => q.db), ['M0', 'M1'])
        assert.match(seen[0].sql, /`admit_block_btc` FROM attestation_responses WHERE request_id = \?/)
        assert.deepStrictEqual(seen[0].params, ['c24bfe588b4c7e52'])
    })
})
