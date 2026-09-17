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
 * BF8 (family section 7, R6 ruled (a) 2026-09-12): the non-BTC leg. A second
 * coin's indexers (LTC) against the SAME hubs as the BTC indexers, with their own
 * decoder credential resolved through the venue's existing stores rather than the
 * harness `.env` (attachedCoinVenueOpts pins the AT5 attach shape). One match row
 * whose read set spans both chains (a_chain BTC, b_chain LTC) is seeded with a
 * TWO-entry admission map, and each chain's indexers are shown to bind it at the
 * block ITS entry selects and not the other's: the two entries are different
 * numbers, the two binding blocks carry different wall-clock stamps and are
 * committed at different instants, and the two indexers on each chain agree on
 * `actions_hash` at their own binding height. The negative row carries a BTC
 * entry only, so on the LTC indexer it binds by the LEGACY time rule alone
 * (section 5.5: a map that never named this chain is a legacy row on it).
 *
 * ARMED ON EVERY INDEXER, hubs left inert: the rows are inert (unsigned, never
 * appliable) and injected, so no producer stamps anything; the height watermark
 * the hubs publish is not gated by their arming. The hubs are handed the standing
 * LTC indexer's URL (secondCoinHubEnv) so `heights[table].LTC` exists at all.
 *
 * The `unit` describe drives the same row shapes through the fixture's binding rule
 * off the rail: `--grep unit`. The live describe needs the rail's BTC and LTC
 * regtest stacks and FAILS, never skips, without them.
 ********************************************************************/

const assert = require('assert')
const path = require('path')
const dotenv = require('dotenv')
dotenv.config()

const fixture = require('../helpers/barrierFamilyFixture')
const rows = require('../helpers/barrierFamilyRows')
const drive = require('../helpers/barrierFamilyDrive')
const { createRail, withRail } = require('../../helpers/chainRail')
const { attachedCoinVenueOpts, secondCoinHubEnv } = require('../../helpers/attestMirrorVenue')
const { diffStateHashes, queryDb } = require('../mirrorDrillWaits')

const BUILD_ROOT = path.resolve(__dirname, '..', '..', '..', '..')
const { HUB_SCHEMA_VERSION } = require(path.join(BUILD_ROOT, 'xchain-indexer', 'src', 'hub', 'hub_schema_version.js'))

const TABLE = 'cross_chain_matches'
const BTC = 'BTC'
const LTC = 'LTC'
const SECOND_COIN = 'litecoin'
// Both indexers of each chain are armed; two per chain so "agree" is node against node.
const ARMED = [0, 1]
// Every mined block must stay inside the mapped rails' 4-block margin of the hubs' settled
// tip, or the armed members hold the block for one round window: one BTC block, two or
// three LTC blocks (three only when two would land on the BTC entry's number).
const BTC_STEPS = 1
const LTC_STEPS_MIN = 2

/**
 * The two-entry map: BTC's entry one past its tip, LTC's two past its tip, or three when
 * two would equal BTC's entry. Different NUMBERS are what let a leg show that a chain
 * binds at its own entry and not the other's; a tie proves nothing either way.
 */
function planEntries (btcTip, ltcTip) {
  const b = Number(btcTip) + BTC_STEPS
  let l = Number(ltcTip) + LTC_STEPS_MIN
  if (l === b) l += 1
  return { [BTC]: b, [LTC]: l }
}

/** The two seeded rows: A carries both entries, N carries BTC's only (legacy on LTC). */
function bf8Rows (plan, base) {
  const tag = 'bf8|' + plan[BTC] + '|' + plan[LTC]
  return {
    A: rows.inertRow(TABLE, Object.assign({ tag: tag + '|A', admitBlocks: plan }, base)),
    N: rows.inertRow(TABLE, Object.assign({ tag: tag + '|N', admitBlocks: { [BTC]: plan[BTC] } }, base)),
  }
}

