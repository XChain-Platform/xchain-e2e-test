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
 * BF4 (family section 7): the boundary is byte-identical, and the NULL rule holds
 * above it too. Two halves.
 *
 * BELOW, the UNIT half (no venue, no rail: `--grep unit` runs it offline). Every
 * member predicate and every binding predicate reduces to today's form over a
 * unit matrix: height watermark absent, table key absent, chain key absent, a
 * non-finite height, and a height equal to, above and below the threshold. The
 * indexer's own methods are driven on a stub `this`, exactly as the mirror
 * client installs them, and the fixture's independent `rowAdmittedAt` is pinned
 * equal to the indexer's `isRowReadableAt` over the same matrix. The SQL form is
 * proven to be the IS NULL OR shape (C33) in the indexer's bind clause, its
 * snapshot scope, and the fixture's read query, never a bare comparison.
 *
 * The OLD-versus-NEW replay over the regtest BTC corpus is row 11's serial pass,
 * driven with the witness pattern of `bin/verify-genesis-arm-replay-equivalence.js`
 * (a reverted tree beside HEAD over ONE corpus with ONE set of mirror inputs). A
 * venue indexer replaying beside the standing one would compare two ledgers fed
 * by two different hub federations, so it is deliberately not faked here.
 *
 * ABOVE, the LIVE half. Activation ARMED: a legacy row (NULL admission column)
 * and a row whose map omits this chain BOTH bind by `effective_time <= t(B)`,
 * asserted at the block the legacy rule selects: excluded at a block stamped
 * before their effective_time, included at the next block stamped past it, while
 * a control row admitted by height binds at the first of the two.
 ********************************************************************/

const assert = require('assert')
const path = require('path')
const dotenv = require('dotenv')
dotenv.config()

const fixture = require('../helpers/barrierFamilyFixture')
const rows = require('../helpers/barrierFamilyRows')
const drive = require('../helpers/barrierFamilyDrive')

const BUILD_ROOT = path.resolve(__dirname, '..', '..', '..', '..')
const INDEXER = path.join(BUILD_ROOT, 'xchain-indexer', 'src')
const gate = require(path.join(INDEXER, 'consensus', 'gates', 'mirror_admission_gate.js'))
const watermarks = require(path.join(INDEXER, 'hub', 'hub_db_sync', 'watermarks.js'))
const members = require(path.join(INDEXER, 'hub', 'hub_db_sync', 'barriers', 'oracle_match_call.js'))
const mirrorReads = require(path.join(INDEXER, 'db', 'database', 'mirror_reads.js'))

const ARMED = 0
const TABLE = 'cross_chain_matches'
const B = 812000
const T = 1788494058

// A stub of the mirror client with the fields the height comparison reads, below or
// above the activation, publishing `heights`.
function mirrorStub (heights, active) {
    return {
        coin: 'BTC', network: 'regtest', heightWatermarks: heights || {}, _heightShortfalls: {},
        admissionChain: () => 'BTC', admissionActiveAt: () => !!active,
        publishedHeight: watermarks.publishedHeight, heightSatisfied: watermarks.heightSatisfied,
        matchBootstrapped: true, matchSyncTimestamp: T - 1, streamWatermark: T, matchWatermarkGraceS: 120,
    }
}

describe('BF4 unit: below the activation every predicate is today\'s form, above it the NULL rule holds', function () {

    it('unit: the height comparison over the absent, non-finite, equal, above and below matrix', function () {
        const target = B - gate.admitMarginBlocks(TABLE)
        const cases = [
            [undefined, false, 'height watermark absent'],
            [{}, false, 'table key absent'],
            [{ [TABLE]: {} }, false, 'chain key absent'],
            [{ [TABLE]: { BTC: 'soon' } }, false, 'non-finite height'],
            [{ [TABLE]: { BTC: NaN } }, false, 'NaN height'],
            [{ [TABLE]: { BTC: target } }, true, 'equal to the threshold'],
            [{ [TABLE]: { BTC: target + 1 } }, true, 'above the threshold'],
            [{ [TABLE]: { BTC: target - 1 } }, false, 'below the threshold'],
        ]
        for (const [heights, want, why] of cases) {
            const stub = mirrorStub(heights, true)
            assert.strictEqual(stub.heightSatisfied(TABLE, B), want, why)
            if (!want) assert.strictEqual(stub._heightShortfalls[TABLE + '|BTC'], target, why + ': the shortfall names the line')
        }
    })

    it('unit: below the activation the match member is the legacy clock form over the same matrix', function () {
        for (const heights of [undefined, {}, { [TABLE]: { BTC: B - 1 } }, { [TABLE]: { BTC: 0 } }]) {
            const inert = mirrorStub(heights, false)
            // Legacy: content escape (max effective_time >= t(B)), else watermark >= t(B) + grace.
            assert.strictEqual(members.matchSyncSatisfied.call(inert, T - 1, B), true, 'content escape at t(B) = max effective_time + 1')
            assert.strictEqual(members.matchSyncSatisfied.call(inert, T + 1, B), false, 'watermark T < t(B) + 120 with no content escape')
            inert.streamWatermark = T + 121
            assert.strictEqual(members.matchSyncSatisfied.call(inert, T + 1, B), true, 'watermark past t(B) + grace')
            inert.matchSyncTimestamp = null
            assert.strictEqual(members.matchSyncSatisfied.call(inert, T + 9999, B), true, 'the empty-mirror escape survives')
        }
        const armed = mirrorStub({ [TABLE]: { BTC: B - 5 } }, true)
        armed.streamWatermark = T + 99999
        assert.strictEqual(members.matchSyncSatisfied.call(armed, T + 1, B), false, 'armed: the clock cannot open a height-keyed member')
    })

})

