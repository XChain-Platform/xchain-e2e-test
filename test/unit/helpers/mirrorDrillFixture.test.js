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

// The one part of the attest-mirror drill prologue that can be judged without a
// chain: how far past a stake a request has to sit before that stake is
// selectable.
//
// It is worth pinning precisely because getting it wrong is invisible. Mine too
// few blocks and the stake is real, confirmed and simply not yet visible to the
// capability snapshot, so the responsible set comes back short, the request is
// refused at admission, and the EXECUTE that emitted it rolls back with no
// valid execution row. Nothing in that chain of events mentions a stake.

const assert = require('assert')

const { stakeVisibilityBlocks } = require('../../attestMirror/mirrorDrillFixture')
const stakeHelper = require('../../helpers/stakeHelper')
const { loadHubModule } = require('../../helpers/multiValidatorHubHelper')

describe('mirrorDrillFixture: stake visibility distance', function () {

    it('accepts BTC, the chain every attest drill runs on', () => {
        // BTC activation is 6 and the burial is 6, so the shared constant's 14
        // carries two blocks of margin. This is the only combination the drills
        // actually use, so it must not merely pass, it must pass for the stated
        // reason: read both terms and check the arithmetic rather than the result.
        const activation = Number(
            loadHubModule('src/coins/index.js').getCoinConfig('BTC', 'regtest').STAKING.ACTIVATION_DELAY_BLOCKS)
        const burial = Number(loadHubModule('src/snapshot_reorg_buffer.js').CANONICAL_REORG_BUFFER)
        const shared = Number(stakeHelper.ATTESTATION_STAKE_VISIBLE_BLOCKS)

        assert.strictEqual(activation, 6, 'BTC activation delay moved; the shared constant needs re-checking')
        assert.strictEqual(burial, 6, 'CANONICAL_REORG_BUFFER moved; the shared constant needs re-checking')
        assert.ok(shared >= activation + burial)
        assert.strictEqual(stakeVisibilityBlocks('BTC', 'regtest'), shared)
    })

    it('REFUSES a chain whose activation delay outruns the shared constant', () => {
        // DOGE's activation delay is 60, so the shared 14 is nowhere near enough
        // and a drill pointed at that chain would stake, mine 14, and then watch
        // its requests get refused at admission for no visible reason. This is
        // not hypothetical padding: the attest BATCH rail rides DOGE, so a future
        // drill on that chain is a question of when.
        assert.throws(() => stakeVisibilityBlocks('DOGE', 'regtest'), (e) => {
            assert.ok(/60 activation \+ 6 burial = 66/.test(e.message),
                'the refusal must show the arithmetic it refused on, got: ' + e.message)
            assert.ok(/ATTESTATION_STAKE_VISIBLE_BLOCKS is 14/.test(e.message),
                'the refusal must name the constant that is too small, got: ' + e.message)
            return true
        })
    })

    it('refuses LTC too, which is the near miss rather than the obvious one', () => {
        // 24 + 6 = 30 against 14. Included separately from DOGE because a rule
        // that only catches the extreme case is easy to write by accident.
        assert.throws(() => stakeVisibilityBlocks('LTC', 'regtest'),
            /24 activation \+ 6 burial = 30/)
    })

    it('takes the harness COIN global, which is a full name and not a ticker', () => {
        // The bug this caught on AT1's first run. The harness sets COIN to
        // 'bitcoin' while the registry is keyed by 'BTC', so passing COIN
        // straight through asked for 'BITCOIN' and the guard refused. It
        // refused CORRECTLY, which is why this is a translation fix rather than
        // a loosened rule: the drill would otherwise have staked and mined the
        // wrong number of blocks against a chain nobody had checked.
        assert.strictEqual(stakeVisibilityBlocks('bitcoin', 'regtest'),
            Number(stakeHelper.ATTESTATION_STAKE_VISIBLE_BLOCKS))
        assert.strictEqual(stakeVisibilityBlocks('BITCOIN', 'regtest'),
            Number(stakeHelper.ATTESTATION_STAKE_VISIBLE_BLOCKS))
        // And the full names still route to the per-chain answer rather than
        // collapsing to BTC's: dogecoin must refuse exactly as DOGE does.
        assert.throws(() => stakeVisibilityBlocks('dogecoin', 'regtest'),
            /60 activation \+ 6 burial = 66/)
    })

    it('refuses a coin it cannot resolve rather than falling back to a default', () => {
        // A silent default here is the whole failure mode: it would hand back 14
        // for a chain nobody checked.
        assert.throws(() => stakeVisibilityBlocks('NOPE', 'regtest'),
            /could not read STAKING.ACTIVATION_DELAY_BLOCKS/)
    })

    it('defaults to BTC when given nothing, rather than throwing on an absent argument', () => {
        // The drills call it through stakeDrillIdentities, which passes the
        // harness COIN; a bare call is the developer-console path and should
        // answer for the chain the drills use.
        assert.strictEqual(stakeVisibilityBlocks(), Number(stakeHelper.ATTESTATION_STAKE_VISIBLE_BLOCKS))
    })
})