describe('BF8 unit: a two-entry map binds per chain at its own entry, a one-entry map is legacy on the other chain', function () {
  const plan = planEntries(1000, 998)
  const base = { network: 'regtest', coin: BTC, otherChain: LTC, snapshotBlock: 1000, effectiveTime: 5000 }
  const seeded = bf8Rows(plan, base)

  it('plans two DIFFERENT entries, three LTC blocks when two would tie', () => {
    assert.deepStrictEqual(plan, { BTC: 1001, LTC: 1000 })
    assert.deepStrictEqual(planEntries(1000, 999), { BTC: 1001, LTC: 1002 })
    assert.notStrictEqual(planEntries(7, 6)[BTC], planEntries(7, 6)[LTC])
  })

  it('shapes the rows: A maps both chains, N maps BTC only, DOGE is never named', () => {
    assert.strictEqual(seeded.A.row.a_chain, BTC)
    assert.strictEqual(seeded.A.row.b_chain, LTC)
    assert.strictEqual(seeded.A.row.admit_block_btc, 1001)
    assert.strictEqual(seeded.A.row.admit_block_ltc, 1000)
    assert.strictEqual(seeded.A.row.admit_block_doge, null)
    assert.strictEqual(seeded.N.row.admit_block_btc, 1001)
    assert.strictEqual(seeded.N.row.admit_block_ltc, null)
    assert.notStrictEqual(seeded.A.row.match_id, seeded.N.row.match_id)
  })

  it('binds A on each chain at that chain\'s entry and not at the other\'s', () => {
    const col = (c) => fixture.admissionColumn(TABLE, c)
    assert.strictEqual(fixture.rowAdmittedAt(seeded.A.row, col(BTC), plan[BTC] - 1, 9e9), false)
    assert.strictEqual(fixture.rowAdmittedAt(seeded.A.row, col(BTC), plan[BTC], 0), true)
    assert.strictEqual(fixture.rowAdmittedAt(seeded.A.row, col(LTC), plan[LTC] - 1, 9e9), false)
    assert.strictEqual(fixture.rowAdmittedAt(seeded.A.row, col(LTC), plan[LTC], 0), true)
    // The other chain's number is not this chain's entry: LTC's entry is below BTC's here.
    assert.strictEqual(fixture.rowAdmittedAt(seeded.A.row, col(BTC), plan[LTC], 9e9), false)
  })

  it('binds N on LTC by the legacy time rule alone, and on BTC by height', () => {
    const col = (c) => fixture.admissionColumn(TABLE, c)
    assert.strictEqual(fixture.rowAdmittedAt(seeded.N.row, col(LTC), 0, base.effectiveTime), true)
    assert.strictEqual(fixture.rowAdmittedAt(seeded.N.row, col(LTC), 9e9, base.effectiveTime - 1), false)
    assert.strictEqual(fixture.rowAdmittedAt(seeded.N.row, col(BTC), plan[BTC] - 1, 9e9), false)
    assert.strictEqual(fixture.rowAdmittedAt(seeded.N.row, col(BTC), plan[BTC], 0), true)
    assert.strictEqual(rows.readableRowsSql(TABLE, LTC, 1, 1).column, 'admit_block_ltc')
  })
})

describe('BF8: the non-BTC leg, one BTC/LTC match bound at each chain\'s own entry', function () {
  this.timeout(Math.max(drive.LEG_FLOOR_MS, 90 * 60 * 1000))

  const ctx = { venue: null, btc: null, ltc: null, ltcVenue: null, plan: null, tips: null, keys: null, sets: { BTC: {}, LTC: {} },
                blocks: { BTC: {}, LTC: {} }, committedAt: {} }

  before(async function () {
    await bootBothCoins(ctx)
  })

  after(async function () {
    // A case that failed while either chain was held must not leave a miner paused.
    await drive.releaseChain(ctx.btc)
    await drive.releaseChain(ctx.ltc)
    if (ctx.ltcVenue) await ctx.ltcVenue.stop()
    if (ctx.venue) await ctx.venue.stop()
  })

  it('seeds the two-entry row and the BTC-only row into the shared hubs, mirrored on all four indexers', async function () {
    await seedRows(ctx)
  })

  it('binds the two-entry row on BTC at its BTC entry and on LTC at its LTC entry, at different wall-clock instants', async function () {
    await bindOnBtc(ctx)
    await bindOnLtc(ctx)
    await assertEntriesDiffer(ctx)
  })

  it('binds the BTC-only row on the LTC indexer by the legacy rule alone', async function () {
    await assertLegacyOnLtc(ctx)
  })

  it('agrees on actions_hash at each chain\'s own binding height, node against node', async function () {
    await assertHashesAgree(ctx)
  })
})

