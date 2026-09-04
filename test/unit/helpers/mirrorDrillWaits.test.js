'use strict'

/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * The pure half of the attest-mirror drills' shared comparison layer.
 *
 * WHY THIS IS WORTH A UNIT SUITE. AT2 through AT6 are hour-long venue drills, so
 * a defect in the code that decides whether two nodes AGREE is discovered at the
 * worst possible moment and, worse, in the direction that hides defects: a diff
 * function that compares nothing passes every drill. These functions decide
 * exactly that, they are pure, and they cost seconds to pin here.
 *
 * `firstSatisfyingBlock` gets the most attention because it is §4.1's binding
 * rule as arithmetic, and AT3 is built entirely on its edges: at the deadline
 * block a row applies, one block past it the row is never applied at all.
 ********************************************************************/

const assert = require('assert')

const {
    APPLIED_FIELDS, STATE_HASH_FIELDS, ROLLCALL_STALL_AFTER_MS,
    until, diffRows, diffStateHashes, rewardFingerprint, firstSatisfyingBlock, wedgeVerdict, happyPathVerdict,
} = require('../../attestMirror/mirrorDrillWaits')

describe('mirrorDrillWaits: the shared comparison layer for AT2 to AT6', () => {

    describe('the field lists cannot silently shrink', () => {

        // An extraction floor rather than an exact list: the point is that a
        // comparison cannot quietly stop covering the columns that carry the
        // claim, while a drill remains free to add one.
        it('keeps every field that carries the tx-less and determinism claims', () => {
            for (const f of ['action_index', 'block_index', 'tx_index', 'tx_hash',
                             'response_payload', 'callback_execute_action_index']) {
                assert.ok(APPLIED_FIELDS.includes(f),
                    'APPLIED_FIELDS no longer covers ' + f + ', so a drill comparing two applied rows ' +
                    'would agree about a difference in it')
            }
        })

        it('keeps all four signed roots, because height agreement is not ledger agreement', () => {
            assert.deepStrictEqual(STATE_HASH_FIELDS.slice().sort(),
                ['balances_root', 'block_merkle_root', 'stakes_root', 'state_root'])
        })

        it('freezes both lists, so a drill cannot mutate the shared one it compares against', () => {
            assert.throws(() => { APPLIED_FIELDS.push('nonsense') })
            assert.throws(() => { STATE_HASH_FIELDS.push('nonsense') })
        })
    })

    describe('diffRows', () => {

        it('reports nothing for identical rows', () => {
            const row = { action_index: 5, block_index: 100, tx_index: null }
            assert.deepStrictEqual(diffRows(row, Object.assign({}, row), ['action_index', 'block_index', 'tx_index']), [])
        })

        it('reports EVERY differing field, not just the first', () => {
            const a = { action_index: 5, block_index: 100, tx_hash: 'aa' }
            const b = { action_index: 6, block_index: 101, tx_hash: 'aa' }
            assert.deepStrictEqual(diffRows(a, b, ['action_index', 'block_index', 'tx_hash']),
                ['action_index: 5 vs 6', 'block_index: 100 vs 101'])
        })

        it('treats a number and its own decimal spelling as equal, because the driver picks', () => {
            // A BIGINT column arrives as a number on one connection and a string on
            // another depending on width. Calling that a fork would cry wolf on every
            // honest run.
            assert.deepStrictEqual(diffRows({ action_index: 42 }, { action_index: '42' }, ['action_index']), [])
        })

        it('treats null and undefined as one spelling, and NEITHER as zero', () => {
            assert.deepStrictEqual(diffRows({ tx_index: null }, {}, ['tx_index']), [])
            // The one that matters: a synthesized action carries NULL tx_index, and a
            // node that wrote 0 there gave the response a transaction position. That
            // must read as a difference.
            assert.deepStrictEqual(diffRows({ tx_index: null }, { tx_index: 0 }, ['tx_index']),
                ['tx_index: NULL vs 0'])
        })

        it('reports a field absent from both as identical rather than inventing a diff', () => {
            assert.deepStrictEqual(diffRows({}, {}, ['nope']), [])
        })

        it('survives a missing row object, so a one-sided apply is reported and not thrown', () => {
            const diffs = diffRows(null, { action_index: 5 }, ['action_index'])
            assert.deepStrictEqual(diffs, ['action_index: NULL vs 5'])
        })
    })

    describe('diffStateHashes', () => {

        const base = {
            state_root: 'aa', balances_root: 'bb', stakes_root: 'cc', block_merkle_root: 'dd',
        }

        it('passes two identical hash sets', () => {
            assert.deepStrictEqual(diffStateHashes(base, Object.assign({}, base)), [])
        })

        // Falsification, one root at a time: a comparison that dropped any single
        // root would still pass the identical case above.
        for (const field of ['state_root', 'balances_root', 'stakes_root', 'block_merkle_root']) {
            it('catches a divergence in ' + field + ' alone', () => {
                const other = Object.assign({}, base)
                other[field] = 'ff'
                assert.deepStrictEqual(diffStateHashes(base, other), [field + ': ' + base[field] + ' vs ff'])
            })
        }
    })

    describe('rewardFingerprint', () => {

        const rows = [
            { id: 9, signing_pubkey_id: 3, source_id: 1, reward_type: 'attest_fee', pubkey: 'BB', amount: '10.5', block_index: 100 },
            { id: 8, signing_pubkey_id: 7, source_id: 2, reward_type: 'attest_fee', pubkey: 'aa', amount: '10.5', block_index: 100 },
        ]

        it('ignores the per-database surrogate keys two nodes cannot agree on', () => {
            const other = rows.map((r, i) => Object.assign({}, r, { id: 100 + i, signing_pubkey_id: 900 + i, source_id: 5 }))
            assert.deepStrictEqual(rewardFingerprint(rows), rewardFingerprint(other))
        })

        it('is order independent, because two nodes have no reason to return one order', () => {
            assert.deepStrictEqual(rewardFingerprint(rows), rewardFingerprint(rows.slice().reverse()))
        })

        it('lower-cases the pubkey, which arrives in three spellings across this codebase', () => {
            assert.deepStrictEqual(rewardFingerprint([rows[0]]), ['attest_fee|bb|10.5|100'])
        })

        it('still distinguishes a different amount, a different type and a different block', () => {
            const one = rewardFingerprint([rows[0]])
            assert.notDeepStrictEqual(one, rewardFingerprint([Object.assign({}, rows[0], { amount: '10.6' })]))
            assert.notDeepStrictEqual(one, rewardFingerprint([Object.assign({}, rows[0], { reward_type: 'attest_bcast' })]))
            assert.notDeepStrictEqual(one, rewardFingerprint([Object.assign({}, rows[0], { block_index: 101 })]))
        })

        it('answers an empty list for no rows rather than throwing', () => {
            assert.deepStrictEqual(rewardFingerprint(null), [])
        })
    })

    describe('firstSatisfyingBlock: section 4.1 as arithmetic', () => {

        // t(B) is protocol time, non-decreasing over the canonical chain.
        const window = [
            { block_index: 100, block_time: 1000 },
            { block_index: 101, block_time: 1010 },
            { block_index: 102, block_time: 1020 },
            { block_index: 103, block_time: 1030 },
        ]

        it('binds at the FIRST block whose protocol time reaches the effective time', () => {
            assert.strictEqual(firstSatisfyingBlock(window, 1015, 103), 102)
        })

        it('binds at a block whose time EQUALS the effective time, because the rule is <=', () => {
            assert.strictEqual(firstSatisfyingBlock(window, 1010, 103), 101)
        })

        it('binds AT the deadline block, which is inclusive', () => {
            // The row's first satisfying block is exactly the deadline: AT3's positive
            // half. An exclusive comparison here would refuse it.
            assert.strictEqual(firstSatisfyingBlock(window, 1030, 103), 103)
        })

        it('binds NOWHERE when the first satisfying block is past the deadline', () => {
            // AT3's negative half: nothing before 103 has reached the effective time,
            // and 103 is past the deadline, so the row is never applicable and the
            // local expiry sweep owns the request instead.
            assert.strictEqual(firstSatisfyingBlock(window, 1030, 102), null)
        })

        it('does not assume the caller sorted the window', () => {
            assert.strictEqual(firstSatisfyingBlock(window.slice().reverse(), 1015, 103), 102)
        })

        it('skips rows it cannot read rather than binding on a NaN comparison', () => {
            const dirty = [{ block_index: 'x', block_time: 1020 }, { block_index: 102, block_time: null }]
                .concat(window)
            assert.strictEqual(firstSatisfyingBlock(dirty, 1015, 103), 102)
        })

        it('answers null for an unreadable effective time or deadline', () => {
            assert.strictEqual(firstSatisfyingBlock(window, null, 103), null)
            assert.strictEqual(firstSatisfyingBlock(window, 1015, undefined), null)
        })

        it('answers null for an empty window', () => {
            assert.strictEqual(firstSatisfyingBlock([], 1015, 103), null)
            assert.strictEqual(firstSatisfyingBlock(null, 1015, 103), null)
        })
    })

    describe('happyPathVerdict: tell a widened round from the happy path, without counting anything', () => {

        const mine = ['AA', 'bb', 'cc', 'dd', 'ee']

        it('accepts widen 0 with every signature from a key the drill staked', () => {
            const v = happyPathVerdict({ widen: 0, signers: ['aa', 'BB', 'cc'], ownPubkeys: mine })
            assert.strictEqual(v.happy, true, v.why)
        })

        it('is case insensitive about pubkeys, which arrive in three spellings here', () => {
            assert.strictEqual(happyPathVerdict({ widen: 0, signers: ['AA'], ownPubkeys: ['aa'] }).happy, true)
        })

        // The reason this guard exists: a widened set is larger than the signer
        // list, so a non-signer may still have been responsible.
        it('refuses a widened round and says why in terms of the responsible set', () => {
            const v = happyPathVerdict({ widen: 1, signers: ['aa', 'bb', 'cc'], ownPubkeys: mine })
            assert.strictEqual(v.happy, false)
            assert.ok(/WIDER than the/.test(v.why), v.why)
        })

        it('refuses a foreign signature and names it', () => {
            const v = happyPathVerdict({ widen: 0, signers: ['aa', 'ff00'], ownPubkeys: mine })
            assert.strictEqual(v.happy, false)
            assert.ok(/did not stake/.test(v.why), v.why)
            assert.ok(/ff00/.test(v.why), v.why)
        })

        it('refuses a row with no signers rather than calling it happy', () => {
            assert.strictEqual(happyPathVerdict({ widen: 0, signers: [], ownPubkeys: mine }).happy, false)
            assert.strictEqual(happyPathVerdict({}).happy, false)
        })

        // A count is never consulted, in either direction: the drill's own set may
        // be any size and the chain's pool is not its business.
        it('does not care how many keys the drill staked or how many signed', () => {
            assert.strictEqual(happyPathVerdict({ widen: 0, signers: ['aa'], ownPubkeys: ['aa'] }).happy, true)
            assert.strictEqual(
                happyPathVerdict({ widen: 0, signers: ['aa', 'bb', 'cc', 'dd', 'ee'], ownPubkeys: mine }).happy,
                true)
        })

        it('treats an unreadable widen as the happy path, because absence is not widening', () => {
            // A hub too old to record the column must not make every drill skip; a
            // foreign signature still catches the case that actually matters.
            assert.strictEqual(happyPathVerdict({ widen: null, signers: ['aa'], ownPubkeys: mine }).happy, true)
        })
    })

    describe('wedgeVerdict: mine DOGE only for the roll-call wedge, never for an idle venue', () => {

        const held = { height: 3823, atMs: 1_000_000 }
        const past = held.atMs + ROLLCALL_STALL_AFTER_MS + 1
        // The wedge's own reason. Required as well as the behind-decoder condition,
        // matching the predicate the fixture's withWedgeClear uses, so the two halves
        // of one remedy cannot disagree about what the wedge is.
        const WEDGE = 'rollcall_proof_unavailable'

        // The measured shape: indexer behind its own decoder, not advancing.
        it('nudges an indexer held behind its decoder past the grace', () => {
            const v = wedgeVerdict({ height: 3823, decoder: 3834, reason: WEDGE }, held, past)
            assert.strictEqual(v.nudge, true)
            assert.ok(/roll-call wedge/.test(v.why), v.why)
        })

        // THE ONE THAT MATTERS MOST. A drill waiting on a PBFT round mines nothing
        // and the tip is static for minutes by design. Mining DOGE for that would be
        // mining for no reason, and on the batch rail it would move a window.
        it('does NOT nudge an idle venue that is level with its decoder', () => {
            const v = wedgeVerdict({ height: 3834, decoder: 3834, reason: WEDGE }, { height: 3834, atMs: 1_000_000 }, past)
            assert.strictEqual(v.nudge, false)
            assert.ok(/idle rather than wedged/.test(v.why), v.why)
        })

        it('does not nudge while the indexer is still advancing', () => {
            const v = wedgeVerdict({ height: 3824, decoder: 3834, reason: WEDGE }, held, past)
            assert.strictEqual(v.nudge, false)
            assert.strictEqual(v.why, 'advancing')
        })

        it('does not nudge inside the grace, so one slow block is not a wedge', () => {
            const v = wedgeVerdict({ height: 3823, decoder: 3834, reason: WEDGE }, held, held.atMs + 1000)
            assert.strictEqual(v.nudge, false)
            assert.ok(/inside the .* grace/.test(v.why), v.why)
        })

        it('does not nudge on an unreadable status, which is its own problem', () => {
            assert.strictEqual(wedgeVerdict(null, held, past).nudge, false)
            assert.strictEqual(wedgeVerdict({ height: null, decoder: 3834, reason: WEDGE }, held, past).nudge, false)
            assert.strictEqual(wedgeVerdict({ height: 3823, decoder: null, reason: WEDGE }, held, past).nudge, false)
        })

        it('honours a caller-supplied grace', () => {
            const v = wedgeVerdict({ height: 3823, decoder: 3834, reason: WEDGE }, held,
                held.atMs + 5000, { stallAfterMs: 1000 })
            assert.strictEqual(v.nudge, true)
        })

        // THE NARROWING THAT MATTERS. A node stuck for some other reason must be
        // REPORTED, not mined at: mining DOGE would turn an unexplained stall into a
        // slower unexplained stall while the drill blamed whatever it was waiting for.
        it('refuses to mine for a stall of any other shape, and marks it a finding', () => {
            const v = wedgeVerdict({ height: 3823, decoder: 3834, reason: 'price_sync_barrier' }, held, past)
            assert.strictEqual(v.nudge, false)
            assert.strictEqual(v.finding, true)
            assert.ok(/price_sync_barrier/.test(v.why), v.why)
            assert.ok(/rather than/.test(v.why), v.why)
        })

        it('treats an absent stall reason as a finding too, never as the wedge', () => {
            const v = wedgeVerdict({ height: 3823, decoder: 3834 }, held, past)
            assert.strictEqual(v.nudge, false)
            assert.strictEqual(v.finding, true)
            assert.ok(/absent/.test(v.why), v.why)
        })
    })

    describe('until', () => {

        it('returns the first satisfying observation, whole', async () => {
            let calls = 0
            const got = await until(async () => { calls++; return { ok: calls === 2, calls: calls } }, 5000, 1)
            assert.strictEqual(got.ok, true)
            assert.strictEqual(got.calls, 2)
        })

        it('hands back the LAST observation on timeout, so the failure can be described', async () => {
            const got = await until(async () => ({ ok: false, height: 41 }), 30, 1)
            assert.strictEqual(got.ok, false)
            assert.strictEqual(got.height, 41,
                'the last observation was discarded on timeout, which is what makes a drill report ' +
                '"never happened" instead of what the node actually looked like')
        })

        it('reports not-ok rather than throwing when the observation never returns a shape', async () => {
            const got = await until(async () => null, 30, 1)
            assert.strictEqual(!!(got && got.ok), false)
        })
    })
})

