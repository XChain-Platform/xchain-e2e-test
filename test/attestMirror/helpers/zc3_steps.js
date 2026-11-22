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
 * ZC3 steps: issuing the request, reading the draw, stopping the victim and
 * waiting for the signed, applied result. The drill itself lives in
 * zc3_headroom.test.js.
 ********************************************************************/

const {
    APPLIED_FIELDS, diffRows,
    waitForMirrorRowEverywhere, waitForAppliedEverywhere,
    waitForHeightWithClear, readRequestRow, findEmittedAttestRequest, attestRequestWatermark,
    clearBeforeBroadcast, settleOrReport,
} = require('./mirrorDrillWaits')
const { mineWhile } = require('./mirrorDrillFixture')
const { REDUNDANCY } = require('./zc3_fixture')
const vmHelper = require('../../helpers/vmHelper')

async function issueRequest (ctx) {
    const sinceAction = await attestRequestWatermark(ctx.contract.contractIndex)
    await clearBeforeBroadcast()
    const exec = await mineWhile(() => vmHelper.sendExecuteV0(
        ctx.contract.owner, ctx.contract.contractIndex, 'ask', ['http_get', ctx.testUrl]))
    return { exec, sinceAction, requestVisibleAtMs: Date.now() }
}

async function readDraw (ctx, sinceAction) {
    const venue     = ctx.venue
    const request   = await findEmittedAttestRequest(
        ctx.contract.contractIndex, sinceAction + 1, { label: 'zc3' })
    const requestId = request.requestId
    await settleOrReport('zc3')

    // ---- the draw, AFTER the request is mined -----------------------------
    //
    // Read from a hub rather than re-ranked here: `getattestationresponsibleset`
    // resolves the capability snapshot, the provider floor and the widening step
    // through the hub's own engines, so it cannot drift from what a live round
    // does. It answers for PENDING requests only, which is exactly the window this
    // drill has to act inside.
    let draw = null
    let drawFrom = null
    for (const hub of venue.hubs) {
        const got = await venue.responsibleSetFromHub(hub.index, requestId)
        if (!got.error) { draw = got; drawFrom = hub.index; break }
    }
    return { request, requestId, draw, drawFrom }
}

function selectVictim (ctx, draw) {
    // THE HEADROOM SLOT IS PRESENT, and this is the precondition the rest rests on.
    // Above the zero-conf height V2 returns `headroom` at elapsed 0 rather than 0
    // (§4.1, D27), so the set is redundancy + 1 from the request's own block. If it
    // were redundancy, stopping a member would leave two live signers and no round
    // could finalize at all: the failure would look like a mirror fault and would
    // in fact be a missing ladder.

    // Rank 1: inside the first `redundancy` slots so the headroom member is what
    // supplies the third signature, and not rank 0, which is the leader at step 0.
    const victimKey = draw.responsible[1]
    const victimHub = ctx.venue.hubIndexForPubkey(victimKey)
    return { victimKey, victimHub }
}

function readRoundStart (tail, requestId, requestVisibleAtMs) {
    const tailAvailable = typeof tail === 'string' && tail.trim().length > 0 &&
        !/^\s*last 0 line\(s\) from /.test(tail)
    const marker = 'AttestationRound: starting ' + requestId.slice(0, 16) + '...'
    const roundStartLine = tailAvailable
        ? tail.split('\n').find((line) => line.includes(marker)) || null
        : null
    const roundStartAtMs = roundStartLine ? Date.parse(roundStartLine.trim().split(/\s+/, 1)[0]) : NaN
    const gapMs = Number.isFinite(roundStartAtMs) ? roundStartAtMs - requestVisibleAtMs : null
    return { tailAvailable, roundStartLine, gapMs }
}

async function stopVictim (ctx, victimHub, victimKey, requestId, requestVisibleAtMs) {
    await ctx.venue.stopHub(victimHub)
    ctx.stoppedHub = victimHub
    console.log('ZC3: stopped hub ' + victimHub + ' (' + victimKey.slice(0, 16) + '...), rank 1 of the draw')

    // THE PRECONDITION, ASSERTED. "Stopped AFTER the draw, before it served" is the
    // whole construction, and a poll that fired first would quietly turn this into a
    // round that four members ran and three finished, which is a different claim.
    // The round-start line is written once per started round on a responsible hub,
    // so its absence on the victim is the evidence.
    const tail = ctx.venue.logTail('hub' + victimHub)
    const { tailAvailable, roundStartLine, gapMs } = readRoundStart(tail, requestId, requestVisibleAtMs)

    // An unavailable tail cannot prove absence. Treat it as a violated window so
    // the retry either obtains observable evidence or exhausts loudly.
    return {
        victimStarted: !tailAvailable || roundStartLine !== null,
        tailAvailable,
        roundStartLine,
        gapMs,
    }
}

