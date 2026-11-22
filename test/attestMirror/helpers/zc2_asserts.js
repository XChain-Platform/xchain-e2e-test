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
 * ZC2 steps, second half: the reorg and re-bind, the one-split money check and
 * the one-fetch check. The drill itself lives in zc2_remine.test.js.
 ********************************************************************/

const assert = require('assert')

const { SETTLE_BLOCKS, orphanFrom, settleAfterReorg } = require('./zc2_fixture')
const {
    APPLIED_FIELDS, untilOrClearDogeStall, diffRows, waitForHeightWithClear,
    readAppliedResponse, readContractState, readAttestRewards, rawAttestRewards,
    venueTipProbe, settleOrReport, feeLines, jsonSafe,
} = require('./mirrorDrillWaits')

async function awaitReapplied (ctx, requestId, appliedBlock) {
    const venue = ctx.venue
    const reapplied = await untilOrClearDogeStall(async () => {
        const rows = []
        for (const ix of venue.indexers) rows.push(await readAppliedResponse(venue, ix.index, requestId))
        return { ok: rows.every((r) => r && Number(r.block_index) === appliedBlock), rows: rows }
    }, { timeoutMs: 15 * 60 * 1000, tipProbe: venueTipProbe(venue, 0) })
    assert.ok(reapplied.ok,
        'the response did not come back at block ' + appliedBlock + ' on both nodes after the ' +
        'reorg; they hold ' + jsonSafe(reapplied.rows.map((r) => (r ? r.block_index : null))) +
        '. The mirror row is rollback-exempt and the request is pending again, so the applier ' +
        'had everything it needed.\n' + venue.logTail('indexer0') + '\n' + venue.logTail('indexer1'))
    return reapplied
}

function assertSameBinding (reapplied, beforeRows) {
    const diffs = diffRows(reapplied.rows[0], reapplied.rows[1], APPLIED_FIELDS)
    assert.deepStrictEqual(diffs, [],
        'the two nodes re-bound the response differently after the reorg: ' + diffs.join('; '))
    for (const field of ['response_hash', 'action_index']) {
        assert.strictEqual(String(reapplied.rows[0][field]), String(beforeRows[0][field]),
            field + ' changed across the reorg (' + beforeRows[0][field] + ' to ' +
            reapplied.rows[0][field] + '). The response is derived from the tag, network and ' +
            'request id, none of which a reorg touches.')
    }
}

// ---- the reorg: keep the request, orphan the applying block -----------
async function reorgAndRebind (ctx, requestId, applied) {
    const { appliedBlock, beforeRows } = applied
    await regtestMinerConnector.pauseMining()
    try {
        const reorg = await orphanFrom(ctx, appliedBlock, 'keep')
        console.log('ZC2: orphaned the applying block ' + appliedBlock + ' and rebuilt to ' +
            reorg.tipAfter)

        const reapplied = await awaitReapplied(ctx, requestId, appliedBlock)
        assertSameBinding(reapplied, beforeRows)

        const state = await readContractState(ctx.venue, 0, ctx.contract.contractIndex)
        assert.strictEqual(JSON.parse(state.callback_status), 'ok',
            'the callback did not re-fire after the reorg (state ' + state.callback_status + ')')
    } finally {
        await regtestMinerConnector.resumeMining()
        await settleAfterReorg('keep')
    }
}

// ---- the money: exactly one split, 25 blocks later --------------------
//
// MINED OUT, not read straight away. A second settle would be written by a
// second apply, and a second apply needs a block to run in; reading the table
// the moment the first one lands proves only that nothing has had the chance
// to go wrong yet.
async function mineOutSettle (ctx) {
    await regtestMinerConnector.generateBlocks(SETTLE_BLOCKS)
    await settleOrReport('zc2')
    const tip = Number(await nodeConnector.getBlockCount())
    for (const ix of ctx.venue.indexers) await waitForHeightWithClear(ctx.venue, ix.index, tip)
}