describe('captureFederationState: an unreadable probe is never counted as evidence', () => {

    const { captureFederationState } = require('../../attestMirror/mirrorDrillWaits')

    // A venue shaped exactly as the helper reads it, with three live hubs.
    const venue = () => ({
        hubDb: { host: 'h', port: 1, user: 'u', pass: 'p' },
        hubs: [0, 1, 2].map((i) => ({
            index: i, pubkey: 'pub' + i, apiUrl: 'http://127.0.0.1:' + (9000 + i),
            dbName: 'db' + i, proc: {},
        })),
    })
    const okPost  = async () => ({ data: { result: { responsible: ['aa', 'bb', 'cc'], redundancy: 3, widen: 0 } } })
    const rowFor  = () => [{ status: 'ok', effective_time: 1788500000, widen: 0 }]
    const noRows  = async () => []

    it('gives a real verdict only when every hub was read', async () => {
        const out = await captureFederationState(venue(), 'r1', 'test', { post: okPost, readRows: async () => rowFor() })
        assert.strictEqual(out.unreadable, 0)
        assert.strictEqual(out.verdict, '3 of 3 hubs hold a finalized row')
    })

    it('says 0 of 3 when the hubs were READ and genuinely hold no row', async () => {
        // The distinction the miscount destroyed: this IS evidence about the mirror.
        const out = await captureFederationState(venue(), 'r1', 'test', { post: okPost, readRows: noRows })
        assert.strictEqual(out.unreadable, 0)
        assert.strictEqual(out.verdict, '0 of 3 hubs hold a finalized row')
    })

    // FALSIFICATION 1: break the responsible-set probe alone.
    it('refuses a verdict when the responsible-set probe throws on every hub', async () => {
        const out = await captureFederationState(venue(), 'r1', 'test', {
            post: async () => { throw new Error('call is not a function') },
            readRows: async () => rowFor(),
        })
        assert.strictEqual(out.unreadable, 3)
        assert.strictEqual(out.verdict, 'NO VERDICT',
            'a broken responsible-set probe must not yield a verdict about the mirror')
    })

    // FALSIFICATION 2: break the finalization read alone. This is the exact shape
    // that printed "0 of 5 hubs hold a finalized row" when nothing had been read.
    it('refuses a verdict when the finalization read fails on every hub', async () => {
        const out = await captureFederationState(venue(), 'r1', 'test', {
            post: okPost,
            readRows: async () => { throw new Error('(no: 1046, SQLState: 3D000) No database selected') },
        })
        assert.strictEqual(out.unreadable, 3)
        assert.strictEqual(out.verdict, 'NO VERDICT')
        assert.strictEqual(out.held, 0)
        assert.ok(out.hubs.every((h) => h.readOk === false))
    })

    // FALSIFICATION 3: one hub of three unreadable still forbids a verdict, because
    // a partial count is the same lie in smaller type.
    it('refuses a verdict when even ONE hub of three is unreadable', async () => {
        let n = 0
        const out = await captureFederationState(venue(), 'r1', 'test', {
            post: okPost,
            readRows: async () => { n++; if (n === 2) throw new Error('boom'); return rowFor() },
        })
        assert.strictEqual(out.unreadable, 1)
        assert.strictEqual(out.verdict, 'NO VERDICT')
    })

    it('marks a stopped hub unreadable rather than as holding no row', async () => {
        const v = venue()
        v.hubs[1].proc = null
        const out = await captureFederationState(v, 'r1', 'test', { post: okPost, readRows: async () => rowFor() })
        assert.strictEqual(out.unreadable, 1)
        assert.strictEqual(out.verdict, 'NO VERDICT')
    })
})