/**
 * The BTC family venue with every indexer armed and the hubs told where LTC's indexer
 * is; then the attached LTC venue, built INSIDE the LTC rail switch so its indexers seed
 * from the standing LTC indexer and discover LTC's decoder (AT5's precedent).
 */
async function bootBothCoins (ctx) {
  ctx.ltc = await createRail(SECOND_COIN, 'regtest')
  const ltcIndexerUrl = 'http://' + ctx.ltc.host + ':' + ctx.ltc.ports.indexer
  const up = await drive.bootFamilyVenue({
    label: 'bf8', repoRoot: BUILD_ROOT, armed: ARMED, venue: { hubExtraEnv: secondCoinHubEnv(LTC, ltcIndexerUrl) },
  })
  Object.assign(ctx, { venue: up.venue, btc: up.btc, evidence: up.evidence })
  assert.deepStrictEqual(Object.keys(ctx.venue.indexerEnv).map(Number), ARMED, 'both BTC indexers must be armed')
  ctx.ltcVenue = await withRail(ctx.ltc, async () => {
    const built = fixture.buildFamilyVenue({
      repoRoot: BUILD_ROOT, armed: ARMED, label: 'bf8ltc',
      venue: attachedCoinVenueOpts(ctx.venue, { coin: SECOND_COIN, indexerCount: 2 }),
    })
    assert.strictEqual(built.venue.useEnvDecoderCredential, false, 'the LTC venue must not take the harness decoder credential')
    assert.strictEqual(built.venue.attachHubs, ctx.venue.hubs, 'the LTC indexers must follow the BTC venue\'s hubs')
    const ok = await built.venue.start()
    assert.ok(ok, 'FAILED DRIVE (not a skip): the attached LTC venue did not come up: ' + String(built.venue.unavailable))
    console.log('BF EVIDENCE ' + JSON.stringify(Object.assign(built.evidence, {
      decoderCredentialSource: built.venue.decoderCredentialSource, followsHubs: built.venue.indexers.map((ix) => ix.followsHub),
    })))
    return built.venue
  })
  await drive.levelIndexers(ctx.ltcVenue)
  const btcFollows = ctx.venue.indexers.map((ix) => ix.followsHub)
  assert.deepStrictEqual(ctx.ltcVenue.indexers.map((ix) => ix.followsHub), btcFollows, 'each LTC indexer must follow the hub its BTC twin follows')
}

// Both chains are held from their tip reads to their planned entries (each miner paused BEFORE
// its read): the plan names exact heights, and a block either adaptive miner lands in between
// moves an entry off the block this leg mines for it.
async function seedRows (ctx) {
  const btcHeld = await drive.holdBaseline(ctx.btc, ctx.venue, { label: 'bf8 BTC' })
  const ltcHeld = await drive.holdBaseline(ctx.ltc, ctx.ltcVenue, { label: 'bf8 LTC' })
  const btcTip = btcHeld.tip
  const ltcTip = ltcHeld.tip
  ctx.tips = { [BTC]: btcTip, [LTC]: ltcTip }
  ctx.plan = planEntries(btcTip, ltcTip)
  const now = Math.floor(Date.now() / 1000)
  const base = { network: ctx.venue.network, coin: BTC, otherChain: LTC, snapshotBlock: btcTip, effectiveTime: now - 10 }
  const seeded = bf8Rows(ctx.plan, base)
  ctx.keys = { A: seeded.A.row.match_id, N: seeded.N.row.match_id }
  const snap = rows.inertRow('capability_snapshots', Object.assign({ tag: 'bf8|snap|' + btcTip, effectiveTime: now }, base))
  await drive.seedMirrors(ctx.venue, [snap, seeded.A, seeded.N])
  for (const ix of ctx.ltcVenue.indexers) ix.mirrorProxy.dropSockets()
  for (const i of ARMED) {
    await drive.waitForMirrorRows(ctx.venue, i, TABLE, 2)
    await drive.waitForMirrorRows(ctx.ltcVenue, i, TABLE, 2)
  }
  const hubSnap = await ctx.venue.hubSnapshot(ctx.venue.indexers[0].followsHub)
  assert.strictEqual(Number(hubSnap.schema_version), HUB_SCHEMA_VERSION, 'the schema axis must not vary here')
  // Before any block: both rows carry a BTC entry above the tip, so BTC reads neither.
  for (const i of ARMED) {
    assert.deepStrictEqual(await drive.mirrorReadableSet(ctx.venue, i, TABLE, BTC, btcTip, now), [],
      'BTC indexer ' + i + ' reads a row below its BTC entry')
  }
  console.log('BF8 seeded A=' + ctx.keys.A + ' map ' + JSON.stringify(ctx.plan) + ' and N=' + ctx.keys.N +
    ' map {BTC:' + ctx.plan[BTC] + '} with effective_time ' + (now - 10) + '; tips BTC ' + btcTip + ', LTC ' + ltcTip)
}

