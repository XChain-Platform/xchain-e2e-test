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
 * ZC1 driven case steps, second half: the mirror row, the measurement, and the
 * N+1 bind. Each step takes `ctx` and the shared `st` object from zc1_steps.js.
 ********************************************************************/

const assert = require('assert')

const {
    until, untilOrClearDogeStall, waitForMirrorRowEverywhere,
    readAppliedResponse, readContractState, readBlockWindow,
    venueTipProbe, settleOrReport, waitForHeightWithClear,
    allHubTails, jsonSafe,
} = require('./mirrorDrillWaits')
const { FIXED_BODY, POLL_MS, FORWARD_S, MIRRORED_WITHIN_S } = require('./zc1_fixture')

/** (b) the mirror row is readable on both indexers and served by a hub route. */
async function assertMirrorReadable (ctx, st) {
    const venue = ctx.venue
    const requestId = st.requestId
    // NEVER OFF A HUB LOG LINE. The live testnet finalize on 2026-09-07 logged
    // no insert and no gossip line at all and the row simply appeared on the
    // snapshot route (measured on the public testnet, 2026-09-07), so a drill keyed on a log line would
    // have reported a working mirror as broken.
    st.mirrorRows = await waitForMirrorRowEverywhere(venue, requestId)
    for (const [i, row] of st.mirrorRows.entries()) {
        assert.strictEqual(String(row.status), 'ok',
            'the mirror row on indexer ' + i + ' carries status ' + row.status +
            ', so the round finalized a NON-OK outcome rather than failing to deliver. ' +
            'provider_error means the fetch itself failed and the hub logs say why.')
    }

    // AND ON THE HUB'S OWN ROUTE, which is the surface §10 names. Read through
    // the route rather than the hub table: the venue's claim is that these hubs
    // SERVE the mirror, and a table read would pass on a hub whose HTTP surface
    // never came up.
    const servedBy = []
    for (const hubIndex of st.responsibleHubs) {
        const snap = await venue.hubSnapshot(hubIndex, { limit: 1000 })
        const rows = (snap && snap.rows) || []
        if (rows.some((r) => String(r.request_id).toLowerCase() === requestId)) servedBy.push(hubIndex)
    }
    assert.ok(servedBy.length > 0,
        'no responsible hub serves a row for ' + requestId + ' on ' +
        '/hub-db/snapshot/attestation_responses, even though both indexers hold one. The ' +
        'route is the surface an indexer bootstraps from, so a row present in the table ' +
        'and absent from the route is a mirror that cannot recover a follower.')
}

/** The mined-to-mirrored seconds, measured off the hubs' own finalized_at. */
async function assertMinedToMirrored (ctx, st) {
    const venue = ctx.venue
    const requestId = st.requestId
    const N = st.N
    // MEASURED OFF `finalized_at`, NOT OFF WHEN THIS DRILL LOOKED. The wall
    // clock at the first observation is a measurement of the drill's own
    // polling: everything above (the draw read, the log wait) happens between
    // the block and the look, so a first-sight figure would charge the hub for
    // the harness's time and could fail a 15 s bound on a 4 s round.
    // `finalized_at` is the hub's own clock at quorum and is written by
    // AttestationResponseMirror at insert, which is the moment the row became
    // readable on that hub.
    const hubRows = []
    for (const hubIndex of st.responsibleHubs) {
        const rows = await venue.hubMirrorRows(hubIndex, { requestId: requestId })
        if (rows.length > 0) hubRows.push({ hub: hubIndex, finalized_at: Number(rows[0].finalized_at) })
    }
    assert.ok(hubRows.length > 0,
        'no responsible hub holds a row for ' + requestId + ' in its own table, so the ' +
        'mined-to-mirrored measurement has no source')
    const firstFinalized = Math.min(...hubRows.map((h) => h.finalized_at))
    st.minedToMirrored = firstFinalized - st.minedAt
    console.log('ZC1 MEASUREMENT: mined-to-mirrored ' + st.minedToMirrored + ' s ' +
        '(block ' + N + ' stamped ' + st.minedAt + ', first hub row at ' + firstFinalized +
        ', poll ' + POLL_MS + ' ms, per-hub ' + jsonSafe(hubRows) + ')')
    assert.ok(st.minedToMirrored >= 0 && st.minedToMirrored <= MIRRORED_WITHIN_S,
        'the mirror row appeared ' + st.minedToMirrored + ' s after block ' + N +
        ', outside the ' + MIRRORED_WITHIN_S + ' s ZC1 allows. At the ' + POLL_MS +
        ' ms poll the budget is one poll plus the provider fetch plus consensus plus the ' +
        'insert; a figure far above it means the hub is still waiting on confirmations, ' +
        'and a NEGATIVE one means the block stamp is ahead of the hubs\' clocks.\n' +
        allHubTails(venue))
}