describe('queryDb opens the connection WITH a database selected', () => {

    const { queryDb } = require('../../attestMirror/mirrorDrillWaits')
    const venue = { hubDb: { host: 'h', port: '3306', user: 'u', pass: 'p' } }

    // THE WHOLE DEFECT THIS GUARDS. The helper it replaces took a database name,
    // validated it and then discarded it, so every unqualified table reference
    // failed with errno 1046 "No database selected". Nothing noticed until a
    // federation capture became the first caller to reach one, and the failure was
    // then miscounted as a hub holding no row. An options object is the only place
    // this shows up without a live database.
    it('passes the database name through to createConnection', async () => {
        let opts = null
        const fake = { createConnection: async (o) => { opts = o; return { query: async () => [], end: async () => {} } } }
        await queryDb(venue, 'XChain_AM_Ixr0', 'SELECT 1', [], { mariadb: fake })
        assert.strictEqual(opts.database, 'XChain_AM_Ixr0',
            'the database was not selected, so every unqualified table reference would fail with errno 1046')
        assert.strictEqual(opts.host, 'h')
        assert.strictEqual(opts.port, 3306, 'the port must be an integer, not the string the handle carries')
        assert.strictEqual(opts.user, 'u')
        assert.strictEqual(opts.password, 'p')
    })

    it('still refuses an unsafe database identifier before connecting', async () => {
        let called = false
        const fake = { createConnection: async () => { called = true; return { query: async () => [], end: async () => {} } } }
        await assert.rejects(() => queryDb(venue, 'bad; DROP', 'SELECT 1', [], { mariadb: fake }),
            /refusing an unsafe database identifier/)
        assert.strictEqual(called, false, 'it connected before validating the identifier')
    })

    it('closes the connection even when the query throws', async () => {
        let ended = false
        const fake = { createConnection: async () => ({
            query: async () => { throw new Error('boom') },
            end: async () => { ended = true },
        }) }
        await assert.rejects(() => queryDb(venue, 'db', 'SELECT 1', [], { mariadb: fake }), /boom/)
        assert.strictEqual(ended, true, 'a failed query must not leak its connection')
    })
})

