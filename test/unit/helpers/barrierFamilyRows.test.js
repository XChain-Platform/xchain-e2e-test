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
 * The pure half of the barrier-family legs, driven without a venue: the inert
 * rows close the right escapes and carry the right admission spelling, the SQL
 * shapes are the ones the members read, the grace ladder is loop-ordered, and
 * the timed-out line parser counts identical lines the way the legs claim.
 ********************************************************************/

const assert = require('assert')

const rows = require('../../attestMirror/helpers/barrierFamilyRows')
const fixture = require('../../attestMirror/helpers/barrierFamilyFixture')
const { MIRROR_BARRIERS, gracedBarrierReason } = require('../../helpers/attestMirrorVenue')

const SPEC = { network: 'regtest', coin: 'BTC', effectiveTime: 1788494058, snapshotBlock: 811999, tag: 't' }

describe('barrierFamilyRows: inert rows', () => {

    it('builds one row per member table with the natural key the injector reads back', () => {
        for (const table of Object.keys(rows.NATURAL_KEYS)) {
            const r = rows.inertRow(table, SPEC)
            assert.strictEqual(r.table, table)
            for (const k of r.key) assert.ok(r.row[k] !== undefined && r.row[k] !== null, table + ' lacks its key column ' + k)
        }
    })

    it('scopes every xdex row to the coin the member reads, so the empty-mirror escape closes', () => {
        const m = rows.inertRow('cross_chain_matches', SPEC).row
        assert.ok([m.a_chain, m.b_chain].includes('BTC') && m.status === 'finalized')
        const c = rows.inertRow('cross_chain_calls', SPEC).row
        assert.ok([c.target_chain, c.source_chain].includes('BTC'))
        const b = rows.inertRow('bridge_transfers', SPEC).row
        assert.ok([b.src_chain, b.dest_chain].includes('BTC'))
        const p = rows.inertRow('policy_snapshots', SPEC).row
        assert.notStrictEqual(p.origin_chain, 'BTC', 'the policy member scopes on origin_chain <> coin')
        assert.throws(() => rows.inertRow('cross_chain_matches', Object.assign({}, SPEC, { otherChain: 'btc' })), /must differ/)
    })

    it('spells the admission columns from the fixture: NULL when unnamed, a height when named', () => {
        const legacy = rows.inertRow('cross_chain_matches', SPEC).row
        for (const c of ['BTC', 'LTC', 'DOGE']) assert.strictEqual(legacy[fixture.admissionColumn('cross_chain_matches', c)], null)
        const era = rows.inertRow('cross_chain_matches', Object.assign({ admitBlocks: { BTC: 812000 } }, SPEC)).row
        assert.strictEqual(era.admit_block_btc, 812000)
        assert.strictEqual(era.admit_block_ltc, null, 'a map naming BTC alone leaves LTC NULL: the legacy rule for that chain')
        const attest = rows.inertRow('attestation_responses', Object.assign({ admitBlocks: { BTC: 5, LTC: 9 } }, SPEC)).row
        assert.strictEqual(attest.admit_block_btc, 5)
        assert.ok(!('admit_block_ltc' in attest), 'the BTC-only rail carries one column')
        assert.ok(!('admit_block' in rows.inertRow('capability_snapshots', SPEC).row), 'a snapshot carries no admission column')
    })

    it('is deterministic per tag and distinct across tags, so re-runs upsert and members do not collide', () => {
        const a = rows.inertRow('bridge_transfers', SPEC).row
        const b = rows.inertRow('bridge_transfers', SPEC).row
        const c = rows.inertRow('bridge_transfers', Object.assign({}, SPEC, { tag: 'u' })).row
        assert.strictEqual(a.transfer_id, b.transfer_id)
        assert.notStrictEqual(a.transfer_id, c.transfer_id)
        assert.strictEqual(rows.familySeedRows(SPEC).length, 6)
        assert.deepStrictEqual(rows.familySeedRows(SPEC).map((s) => s.table),
            ['oracle_prices', 'cross_chain_matches', 'cross_chain_calls', 'bridge_transfers', 'policy_snapshots', 'attestation_responses'])
    })

    it('seeds an oracle row whose effective_at is the seed time, since member 3 reads MAX(effective_at)', () => {
        const oracle = rows.familySeedRows(SPEC).find((s) => s.table === 'oracle_prices')
        assert.strictEqual(oracle.row.effective_at, SPEC.effectiveTime)
        assert.strictEqual(oracle.row.source_chain, 'BTC')
        assert.notStrictEqual(oracle.row.action_index, rows.inertRow('oracle_prices', SPEC).row.action_index, 'the family tag keys the row')
    })
})

