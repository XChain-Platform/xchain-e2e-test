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
 * AT6 case steps: the two driven cases, split into cohesive named steps.
 ********************************************************************/

const assert = require('assert')
const mathjs = require('mathjs')

const { mineWhile, readContractState } = require('./mirrorDrillFixture')
const {
    untilOrClearDogeStall, waitForMirrorRowEverywhere,
    readAttestRewards, readResponseRows, readRequestRow, venueTipProbe,
    findEmittedAttestRequest, clearBeforeBroadcast, waitForHeightWithClear,
    attestRequestWatermark, settleOrReport, widenArithmetic, jsonSafe, feeLines, rawAttestRewards,
} = require('./mirrorDrillWaits')
const vmHelper = require('../../helpers/vmHelper')
const {
    FIXED_BODY, MIRROR_ERA_VERDICT, ALREADY_VERDICT_PREFIX, DEADLINE_BLOCKS, BURIAL_BLOCKS, FEE_DECIMALS,
    broadcastStaleOnChainResponse,
} = require('./at6_fixture')

/** Execute `ask` and find the request it emitted. */
async function emitRequest (ctx, execMessage, label) {
    const contract = ctx.contract
    // Watermark FIRST: see attestRequestWatermark for why the execute's own
    // action index cannot be trusted as the correlation input.
    const sinceAction = await attestRequestWatermark(contract.contractIndex)
    await clearBeforeBroadcast()
    const exec = await mineWhile(() => vmHelper.sendExecuteV0(
        contract.owner, contract.contractIndex, 'ask', ['http_get', ctx.testUrl]))
    assert.strictEqual(exec.execution.status, 'valid', execMessage + exec.execution.status)
    return findEmittedAttestRequest(contract.contractIndex, sinceAction + 1, { label: label })
}

/** Bury the request block, then wait for the mirror row on every indexer. */
async function buryAndAwaitMirror (ctx, request, heightWait) {
    await regtestMinerConnector.generateBlocks(BURIAL_BLOCKS)
    await settleOrReport('at6')
    await heightWait()
    await waitForMirrorRowEverywhere(ctx.venue, request.requestId, null, {
        // MINES WHILE WAITING, because the widening ladder is height-driven and a
        // still chain sits at widen 0 forever: a draw containing a key no live hub
        // holds then never finalizes. Capped below the deadline so the wait cannot
        // run the request into its own expiry sweep.
        mineWhileWaiting: { perPoll: 1, maxBlocks: widenArithmetic(DEADLINE_BLOCKS).safeCap },
    })
}

/** Both v1 rows exist: the refused chain row and the applied mirror row. */
async function awaitBothV1Rows (ctx, requestId) {
    const venue = ctx.venue
    // Waiting for the applied one is waiting for a v1 with a
    // NULL transaction position, because the chain row is a v1 too.
    const settled = await untilOrClearDogeStall(async () => {
        await regtestMinerConnector.generateBlocks(1)
        const perIndexer = []
        for (const ix of venue.indexers) perIndexer.push(await readResponseRows(venue, ix.index, requestId))
        const ok = perIndexer.every((rows) =>
            rows.some((r) => r.tx_index === null) && rows.some((r) => r.tx_index !== null))
        return { ok: ok, perIndexer: perIndexer }
    }, { timeoutMs: 15 * 60 * 1000, intervalMs: 3000, tipProbe: venueTipProbe(venue, 0) })
    assert.ok(settled.ok,
        'the two v1 rows this case needs did not both appear on both indexers. Rows seen: ' +
        jsonSafe((settled.perIndexer || []).map((rows) =>
            rows.map((r) => ({ action: r.action_index, tx: r.tx_index, verdict: r.verdict })))) +
        '\n' + venue.logTail('indexer0'))
    return settled
}

/** The refused chain row on one indexer. */
function assertRefusedChainRow (ix, onChain) {
    // THE GATE. The exact string, because it is a stored verdict a replay
    // re-derives; and asserting it exactly is also what rules out the
    // rejection having come from the deliberately fake signatures, which
    // would read as a different string entirely.
    assert.strictEqual(String(onChain[0].verdict), MIRROR_ERA_VERDICT,
        'indexer ' + ix.index + ' recorded the on-chain v1 as "' + onChain[0].verdict +
        '" rather than "' + MIRROR_ERA_VERDICT + '". Above the height the chain handler must refuse ' +
        'it before every other request-derived branch, or a stale hub double-delivers.')
    assert.strictEqual(onChain[0].validator_signatures, null,
        'indexer ' + ix.index + ' stored signatures for a refused on-chain v1')
    assert.strictEqual(onChain[0].callback_execute_action_index, null,
        'indexer ' + ix.index + ' fired a callback from the REFUSED on-chain v1, which is the ' +
        'double-delivery this gate exists to prevent')
}