async function bindOnBtc (ctx) {
  const started = Date.now()
  await drive.assertChainHeld(ctx.btc, ctx.tips[BTC], 'the BTC chain, before its entry,')
  // Resumes the BTC miner: the plan has one BTC block, so the BTC hold ends here.
  const block = await drive.mineStamped(ctx.btc, null)
  assert.strictEqual(block.height, ctx.plan[BTC], 'the BTC block is not the planned entry')
  for (const i of ARMED) {
    const got = await drive.waitCommitted(ctx.venue, i, block.height, 10 * 60 * 1000)
    assert.ok(got.ok, 'BTC indexer ' + i + ' never committed ' + block.height + ': ' + JSON.stringify(got.s) + '\n' + ctx.venue.logTail('indexer' + i))
  }
  ctx.committedAt[BTC] = Date.now()
  ctx.blocks[BTC][block.height] = block
  const expect = [ctx.keys.A, ctx.keys.N].sort()
  for (const i of ARMED) {
    ctx.sets[BTC][block.height] = await drive.mirrorReadableSet(ctx.venue, i, TABLE, BTC, block.height, block.blockTime)
    assert.deepStrictEqual(ctx.sets[BTC][block.height], expect, 'BTC indexer ' + i + ' does not bind both rows at the BTC entry')
    assert.deepStrictEqual(await drive.mirrorReadableSet(ctx.venue, i, TABLE, BTC, block.height - 1, block.blockTime), [],
      'BTC indexer ' + i + ' binds a row one below the BTC entry')
  }
  console.log('BF8 BTC bound both rows at ' + block.height + ' (stamp ' + block.blockTime + ') in ' + (Date.now() - started) + ' ms')
}

async function bindOnLtc (ctx) {
  // Stamps have one-second resolution: two seconds keeps the LTC stamp off BTC's.
  await new Promise((r) => setTimeout(r, 2000))
  await withRail(ctx.ltc, async () => {
    await drive.assertChainHeld(ctx.ltc, ctx.tips[LTC], 'the LTC chain, before its run,')
    for (let h = ctx.tips[LTC] + 1; h <= ctx.plan[LTC]; h++) {
      // The LTC miner stays paused between the run's blocks (each commit wait is minutes
      // long) and resumes with the last one, the LTC entry.
      const block = await drive.mineStamped(ctx.ltc, null, { resume: h === ctx.plan[LTC] })
      assert.strictEqual(block.height, h, 'the LTC block is not the next height')
      for (const i of ARMED) {
        const got = await drive.waitCommitted(ctx.ltcVenue, i, h, 10 * 60 * 1000)
        assert.ok(got.ok, 'LTC indexer ' + i + ' never committed ' + h + ': ' + JSON.stringify(got.s) + '\n' + ctx.ltcVenue.logTail('indexer' + i))
      }
      ctx.blocks[LTC][h] = block
      const sets = []
      for (const i of ARMED) sets.push(await drive.mirrorReadableSet(ctx.ltcVenue, i, TABLE, LTC, h, block.blockTime))
      assert.deepStrictEqual(sets[0], sets[1], 'the two LTC indexers disagree on the readable set at ' + h)
      ctx.sets[LTC][h] = sets[0]
      const expect = h < ctx.plan[LTC] ? [ctx.keys.N] : [ctx.keys.A, ctx.keys.N].sort()
      assert.deepStrictEqual(sets[0], expect, 'LTC at ' + h + ' (entry ' + ctx.plan[LTC] + ') reads ' + JSON.stringify(sets[0]))
    }
  })
  ctx.committedAt[LTC] = Date.now()
  console.log('BF8 LTC bound A at ' + ctx.plan[LTC] + ' and N from ' + Object.keys(ctx.sets[LTC])[0] + ' (legacy); stamps ' +
    JSON.stringify(Object.keys(ctx.blocks[LTC]).map((h) => ctx.blocks[LTC][h].blockTime)))
}