describe('barrierFamilyRows: BF1 judges each walker observation against its own deadline', () => {
    // The rail's walker block (2026-09-17, v020-final-bf1.log): stamped 1789635655, ladder step 90.
    const STAMP = 1789635655
    const LADDER = { oracle_sync_barrier: 180, match_sync_barrier: 270 }
    const SKIP = ['price_sync_barrier', 'snapshot_sync_barrier']
    const ms = (s) => s * 1000
    const obs = (reason, askedS, atS, stallClass, clearsAt) => ({
        askedAt: ms(askedS), at: ms(atS), stallReason: reason, stallClass,
        stallClearsAt: clearsAt === undefined ? ms(STAMP + LADDER[reason]) : clearsAt,
    })

    it('passes the rail shape: a future wait before the deadline, then the stale label read wedged after it', () => {
        const walk = [
            obs('price_sync_barrier', STAMP + 100, STAMP + 100, 'wedged', null),
            obs('oracle_sync_barrier', STAMP + 160, STAMP + 160, 'future_block_wait'),
            obs('oracle_sync_barrier', STAMP + 179, STAMP + 179.5, 'future_block_wait'),
            // 09:03:55Z to 09:04:58Z on the rail: the rung opened, match's wait had not timed out yet.
            obs('oracle_sync_barrier', STAMP + 185, STAMP + 185, 'wedged'),
            obs('match_sync_barrier', STAMP + 245, STAMP + 245, 'future_block_wait'),
            obs('match_sync_barrier', STAMP + 280, STAMP + 280, 'barrier_defer'),
            obs('snapshot_sync_barrier', STAMP + 900, STAMP + 900, 'wedged', null),
        ]
        assert.deepStrictEqual(rows.enumerationClassFaults(walk, LADDER, STAMP, SKIP), [])
    })

    it('does not judge a read that straddles the deadline, in either class', () => {
        const walk = [
            obs('oracle_sync_barrier', STAMP + 170, STAMP + 170, 'future_block_wait'),
            obs('oracle_sync_barrier', STAMP + 179.9, STAMP + 180.2, 'future_block_wait'),
            obs('oracle_sync_barrier', STAMP + 179.9, STAMP + 180.2, 'wedged'),
        ]
        assert.deepStrictEqual(rows.enumerationClassFaults(walk, LADDER, STAMP, SKIP), [])
    })

    it('fails a non-future class before the deadline, and a future wait asked after it', () => {
        const early = rows.enumerationClassFaults([obs('oracle_sync_barrier', STAMP + 100, STAMP + 101, 'wedged')], LADDER, STAMP, SKIP)
        assert.ok(early.some((f) => /oracle_sync_barrier reported wedged at .*before its deadline/.test(f)), JSON.stringify(early))
        const late = rows.enumerationClassFaults([
            obs('oracle_sync_barrier', STAMP + 170, STAMP + 170, 'future_block_wait'),
            obs('oracle_sync_barrier', STAMP + 181, STAMP + 181, 'future_block_wait'),
        ], LADDER, STAMP, SKIP)
        assert.deepStrictEqual(late.length, 1)
        assert.ok(/still reported future_block_wait when asked at .*past its deadline/.test(late[0]), late[0])
    })

    it('fails a deadline that is not stamp plus the member\'s own rung', () => {
        const got = rows.enumerationClassFaults([obs('match_sync_barrier', STAMP + 10, STAMP + 10, 'future_block_wait', ms(STAMP + 180))], LADDER, STAMP, SKIP)
        assert.ok(got.some((f) => /match_sync_barrier clears at .*not stamp \+ its own grace 270/.test(f)), JSON.stringify(got))
    })

    it('fails a graced member that was only ever seen past its deadline, so the class check cannot be vacuous', () => {
        const got = rows.enumerationClassFaults([obs('match_sync_barrier', STAMP + 300, STAMP + 300, 'wedged')], LADDER, STAMP, SKIP)
        assert.deepStrictEqual(got, ['match_sync_barrier was never observed in future_block_wait before its deadline'])
    })

    it('ignores the members with no clock deadline and any reason outside the ladder', () => {
        const got = rows.enumerationClassFaults([
            obs('price_sync_barrier', STAMP, STAMP, 'wedged', null),
            obs('snapshot_sync_barrier', STAMP, STAMP, 'wedged', null),
            { at: 1, stallReason: 'vm_executor_unavailable', stallClass: 'barrier_defer', stallClearsAt: null },
        ], Object.assign({ price_sync_barrier: 90 }, LADDER), STAMP, SKIP)
        assert.deepStrictEqual(got, [])
    })
})