describe('BF4 unit: the binding rule and its SQL form', function () {

    it('unit: the binding rule, the fixture\'s independent spelling pinned equal to the indexer\'s', function () {
        const matrix = [
            [null, B, T, T], [undefined, B, T, T + 1], [null, B, T + 1, T], [null, B, 'x', T], [null, B, T, null],
            [B, B, T + 9, T], [B - 1, B, T + 9, T], [B + 1, B, T - 9, T], ['812000', B, T, T], ['nope', B, T, T],
            [B, 'nope', T, T], [B, null, T, T], [0, 0, T, T], [0, -1, T, T],
        ]
        for (const [admit, height, et, bt] of matrix) {
            const row = { [fixture.admissionColumn(TABLE, 'BTC')]: admit, effective_time: et }
            const ours = fixture.rowAdmittedAt(row, fixture.admissionColumn(TABLE, 'BTC'), height, bt)
            const theirs = gate.isRowReadableAt(admit, height, et, bt)
            assert.strictEqual(ours, theirs, 'diverged on ' + JSON.stringify({ admit, height, et, bt }))
        }
        assert.strictEqual(gate.isRowReadableAt(null, B, T, T), true, 'legacy NULL binds by effective_time <= t(B)')
        assert.strictEqual(gate.isRowReadableAt(undefined, B, T, T), true, 'a map that omits this chain binds by effective_time')
        assert.strictEqual(gate.isRowReadableAt(B + 1, B, T - 9999, T), false, 'an admission height past B never binds early')
    })

    it('unit: the SQL form is the IS NULL OR shape in the bind clause, the snapshot scope and the fixture query', function () {
        const col = fixture.admissionColumn(TABLE, 'BTC')
        const stub = { mirrorAdmissionActiveAt: () => true, admitColumn: () => col }
        const clause = mirrorReads.mirrorBindClause.call(stub, T, B, null, null)
        const shape = '((' + col + ' IS NULL AND effective_time <= ?) OR (' + col + ' IS NOT NULL AND ' + col + ' <= ?))'
        assert.strictEqual(clause.sql, shape, 'the bind clause is not the C33 form')
        assert.deepStrictEqual(clause.args, [T, B])
        const inert = mirrorReads.mirrorBindClause.call({ mirrorAdmissionActiveAt: () => false, admitColumn: () => col }, T, B, null, null)
        assert.deepStrictEqual(inert, { sql: 'effective_time <= ?', args: [T] }, 'below the activation the clause is today\'s bytes')
        const q = rows.readableRowsSql(TABLE, 'BTC', B, T)
        assert.ok(q.sql.includes('`' + col + '` IS NULL AND effective_time <= ?') && q.sql.includes('`' + col + '` IS NOT NULL AND `' + col + '` <= ?'),
            'the fixture query is not the IS NULL OR shape: ' + q.sql)
        assert.ok(!/\bWHERE[^(]*`admit_block_[a-z]+` <= \?/.test(q.sql), 'a bare comparison on the nullable column silently drops legacy rows')
        const snapshotSrc = require('fs').readFileSync(path.join(INDEXER, 'hub', 'hub_db_sync', 'barriers', 'snapshot.js'), 'utf8')
        assert.ok(snapshotSrc.includes("' IS NULL AND ' + alias + '.effective_time <= ?) OR ('"), 'the snapshot scope lost the IS NULL arm')
    })
})

describe('BF4 live: above the activation a NULL row and a chain-omitting row bind by the legacy rule', function () {
    this.timeout(drive.LEG_FLOOR_MS)

    const ctx = { venue: null, btc: null, coin: 'BTC', T: null, tip: null, keys: {}, blocks: [] }

    before(async function () {
        const up = await drive.bootFamilyVenue({ label: 'bf4', repoRoot: BUILD_ROOT, armed: [ARMED, 1], armHubs: true })
        Object.assign(ctx, up, { coin: up.evidence.coinCode })
    })

    after(async function () {
        if (ctx.venue) await ctx.venue.stop()
    })

    it('seeds a legacy NULL row, a row whose map omits this chain, and a height-admitted control', async function () {
        await seedThree(ctx)
    })

    it('excludes both legacy-rule rows at the block stamped before their effective_time, includes the control', async function () {
        const b = await drive.mineStamped(ctx.btc, ctx.T - 30)
        await expectReadSet(ctx, b, [ctx.keys.control])
    })

    it('includes both at the next block stamped past their effective_time', async function () {
        const b = await drive.mineStamped(ctx.btc, ctx.T + 30)
        await expectReadSet(ctx, b, [ctx.keys.control, ctx.keys.legacy, ctx.keys.omits].sort())
    })
})

async function seedThree (ctx) {
    ctx.tip = Number(await ctx.btc.globals.nodeConnector.getBlockCount())
    const floor = await drive.minimumStamp(ctx.btc)
    // Both drill blocks must be stampable: T sits comfortably above the tip's median time.
    ctx.T = Math.max(Math.floor(Date.now() / 1000), floor.floor + 60) + 120
    // Snapshot at the next height, not the reached tip: a fresh node's stake re-derivation rejects a synthetic capability row at a reached height.
    const base = { network: ctx.venue.network, coin: ctx.coin, effectiveTime: ctx.T, snapshotBlock: ctx.tip + 1 }
    const legacy = rows.inertRow(TABLE, Object.assign({ tag: 'bf4|legacy|' + ctx.tip }, base))
    const omits = rows.inertRow(TABLE, Object.assign({ tag: 'bf4|omits|' + ctx.tip, admitBlocks: { LTC: 5 } }, base))
    const control = rows.inertRow(TABLE, Object.assign({ tag: 'bf4|control|' + ctx.tip, admitBlocks: { BTC: ctx.tip + 1 }, effectiveTime: ctx.T + 9999 }, base))
    // The legacy row lives in cross_chain_matches, whose armed apply reads the capability set before the
    // canonical; the guard fails this case, not the drill block, if it is ever moved to bridge or policy.
    assert.deepStrictEqual(rows.armedLegacyApplyHazards([legacy, omits, control]), [], 'BF4 would seed a legacy row the armed apply pass refuses')
    await drive.seedMirrors(ctx.venue, [rows.inertRow('capability_snapshots', Object.assign({ tag: 'bf4|snap|' + ctx.tip }, base)), legacy, omits, control])
    await drive.waitForMirrorRows(ctx.venue, ARMED, TABLE, 3)
    ctx.keys = { legacy: legacy.row.match_id, omits: omits.row.match_id, control: control.row.match_id }
    assert.strictEqual(omits.row[fixture.admissionColumn(TABLE, 'BTC')], null, 'the omitting row must carry NULL for this chain')
    assert.strictEqual(omits.row[fixture.admissionColumn(TABLE, 'LTC')], 5, 'the omitting row must carry a height for the other chain')
    console.log('BF4 seeded at T=' + ctx.T + ' against tip ' + ctx.tip + ': ' + JSON.stringify(ctx.keys))
}

async function expectReadSet (ctx, block, want) {
    const got = await drive.waitCommitted(ctx.venue, ARMED, block.height, 10 * 60 * 1000)
    assert.ok(got.ok, 'the armed node did not commit block ' + block.height + ': ' + JSON.stringify(got.s) + '\n' + ctx.venue.logTail('indexer' + ARMED))
    const read = await drive.mirrorReadableSet(ctx.venue, ARMED, TABLE, ctx.coin, block.height, block.blockTime)
    const hubRows = await drive.hubRows(ctx.venue, ctx.venue.indexers[ARMED].followsHub, TABLE)
    const expected = fixture.admittedRowSet(hubRows, TABLE, ctx.coin, block.height, block.blockTime, (r) => String(r.match_id))
    ctx.blocks.push({ block, read, expected })
    console.log('BF4 block ' + block.height + ' stamped ' + block.blockTime + ': read ' + JSON.stringify(read))
    assert.deepStrictEqual(read, want, 'at block ' + block.height + ' (t=' + block.blockTime + ', T=' + ctx.T + ') the mirror reads ' + JSON.stringify(read))
    assert.deepStrictEqual(expected, want, 'the fixture computes ' + JSON.stringify(expected) + ' from the hub rows')
}
