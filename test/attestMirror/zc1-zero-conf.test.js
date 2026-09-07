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
 * ZC1, THE ZERO-CONFIRMATION FLIP. A request mined at block N is served at tip N,
 * and its callback binds at N+1.
 *
 * The spec's own test (zero-confirmation-flip §10 ZC1), driven here with the poll
 * default the fleet will run: an `http_get` request mined at N starts its round at
 * tip N on every responsible hub (`AttestationRound: starting <rid16>... tip=N
 * conf=0 widen=1`, D77), its mirror row is readable within 15 s of the block, and
 * the callback binds at N+1. Records mined-to-mirrored seconds.
 *
 * EXCLUSIVE ON THE SHARED REGTEST CHAIN, not merely serialized. This drill PAUSES
 * THE SHARED MINER for the whole of the driven case and mines two blocks by hand,
 * because "binds at N+1" is not a claim a drill can make on a chain something else
 * is advancing. Nothing else may run against this chain while it does.
 *
 * WHY THE MINER HAS TO BE PAUSED, stated so nobody removes it as fussiness. The
 * applier binds a response at the FIRST block whose protocol time is past the
 * signed `effective_time`, and `effective_time` is stamped `now + forwardS` by the
 * leader. On mainnet blocks are ten minutes apart and forwardS is 120 s, so the
 * next block is always past it and N+1 is the answer by construction. On regtest
 * the miner produces blocks every few seconds, so N+1 lands BEFORE the stamp, does
 * not satisfy it, and the response binds at N+2 or N+3 for a reason that has
 * nothing to do with what ZC1 is about. Pausing the miner and mining N+1 once the
 * stamp has passed reproduces the mainnet geometry rather than papering over it.
 *
 * WHAT THE POLL SETTING MEANS HERE, since the venue pins its own. `attestationPollMs`
 * is passed EXPLICITLY at 3000 (D8): the venue's resting default is 2000, and ZC1
 * measures the value the hub fleet will actually carry after this train
 * (`AttestationRound.DEFAULT_POLL_MS`, §3.3). A drill that inherited the venue's
 * faster poll would report a discovery latency no operator will ever see. The
 * option does reach a spawned hub: `xchain-hub/src/api.js:403` reads
 * ATTESTATION_POLL_MS into p2pConfig (D83).
 *
 * WALL-TIME BUDGET: about 30 minutes, nearly all of it the venue's two indexers
 * replaying the borrowed chain from genesis. The driven part is under two minutes.
 ********************************************************************/

const assert = require('assert')
const dotenv = require('dotenv')
dotenv.config()

const { AttestMirrorVenue } = require('../helpers/attestMirrorVenue')
const {
    provisionDrillIdentities, waitForVenueIndexersAtTip, startAttestTestServer, deployRequestContract,
} = require('./mirrorDrillFixture')
const {
    until, untilOrClearDogeStall, waitForMirrorRowEverywhere,
    readAppliedResponse, readContractState, readRequestRow, readBlockWindow,
    venueTipProbe, findEmittedAttestRequest, attestRequestWatermark,
    clearBeforeBroadcast, settleOrReport, waitForHeightWithClear,
    allHubTails, jsonSafe,
} = require('./mirrorDrillWaits')
const vmHelper = require('../helpers/vmHelper')

const FIXED_BODY = '{"score":7,"meta":"zc1-zero-conf"}'

// The fleet default this train ships (xchain-hub AttestationRound.DEFAULT_POLL_MS).
// Passed explicitly because the venue pins 2000 of its own (D8).
const POLL_MS = 3000

// The signed forward margin. Small so the drill closes in seconds, and it must stay
// ABOVE the venue's 2 s gossip-hop budget or `assertTimingInvariants` refuses the
// venue outright: a follower that receives a row after its own stamp has passed
// cannot verify the window it was signed under.
const FORWARD_S = 3

// The §10 bound on mined-to-mirrored. Generous against the §3.4 table's 3-to-15 s
// for `http_get`, and it is the whole point of the flip: at three confirmations the
// same measurement could not start for three blocks.
const MIRRORED_WITHIN_S = 15