describe('wedgeVerdict: catch-up is not a finding', () => {

    const held = { height: 4253, atMs: 1_000_000 }
    const past = held.atMs + ROLLCALL_STALL_AFTER_MS + 1

    // Measured on a real run: a fresh venue indexer 185 blocks behind, pausing on a
    // heavy block, was reported as "a stall of a shape nobody has seen yet".
    it('treats a large lag with no stall reason as ordinary catch-up', () => {
        const v = wedgeVerdict({ height: 4253, decoder: 4438 }, held, past)
        assert.strictEqual(v.nudge, false)
        assert.ok(!v.finding, 'catch-up must not be reported as an anomaly')
        assert.ok(/ordinary catch-up/.test(v.why), v.why)
    })

    // The genuinely odd shape: nothing left to do, and still not moving.
    it('still reports a SMALL lag with no stall reason as a finding', () => {
        const v = wedgeVerdict({ height: 4436, decoder: 4438 }, { height: 4436, atMs: 1_000_000 }, past)
        assert.strictEqual(v.finding, true)
        assert.ok(/NOT catch-up either/i.test(v.why), v.why)
    })

    it('still nudges a large lag when the reason IS the wedge', () => {
        const v = wedgeVerdict({ height: 4253, decoder: 4438, reason: 'rollcall_proof_unavailable' }, held, past)
        assert.strictEqual(v.nudge, true, 'the wedge is the wedge at any lag')
    })
})
