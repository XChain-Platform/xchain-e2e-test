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
 *
 * THE VENUE ARMS AT A CROSSING, NOT AT GENESIS. "Armed" resolves to height 0, and on
 * that venue no block sits below the activation, so a NULL-map seed is not a legacy
 * row at all: it is a modern row missing its mandatory map, which no hub produces and
 * which the canonical builder refuses by design: it rejects a NULL admission map on any
 * row whose era block is at or above the producer activation (adjudicated 2026-09-18, the
 * product is correct on both sides and they agree; the seed was the defect). The leg
 * arms producers and consumers at the chain's tip + 1 and seeds its legacy row below
 * that height, so the row is one a pre-crossing hub really wrote and the crossing is
 * one this venue walked through rather than one the seeding manufactured.
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

function renderEvidence (value) {
    try {
        const rendered = JSON.stringify(value, (key, item) => typeof item === 'bigint' ? item.toString() : item)
        return rendered === undefined ? String(value) : rendered
    } catch (error) {
        return '[unprintable: ' + (error && error.message ? error.message : String(error)) + ']'
    }
}

function assertionMessage (expected, found, next) {
    return 'expected ' + expected + '; found ' + renderEvidence(found) + '; inspect ' + next
}

function deferralNote (venue, indexer) {
    const which = 'indexer' + indexer
    try {
        const tail = String(venue.logTail(which) || '')
        if (!tail || /\blast 0 line\(s\) from\b/.test(tail)) {
            return 'log tail unavailable: ' + which + ' has not written any lines yet'
        }
        const lines = tail.split(/\r?\n/).filter((line) => /Deferring block /.test(line))
        if (lines.length) return 'latest deferral from ' + which + ': ' + lines[lines.length - 1].trim()
        return 'deferral evidence unavailable: no matching line in the available ' + which + ' log tail'
    } catch (error) {
        return 'log tail unavailable: ' + (error && error.message ? error.message : String(error))
    }
}

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
            const satisfied = stub.heightSatisfied(TABLE, B)
            assert.strictEqual(satisfied, want,
                assertionMessage(why + ' to produce heightSatisfied=' + want, satisfied, 'the BF4 height matrix case'))
            if (!want) {
                assert.strictEqual(stub._heightShortfalls[TABLE + '|BTC'], target,
                    assertionMessage(why + ' shortfall=' + target, stub._heightShortfalls[TABLE + '|BTC'], 'the BF4 shortfall map'))
            }
        }
    })

    it('unit: below the activation the match member is the legacy clock form over the same matrix', function () {
        for (const heights of [undefined, {}, { [TABLE]: { BTC: B - 1 } }, { [TABLE]: { BTC: 0 } }]) {
            const inert = mirrorStub(heights, false)
            // Legacy: content escape (max effective_time >= t(B)), else watermark >= t(B) + grace.
            const escapedByContent = members.matchSyncSatisfied.call(inert, T - 1, B)
            assert.strictEqual(escapedByContent, true,
                assertionMessage('content escape=true at t(B)=max effective_time+1', escapedByContent, 'the BF4 legacy member predicate'))
            const beforeGrace = members.matchSyncSatisfied.call(inert, T + 1, B)
            assert.strictEqual(beforeGrace, false,
                assertionMessage('legacy member=false before watermark grace', beforeGrace, 'the BF4 legacy member predicate'))
            inert.streamWatermark = T + 121
            const afterGrace = members.matchSyncSatisfied.call(inert, T + 1, B)
            assert.strictEqual(afterGrace, true,
                assertionMessage('legacy member=true after watermark grace', afterGrace, 'the BF4 legacy member predicate'))
            inert.matchSyncTimestamp = null
            const emptyMirror = members.matchSyncSatisfied.call(inert, T + 9999, B)
            assert.strictEqual(emptyMirror, true,
                assertionMessage('empty-mirror escape=true', emptyMirror, 'the BF4 legacy member predicate'))
        }
        const armed = mirrorStub({ [TABLE]: { BTC: B - 5 } }, true)
        armed.streamWatermark = T + 99999
        const armedSatisfied = members.matchSyncSatisfied.call(armed, T + 1, B)
        assert.strictEqual(armedSatisfied, false,
            assertionMessage('armed height-keyed member=false below its height line', armedSatisfied, 'the BF4 armed member predicate'))
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
            assert.strictEqual(ours, theirs,
                assertionMessage('fixture result=' + theirs, ours, 'the BF4 binding matrix case ' + renderEvidence({ admit, height, et, bt })))
        }
        const legacyReadable = gate.isRowReadableAt(null, B, T, T)
        assert.strictEqual(legacyReadable, true,
            assertionMessage('legacy NULL readable=true at effective_time <= t(B)', legacyReadable, 'the BF4 binding boundary'))
        const omittedReadable = gate.isRowReadableAt(undefined, B, T, T)
        assert.strictEqual(omittedReadable, true,
            assertionMessage('chain-omitting map readable=true by effective_time', omittedReadable, 'the BF4 binding boundary'))
        const futureReadable = gate.isRowReadableAt(B + 1, B, T - 9999, T)
        assert.strictEqual(futureReadable, false,
            assertionMessage('future admission height readable=false at B', futureReadable, 'the BF4 binding boundary'))
    })

    it('unit: the SQL form is the IS NULL OR shape in the bind clause, the snapshot scope and the fixture query', function () {
        const col = fixture.admissionColumn(TABLE, 'BTC')
        const stub = { mirrorAdmissionActiveAt: () => true, admitColumn: () => col }
        const clause = mirrorReads.mirrorBindClause.call(stub, T, B, null, null)
        const shape = '((' + col + ' IS NULL AND effective_time <= ?) OR (' + col + ' IS NOT NULL AND ' + col + ' <= ?))'
        assert.strictEqual(clause.sql, shape,
            assertionMessage('the C33 bind clause SQL', clause.sql, 'the BF4 mirror bind clause'))
        assert.deepStrictEqual(clause.args, [T, B],
            assertionMessage('bind arguments [T, B]', clause.args, 'the BF4 mirror bind clause arguments'))
        const inert = mirrorReads.mirrorBindClause.call({ mirrorAdmissionActiveAt: () => false, admitColumn: () => col }, T, B, null, null)
        assert.deepStrictEqual(inert, { sql: 'effective_time <= ?', args: [T] },
            assertionMessage('the legacy effective_time bind clause', inert, 'the BF4 below-activation SQL'))
        const q = rows.readableRowsSql(TABLE, 'BTC', B, T)
        const hasNullOrShape = q.sql.includes('`' + col + '` IS NULL AND effective_time <= ?') &&
            q.sql.includes('`' + col + '` IS NOT NULL AND `' + col + '` <= ?')
        assert.ok(hasNullOrShape,
            assertionMessage('fixture SQL with both IS NULL and IS NOT NULL arms', q.sql, 'the BF4 readableRowsSql query'))
        const hasBareComparison = /\bWHERE[^(]*`admit_block_[a-z]+` <= \?/.test(q.sql)
        assert.ok(!hasBareComparison,
            assertionMessage('no bare nullable admission-height comparison', { hasBareComparison, sql: q.sql }, 'the BF4 readableRowsSql WHERE clause'))
        const snapshotSrc = require('fs').readFileSync(path.join(INDEXER, 'hub', 'hub_db_sync', 'barriers', 'snapshot.js'), 'utf8')
        const snapshotHasNullArm = snapshotSrc.includes("' IS NULL AND ' + alias + '.effective_time <= ?) OR ('")
        assert.ok(snapshotHasNullArm,
            assertionMessage('snapshot scope with the IS NULL arm', snapshotHasNullArm, 'the BF4 snapshot barrier source'))
    })
})