async function assertIndexerSplit (ctx, ix, roundRef, appliedBlock) {
    const venue   = ctx.venue
    const rewards = await readAttestRewards(venue, ix.index, { roundReference: roundRef })
    const fees    = rewards.filter((r) => String(r.reward_type) === 'attest_fee')
    const raw     = fees.length > 0 ? '' : await rawAttestRewards(venue, ix.index)
    assert.ok(fees.length > 0,
        'indexer ' + ix.index + ' holds no attest_fee row for round_reference ' + roundRef +
        ' after the re-bind, so the escrow went nowhere and "exactly one split" would pass ' +
        'vacuously\n' + feeLines(venue, 'indexer' + ix.index) + '\n' + raw)

    // ONE SET, counted by the BLOCK the rows were written at. Every row of one
    // split shares the applying block, so a second settle (the failure this whole
    // drill exists to catch: a re-mine that pays the set twice out of one escrow)
    // shows up as a second distinct block_index under the same round_reference.
    // Counting ROWS instead would fail on an honest split of any size.
    const blocks = [...new Set(fees.map((r) => Number(r.block_index)))].sort((a, b) => a - b)
    assert.deepStrictEqual(blocks, [Number(appliedBlock)],
        'indexer ' + ix.index + ' holds attest_fee rows for round_reference ' + roundRef +
        ' at block(s) ' + jsonSafe(blocks) + ' rather than only at the re-bound block ' +
        appliedBlock + '. More than one block means the escrow was split more than once for ' +
        'one request, which is the double-payment a re-mine must not cause; a different ' +
        'single block means the rollback did not take the first split with it. Rows: ' +
        jsonSafe(fees))

    // The payees are distinct: a set paid twice inside ONE block would show a
    // pubkey twice and the block count above could not see it.
    const payees = fees.map((r) => String(r.pubkey).toLowerCase())
    assert.strictEqual(new Set(payees).size, payees.length,
        'indexer ' + ix.index + ' paid a pubkey more than once in the same split: ' +
        jsonSafe(payees))
    console.log('ZC2: indexer ' + ix.index + ' holds one attest_fee split at block ' +
        appliedBlock + ' across ' + fees.length + ' payee(s)')
}

async function assertOneSplit (ctx, applied) {
    await mineOutSettle(ctx)
    for (const ix of ctx.venue.indexers) {
        await assertIndexerSplit(ctx, ix, applied.roundRef, applied.appliedBlock)
    }
}

async function readFetchAfter (venue) {
    const after = {}
    for (const hub of venue.hubs) {
        const s = await venue.attestationStatsOf(hub.index)
        assert.ok(!s.error, 'hub ' + hub.index + ' would not answer getattestationstats after the ' +
            'reorg (' + s.error + ')')
        after[hub.index] = Number(s.fetch_count)
    }
    return after
}

// ---- the fetch: paid for once ----------------------------------------
async function assertFetchedOnce (ctx, before, responsibleHubs) {
    const venue = ctx.venue
    const after = await readFetchAfter(venue)
    console.log('ZC2 fetch_count per hub: before ' + jsonSafe(before) + ', after ' + jsonSafe(after))

    for (const hubIndex of responsibleHubs) {
        const delta = after[hubIndex] - before[hubIndex]
        assert.strictEqual(delta, 1,
            'responsible hub ' + hubIndex + ' issued ' + delta + ' paid provider fetch(es) across ' +
            'this request (fetch_count ' + before[hubIndex] + ' to ' + after[hubIndex] + '). ' +
            'Exactly one is the claim: the request id is content-derived and therefore ' +
            'reorg-stable, so the re-mined request is the SAME request and the finalized ring ' +
            'refuses a second round for it outright. Two means the ring did not hold and the ' +
            'federation re-paid the provider for work it already had.\n' +
            venue.logTail('hub' + hubIndex))
    }
    const outsiders = venue.hubs
        .map((h) => h.index)
        .filter((i) => !responsibleHubs.includes(i))
        .filter((i) => after[i] - before[i] !== 0)
    assert.deepStrictEqual(outsiders, [],
        'hub(s) ' + jsonSafe(outsiders) + ' fetched from the provider without being in the ' +
        'responsible set, so a hub outside the draw is paying for work it was never asked to do')
}

module.exports = { reorgAndRebind, assertOneSplit, assertFetchedOnce }