/** The two entries are different numbers, mined and committed at different wall-clock instants. */
function assertEntriesDiffer (ctx) {
  const bB = ctx.plan[BTC]
  const bL = ctx.plan[LTC]
  assert.notStrictEqual(bB, bL, 'the two entries are the same number, so nothing distinguishes the chains')
  const stampB = ctx.blocks[BTC][bB].blockTime
  const stampL = ctx.blocks[LTC][bL].blockTime
  assert.notStrictEqual(stampB, stampL, 'the two binding blocks carry the same wall-clock stamp')
  assert.ok(ctx.committedAt[LTC] > ctx.committedAt[BTC], 'the LTC binding was not observed after the BTC binding')
  // The lower entry, read on the OTHER chain's mirror at that same number, does not admit A:
  // the row binds at each chain's own entry, not at the other's.
  const lower = Math.min(bB, bL)
  const otherChain = lower === bB ? LTC : BTC
  const otherVenue = otherChain === LTC ? ctx.ltcVenue : ctx.venue
  const otherSet = ctx.sets[otherChain][lower]
  if (otherSet !== undefined) assert.ok(!otherSet.includes(ctx.keys.A), otherChain + ' admits A at the other chain\'s entry ' + lower)
  return drive.mirrorReadableSet(otherVenue, 0, TABLE, otherChain, lower, 0).then((s) => {
    assert.ok(!s.includes(ctx.keys.A), otherChain + ' admits A at the other chain\'s entry ' + lower + ': ' + JSON.stringify(s))
    console.log('BF8 entries differ: BTC ' + bB + ' (stamp ' + stampB + ') vs LTC ' + bL + ' (stamp ' + stampL + ')')
  })
}

/** N is a legacy row on LTC: NULL admission column, admitted by effective_time before A's entry. */
function assertLegacyOnLtc (ctx) {
  const heights = Object.keys(ctx.sets[LTC]).map(Number).sort((a, b) => a - b)
  const below = heights.filter((h) => h < ctx.plan[LTC])
  assert.ok(below.length >= 1, 'no LTC block below the LTC entry was observed')
  for (const h of below) assert.deepStrictEqual(ctx.sets[LTC][h], [ctx.keys.N], 'LTC at ' + h + ' should read N alone (legacy)')
  return queryDb(ctx.ltcVenue, ctx.ltcVenue.indexers[0].mirrorDbName,
    'SELECT admit_block_ltc AS l, admit_block_btc AS b, effective_time AS t FROM `' + TABLE + '` WHERE match_id = ?', [ctx.keys.N])
    .then((r) => {
      assert.strictEqual(r.length, 1, 'N is not in the LTC mirror')
      assert.strictEqual(r[0].l, null, 'N carries an LTC entry; it must be legacy on LTC')
      assert.strictEqual(Number(r[0].b), ctx.plan[BTC])
      assert.ok(Number(r[0].t) <= ctx.blocks[LTC][below[0]].blockTime, 'N\'s effective_time is past the first LTC block\'s stamp')
    })
}

/** Node against node on each chain, at that chain's own binding height. */
async function assertHashesAgree (ctx) {
  for (const [chain, venue] of [[BTC, ctx.venue], [LTC, ctx.ltcVenue]]) {
    const h = ctx.plan[chain]
    const a = await drive.blockHashesOf(venue, 0, h)
    const b = await drive.blockHashesOf(venue, 1, h)
    assert.ok(a.actions_hash, chain + ' indexer 0 has no actions_hash at ' + h)
    assert.strictEqual(String(a.actions_hash), String(b.actions_hash), chain + ' actions_hash differs at ' + h)
    assert.strictEqual(String(a.ledger_hash), String(b.ledger_hash), chain + ' ledger_hash differs at ' + h)
    assert.deepStrictEqual(diffStateHashes(a, b), [], chain + ' state hashes differ at ' + h + ': ' + JSON.stringify(diffStateHashes(a, b)))
    console.log('BF8 ' + chain + ' at ' + h + ': actions_hash ' + String(a.actions_hash).slice(0, 16) + '... on both indexers')
  }
}