/** (c) hold the chain until the signed stamp has passed, then mine N+1. */
async function mineBindBlock (ctx, st) {
    const effectiveTime = Number(st.mirrorRows[0].effective_time)
    st.effectiveTime = effectiveTime
    assert.ok(Number.isInteger(effectiveTime) && effectiveTime > 0,
        'the mirror row carries no usable effective_time (' + st.mirrorRows[0].effective_time + ')')

    // HOLD THE CHAIN UNTIL THE STAMP HAS PASSED, and wait on that CONDITION
    // rather than for a fixed duration: the margin is signed by the leader and
    // the drill does not know when the round finished, so a fixed sleep would
    // be right only by luck. Regtest stamps a block at about wall clock now,
    // so a clock past the stamp is what makes the next block satisfy it. This
    // is the mainnet geometry reproduced: there, the next block arrives long
    // after the stamp on its own.
    console.log('ZC1: effective_time ' + effectiveTime + ', holding the chain until the ' +
        'clock passes it before mining N+1')
    const passed = await until(async () => {
        const now = Math.floor(Date.now() / 1000)
        return { ok: now > effectiveTime, now: now }
    }, 5 * 60 * 1000, 1000)
    assert.ok(passed.ok,
        'the wall clock never passed the signed effective_time ' + effectiveTime +
        ' (reached ' + (passed && passed.now) + '). The forward margin is ' + FORWARD_S +
        ' s, so a stamp minutes into the future means the leader\'s clock is far ahead of ' +
        'this box and no block mined here could ever satisfy it.')

    await regtestMinerConnector.generateBlocks(1)
    const tipNow = Number(await nodeConnector.getBlockCount())
    assert.strictEqual(tipNow, st.N + 1,
        'mining one block left the chain at ' + tipNow + ' rather than ' + (st.N + 1) +
        '; something else is producing blocks on this chain and the drill is not exclusive')
    await settleOrReport('zc1')
}

/** The callback bound at N+1 on both indexers. */
async function assertBoundAtNext (ctx, st) {
    const venue = ctx.venue
    const N = st.N
    for (const ix of venue.indexers) await waitForHeightWithClear(venue, ix.index, N + 1)

    const bound = await untilOrClearDogeStall(async () => {
        const rows = []
        for (const ix of venue.indexers) rows.push(await readAppliedResponse(venue, ix.index, st.requestId))
        return { ok: rows.every((r) => r && Number(r.block_index) === N + 1), rows: rows }
    }, { timeoutMs: 10 * 60 * 1000, intervalMs: 2000, tipProbe: venueTipProbe(venue, 0) })
    assert.ok(bound.ok,
        'the callback did not bind at ' + (N + 1) + ' on both indexers; they hold ' +
        jsonSafe((bound.rows || []).map((r) => (r ? Number(r.block_index) : null))) + '. ' +
        'N+1 is the FLOOR and this spec reaches it: the row cannot bind inside N itself ' +
        '(it does not exist when N is processed), and it must not need a second block, ' +
        'which is what a hub still waiting on confirmations would produce.\n' +
        venue.logTail('indexer0') + '\n' + venue.logTail('indexer1'))
}

/** The binding block is past the stamp and the callback carried the body. */
async function assertBindEvidence (ctx, st) {
    const N = st.N
    // The binding block's own time is past the signed stamp, which is the rule
    // the applier applies. Asserted so a pass cannot come from an applier that
    // ignores effective_time and binds at whatever block runs next.
    const window = await readBlockWindow(ctx.venue, 0, N, N + 1)
    const bindBlock = window.find((b) => Number(b.block_index) === N + 1)
    assert.ok(bindBlock && Number(bindBlock.block_time) >= st.effectiveTime,
        'block ' + (N + 1) + ' is stamped ' + (bindBlock && bindBlock.block_time) +
        ', which is NOT past the signed effective_time ' + st.effectiveTime +
        '. A bind there would mean the applier is not reading the stamp at all.')

    const state = await readContractState(ctx.venue, 0, ctx.contract.contractIndex)
    assert.strictEqual(JSON.parse(state.callback_status), 'ok',
        'the callback did not fire from the mirror row (status ' + state.callback_status + ')')
    assert.strictEqual(JSON.parse(state.callback_context), 'ctx-zc1')
    assert.strictEqual(JSON.parse(state.callback_payload), FIXED_BODY,
        'the callback payload is not the body the provider served')
}

module.exports = {
    assertMirrorReadable, assertMinedToMirrored, mineBindBlock, assertBoundAtNext, assertBindEvidence,
}