/** The mirror row still lands on one indexer, and the request is fulfilled. */
async function assertMirrorStillLands (ctx, ix, applied, requestId) {
    // AND THE MIRROR STILL LANDS. The refusal must not consume the request.
    assert.ok(applied[0].callback_execute_action_index !== null,
        'indexer ' + ix.index + ' applied the mirror row without injecting a callback')
    assert.strictEqual(String(applied[0].response_payload), FIXED_BODY,
        'indexer ' + ix.index + ' applied a body other than the one the provider served')

    // request-row-wait-ok: the caller already waited for every indexer to commit request.blockIndex.
    const req = await readRequestRow(ctx.venue, ix.index, requestId)
    assert.strictEqual(String(req.request_status), 'fulfilled',
        'indexer ' + ix.index + ' left the request ' + req.request_status +
        ' after the mirror row applied')
}

async function assertGateOnEveryIndexer (ctx, settled, requestId) {
    for (const ix of ctx.venue.indexers) {
        const rows    = settled.perIndexer[ix.index]
        const onChain = rows.filter((r) => r.tx_index !== null)
        const applied = rows.filter((r) => r.tx_index === null)
        assertRefusedChainRow(ix, onChain)
        await assertMirrorStillLands(ctx, ix, applied, requestId)
    }
    const state = await readContractState(ctx.venue, 0, ctx.contract.contractIndex)
    assert.strictEqual(JSON.parse(state.callback_status), 'ok',
        'the callback did not fire from the mirror row (status ' + state.callback_status + ')')
}

/** The escrow read back from the local request row; refuses a fee-less request. */
async function readEscrow (ctx, requestId) {
    // request-row-wait-ok: the caller already waited for every indexer to commit request.blockIndex.
    const local = await readRequestRow(ctx.venue, 0, requestId)
    const escrow = String(local.fee_amount)
    assert.ok(mathjs.bignumber(escrow).gt(mathjs.bignumber('0')),
        'this request escrowed no fee (' + escrow + '), so the split assertions below would pass ' +
        'trivially and prove nothing about the retired carve-out')
    return { local: local, escrow: escrow }
}

/** No attest_bcast row exists, and attest_fee rows exist. Returns the fee rows. */
async function assertNoBcastAndFees (ctx, ix, local, requestId) {
    const rewards = await readAttestRewards(ctx.venue, ix.index, { roundReference: Number(local.action_index) })
    const bcast   = rewards.filter((r) => String(r.reward_type) === 'attest_bcast')
    const fees    = rewards.filter((r) => String(r.reward_type) === 'attest_fee')

    // NOT WRITTEN AT ALL is the claim, and zero is not a cardinality claim
    // about any roster: it is the absence of a row type.
    assert.deepStrictEqual(bcast, [],
        'indexer ' + ix.index + ' wrote ' + bcast.length + ' attest_bcast row(s) for a mirror-era ' +
        'request. Nobody broadcasts above the height, so the reimbursement is retired and the row ' +
        'type must not appear: ' + jsonSafe(bcast))

    const rawRewards = fees.length > 0 ? '' : await rawAttestRewards(ctx.venue, ix.index)
    assert.ok(fees.length > 0,
        'indexer ' + ix.index + ' paid no attest_fee at all, so the escrow went nowhere\n' +
        feeLines(ctx.venue, 'indexer' + ix.index) + '\n' + rawRewards +
        '\n  drill scoped on round_reference ' + Number(local.action_index) +
        ' (v0 action of ' + String(requestId).slice(0, 12) + ')')
    return fees
}

/** The amounts paid add back up to the escrow, less only the floor remainder. */
function assertEscrowSplit (ix, fees, escrow) {
    // THE WHOLE ESCROW. Deliberately expressed as a residual rather than as
    // an expected per-signer amount: the number of payees comes from the
    // responsible set the indexer recomputed, which is not this drill's to
    // predict, so the drill divides by the count it actually found.
    const paid = fees.reduce((acc, r) => acc.add(mathjs.bignumber(String(r.amount))),
        mathjs.bignumber('0'))
    const residual = mathjs.bignumber(escrow).sub(paid)
    const dust = mathjs.bignumber(String(fees.length)).mul(mathjs.bignumber('1e-' + FEE_DECIMALS))
    assert.ok(residual.gte(mathjs.bignumber('0')),
        'indexer ' + ix.index + ' paid ' + paid.toString() + ' out of an escrow of ' + escrow +
        ', which is MORE than was escrowed')
    assert.ok(residual.lt(dust),
        'indexer ' + ix.index + ' paid ' + paid.toString() + ' of the ' + escrow + ' escrow across ' +
        fees.length + ' attest_fee rows, leaving ' + residual.toString() + ' behind. The only ' +
        'shortfall the split may leave is the floor remainder, under ' + dust.toString() +
        '. Anything larger means a carve-out was still taken out of the pool, which is exactly what ' +
        'the flag day retires.')
    console.log('AT6: indexer ' + ix.index + ' split ' + paid.toString() + ' of ' + escrow +
        ' across ' + fees.length + ' attest_fee rows, no attest_bcast')
}