describe('BF4 live: above the activation a NULL row and a chain-omitting row bind by the legacy rule', function () {
    this.timeout(drive.LEG_FLOOR_MS)

    const ctx = { venue: null, btc: null, coin: 'BTC', T: null, tip: null, armHeight: null, legacyBlock: null, keys: {}, blocks: [] }

    before(async function () {
        const up = await drive.bootFamilyVenue({ label: 'bf4', repoRoot: BUILD_ROOT, armed: [ARMED, 1], armHubs: true, armAtCrossing: true })
        Object.assign(ctx, up, { coin: up.evidence.coinCode })
        console.log('BF4 armed at ' + ctx.armHeight + ', legacy era block ' + ctx.legacyBlock)
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
    // The crossing, asserted before anything is seeded: the legacy block is a real block BELOW the
    // activation and the drill blocks land at or above it, so both eras exist on this one venue.
    assert.strictEqual(ctx.legacyBlock, fixture.legacyEraBlock(ctx.armHeight),
        assertionMessage('legacyBlock=' + fixture.legacyEraBlock(ctx.armHeight), 'legacyBlock=' + ctx.legacyBlock, 'the BF4 activation setup'))
    assert.ok(ctx.legacyBlock < ctx.armHeight,
        assertionMessage('legacyBlock below armHeight', { legacyBlock: ctx.legacyBlock, armHeight: ctx.armHeight }, 'the BF4 legacy seed era'))
    assert.ok(ctx.armHeight <= ctx.tip + 1,
        assertionMessage('armHeight at or below next tip', { armHeight: ctx.armHeight, nextTip: ctx.tip + 1 }, 'the BF4 crossing height'))
    // The legacy row is the one seed in the pre-activation era: its map is NULL because the hub that
    // wrote it did not stamp maps yet, which is the row C33 and BF4's "Above" half are about.
    const legacy = rows.inertRow(TABLE, Object.assign({ tag: 'bf4|legacy|' + ctx.tip }, base, { snapshotBlock: ctx.legacyBlock }))
    const omits = rows.inertRow(TABLE, Object.assign({ tag: 'bf4|omits|' + ctx.tip, admitBlocks: { LTC: 5 } }, base))
    const control = rows.inertRow(TABLE, Object.assign({ tag: 'bf4|control|' + ctx.tip, admitBlocks: { BTC: ctx.tip + 1 }, effectiveTime: ctx.T + 9999 }, base))
    // The legacy row lives in cross_chain_matches, whose armed apply reads the capability set before the
    // canonical; the guard fails this case, not the drill block, if it is ever moved to bridge or policy.
    const hazards = rows.armedLegacyApplyHazards([legacy, omits, control], ctx.armHeight)
    assert.deepStrictEqual(hazards, [], assertionMessage('no armed legacy apply hazards', hazards, 'the BF4 seed rows'))
    await drive.seedMirrors(ctx.venue, [rows.inertRow('capability_snapshots', Object.assign({ tag: 'bf4|snap|' + ctx.tip }, base)), legacy, omits, control])
    await drive.waitForMirrorRows(ctx.venue, ARMED, TABLE, 3)
    ctx.keys = { legacy: legacy.row.match_id, omits: omits.row.match_id, control: control.row.match_id }
    assert.strictEqual(omits.row[fixture.admissionColumn(TABLE, 'BTC')], null,
        assertionMessage('BTC admission height=NULL', omits.row[fixture.admissionColumn(TABLE, 'BTC')], 'the BF4 chain-omitting seed'))
    assert.strictEqual(omits.row[fixture.admissionColumn(TABLE, 'LTC')], 5,
        assertionMessage('LTC admission height=5', omits.row[fixture.admissionColumn(TABLE, 'LTC')], 'the BF4 chain-omitting seed'))
    // Each seed in the era it is meant to be in, read off the row rather than off the spec.
    assert.ok(legacy.row.snapshot_block < ctx.armHeight,
        assertionMessage('legacy snapshot_block below armHeight', { snapshotBlock: legacy.row.snapshot_block, armHeight: ctx.armHeight }, 'the BF4 legacy seed'))
    for (const s of [omits, control]) {
        assert.ok(s.row.snapshot_block >= ctx.armHeight,
            assertionMessage('map-carrying snapshot_block at or above armHeight', { snapshotBlock: s.row.snapshot_block, armHeight: ctx.armHeight }, 'the BF4 admission-era seeds'))
    }
    console.log('BF4 seeded at T=' + ctx.T + ' against tip ' + ctx.tip + ', activation ' + ctx.armHeight +
                ', legacy era block ' + ctx.legacyBlock + ': ' + JSON.stringify(ctx.keys))
}

async function expectReadSet (ctx, block, want) {
    const got = await drive.waitCommitted(ctx.venue, ARMED, block.height, 10 * 60 * 1000)
    assert.ok(got.ok, assertionMessage('armed node commit of block ' + block.height + ' inside 600000 ms',
        { ok: got.ok, status: got.s }, 'the armed indexer evidence: ' + deferralNote(ctx.venue, ARMED)))
    const read = await drive.mirrorReadableSet(ctx.venue, ARMED, TABLE, ctx.coin, block.height, block.blockTime)
    const hubRows = await drive.hubRows(ctx.venue, ctx.venue.indexers[ARMED].followsHub, TABLE)
    const expected = fixture.admittedRowSet(hubRows, TABLE, ctx.coin, block.height, block.blockTime, (r) => String(r.match_id))
    ctx.blocks.push({ block, read, expected })
    console.log('BF4 block ' + block.height + ' stamped ' + block.blockTime + ': read ' + JSON.stringify(read))
    assert.deepStrictEqual(read, want,
        assertionMessage('mirror read set ' + renderEvidence(want), read, 'the BF4 mirror rows at block ' + block.height + ', t=' + block.blockTime + ', T=' + ctx.T))
    assert.deepStrictEqual(expected, want,
        assertionMessage('fixture admitted set ' + renderEvidence(want), expected, 'the BF4 hub rows at block ' + block.height))
}
