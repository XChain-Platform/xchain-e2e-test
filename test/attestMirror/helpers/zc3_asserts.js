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
 * ZC3 drill logic: the victim-window attempts and the signer, binding and
 * first-segment assertions. The drill itself lives in zc3_headroom.test.js.
 ********************************************************************/

const assert = require('assert')

const { allHubTails, jsonSafe } = require('./mirrorDrillWaits')
const {
    POLL_MS, VICTIM_WINDOW_ATTEMPTS, FOLLOWED_REDRAW_ATTEMPTS, REDUNDANCY,
} = require('./zc3_fixture')
const {
    issueRequest, readDraw, selectVictim, stopVictim, victimAttemptEvidence,
    waitForSignedResult, applyResult, bindingWindow,
} = require('./zc3_steps')

function assertDrawShape (ctx, draw, requestId, drawFrom) {
    assert.ok(draw, 'no venue hub could resolve the responsible set for ' + requestId +
        ' while it was pending\n' + allHubTails(ctx.venue))
    console.log('ZC3: hub ' + drawFrom + ' drew ' + jsonSafe(draw.responsible.map((p) => p.slice(0, 16))) + ' (redundancy ' + draw.redundancy + ', widen ' + draw.widen + ') for request ' + requestId.slice(0, 12))
    assert.strictEqual(draw.widen, 1,
        'the draw carries widen ' + draw.widen + ' rather than 1. At the request\'s own block ' + 'the V2 ladder returns its headroom slot and nothing more, so 0 means the stage-2 early ' + 'return is not armed and 2 or more means blocks went by before the draw was read.')
    assert.strictEqual(draw.responsible.length, REDUNDANCY + 1,
        'the responsible set holds ' + draw.responsible.length + ' member(s) rather than ' + (REDUNDANCY + 1) + ' (redundancy ' + REDUNDANCY + ' plus one headroom slot): ' + jsonSafe(draw.responsible.map((p) => p.slice(0, 16))))
}

// One fresh request: issue it, read and check its draw, pick the rank-1 victim.
async function drawFreshRequest (ctx, st) {
    const { exec, sinceAction, requestVisibleAtMs } = await issueRequest(ctx)
    assert.strictEqual(exec.execution.status, 'valid',
        'the EXECUTE that emits the request came back ' + exec.execution.status)
    const read = await readDraw(ctx, sinceAction)
    st.requestId = read.requestId
    st.request = read.request
    st.draw = read.draw
    assertDrawShape(ctx, st.draw, st.requestId, read.drawFrom)
    const selected = selectVictim(ctx, st.draw)
    st.victimKey = selected.victimKey
    st.victimHub = selected.victimHub
    assert.ok(st.victimHub >= 0,
        'the drawn member at rank 1 (' + st.victimKey.slice(0, 16) + '...) belongs to no venue hub. ' + 'The venue adopts the roster precisely so every drawn key has a live hub here.')
    return requestVisibleAtMs
}

// True when the draw must be thrown away because a venue indexer follows the victim.
function discardedAsFollowed (ctx, st) {
    if (!ctx.venue.indexers.some((ix) => ix.followsHub === st.victimHub)) return false
    assert.ok(++st.redraws <= FOLLOWED_REDRAW_ATTEMPTS, 'ZC3 drew ' + st.redraws + ' requests (across all window attempts) whose rank 1 is a hub a venue indexer follows; stopping it would starve that indexer\'s mirror')
    console.log('ZC3: discarded request ' + st.requestId.slice(0, 12) + ' before stopping anything: rank 1 is hub ' + st.victimHub + ', which a venue indexer follows (redraw ' + st.redraws + ')')
    return true
}

// Returns 'redraw' (same attempt again), 'stop' (window constructed) or 'next'.
async function runVictimAttempt (ctx, st, attempt) {
    const requestVisibleAtMs = await drawFreshRequest(ctx, st)
    if (discardedAsFollowed(ctx, st)) return 'redraw'
    const observation = await stopVictim(
        ctx, st.victimHub, st.victimKey, st.requestId, requestVisibleAtMs)
    st.victimStarted = observation.victimStarted
    st.victimAttempts.push(victimAttemptEvidence(
        attempt, st.requestId, st.victimHub, requestVisibleAtMs, observation))
    if (!st.victimStarted) return 'stop'
    if (attempt < VICTIM_WINDOW_ATTEMPTS) {
        await ctx.venue.startHub(st.victimHub)
        ctx.stoppedHub = null
        console.log('ZC3: discarded request ' + st.requestId.slice(0, 12) +
            ' after its victim started; hub ' + st.victimHub +
            ' is back for fresh attempt ' + (attempt + 1))
    }
    return 'next'
}