function victimAttemptEvidence (attempt, requestId, victimHub, requestVisibleAtMs, observation) {
    const prefix = 'attempt ' + attempt + ' request ' + requestId.slice(0, 16) +
        '... hub ' + victimHub + ': '
    if (!observation.tailAvailable) {
        return prefix + 'log tail unavailable; request observed at ' +
            new Date(requestVisibleAtMs).toISOString() + ', round-start gap not measurable'
    }
    if (!observation.roundStartLine) {
        return prefix + 'no round-start line; request observed at ' +
            new Date(requestVisibleAtMs).toISOString()
    }
    return prefix + 'round-start gap ' + observation.gapMs + 'ms (request observed ' +
        new Date(requestVisibleAtMs).toISOString() + ', round started ' +
        new Date(requestVisibleAtMs + observation.gapMs).toISOString() + ')'
}

async function waitForSignedResult (ctx, requestId, draw) {
    // ---- the round finalizes without it -----------------------------------
    const mirrorRows = await waitForMirrorRowEverywhere(ctx.venue, requestId, 15 * 60 * 1000, {
        // The ladder is height-driven, so a still chain never climbs it. Capped well
        // inside the first segment: this drill's whole claim is that no climbing is
        // needed, and mining past the segment would let a LATER slot rescue the round
        // and pass for the wrong reason.
        mineWhileWaiting: { perPoll: 1, maxBlocks: 4 },
    })

    // EXACTLY REDUNDANCY VALID SIGNATURES. Not "at least": the indexer's verifier
    // admits `validSigs >= redundancy`, and the interesting number is how many the
    // federation could actually produce with one drawn member dark. Three is the
    // arithmetic §4.4 states (quorum is measured on the PRE-widening size, so
    // needed stays at redundancy); four would mean the stopped hub signed anyway.
    let signers = mirrorRows[0].signer_pubkeys
    if (typeof signers === 'string') signers = JSON.parse(signers)
    signers = signers.map((s) => String(s).toLowerCase())

    // THE HEADROOM MEMBER IS ONE OF THEM. This is what makes the case about §4.1
    // rather than about a three-member set that happened to have three live hubs:
    // without the widened slot the third signature has nowhere to come from.
    const headroomKey = String(draw.responsible[REDUNDANCY]).toLowerCase()
    const drawn = new Set(draw.responsible.map((p) => String(p).toLowerCase()))
    const strays = signers.filter((s) => !drawn.has(s))
    return { mirrorRows, signers, headroomKey, strays }
}

async function applyResult (ctx, requestId) {
    // ---- and binds at the same block on both indexers ---------------------
    const applied = await waitForAppliedEverywhere(ctx.venue, requestId, 15 * 60 * 1000, {
        // The applier runs in the block loop, so on a chain nobody is mining a
        // delivered, valid, applicable response is never applied. Capped inside the
        // first segment for the same reason as above.
        mineWhileWaiting: { perPoll: 1, maxBlocks: 6 },
    })
    const diffs = diffRows(applied[0], applied[1], APPLIED_FIELDS)
    return { applied, diffs }
}

async function bindingWindow (ctx, request, applied) {
    await waitForHeightWithClear(ctx.venue, 0, request.blockIndex)
    const local        = await readRequestRow(ctx.venue, 0, request.requestId)
    const requestBlock = Number(local.block_index)
    const deadline     = Number(local.deadline_block)
    const bindBlock    = Number(applied[0].block_index)

    // ladder starts at the REQUEST's own block above the height (startOffset 0), the
    // span runs to the deadline, and the segment is span / (maxSlots + 1). Below the
    // height it started at request + 3 and the first widen arrived a segment later,
    // which is the six-block wait measured on the public testnet. Spelled here rather than taken
    // from `widenArithmetic`, which computes the STAGE-1 geometry and would give a
    // different, wrong boundary.
    const span    = deadline - requestBlock
    const segment = span / 3
    const cutoff  = requestBlock + segment
    return { requestBlock, deadline, bindBlock, span, cutoff }
}

module.exports = {
    issueRequest, readDraw, selectVictim, stopVictim, victimAttemptEvidence,
    waitForSignedResult, applyResult, bindingWindow,
}
