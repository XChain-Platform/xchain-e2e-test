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
        assert.strictEqual(rows.familySeedRows(SPEC).length, 5)
        assert.deepStrictEqual(rows.familySeedRows(SPEC).map((s) => s.table),
            ['cross_chain_matches', 'cross_chain_calls', 'bridge_transfers', 'policy_snapshots', 'attestation_responses'])
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