async function assertMoney (ctx, requestId) {
    // ---- the money ----------------------------------------------------
    const { local, escrow } = await readEscrow(ctx, requestId)
    for (const ix of ctx.venue.indexers) {
        const fees = await assertNoBcastAndFees(ctx, ix, local, requestId)
        assertEscrowSplit(ix, fees, escrow)
    }
}

async function refusesOnChainV1AndSettles (ctx) {
    const request = await emitRequest(ctx,
        'the EXECUTE that emits the request came back ', 'at6 first')
    const requestId = request.requestId
    const venue = ctx.venue

    await buryAndAwaitMirror(ctx, request, async () => {
        for (const ix of venue.indexers) await waitForHeightWithClear(venue, ix.index, request.blockIndex)
    })

    // THE STALE BROADCAST, while the request is still pending, which is the only
    // moment at which accepting it would double-deliver.
    await broadcastStaleOnChainResponse(ctx, requestId, 'pending')

    const settled = await awaitBothV1Rows(ctx, requestId)
    await assertGateOnEveryIndexer(ctx, settled, requestId)
    await assertMoney(ctx, requestId)
}

/** Wait for the second request to reach fulfilled before the stale broadcast. */
async function awaitFulfilled (ctx, requestId) {
    // Let it reach a terminal state FIRST this time.
    const done = await untilOrClearDogeStall(async () => {
        await regtestMinerConnector.generateBlocks(1)
        // request-row-wait-ok: the caller already waited for every indexer to commit request.blockIndex.
        const req = await readRequestRow(ctx.venue, 0, requestId)
        return { ok: !!req && String(req.request_status) === 'fulfilled', req: req }
    }, { timeoutMs: 15 * 60 * 1000, intervalMs: 3000, tipProbe: venueTipProbe(ctx.venue, 0) })
    assert.ok(done.ok, 'the second request never reached fulfilled: ' +
        jsonSafe(done.req) + '\n' + ctx.venue.logTail('indexer0'))
}

async function awaitChainV1Row (ctx, requestId) {
    const seen = await untilOrClearDogeStall(async () => {
        await regtestMinerConnector.generateBlocks(1)
        const rows = await readResponseRows(ctx.venue, 0, requestId)
        return { ok: rows.some((r) => r.tx_index !== null), rows: rows }
    }, { timeoutMs: 10 * 60 * 1000, intervalMs: 3000, tipProbe: venueTipProbe(ctx.venue, 0) })
    assert.ok(seen.ok, 'the second on-chain v1 never appeared on the venue indexer')
    return seen
}

function assertSameReason (onChain) {
    assert.strictEqual(String(onChain.verdict), MIRROR_ERA_VERDICT,
        'the refusal for an already-fulfilled mirror-era request reads "' + onChain.verdict +
        '". It must still be the flag-day reason: the gate is deliberately the FIRST request-derived ' +
        'branch so that one wire gets one stored verdict regardless of the request\'s incidental state.')
    assert.ok(!String(onChain.verdict).startsWith(ALREADY_VERDICT_PREFIX),
        'the already-terminal branch answered first, which makes the stored verdict depend on timing')
    console.log('AT6: a second on-chain v1 against a fulfilled request also reads ' + MIRROR_ERA_VERDICT)
}

async function refusesForSameReasonWhenFulfilled (ctx) {
    // The ordering half, and it is cheap now that a fulfilled mirror-era request
    // exists. Every request-derived branch below the gate also rejects, so an
    // ordering fault could not admit the action; what it WOULD do is record a
    // different reason for the same wire depending on the request's incidental
    // state, and the reason is consensus. This case is what notices that.
    const request = await emitRequest(ctx, 'the second EXECUTE came back ', 'at6 second')
    const requestId = request.requestId

    await buryAndAwaitMirror(ctx, request,
        () => waitForHeightWithClear(ctx.venue, 0, request.blockIndex))
    await awaitFulfilled(ctx, requestId)
    await broadcastStaleOnChainResponse(ctx, requestId, 'fulfilled')

    const seen = await awaitChainV1Row(ctx, requestId)
    assertSameReason(seen.rows.filter((r) => r.tx_index !== null)[0])
}

module.exports = { refusesOnChainV1AndSettles, refusesForSameReasonWhenFulfilled }