describe('barrierFamilyRows: the heights a drill block needs before it is mined', () => {
    const MARGINS = { cross_chain_matches: 4, attestation_responses: 1, anchor_reward_attestations: 144 }
    const marginOf = (t) => MARGINS[t]
    const TABLES = Object.keys(MARGINS)

    it('names the rail\'s BF2 shortfall: no anchor height at all, in the indexer\'s own spelling', () => {
        const heights = { cross_chain_matches: { BTC: 103 }, attestation_responses: { BTC: 103 } }
        const got = rows.admissionHeightShortfalls(heights, TABLES, 'BTC', 104, marginOf)
        assert.deepStrictEqual(got, [{ table: 'anchor_reward_attestations', chain: 'BTC', have: null, need: -40 }])
        assert.strictEqual(rows.describeShortfall(got[0]), 'admission height anchor_reward_attestations.BTC at none, needs -40')
    })

    it('is satisfied exactly at each member\'s line and short one below it', () => {
        const at = { cross_chain_matches: { BTC: 100 }, attestation_responses: { BTC: 103 }, anchor_reward_attestations: { BTC: 0 } }
        assert.deepStrictEqual(rows.admissionHeightShortfalls(at, TABLES, 'BTC', 104, marginOf), [])
        const below = { cross_chain_matches: { BTC: 99 }, attestation_responses: { BTC: 102 }, anchor_reward_attestations: { BTC: 0 } }
        assert.deepStrictEqual(rows.admissionHeightShortfalls(below, TABLES, 'BTC', 104, marginOf).map((s) => s.table),
            ['cross_chain_matches', 'attestation_responses'])
    })

    it('never reads a missing, foreign-chain or non-integer entry as a height', () => {
        const odd = { cross_chain_matches: { LTC: 500 }, attestation_responses: { BTC: '103' }, anchor_reward_attestations: { BTC: -1 } }
        assert.deepStrictEqual(rows.admissionHeightShortfalls(odd, TABLES, 'BTC', 104, marginOf).map((s) => s.have), [null, null, null])
        assert.strictEqual(rows.admissionHeightShortfalls(undefined, TABLES, 'BTC', 104, marginOf).length, 3)
    })
})

describe('barrierFamilyRows: no legacy row where a height-0 armed apply pass canonicalizes it', () => {
    const B = 104
    const MEMBERS = ['cross_chain_matches', 'cross_chain_calls', 'bridge_transfers', 'policy_snapshots', 'attestation_responses']
    const legacy = (t) => rows.inertRow(t, Object.assign({}, SPEC, { tag: 'legacy|' + t }))

    it('flags a finalized NULL-map row in bridge_transfers and policy_snapshots, and only there', () => {
        const hazards = rows.armedLegacyApplyHazards(MEMBERS.map(legacy))
        assert.deepStrictEqual(hazards.map((h) => h.split('|')[0]), ['bridge_transfers', 'policy_snapshots'])
        assert.strictEqual(hazards[0], 'bridge_transfers|' + legacy('bridge_transfers').row.transfer_id, 'the hazard names the row key')
    })

    it('passes a row whose map names any chain, and a legacy row no apply select reads', () => {
        const atB = rows.inertRow('bridge_transfers', Object.assign({}, SPEC, { tag: 'at', admitBlocks: { BTC: B } }))
        const omitsBtc = rows.inertRow('policy_snapshots', Object.assign({}, SPEC, { tag: 'omits', admitBlocks: { LTC: 5 } }))
        const retracted = legacy('bridge_transfers')
        retracted.row = Object.assign({}, retracted.row, { status: 'retracted' })
        assert.deepStrictEqual(rows.armedLegacyApplyHazards([atB, omitsBtc, retracted]), [])
    })

    it('BF2\'s seed plan carries at-B and past-B rows everywhere, legacy rows only where the apply cannot reach them', () => {
        const seeds = rows.admissionSeedRows(MEMBERS, SPEC, B, 103)
        assert.deepStrictEqual(rows.armedLegacyApplyHazards(seeds), [], 'the BF2 plan seeds a row the armed node stalls on')
        const count = (t) => seeds.filter((s) => s.table === t).length
        assert.deepStrictEqual(MEMBERS.map(count), [3, 3, 2, 2, 3])
        for (const t of MEMBERS) {
            const col = fixture.admissionColumn(t, 'BTC')
            const heights = seeds.filter((s) => s.table === t).map((s) => s.row[col])
            assert.ok(heights.includes(B) && heights.includes(B + 3), t + ': the at-B and past-B rows are both present')
            // The fixture's expected set at B is the seeded count minus the past-B row, which is what BF2 asserts.
            const admitted = fixture.admittedRowSet(seeds.filter((s) => s.table === t).map((s) => s.row), t, 'BTC', B, SPEC.effectiveTime, (r) => String(r[s0(t)]))
            assert.strictEqual(admitted.length, count(t) - 1, t + ': admitted at B')
        }
    })

    function s0 (t) { return rows.NATURAL_KEYS[t][0] }
})