async function constructVictimWindow (ctx) {
    const st = {
        requestId: null, draw: null, request: null, victimKey: null, victimHub: null,
        victimStarted: true, victimAttempts: [], redraws: 0,
    }
    for (let attempt = 1; attempt <= VICTIM_WINDOW_ATTEMPTS; attempt++) {
        const outcome = await runVictimAttempt(ctx, st, attempt)
        if (outcome === 'redraw') { attempt--; continue }
        if (outcome === 'stop') break
    }

    assert.strictEqual(st.victimStarted, false,
        'ZC3 exhausted ' + VICTIM_WINDOW_ATTEMPTS + ' fresh request attempts without constructing ' +
        'a victim window at poll interval ' + POLL_MS + 'ms. A selected victim had already ' +
        'started its request, or its log tail was unavailable, so it cannot prove a member that ' +
        'never signed. ' + st.victimAttempts.join('; ') + '\n' + ctx.venue.logTail('hub' + st.victimHub))
    return st
}

function assertSigners (ctx, st, result) {
    const { mirrorRows, signers, headroomKey, strays } = result
    for (const [i, row] of mirrorRows.entries()) {
        assert.strictEqual(String(row.status), 'ok',
            'the mirror row on indexer ' + i + ' carries status ' + row.status +
            ' rather than ok, so the round finalized a non-ok outcome')
    }
    assert.strictEqual(signers.length, REDUNDANCY,
        'the finalized row carries ' + signers.length + ' signature(s) rather than exactly ' +
        REDUNDANCY + ': ' + jsonSafe(signers.map((s) => s.slice(0, 16))) + '\n' + allHubTails(ctx.venue))
    assert.ok(!signers.includes(String(st.victimKey).toLowerCase()),
        'the stopped hub\'s key ' + st.victimKey.slice(0, 16) + '... signed the row, so it was not ' +
        'actually dark and the round did not have to reach past it')
    assert.ok(signers.includes(headroomKey),
        'the headroom member ' + headroomKey.slice(0, 16) + '... did not sign, so the three ' + 'signatures came from somewhere other than the widened slot: ' + jsonSafe(signers.map((s) => s.slice(0, 16))))
    // Every signer was drawn. A signature from outside the set is refused by the
    // verifier, so a row carrying one would be inert and this drill would be
    // asserting against a row no node can admit.
    assert.deepStrictEqual(strays, [],
        'the row carries signature(s) from outside the responsible set: ' +
        jsonSafe(strays.map((s) => s.slice(0, 16))))
}

async function assertSignedResult (ctx, st) {
    const result = await waitForSignedResult(ctx, st.requestId, st.draw)
    assertSigners(ctx, st, result)
    return result.signers
}

async function assertBoundInFirstSegment (ctx, st, signers) {
    const { applied, diffs } = await applyResult(ctx, st.requestId)
    assert.deepStrictEqual(diffs, [],
        'the two indexers bound the response differently: ' + diffs.join('; ') +
        '. The applier is deterministic by construction, so a difference here is a fork between ' +
        'two nodes reading the same mirror row.')
    // THE FIRST LADDER SEGMENT, computed from the V2 shape the spec states: the
    const window = await bindingWindow(ctx, st.request, applied)
    const { requestBlock, deadline, bindBlock, span, cutoff } = window
    assert.ok(bindBlock < cutoff,
        'the response bound at block ' + bindBlock + ', at or past the end of the first ladder ' +
        'segment (' + requestBlock + ' + ' + span + '/3 = ' + cutoff.toFixed(2) + '). Inside the ' +
        'first segment is the point: headroom makes a round with one dark member finalize with no ' +
        'clock at all, and a bind past the cutoff means it waited for the ladder to open a slot ' +
        'instead, which is exactly the delay this spec removes.')
    console.log('ZC3 GREEN: hub ' + st.victimHub + ' dark, round finalized with ' + signers.length + ' signature(s) including the headroom member, bound at ' + bindBlock + ' on both indexers (request ' + requestBlock + ', deadline ' + deadline + ', first segment ends ' + cutoff.toFixed(2) + ')')
}

module.exports = { constructVictimWindow, assertSignedResult, assertBoundInFirstSegment }
