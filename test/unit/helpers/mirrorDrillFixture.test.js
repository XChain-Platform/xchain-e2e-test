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
        // The drills reach it through the prologue, which passes the
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
        assert.ok(/clearWedgeBefore\('contract deploy /.test(code), 'the deploy broadcast lost its pre-clear')
    })

    // THE STAKE BROADCAST IS GONE, AND THAT IS THE RULING RATHER THAN A CLEANUP.
    //
    // This guard replaced one asserting the stake's pre-clear was present, which
    // became a guard for the opposite of what the fixture is now supposed to do.
    // The venue ADOPTS the seated roster instead of staking into it, because
    // stake is a pre-filter and never a rank, so a new stake cannot win a draw
    // and only dilutes the pool with keys whose hubs are not in this mesh.
    //
    // Re-introducing a stake here would not fail loudly. It would seat a key,
    // the roster would grow by one, and roughly one draw in four would contain a
    // member some later run has no signer for, which presents as a missing
    // mirror row forty minutes in. So the absence is pinned.
    it('does not stake, because the venue adopts the roster instead', function () {
        const src = require('fs').readFileSync(fixturePath, 'utf8')
        const code = src.split('\n')
            .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
            .join('\n')

        assert.ok(!/sendStakeV1/.test(code),
            'mirrorDrillFixture broadcasts a stake again. The venue adopts the seated roster; a ' +
            'fresh stake dilutes the draw with a key no venue hub signs for, which is the failure ' +
            'that cost this ladder five AT1 drives.')
        assert.ok(/provisionDrillIdentities/.test(code),
            'the adoption entry point is gone; this guard must not pass vacuously against a file ' +
            'that simply no longer does anything')
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

describe('mirrorDrillFixture: the venue adopts the roll-call roster', function () {
    const { _pubkeyForSeed, _knownSignerSeeds, IDLE_GENERATION_SCAN } =
        require('../../attestMirror/mirrorDrillFixture')
    const rollcall = require('../../helpers/rollcallHelper')
    const crypto   = require('crypto')

    // THE WHOLE DESIGN RESTS ON THIS ONE EQUALITY, so it is pinned rather than
    // trusted: the keys seated for the attestation capability on the regtest
    // chain are the roll-call federation's three fixed signing seeds. If that
    // ever stops being true, the venue is back to competing with validators it
    // does not run, which is the failure that cost this ladder five drives.
    //
    // Pinned as PUBKEYS, read off the chain on 2026-09-04 at buried block 5370
    // and again at tip 5387. A future roster change should fail HERE, loudly,
    // rather than as a stalled round forty minutes into a drill.
    const SEATED_ON_REGTEST_2026_09_04 = [
        'd04ab232742bb4ab3a1368bd4615e4e6d0224ab71a016baf8520a332c9778737',
        'a09aa5f47a6759802ff955f8dc2d2a14a5c99d23be97f864127ff9383455a4f0',
        '17cb79fb2b4120f2b1ec65e4198d6e08b28e813feb01e4a400839b85e18080ce',
    ]

    it('derives the seated roster pubkeys from the federation signing seeds', function () {
        const derived = (rollcall.SIGNING_SEEDS || []).map((s) => _pubkeyForSeed(s))
        assert.deepStrictEqual(derived.slice().sort(), SEATED_ON_REGTEST_2026_09_04.slice().sort(),
            'the three federation signing seeds no longer derive the three keys measured as seated ' +
            'for the attestation capability. Either the seeds moved or the roster did; until they ' +
            'agree again the venue cannot adopt the roster and every draw containing an unadopted ' +
            'key stalls its round to timeout.')
    })

    it('derives a pubkey through the hub module, not a second implementation', function () {
        // Cross-checked against the hub's own identity class rather than against
        // a literal, so a change in the hub's derivation fails here instead of
        // producing hubs whose pubkeys nobody can match to a seat.
        const ValidatorIdentity = loadHubModule('src/ValidatorIdentity.js')
        const seed = '11'.repeat(32)
        assert.strictEqual(_pubkeyForSeed(seed),
            new ValidatorIdentity(seed).getPubkeyHex().toLowerCase())
    })

    it('holds a signer for every federation signing seed', function () {
        const known = _knownSignerSeeds()
        for (const seed of (rollcall.SIGNING_SEEDS || [])) {
            assert.ok(known.has(_pubkeyForSeed(seed)),
                'no signer held for federation seed deriving ' + _pubkeyForSeed(seed).slice(0, 16))
        }
    })

    it('holds the legacy idle seed, because an unconfigured venue seats it', function () {
        const known = _knownSignerSeeds()
        assert.ok(known.has(_pubkeyForSeed(rollcall.LEGACY_IDLE_SEED)),
            'the legacy idle key can be seated by an unconfigured roll-call venue, and a seated ' +
            'key with no signer is exactly what the adoption precondition exists to refuse')
    })

    it('SWEEPS idle generations, so a rotated generation still resolves', function () {
        // The generation is a roll-call-side counter this lane is never told, so
        // the sweep is what keeps a rotation from silently deriving a valid but
        // WRONG identity. Driven with a stand-in mnemonic at a generation well
        // above any configured one.
        const saved = process.env.XC_ROLLCALL_FEDERATION_MNEMONIC
        const savedGen = process.env.XC_ROLLCALL_IDLE_GENERATION
        try {
            process.env.XC_ROLLCALL_FEDERATION_MNEMONIC = 'a stand-in mnemonic for this guard'
            delete process.env.XC_ROLLCALL_IDLE_GENERATION
            const gen = IDLE_GENERATION_SCAN            // the last one swept
            const seed = crypto.createHash('sha256')
                .update('xchain-rollcall-idle|' + gen + '|' + process.env.XC_ROLLCALL_FEDERATION_MNEMONIC, 'utf8')
                .digest('hex')
            const known = _knownSignerSeeds()
            assert.ok(known.has(_pubkeyForSeed(seed)),
                'generation ' + gen + ' is inside the sweep and must resolve')
            assert.strictEqual(known.get(_pubkeyForSeed(seed)).origin, 'idle generation ' + gen)
        } finally {
            if (saved === undefined) delete process.env.XC_ROLLCALL_FEDERATION_MNEMONIC
            else process.env.XC_ROLLCALL_FEDERATION_MNEMONIC = saved
            if (savedGen === undefined) delete process.env.XC_ROLLCALL_IDLE_GENERATION
            else process.env.XC_ROLLCALL_IDLE_GENERATION = savedGen
        }
    })

    it('does NOT resolve a generation past the sweep, so the bound is real', function () {
        const saved = process.env.XC_ROLLCALL_FEDERATION_MNEMONIC
        try {
            process.env.XC_ROLLCALL_FEDERATION_MNEMONIC = 'a stand-in mnemonic for this guard'
            const beyond = IDLE_GENERATION_SCAN + 1
            const seed = crypto.createHash('sha256')
                .update('xchain-rollcall-idle|' + beyond + '|' + process.env.XC_ROLLCALL_FEDERATION_MNEMONIC, 'utf8')
                .digest('hex')
            assert.ok(!_knownSignerSeeds().has(_pubkeyForSeed(seed)),
                'a generation past the sweep must NOT resolve; a guard that matches everything ' +
                'would never let the adoption precondition refuse')
        } finally {
            if (saved === undefined) delete process.env.XC_ROLLCALL_FEDERATION_MNEMONIC
            else process.env.XC_ROLLCALL_FEDERATION_MNEMONIC = saved
        }
    })

    it('lets an explicitly pinned idle seed resolve', function () {
        const saved = process.env.XC_ROLLCALL_IDLE_SEED
        try {
            process.env.XC_ROLLCALL_IDLE_SEED = '5a'.repeat(32)
            const known = _knownSignerSeeds()
            const pk = _pubkeyForSeed('5a'.repeat(32))
            assert.ok(known.has(pk), 'XC_ROLLCALL_IDLE_SEED must resolve')
            assert.strictEqual(known.get(pk).origin, 'XC_ROLLCALL_IDLE_SEED')
        } finally {
            if (saved === undefined) delete process.env.XC_ROLLCALL_IDLE_SEED
            else process.env.XC_ROLLCALL_IDLE_SEED = saved
        }
    })
})

describe('mirrorDrillFixture: the provider floor is INCLUSIVE at equality', function () {
    // THE ADOPTED ROSTER LEANS ON THIS EXACTLY, which is why it is a test.
    //
    // Two of the seated validators carry weight 25000 and the `llm` provider
    // declares min_stake_xchain 25000, so the entire llm half of AT1 hangs on
    // the comparison being `>=` rather than `>`. If the hub ever tightens it,
    // the eligible set for llm drops from four to two, falls below redundancy 3,
    // and every llm round is skipped as unfinalizable: the request expires at
    // its deadline with nothing anywhere near the floor that caused it.
    //
    // Driven through the hub's OWN comparator rather than a re-implementation,
    // because a second implementation of a consensus filter in the test tree is
    // the thing this fixture exists to avoid.
    it('admits a validator whose weight equals the floor exactly', function () {
        const AttestationRound = loadHubModule('src/AttestationRound.js')
        const meets = AttestationRound.prototype._meetsProviderFloor
        assert.strictEqual(typeof meets, 'function',
            'the hub no longer exposes _meetsProviderFloor; the adoption precondition checks the ' +
            'floor through it and cannot silently fall back to a local comparison')

        assert.strictEqual(meets.call(null, '25000.00000000', '25000'), true,
            'weight exactly at the floor must be ADMITTED; two seated validators sit exactly here')
        assert.strictEqual(meets.call(null, '24999.99999999', '25000'), false,
            'a weight below the floor must be refused, or this guard proves nothing')
        assert.strictEqual(meets.call(null, '300000.00000000', '25000'), true)
    })

    it('reads the llm floor from the registry rather than a literal here', function () {
        const defaults = loadHubModule('src/ProviderRegistry.js').DEFAULTS || {}
        assert.ok(defaults.llm && defaults.llm.min_stake_xchain !== undefined,
            'could not read the llm provider floor; this guard must not pass vacuously')
        assert.strictEqual(String(defaults.llm.min_stake_xchain), '25000',
            'the llm floor moved. The seated roster carries two validators at exactly 25000, so a ' +
            'floor above that drops the eligible set below redundancy and makes every llm round ' +
            'unfinalizable. Re-measure the seated weights before changing this number.')
    })
})

describe('mirrorDrillFixture: resolveAdoptionPlan scopes the orphan rule by declared provider', function () {
    const { resolveAdoptionPlan } = require('../../attestMirror/mirrorDrillFixture')

    // A synthetic capability snapshot in the shape `readCapabilitySet` returns:
    // the raw `getstakeweightsbycapability` rows, keyed by pubkey. Weights are
    // decimal STRINGS because that is what the chain answers with and what both
    // the provider-floor comparator and the stake-weighted quorum are written to
    // handle exactly; a JS number here would test a rounding path nothing uses.
    const seatedSet = (rows) => ({
        pubkeys:  rows.map((r) => r.pubkey),
        byPubkey: new Map(rows.map((r) => [r.pubkey, r])),
    })
    const member = (tag, weight) => ({ pubkey: tag.repeat(64).slice(0, 64), source: 'source-' + tag, weight: weight })
    const signersFor = (rows) => new Map(rows.map((r, i) => [r.pubkey, { seedHex: String(i), origin: 'test seed ' + i }]))

    // THE MEASURED SITUATION THIS OPTION WAS BUILT FOR, 2026-09-08: the re-genesised
    // BTC regtest chain seats one key at 10000 which is the STANDING hub's own
    // identity. Its seed lives in that hub's container, so the harness cannot sign
    // for it, and a venue hub running the same key beside the live one would
    // equivocate and get it slashed. It clears the http_get floor (10000) and misses
    // the llm floor (25000).
    const FOREIGN = member('a', '10000.00000000')
    const VENUE   = [member('1', '50000.00000000'), member('2', '50000.00000000'),
                     member('3', '50000.00000000'), member('4', '50000.00000000')]
    const plan = (rows, opts) => resolveAdoptionPlan(seatedSet(rows), signersFor(rows.filter((r) => r !== FOREIGN)),
        Object.assign({ redundancy: 3, buriedBlock: 5000, network: 'regtest' }, opts))

    it('passes a below-floor foreign key OVER rather than refusing on it', function () {
        const out = plan(VENUE.concat([FOREIGN]), { providers: ['llm'] })
        assert.deepStrictEqual(out.belowFloor, [FOREIGN.pubkey],
            'the seated key that misses every declared floor must be listed, not silently dropped: it ' +
            'still counts against the batch co-sign quorum and a reader has to be able to see it')
        assert.deepStrictEqual(out.adopted.map((a) => a.pubkeyHex), VENUE.map((v) => v.pubkey))
        assert.deepStrictEqual(out.orphans, [], 'a key no draw can contain is not this drill\'s orphan')
        assert.deepStrictEqual(out.floorReport, [{ providerId: 'llm', floor: '25000', eligible: 4 }])
    })

    it('REFUSES the identical key when the drill declares a provider whose floor it clears', function () {
        // The same set and the same signers: only the declared provider moves. This
        // is the pair that proves the scoping is doing the work rather than a
        // loosened rule quietly admitting everything.
        assert.throws(() => plan(VENUE.concat([FOREIGN]), { providers: ['http_get'] }), (e) => {
            assert.ok(e.message.indexOf(FOREIGN.pubkey.slice(0, 16)) >= 0,
                'the refusal must name the key it refused on, got: ' + e.message)
            assert.ok(/declares \(http_get\)/.test(e.message),
                'the refusal must name the provider scope it judged against, got: ' + e.message)
            return true
        })
    })

    it('defaults to EVERY registry provider, which is what every caller had before the option', function () {
        // Omitting `providers` must not quietly become the permissive case: the
        // drills that ask for http_get still have to refuse on this key.
        assert.throws(() => plan(VENUE.concat([FOREIGN]), {}), /have NO signing key this harness can run/)
    })

    it('still refuses a declared provider whose floor leaves fewer keys than the redundancy', function () {
        // Two venue keys and the foreign one, llm declared: the foreign key is
        // filtered out of the draw as before, and what is left is short. The round
        // is then skipped as unfinalizable and the request expires with nothing
        // anywhere near the floor that caused it, so this must fail here.
        assert.throws(() => plan(VENUE.slice(0, 2).concat([FOREIGN]), { providers: ['llm'] }),
            /only 2 of 3 seated validator\(s\) clear it .* below the redundancy of 3/s)
    })

    it('refuses a venue that cannot reach the BATCH quorum beside its silent set members', function () {
        // THE HALF THE PROVIDER FLOOR DOES NOT COVER. `_verifyBatchQuorum` measures
        // a window's signatures against the whole capability snapshot, so keys the
        // draw filters out still raise the batch bar. Three adoptable keys at 25000
        // against three silent ones just under the llm floor: eligible 3 of 6 clears
        // the redundancy, and 3 x 75000 does not exceed 2 x 149999.99999997.
        const ours    = ['1', '2', '3'].map((t) => member(t, '25000.00000000'))
        const silent  = ['x', 'y', 'z'].map((t) => member(t, '24999.99999999'))
        const rows    = ours.concat(silent)
        assert.throws(() => resolveAdoptionPlan(seatedSet(rows), signersFor(ours),
            { providers: ['llm'], redundancy: 3, buriedBlock: 5000, network: 'regtest' }),
        (e) => {
            assert.ok(/cannot reach the batch co-sign quorum/.test(e.message), e.message)
            assert.ok(/3 x 75000 must exceed 2 x 149999\.99999997/.test(e.message),
                'the refusal must carry the arithmetic it refused on, got: ' + e.message)
            assert.ok(e.message.indexOf(silent[0].pubkey.slice(0, 16)) >= 0,
                'the refusal must name the silent members that raised the bar, got: ' + e.message)
            return true
        })
    })

    it('reports NO SPARE when losing one venue signer would lose the batch quorum', function () {
        // Three adoptable at 25000 beside one silent at 24999.99999999: the quorum
        // holds with all three (225000 > 199999.99999998) and fails with any two
        // (150000). Not fatal, because such a venue still publishes when nothing
        // goes wrong, but a window that fails the first time a hub child is slow
        // must be recognisable rather than new.
        const ours   = ['1', '2', '3'].map((t) => member(t, '25000.00000000'))
        const silent = [member('x', '24999.99999999')]
        const out = resolveAdoptionPlan(seatedSet(ours.concat(silent)), signersFor(ours),
            { providers: ['llm'], redundancy: 3, buriedBlock: 5000, network: 'regtest' })
        assert.strictEqual(out.quorum.weighted, true)
        assert.strictEqual(out.quorum.spare, false)

        // And the roster the reseed tool is sized for DOES carry the spare, which is
        // the whole reason that count is what it is.
        const sized = plan(VENUE.concat([FOREIGN]), { providers: ['llm'] })
        assert.strictEqual(sized.quorum.spare, true)
        assert.strictEqual(sized.quorum.totalStake, '210000')
        assert.strictEqual(sized.quorum.oursStake, '200000')
    })

    it('falls to the COUNT rule where stake-weighted quorum is not active', function () {
        // The batch verifier branches on `isStakeWeightedQuorumActive(anchor, network)`
        // and an unknown network answers false (safe direction), so this pins that the
        // check follows the hub rather than assuming the weighted rule everywhere.
        const out = plan(VENUE.concat([FOREIGN]), { providers: ['llm'], network: 'nosuchnetwork' })
        assert.strictEqual(out.quorum.weighted, false)
        assert.strictEqual(out.quorum.spare, true, '4 of 5 with a count quorum of 3 has a spare')
    })

    it('refuses an unknown or empty provider list rather than scoping the rule to nothing', function () {
        assert.throws(() => plan(VENUE.concat([FOREIGN]), { providers: ['not_a_provider'] }),
            /unknown provider not_a_provider/)
        assert.throws(() => plan(VENUE.concat([FOREIGN]), { providers: [] }),
            /must name at least one provider/)
    })
})

describe('mirrorDrillFixture: assertResponsibleSetIsVenueOnly', function () {
    const { assertResponsibleSetIsVenueOnly } = require('../../attestMirror/mirrorDrillFixture')

    const venue = { hubs: [
        { pubkey: 'ff5eeb94d7559682aaaa' },
        { pubkey: 'c6f6a81411278f23bbbb' },
        { pubkey: 'cc5d20c35ade8568cccc' },
    ] }
    const cap = (responsibleArrays) => ({
        phase: 'x', requestId: 'r',
        hubs: responsibleArrays.map((r, i) => ({ hub: i, responsible: r })),
    })

    it('passes when every drawn member is a hub this venue runs', function () {
        assertResponsibleSetIsVenueOnly(venue, cap([
            ['ff5eeb94d7559682', 'c6f6a81411278f23', 'cc5d20c35ade8568'],
        ]))
    })

    it('names the members it cannot account for', function () {
        // The real run 5 draw: one venue hub, one out-of-mesh validator, one dead key.
        assert.throws(() => assertResponsibleSetIsVenueOnly(venue, cap([
            ['d04ab232742bb4ab', 'cc5d20c35ade8568', '7e3aa9d750d51883'],
        ])), (e) => {
            assert.ok(/d04ab232742bb4ab/.test(e.message), 'must name the foreign member')
            assert.ok(/7e3aa9d750d51883/.test(e.message), 'must name every foreign member, not the first')
            assert.ok(!/cc5d20c35ade8568,/.test(e.message.split('Venue hubs:')[0]),
                'must not accuse the member that IS a venue hub')
            assert.ok(/ADOPTS the roster/.test(e.message),
                'must point at the mechanism, since that is what the reader has to change: the ' +
                'venue adopts the roster, so a foreign member means a seated key got no hub')
            return true
        })
    })

    it('refuses to render a verdict when no hub returned a readable set', function () {
        // The capture reports an error STRING rather than an array when a probe
        // fails. Treating that as a clean draw is the same defect the capture
        // itself was rebuilt for, so this must refuse rather than pass.
        assert.throws(() => assertResponsibleSetIsVenueOnly(venue, {
            phase: 'x', requestId: 'r',
            hubs: [{ hub: 0, responsible: 'unreachable: boom' }, { hub: 1, responsible: 'hub stopped' }],
        }), /INSTRUMENT failure and NOT evidence/)
    })

    it('judges on the readable hubs when only some could be read', function () {
        assert.throws(() => assertResponsibleSetIsVenueOnly(venue, {
            phase: 'x', requestId: 'r',
            hubs: [
                { hub: 0, responsible: 'unreachable: boom' },
                { hub: 1, responsible: ['d04ab232742bb4ab'] },
            ],
        }), /d04ab232742bb4ab/)
    })
})