describe('barrierFamilyRows: the SQL shapes the legs read with', () => {

    it('counts content-escape rows in each member\'s own coin scope', () => {
        const q = rows.contentEscapeSql('cross_chain_matches', 'btc', 100)
        assert.ok(/status = 'finalized' AND \(a_chain = \? OR b_chain = \?\) AND effective_time >= \?/.test(q.sql), q.sql)
        assert.deepStrictEqual(q.args, ['BTC', 'BTC', 100])
        assert.deepStrictEqual(rows.contentEscapeSql('policy_snapshots', 'BTC', 7).args, ['BTC', 7])
        assert.ok(rows.contentEscapeSql('attestation_responses', 'BTC', 7).sql.includes('WHERE 1 = 1 AND 1 = 1'), 'the attest rail has no finalized status')
        assert.throws(() => rows.contentEscapeSql('capability_snapshots', 'BTC', 1), /no coin scope/)
    })

    it('reads the readable set in the IS NULL OR form, never a bare comparison on the nullable column', () => {
        const q = rows.readableRowsSql('cross_chain_matches', 'BTC', 812000, 1788494058)
        assert.strictEqual(q.column, 'admit_block_btc')
        assert.ok(q.sql.includes('(`admit_block_btc` IS NULL AND effective_time <= ?) OR (`admit_block_btc` IS NOT NULL AND `admit_block_btc` <= ?)'), q.sql)
        assert.deepStrictEqual(q.args, [1788494058, 812000])
        assert.strictEqual(rows.readableRowsSql('attestation_responses', 'LTC', 1, 1).column, 'admit_block_btc', 'the BTC-only rail binds on its one column')
        assert.strictEqual(rows.readableRowsSql('attestation_responses', 'BTC', 1, 1).sql.split(' AS k ')[0], 'SELECT `request_id`', 'the key is the request id')
    })
})

describe('barrierFamilyRows: the grace ladder and the loop order', () => {

    it('raises each graced member one step above the member before it in loop order', () => {
        const ladder = rows.graceLadder(90)
        assert.deepStrictEqual(Object.keys(ladder).sort(), MIRROR_BARRIERS.slice().sort(), 'every graced key gets a rung')
        const byReason = {}
        for (const key of Object.keys(ladder)) byReason[gracedBarrierReason(key)] = ladder[key]
        let last = 0
        for (const reason of rows.ladderReasons()) {
            assert.strictEqual(byReason[reason], last + 90, reason + ' is not one step above the previous member')
            last = byReason[reason]
        }
        assert.strictEqual(rows.ladderReasons().length, 8, 'eight graced members, the snapshot member is content-keyed')
        assert.throws(() => rows.graceLadder(0), /positive step/)
    })

    it('judges a reason sequence by loop position and collapses runs', () => {
        assert.deepStrictEqual(rows.distinctRuns(['a', 'a', 'b', 'b', 'a']), ['a', 'b', 'a'])
        assert.strictEqual(rows.inLoopOrder(fixture.FAMILY_REASONS_LOOP_ORDER.slice()), true)
        assert.strictEqual(rows.inLoopOrder(['match_sync_barrier', 'price_sync_barrier']), false, 'a later member before an earlier one')
        assert.strictEqual(rows.inLoopOrder(['match_sync_barrier', 'match_sync_barrier']), false, 'a repeat is not progress')
        assert.strictEqual(rows.inLoopOrder(['bridge_proof_barrier']), false, 'an out-of-family reason is not in the order')
        assert.strictEqual(rows.inLoopOrder([]), true)
    })
})