// Long enough that nothing under test races the expiry sweep while the miner is
// paused, short enough that the ladder arithmetic stays readable.
const DEADLINE_BLOCKS = 60

const CONTRACT_CODE = `
module.exports = {
    ask: function(xchain) {
        var requestId = xchain.attestation.request(
            xchain.getInputParam(0),
            xchain.getInputParam(1),
            'handleResponse',
            ['ctx-zc1'],
            { redundancy: 3, deadlineBlocks: ${DEADLINE_BLOCKS} }
        );
        return requestId;
    },
    handleResponse: function(xchain) {
        xchain.state.set('callback_status',  xchain.getInputParam(2));
        xchain.state.set('callback_payload', xchain.getInputParam(3));
        xchain.state.set('callback_context', xchain.getInputParam(4));
    }
};
`

function sleep (ms) { return new Promise((r) => setTimeout(r, ms)) }

/**
 * Run `work` and mine AT MOST ONE block, and only once the mempool has something.
 *
 * `mineWhile` is the shared shape and it is the wrong one here: it mines every few
 * seconds for as long as the work is pending, so a confirm wait that takes a beat
 * longer than the interval leaves N+1 already on the chain before the round has even
 * started. This mines the one block the EXECUTE needs to confirm and then stops, so
 * the request block is the tip when the round runs, which is the state ZC1 asserts.
 */
async function mineOneBlockFor (work) {
    let settled = false
    const p = Promise.resolve(work()).finally(() => { settled = true })
    let mined = 0
    const miner = (async () => {
        while (!settled && mined < 1) {
            await sleep(1000)
            if (settled) break
            let pool = []
            try { pool = await nodeConnector.getRawMempool() } catch (_) { pool = [] }
            if (!pool || pool.length === 0) continue
            await regtestMinerConnector.generateBlocks(1)
            mined++
        }
    })()
    try { return await p } finally { await miner; }
}