describe('mirrorDrillFixture: withWedgeClear', function () {
    const { withWedgeClear } = require('../../attestMirror/mirrorDrillFixture')
    const waitsPath = require.resolve('../../attestMirror/mirrorDrillWaits')
    let savedWaits

    // The helper lazy-requires mirrorDrillWaits (a cycle otherwise), so the
    // seam is the module cache. Driving the REAL module here would mine DOGE
    // on a live regtest chain from a unit test.
    function stubWaits (stub) {
        savedWaits = require.cache[waitsPath]
        require.cache[waitsPath] = {
            id: waitsPath, filename: waitsPath, loaded: true, exports: stub,
        }
    }

    afterEach(function () {
        if (savedWaits) { require.cache[waitsPath] = savedWaits } else { delete require.cache[waitsPath] }
        savedWaits = undefined
    })

    function waitsStub (sample, mined) {
        return {
            DOGE_NUDGE_BLOCKS: 3,
            standingTipProbe: () => async () => sample,
            mineDogeBlocks: async (n) => { mined.push(n); return 999 },
        }
    }

    // RENAMED from "never probes": the wrapper now pre-clears, so it DOES probe
    // before the call. What must still hold is that an unreadable probe never
    // blocks or retries the work it guards, which is what this drives by making
    // the probe throw.
    it('runs a succeeding step exactly once even when the probe cannot answer', async function () {
        const mined = []
        stubWaits({
            DOGE_NUDGE_BLOCKS: 3,
            standingTipProbe: () => async () => { throw new Error('probe is down') },
            mineDogeBlocks: async () => { throw new Error('must not mine on success') },
        })
        let calls = 0
        const out = await withWedgeClear('step', async () => { calls++; return 'ok' })
        assert.strictEqual(out, 'ok')
        assert.strictEqual(calls, 1, 'a succeeding step must run exactly once')
        assert.deepStrictEqual(mined, [])
    })

    it('clears the wedge and retries ONCE when the node is behind its decoder on rollcall', async function () {
        const mined = []
        stubWaits(waitsStub({ height: 3853, decoder: 3855, reason: 'rollcall_proof_unavailable' }, mined))
        let calls = 0
        const out = await withWedgeClear('mint', async () => {
            calls++
            if (calls === 1) throw new Error('checkMint: GAVE UP after 60282ms')
            return 'landed'
        })
        assert.strictEqual(out, 'landed')
        assert.strictEqual(calls, 2, 'the step must be retried exactly once after the clear')
        // TWICE, and that is correct rather than a double-nudge bug: this stub
        // reports the node wedged from the very start, so the PRE-clear fires
        // before the call and the RETRY clear fires after it fails. A node that
        // is healthy at the start and wedges mid-wait mines only once, which is
        // the 'forms DURING the wait' case below.
        assert.deepStrictEqual(mined, [3, 3],
            'a node wedged from the start is cleared once before the call and once before the retry')
    })

    it('rethrows the ORIGINAL error when the node is merely draining, and mines nothing', async function () {
        // Behind its decoder but NOT on the roll-call reason: a node draining
        // normally. Mining DOGE here would be a nudge for nothing.
        const mined = []
        stubWaits(waitsStub({ height: 3853, decoder: 3855, reason: null }, mined))
        await assert.rejects(
            () => withWedgeClear('mint', async () => { throw new Error('checkMint: GAVE UP after 60282ms') }),
            /GAVE UP after 60282ms/)
        assert.deepStrictEqual(mined, [], 'a draining node must not be nudged')
    })

    it('rethrows when the node is AT its decoder even if the reason still reads rollcall', async function () {
        const mined = []
        stubWaits(waitsStub({ height: 3855, decoder: 3855, reason: 'rollcall_proof_unavailable' }, mined))
        await assert.rejects(
            () => withWedgeClear('deploy', async () => { throw new Error('checkContract: GAVE UP') }),
            /checkContract: GAVE UP/)
        assert.deepStrictEqual(mined, [], 'a node level with its decoder is not wedged')
    })

    it('rethrows the original error when the probe itself cannot answer', async function () {
        const mined = []
        stubWaits({
            DOGE_NUDGE_BLOCKS: 3,
            standingTipProbe: () => async () => { throw new Error('ECONNREFUSED') },
            mineDogeBlocks: async (n) => { mined.push(n) },
        })
        await assert.rejects(
            () => withWedgeClear('stake', async () => { throw new Error('original failure') }),
            /original failure/,
            'an unreadable probe must not swallow the real error')
        assert.deepStrictEqual(mined, [])
    })

    it('lets a second failure escape rather than retrying forever', async function () {
        const mined = []
        stubWaits(waitsStub({ height: 3853, decoder: 3855, reason: 'rollcall_proof_unavailable' }, mined))
        let calls = 0
        await assert.rejects(
            () => withWedgeClear('mint', async () => { calls++; throw new Error('still wedged #' + calls) }),
            /still wedged #2/)
        assert.strictEqual(calls, 2, 'exactly one retry, never a loop')
    })
})

describe('mirrorDrillFixture: clearWedgeBefore, and the broadcast-safety rule it enforces', function () {
    const fixturePath = require.resolve('../../attestMirror/mirrorDrillFixture')
    const { clearWedgeBefore } = require('../../attestMirror/mirrorDrillFixture')
    const waitsPath = require.resolve('../../attestMirror/mirrorDrillWaits')
    let savedWaits

    function stubWaits (stub) {
        savedWaits = require.cache[waitsPath]
        require.cache[waitsPath] = { id: waitsPath, filename: waitsPath, loaded: true, exports: stub }
    }

    afterEach(function () {
        if (savedWaits) { require.cache[waitsPath] = savedWaits } else { delete require.cache[waitsPath] }
        savedWaits = undefined
    })

    it('mines and reports true when the node is wedged', async function () {
        const mined = []
        stubWaits({
            DOGE_NUDGE_BLOCKS: 3,
            standingTipProbe: () => async () => ({ height: 4033, decoder: 4046, reason: 'rollcall_proof_unavailable' }),
            mineDogeBlocks: async (n) => { mined.push(n); return 1 },
        })
        assert.strictEqual(await clearWedgeBefore('stake 0'), true)
        assert.deepStrictEqual(mined, [3])
    })

    it('mines nothing and reports false when the node is merely draining', async function () {
        const mined = []
        stubWaits({
            DOGE_NUDGE_BLOCKS: 3,
            standingTipProbe: () => async () => ({ height: 4033, decoder: 4046, reason: null }),
            mineDogeBlocks: async (n) => { mined.push(n) },
        })
        assert.strictEqual(await clearWedgeBefore('stake 0'), false)
        assert.deepStrictEqual(mined, [], 'a draining node must not be nudged')
    })

    it('never throws when the probe cannot answer, because it guards a broadcast', async function () {
        stubWaits({
            DOGE_NUDGE_BLOCKS: 3,
            standingTipProbe: () => async () => { throw new Error('ECONNREFUSED') },
            mineDogeBlocks: async () => { throw new Error('must not mine') },
        })
        assert.strictEqual(await clearWedgeBefore('deploy'), false,
            'an unreadable probe must not block the broadcast it precedes')
    })

    // THE REGRESSION GUARD FOR THE HAZARD ITSELF, not for the helper.
    //
    // withWedgeClear RETRIES its callback. Around a broadcast-and-wait that means
    // a second transaction: a double stake, or two contracts where the drill
    // assumes one. Those two calls must therefore be preceded by clearWedgeBefore
    // and never wrapped. This reads the source because the rule is about SHAPE,
    // and a behavioural test would have to actually broadcast twice to catch it.
    it('never wraps a broadcast-and-wait call in the retrying helper', function () {
        const src = require('fs').readFileSync(fixturePath, 'utf8')

        // Only the executable body: the file's own prose explains this rule and
        // legitimately names both helpers next to both calls.
        const code = src.split('\n')
            .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
            .join('\n')

        const wrapped = /withWedgeClear\([^)]*,\s*\(\)\s*=>\s*(stakeHelper\.sendStakeV1|vmHelper\.sendDeployV0)/
        assert.ok(!wrapped.test(code),
            'a broadcast-and-wait call is wrapped in withWedgeClear, which retries it and would ' +
            'double-stake or deploy twice; precede it with clearWedgeBefore instead')

        // And the protection is actually present rather than merely absent.
        assert.ok(/clearWedgeBefore\('stake /.test(code), 'the stake broadcast lost its pre-clear')
        assert.ok(/clearWedgeBefore\('contract deploy /.test(code), 'the deploy broadcast lost its pre-clear')
    })
})

describe('mirrorDrillFixture: withWedgeClear also pre-clears', function () {
    const { withWedgeClear } = require('../../attestMirror/mirrorDrillFixture')
    const waitsPath = require.resolve('../../attestMirror/mirrorDrillWaits')
    let savedWaits

    function stubWaits (stub) {
        savedWaits = require.cache[waitsPath]
        require.cache[waitsPath] = { id: waitsPath, filename: waitsPath, loaded: true, exports: stub }
    }
    afterEach(function () {
        if (savedWaits) { require.cache[waitsPath] = savedWaits } else { delete require.cache[waitsPath] }
        savedWaits = undefined
    })

    it('clears a wedge that ALREADY EXISTS before running the call, without retrying', async function () {
        // The pre-clear case: wedged at the start, the call then succeeds. The
        // retry must NOT fire, so the call runs exactly once.
        const order = []
        stubWaits({
            DOGE_NUDGE_BLOCKS: 3,
            standingTipProbe: () => async () => ({ height: 10, decoder: 20, reason: 'rollcall_proof_unavailable' }),
            mineDogeBlocks: async () => { order.push('mine'); return 1 },
        })
        const out = await withWedgeClear('gas mint', async () => { order.push('call'); return 'ok' })
        assert.strictEqual(out, 'ok')
        assert.deepStrictEqual(order, ['mine', 'call'],
            'the wedge must be cleared BEFORE the call, and the call must run once')
    })

    it('does not mine at all when the node is healthy', async function () {
        const order = []
        stubWaits({
            DOGE_NUDGE_BLOCKS: 3,
            standingTipProbe: () => async () => ({ height: 20, decoder: 20, reason: null }),
            mineDogeBlocks: async () => { order.push('mine') },
        })
        await withWedgeClear('gas mint', async () => { order.push('call'); return 'ok' })
        assert.deepStrictEqual(order, ['call'], 'a healthy node must not be mined for')
    })

    it('still recovers a wedge that forms DURING the wait', async function () {
        // Healthy at the start, so the pre-clear does nothing; the call then
        // fails against a node that has since wedged, and the retry recovers it.
        let probes = 0
        const order = []
        stubWaits({
            DOGE_NUDGE_BLOCKS: 3,
            standingTipProbe: () => async () => {
                probes++
                return probes === 1
                    ? { height: 20, decoder: 20, reason: null }
                    : { height: 20, decoder: 33, reason: 'rollcall_proof_unavailable' }
            },
            mineDogeBlocks: async () => { order.push('mine'); return 1 },
        })
        let calls = 0
        const out = await withWedgeClear('gas mint', async () => {
            order.push('call')
            calls++
            if (calls === 1) throw new Error('checkMint: GAVE UP')
            return 'recovered'
        })
        assert.strictEqual(out, 'recovered')
        assert.deepStrictEqual(order, ['call', 'mine', 'call'],
            'a mid-wait wedge must still be cleared and the call retried')
    })
})

describe('mirrorDrillFixture: queryVenueDb selects the database it validates', function () {
    const { queryVenueDb } = require('../../attestMirror/mirrorDrillFixture')
    const mariadbPath = require.resolve('mariadb')
    let saved

    // queryVenueDb lazy-requires mariadb inside the function, so the module
    // cache is the seam. A behavioural test would need a live venue database;
    // this asserts the CONNECTION OPTIONS, which is where the defect lived.
    function stubMariadb (captured) {
        saved = require.cache[mariadbPath]
        require.cache[mariadbPath] = {
            id: mariadbPath, filename: mariadbPath, loaded: true,
            exports: {
                createConnection: async (opts) => {
                    captured.push(opts)
                    return {
                        query: async () => [{ ok: 1 }],
                        end: async () => {},
                    }
                },
            },
        }
    }

    afterEach(function () {
        if (saved) { require.cache[mariadbPath] = saved } else { delete require.cache[mariadbPath] }
        saved = undefined
    })

    const venue = { hubDb: { host: '127.0.0.1', port: '13306', user: 'u', pass: 'p' } }

    it('passes the database name to the connection, not just past the validator', async function () {
        // THE REGRESSION. Without `database:` every unqualified query dies with
        // errno 1046, and both of this module's readers go through here, so the
        // failure surfaces at the END of a long drill as an unexplained error.
        const captured = []
        stubMariadb(captured)
        await queryVenueDb(venue, 'XChain_BTC_Regtest_MVH_ix0', 'SELECT 1', [])
        assert.strictEqual(captured.length, 1, 'expected exactly one connection')
        assert.strictEqual(captured[0].database, 'XChain_BTC_Regtest_MVH_ix0',
            'the validated database name must reach the connection, or every query is 1046')
    })

    it('still refuses an unsafe identifier before connecting at all', async function () {
        const captured = []
        stubMariadb(captured)
        await assert.rejects(
            () => queryVenueDb(venue, 'bad; DROP TABLE x', 'SELECT 1', []),
            /refusing an unsafe database identifier/)
        assert.strictEqual(captured.length, 0, 'it must refuse before opening a connection')
    })
})