describe('barrierFamilyRows: the timed-out line parser', () => {

    const line = (block, wm) => '2026-09-16T19:00:00Z warn: Deferring block ' + block + ' (cross-chain match sync):  Error: match sync barrier ' +
        'timed out after 60000ms waiting for block_time 1788501258 (stream watermark at ' + wm + ')'

    it('counts lines for the block as identical once the moving watermark is normalised', () => {
        const tail = [line(812000, 1788494058), line(812000, 1788494118), line(812000, 1788494178), line(811999, 1788494000), 'noise'].join('\n')
        const got = rows.timedOutLines(tail, 812000)
        assert.strictEqual(got.lines, 3)
        assert.strictEqual(got.identical, 3)
        assert.strictEqual(got.distinct.length, 1)
        assert.ok(got.distinct[0].includes('stream watermark at N'))
    })

    it('does not count a differently worded retry as identical, nor another block\'s line', () => {
        const other = '2026 warn: Deferring block 812000 (attestation response mirror):  Error: attestation response mirror barrier timed out after 60000ms'
        const got = rows.timedOutLines([line(812000, 1), other, other].join('\n'), 812000)
        assert.strictEqual(got.lines, 3)
        assert.strictEqual(got.identical, 2)
        assert.strictEqual(got.distinct.length, 2)
        assert.deepStrictEqual(rows.timedOutLines('', 812000), { lines: 0, distinct: [], identical: 0 })
    })
})