describe('ZC1: a request mined at N is served at tip N and binds at N+1', function () {
    // Five hub processes, two indexers replaying from genesis, then one round.
    this.timeout(60 * 60 * 1000)

    let venue      = null
    let up         = false
    let testServer = null
    let testUrl    = null
    let contract   = null

    before(async function () {
        // REAL TLS, not http. The provider refuses a non-https payload before it does
        // any network work, so a plain-HTTP server resolves every round provider_error,
        // which reads downstream as a missing mirror row.
        testServer = await startAttestTestServer({ body: FIXED_BODY })
        testUrl    = testServer.url

        const staked = await provisionDrillIdentities({ label: 'zc1', count: 5, redundancy: 3 })
        venue = new AttestMirrorVenue({
            label: 'zc1', identities: staked.identities, hubExtraEnv: testServer.hubEnv,
            attestationPollMs: POLL_MS,
            forwardS: FORWARD_S,
        })
        up = await venue.start()
        if (!up) {
            console.log('ZC1 SKIPPED: ' + venue.unavailable)
            this.skip()
            return
        }

        // BEFORE ANY REQUEST. The venue's indexers replay the borrowed chain from
        // scratch, so at this point they are far behind the tip. A request made now
        // sits at a block they have not reached, and its response reads as "not
        // applied" when the node simply has not got there yet.
        await waitForVenueIndexersAtTip(venue)
        contract = await deployRequestContract({ label: 'zc1', code: CONTRACT_CODE })
    })

    after(async function () {
        // Said out loud rather than swallowed: a resume that genuinely fails leaves the
        // SHARED miner paused for every drill queued after this one.
        try { await regtestMinerConnector.resumeMining() } catch (e) {
            console.log('ZC1 teardown: resumeMining failed (' + (e && e.message) +
                '); the shared miner may still be paused')
        }
        if (testServer) await testServer.close()
        if (venue) await venue.stop()
    })

    it('starts the round at tip N with conf=0 widen=1, mirrors within 15 s, and binds at N+1',
        async function () {
            // Watermark FIRST: see attestRequestWatermark for why the execute's own
            // action index cannot be trusted as the correlation input.
            const sinceAction = await attestRequestWatermark(contract.contractIndex)
            await clearBeforeBroadcast()

            await regtestMinerConnector.pauseMining()
            try {
                const exec = await mineOneBlockFor(() => vmHelper.sendExecuteV0(
                    contract.owner, contract.contractIndex, 'ask', ['http_get', testUrl]))
                assert.strictEqual(exec.execution.status, 'valid',
                    'the EXECUTE that emits the request came back ' + exec.execution.status +
                    '. A responsible set smaller than redundancy is rejected at admission and rolls the ' +
                    'EXECUTE back, so this is the shape a short stake roster takes.')

                const request   = await findEmittedAttestRequest(
                    contract.contractIndex, sinceAction + 1, { label: 'zc1' })
                const requestId = request.requestId
                await settleOrReport('zc1')

                const local = await readRequestRow(venue, 0, requestId)
                assert.ok(local, 'the venue indexer holds no v0 request row for ' + requestId)
                const N = Number(local.block_index)

                // THE PRECONDITION THE WHOLE CASE RESTS ON. The miner is paused precisely
                // so that nothing lands between the request and its round, and a tip above
                // N means the confirm wait mined past it: the round would then start at a
                // tip that is not the request's block and "binds at N+1" would be a claim
                // about a block that already exists with a time before the stamp. Refused
                // rather than weakened, because a pass under those conditions says nothing.
                const tipAfterRequest = Number(await nodeConnector.getBlockCount())
                assert.strictEqual(tipAfterRequest, N,
                    'the chain sits at ' + tipAfterRequest + ' with the request at ' + N +
                    ', so a block landed between the request and its round even with the shared miner ' +
                    'paused. The EXECUTE confirm wait outran the one-block miner; re-run. ZC1 cannot ' +
                    'assert a bind at N+1 on a chain that already reached it.')

                const block = await nodeConnector.getBlock(await nodeConnector.getBlockHash(N))
                const minedAt = Number(block.time)

                // THE DRAW, taken while the request is still pending: only then does
                // `getattestationresponsibleset` answer at all. Full pubkeys, because the
                // line assertion below has to name a hub INDEX and only the whole key maps
                // back to one.
                let draw = null
                for (const hub of venue.hubs) {
                    const got = await venue.responsibleSetFromHub(hub.index, requestId)
                    if (!got.error) { draw = got; break }
                }
                assert.ok(draw, 'no venue hub could resolve the responsible set for ' + requestId +
                    ' while it was still pending, so ZC1 cannot say which hubs owed a round.\n' +
                    allHubTails(venue))
                const responsibleHubs = draw.responsible
                    .map((pk) => venue.hubIndexForPubkey(pk))
                    .filter((i) => i >= 0)
                assert.strictEqual(responsibleHubs.length, draw.responsible.length,
                    'the draw for ' + requestId + ' includes a key no venue hub signs with (' +
                    jsonSafe(draw.responsible.map((p) => p.slice(0, 16))) + '). The venue adopts the ' +
                    'roster precisely so this cannot happen, and a round drawing a foreign key can ' +
                    'never finalize.')
                console.log('ZC1: request ' + requestId.slice(0, 12) + ' mined at ' + N +
                    ', drawn hubs ' + jsonSafe(responsibleHubs) +
                    ' (redundancy ' + draw.redundancy + ', widen ' + draw.widen + ')')

                // ---- (a) the round started at the tip the request was mined in -------
                //
                // WAITED FOR, not read once: the hub polls every POLL_MS and the line is
                // written when the round starts, so a bare read a second after the block
                // asks the question before there is an answer. Budgeted at several poll
                // intervals plus the capability read behind it.
                const wantLine = 'AttestationRound: starting ' + requestId.slice(0, 16) +
                    '... tip=' + N + ' conf=0 widen=1'
                const lines = await until(async () => {
                    const missing = responsibleHubs.filter((i) => !venue.logTail('hub' + i).includes(wantLine))
                    return { ok: missing.length === 0, missing: missing }
                }, 3 * 60 * 1000, 2000)
                assert.deepStrictEqual(lines.missing, [],
                    'hub(s) ' + jsonSafe(lines.missing) + ' never logged "' + wantLine + '". ' +
                    'That line is the only place the EFFECTIVE confirmation count is visible, and it ' +
                    'is written once per started round on a responsible hub. tip=' + N + ' says the ' +
                    'round started in the block the request was mined in; conf=0 says confirmationsFor ' +
                    'resolved the zero-conf branch; widen=1 says the V2 headroom slot was drawn at ' +
                    'elapsed 0, which is the branch §4.1 exists for.\n' + allHubTails(venue))
                console.log('ZC1: every responsible hub logged "' + wantLine + '"')

                // The line is written AFTER the `amResponsible` guard, so a hub outside
                // the draw must not carry it. Asserted because a line every hub logs
                // would make the assertion above true for the wrong reason.
                const outsiders = venue.hubs
                    .map((h) => h.index)
                    .filter((i) => !responsibleHubs.includes(i))
                    .filter((i) => venue.logTail('hub' + i).includes(wantLine))
                assert.deepStrictEqual(outsiders, [],
                    'hub(s) ' + jsonSafe(outsiders) + ' logged the round-start line without being in ' +
                    'the responsible set. The line sits below the amResponsible guard, so this is a ' +
                    'hub running a round it was not drawn for.')

                // ---- (b) the row is readable, and how long after the block ------------
                //
                // NEVER OFF A HUB LOG LINE. The live testnet finalize on 2026-09-07 logged
                // no insert and no gossip line at all and the row simply appeared on the
                // snapshot route (measured on the public testnet, 2026-09-07), so a drill keyed on a log line would
                // have reported a working mirror as broken.
                const mirrorRows = await waitForMirrorRowEverywhere(venue, requestId)
                for (const [i, row] of mirrorRows.entries()) {
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
                for (const hubIndex of responsibleHubs) {
                    const snap = await venue.hubSnapshot(hubIndex, { limit: 1000 })
                    const rows = (snap && snap.rows) || []
                    if (rows.some((r) => String(r.request_id).toLowerCase() === requestId)) servedBy.push(hubIndex)
                }
                assert.ok(servedBy.length > 0,
                    'no responsible hub serves a row for ' + requestId + ' on ' +
                    '/hub-db/snapshot/attestation_responses, even though both indexers hold one. The ' +
                    'route is the surface an indexer bootstraps from, so a row present in the table ' +
                    'and absent from the route is a mirror that cannot recover a follower.')

                // MEASURED OFF `finalized_at`, NOT OFF WHEN THIS DRILL LOOKED. The wall
                // clock at the first observation is a measurement of the drill's own
                // polling: everything above (the draw read, the log wait) happens between
                // the block and the look, so a first-sight figure would charge the hub for
                // the harness's time and could fail a 15 s bound on a 4 s round.
                // `finalized_at` is the hub's own clock at quorum and is written by
                // AttestationResponseMirror at insert, which is the moment the row became
                // readable on that hub.
                const hubRows = []
                for (const hubIndex of responsibleHubs) {
                    const rows = await venue.hubMirrorRows(hubIndex, { requestId: requestId })
                    if (rows.length > 0) hubRows.push({ hub: hubIndex, finalized_at: Number(rows[0].finalized_at) })
                }
                assert.ok(hubRows.length > 0,
                    'no responsible hub holds a row for ' + requestId + ' in its own table, so the ' +
                    'mined-to-mirrored measurement has no source')
                const firstFinalized = Math.min(...hubRows.map((h) => h.finalized_at))
                const minedToMirrored = firstFinalized - minedAt
                console.log('ZC1 MEASUREMENT: mined-to-mirrored ' + minedToMirrored + ' s ' +
                    '(block ' + N + ' stamped ' + minedAt + ', first hub row at ' + firstFinalized +
                    ', poll ' + POLL_MS + ' ms, per-hub ' + jsonSafe(hubRows) + ')')
                assert.ok(minedToMirrored >= 0 && minedToMirrored <= MIRRORED_WITHIN_S,
                    'the mirror row appeared ' + minedToMirrored + ' s after block ' + N +
                    ', outside the ' + MIRRORED_WITHIN_S + ' s ZC1 allows. At the ' + POLL_MS +
                    ' ms poll the budget is one poll plus the provider fetch plus consensus plus the ' +
                    'insert; a figure far above it means the hub is still waiting on confirmations, ' +
                    'and a NEGATIVE one means the block stamp is ahead of the hubs\' clocks.\n' +
                    allHubTails(venue))

                // ---- (c) the callback binds at N+1 ------------------------------------
                const effectiveTime = Number(mirrorRows[0].effective_time)
                assert.ok(Number.isInteger(effectiveTime) && effectiveTime > 0,
                    'the mirror row carries no usable effective_time (' + mirrorRows[0].effective_time + ')')

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
                assert.strictEqual(tipNow, N + 1,
                    'mining one block left the chain at ' + tipNow + ' rather than ' + (N + 1) +
                    '; something else is producing blocks on this chain and the drill is not exclusive')
                await settleOrReport('zc1')

                for (const ix of venue.indexers) await waitForHeightWithClear(venue, ix.index, N + 1)

                const bound = await untilOrClearDogeStall(async () => {
                    const rows = []
                    for (const ix of venue.indexers) rows.push(await readAppliedResponse(venue, ix.index, requestId))
                    return { ok: rows.every((r) => r && Number(r.block_index) === N + 1), rows: rows }
                }, { timeoutMs: 10 * 60 * 1000, intervalMs: 2000, tipProbe: venueTipProbe(venue, 0) })
                assert.ok(bound.ok,
                    'the callback did not bind at ' + (N + 1) + ' on both indexers; they hold ' +
                    jsonSafe((bound.rows || []).map((r) => (r ? Number(r.block_index) : null))) + '. ' +
                    'N+1 is the FLOOR and this spec reaches it: the row cannot bind inside N itself ' +
                    '(it does not exist when N is processed), and it must not need a second block, ' +
                    'which is what a hub still waiting on confirmations would produce.\n' +
                    venue.logTail('indexer0') + '\n' + venue.logTail('indexer1'))

                // The binding block's own time is past the signed stamp, which is the rule
                // the applier applies. Asserted so a pass cannot come from an applier that
                // ignores effective_time and binds at whatever block runs next.
                const window = await readBlockWindow(venue, 0, N, N + 1)
                const bindBlock = window.find((b) => Number(b.block_index) === N + 1)
                assert.ok(bindBlock && Number(bindBlock.block_time) >= effectiveTime,
                    'block ' + (N + 1) + ' is stamped ' + (bindBlock && bindBlock.block_time) +
                    ', which is NOT past the signed effective_time ' + effectiveTime +
                    '. A bind there would mean the applier is not reading the stamp at all.')

                const state = await readContractState(venue, 0, contract.contractIndex)
                assert.strictEqual(JSON.parse(state.callback_status), 'ok',
                    'the callback did not fire from the mirror row (status ' + state.callback_status + ')')
                assert.strictEqual(JSON.parse(state.callback_context), 'ctx-zc1')
                assert.strictEqual(JSON.parse(state.callback_payload), FIXED_BODY,
                    'the callback payload is not the body the provider served')

                console.log('ZC1 GREEN: request at ' + N + ', round started at tip ' + N +
                    ' conf=0 widen=1 on hubs ' + jsonSafe(responsibleHubs) +
                    ', mirrored in ' + minedToMirrored + ' s, bound at ' + (N + 1))
            } finally {
                await regtestMinerConnector.resumeMining()
            }
        })
})