describe('barrierFamilyRows: the AT4 signed admission-era corpus', () => {
    const COL = 'admit_block_btc'
    const signed = (over) => Object.assign({ response_hash: 'de30690073c0f924', signatures: '["aa","bb","cc"]', [COL]: 276 }, over || {})
    const applied = (over) => Object.assign({ action_index: 22, block_index: 276, tx_index: null, response_hash: 'de30690073c0f924' }, over || {})

    it('builds an asker that requests at redundancy 3 inside the given window and tags its callback', () => {
        const code = rows.attestRequestContractCode(60, 'ctx-at4corpus')
        assert.match(code, /redundancy: 3, deadlineBlocks: 60 \}/)
        assert.match(code, /\['ctx-at4corpus'\]/)
        assert.throws(() => rows.attestRequestContractCode(0, 'ctx'), /bad deadline/)
        assert.throws(() => rows.attestRequestContractCode(60, "x'); evil('"), /bad context tag/)
    })

    it('stringifies a mariadb row carrying a BigInt column without throwing, and prints its digits', () => {
        const row = { id: 1, response_hash: 'de30690073c0f924', [COL]: 276n }
        assert.doesNotThrow(() => rows.bigintSafeStringify(row))
        assert.strictEqual(rows.bigintSafeStringify(row), JSON.stringify({ id: 1, response_hash: 'de30690073c0f924', [COL]: 276 }))
        assert.strictEqual(rows.bigintSafeStringify([[row], [row]]), JSON.stringify([[{ id: 1, response_hash: 'de30690073c0f924', [COL]: 276 }], [{ id: 1, response_hash: 'de30690073c0f924', [COL]: 276 }]]))
    })

    it('accepts a signed row applied at its admission height on both indexers, and reports that height', () => {
        const got = rows.admitHeightApplyFindings(COL, [[signed()], [signed()]], [applied(), applied()])
        assert.deepStrictEqual(got, { findings: [], admitHeight: 276 })
    })

    it('binds the earliest admission height when a second leader slot left a later row', () => {
        const got = rows.admitHeightApplyFindings(COL, [[signed({ [COL]: 279 }), signed()], [signed()]], [applied(), applied()])
        assert.deepStrictEqual(got, { findings: [], admitHeight: 276 })
    })

    it('names an apply one block past the admission height, which is the claim under test', () => {
        const got = rows.admitHeightApplyFindings(COL, [[signed()], [signed()]], [applied(), applied({ block_index: 277 })])
        assert.ok(got.findings.some((f) => /indexer 1 applied it at block 277, not at its admission height 276/.test(f)), JSON.stringify(got.findings))
        assert.ok(got.findings.some((f) => /block_index=277 while indexer 0 applied 276/.test(f)), JSON.stringify(got.findings))
    })

    it('names a legacy-era row, an unsigned row, a transaction-backed apply and a missing mirror', () => {
        const legacy = rows.admitHeightApplyFindings(COL, [[signed({ [COL]: null })], [signed()]], [])
        assert.ok(legacy.findings.some((f) => /indexer 0: mirror row de30690073c0f924 carries no admit_block_btc/.test(f)), JSON.stringify(legacy.findings))
        const unsigned = rows.admitHeightApplyFindings(COL, [[signed({ signatures: '[]' })], [signed()]], [])
        assert.ok(unsigned.findings.some((f) => /carries no signatures/.test(f)), JSON.stringify(unsigned.findings))
        const txBacked = rows.admitHeightApplyFindings(COL, [[signed()], [signed()]], [applied({ tx_index: 3 }), applied()])
        assert.ok(txBacked.findings.some((f) => /tx_index 3, not NULL/.test(f)), JSON.stringify(txBacked.findings))
        const missing = rows.admitHeightApplyFindings(COL, [[signed()], []], [])
        assert.ok(missing.findings.some((f) => /indexer 1 holds no mirror row/.test(f)), JSON.stringify(missing.findings))
        assert.ok(missing.findings.some((f) => /disagree on the admission height/.test(f)), JSON.stringify(missing.findings))
    })

    const corpus = (over) => Object.assign({
        indexerRoot: '/tree/xchain-indexer', coin: 'BTC', network: 'regtest',
        decoderDb: 'XChain_BTC_Regtest_Decoder', decoderServer: { host: '127.0.0.1', port: 57400 },
        mirrorDb: 'XChain_AM_MVH_at4corpus_Mirror0', db: { host: '127.0.0.1', port: '57400', user: 'root' },
        passEnv: 'HUB_DB_PASS', hubDbDisposable: false, admitHeight: 276, corpusTip: 322,
    }, over || {})

    it('puts H strictly above the admission height and at or below the corpus tip, and passes the password by name', () => {
        const got = rows.replayWitnessCommand(corpus())
        assert.deepStrictEqual(got.refusals, [])
        assert.strictEqual(got.activationHeight, 299)
        assert.strictEqual(got.line, 'node /tree/xchain-indexer/bin/verify-mirror-admission-replay-equivalence.js --coin BTC --network regtest ' +
            '--decoder-db XChain_BTC_Regtest_Decoder --mirror-db XChain_AM_MVH_at4corpus_Mirror0 --activation-height 299 ' +
            '--db-host 127.0.0.1 --db-port 57400 --db-user root --db-pass-env HUB_DB_PASS')
        const tight = rows.replayWitnessCommand(corpus({ corpusTip: 277 }))
        assert.strictEqual(tight.activationHeight, 277)
        for (let tip = 277; tip < 290; tip++) {
            const h = rows.replayWitnessCommand(corpus({ corpusTip: tip })).activationHeight
            assert.ok(h > 276 && h <= tip, 'H ' + h + ' outside (276, ' + tip + ']')
        }
    })

    it('refuses a corpus no witness can read: no block above the admission height, split servers, a disposable mirror', () => {
        assert.match(rows.replayWitnessCommand(corpus({ corpusTip: 276 })).refusals.join(), /not above the admission height/)
        assert.strictEqual(rows.replayWitnessCommand(corpus({ corpusTip: 276 })).activationHeight, null)
        assert.match(rows.replayWitnessCommand(corpus({ decoderServer: { host: '127.0.0.1', port: 3306 } })).refusals.join(), /reads both from one server/)
        assert.deepStrictEqual(rows.replayWitnessCommand(corpus({ decoderServer: { host: 'localhost', port: '57400' } })).refusals, [])
        assert.match(rows.replayWitnessCommand(corpus({ hubDbDisposable: true })).refusals.join(), /disposable database/)
        assert.match(rows.replayWitnessCommand(corpus({ mirrorDb: 'x`; DROP' })).refusals.join(), /not a plain schema name/)
        assert.match(rows.replayWitnessCommand(corpus({ passEnv: 'hunter2' })).refusals.join(), /not an environment variable name/)
    })
})
