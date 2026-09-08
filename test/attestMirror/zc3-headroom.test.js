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
 * ZC3, THE HEADROOM SLOT. One drawn member that cannot sign must not stall the
 * round for a third of the deadline window.
 *
 * The spec's own test (zero-confirmation-flip §10 ZC3): make a request, read the
 * draw through `getattestationresponsibleset`, stop one drawn venue hub; the round
 * finalizes with `redundancy` signatures INSIDE THE FIRST LADDER SEGMENT at the
 * same block on both venue indexers.
 *
 * THE DEFECT THIS MEASURES, measured on the public testnet. A 0.11.0 community validator seated in one
 * of the attestation slots proposes without a signed `effective_time`; every
 * current hub rejects its proposal, so a 3-of-7 draw that includes it stalls at 2
 * of 3. Before this train the ladder admitted a fourth member only after the first
 * THIRD of the serviceable span, which on contract 49's ten-block deadline is six
 * blocks; the live measurement was an hour and three quarters of retries. With the
 * V2 headroom slot the same round finalizes at the request's own block, with no
 * clock at all. A stopped hub is that key: from the federation's side, a member
 * that is drawn and never signs is a member that is drawn and never signs.
 *
 * WHY THE STOPPED MEMBER IS RANK 1 AND NOT THE LAST. The draw is ranked by
 * `sha256(request_id || pubkey)`, so the widened HEADROOM slot is the last entry.
 * Stopping that one leaves an ordinary three-of-three round and proves nothing:
 * the round would finalize with or without §4.1. Stopping a member inside the
 * first `redundancy` slots is what makes the headroom slot load-bearing, because
 * the third signature can then only come from it. Rank 1 rather than rank 0
 * because rank 0 is the leader at escalation step 0 and stopping it would be a
 * test of leader rotation instead.
 *
 * WHY THE POLL IS SLOWED DOWN HERE, and what it is NOT. `attestationPollMs` is
 * raised to open a window between the request becoming visible and the first round
 * starting, so the drill can read the draw and stop a hub inside it: "selects the
 * dead member AFTER the draw" (gaps 8) is a precondition, not a hope. ZC1 owns the
 * claim about the fleet's poll default; this value is a drill knob and says
 * nothing about it. The precondition is then ASSERTED rather than assumed: the
 * stopped hub must have logged no round-start line for this request.
 *
 * SERIALIZED, not chain-exclusive. It adopts the standing roster (so every draw is
 * venue-only) and stops one of its own hub processes; it orphans nothing and does
 * not touch the shared miner, so the chain is left exactly as it was found.
 *
 * WALL-TIME BUDGET: about 35 minutes, nearly all of it the venue's two indexers
 * replaying the borrowed chain from genesis.
 ********************************************************************/

const assert = require('assert')
const dotenv = require('dotenv')
dotenv.config()

const { AttestMirrorVenue } = require('../helpers/attestMirrorVenue')
const {
    provisionDrillIdentities, waitForVenueIndexersAtTip, startAttestTestServer, deployRequestContract,
    mineWhile,
} = require('./mirrorDrillFixture')
const {
    APPLIED_FIELDS, diffRows,
    waitForMirrorRowEverywhere, waitForAppliedEverywhere,
    readRequestRow, findEmittedAttestRequest, attestRequestWatermark,
    clearBeforeBroadcast, settleOrReport, allHubTails, jsonSafe,
} = require('./mirrorDrillWaits')
const vmHelper = require('../helpers/vmHelper')

const FIXED_BODY = '{"score":23,"meta":"zc3-headroom"}'

// The drill's window knob, NOT a claim about the fleet default (see the header).
// Long enough to read the draw and stop a hub before any hub's first poll fires.
const POLL_MS = 20000

const FORWARD_S = 3

// Sixty blocks gives a first ladder segment of twenty (span 60, V2 maxSlots 2, so
// segment = span / 3), which is wide enough that the assertion below is about the
// headroom slot rather than about how fast the shared miner happened to be.
const DEADLINE_BLOCKS = 60

// The request's redundancy, and therefore the exact number of valid signatures the
// round must finalize with once one drawn member is gone.
const REDUNDANCY = 3

const CONTRACT_CODE = `
module.exports = {
    meta: { name: 'Zero Conf Headroom Asker', description: 'Requests an attestation used to measure zero-conf mirror headroom.', version: '1.0.0' },
    ask: function(xchain) {
        var requestId = xchain.attestation.request(
            xchain.getInputParam(0),
            xchain.getInputParam(1),
            'handleResponse',
            ['ctx-zc3'],
            { redundancy: ${REDUNDANCY}, deadlineBlocks: ${DEADLINE_BLOCKS} }
        );
        return requestId;
    },
    handleResponse: function(xchain) {
        xchain.state.set('callback_status',  xchain.getInputParam(2));
        xchain.state.set('callback_payload', xchain.getInputParam(3));
    }
};
`

describe('ZC3: a drawn member that cannot sign is covered by the headroom slot', function () {
    this.timeout(75 * 60 * 1000)

    let venue      = null
    let up         = false
    let testServer = null
    let testUrl    = null
    let contract   = null
    let stoppedHub = null

    before(async function () {
        testServer = await startAttestTestServer({ body: FIXED_BODY })
        testUrl    = testServer.url

        const staked = await provisionDrillIdentities({ label: 'zc3', count: 5, redundancy: REDUNDANCY })
        venue = new AttestMirrorVenue({
            label: 'zc3', identities: staked.identities, hubExtraEnv: testServer.hubEnv,
            attestationPollMs: POLL_MS, forwardS: FORWARD_S,
        })
        up = await venue.start()
        if (!up) {
            console.log('ZC3 SKIPPED: ' + venue.unavailable)
            this.skip()
            return
        }
        await waitForVenueIndexersAtTip(venue)
        contract = await deployRequestContract({ label: 'zc3', code: CONTRACT_CODE })
    })

    after(async function () {
        // The hub goes back whatever happened, so the venue teardown kills a process it
        // started rather than leaking one, and a re-run finds five hubs.
        if (venue && stoppedHub !== null) {
            try { await venue.startHub(stoppedHub) } catch (e) {
                console.log('ZC3 teardown: hub ' + stoppedHub + ' did not restart (' + (e && e.message) + ')')
            }
        }
        if (testServer) await testServer.close()
        if (venue) await venue.stop()
    })

    it('finalizes with exactly redundancy signatures inside the first ladder segment', async function () {
        const sinceAction = await attestRequestWatermark(contract.contractIndex)
        await clearBeforeBroadcast()
        const exec = await mineWhile(() => vmHelper.sendExecuteV0(
            contract.owner, contract.contractIndex, 'ask', ['http_get', testUrl]))
        assert.strictEqual(exec.execution.status, 'valid',
            'the EXECUTE that emits the request came back ' + exec.execution.status)

        const request   = await findEmittedAttestRequest(
            contract.contractIndex, sinceAction + 1, { label: 'zc3' })
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
        assert.ok(draw, 'no venue hub could resolve the responsible set for ' + requestId +
            ' while it was pending\n' + allHubTails(venue))
        console.log('ZC3: hub ' + drawFrom + ' drew ' + jsonSafe(draw.responsible.map((p) => p.slice(0, 16))) +
            ' (redundancy ' + draw.redundancy + ', widen ' + draw.widen + ') for request ' +
            requestId.slice(0, 12))

        // THE HEADROOM SLOT IS PRESENT, and this is the precondition the rest rests on.
        // Above the zero-conf height V2 returns `headroom` at elapsed 0 rather than 0
        // (§4.1, D27), so the set is redundancy + 1 from the request's own block. If it
        // were redundancy, stopping a member would leave two live signers and no round
        // could finalize at all: the failure would look like a mirror fault and would
        // in fact be a missing ladder.
        assert.strictEqual(draw.widen, 1,
            'the draw carries widen ' + draw.widen + ' rather than 1. At the request\'s own block ' +
            'the V2 ladder returns its headroom slot and nothing more, so 0 means the stage-2 early ' +
            'return is not armed and 2 or more means blocks went by before the draw was read.')
        assert.strictEqual(draw.responsible.length, REDUNDANCY + 1,
            'the responsible set holds ' + draw.responsible.length + ' member(s) rather than ' +
            (REDUNDANCY + 1) + ' (redundancy ' + REDUNDANCY + ' plus one headroom slot): ' +
            jsonSafe(draw.responsible.map((p) => p.slice(0, 16))))

        // Rank 1: inside the first `redundancy` slots so the headroom member is what
        // supplies the third signature, and not rank 0, which is the leader at step 0.
        const victimKey = draw.responsible[1]
        const victimHub = venue.hubIndexForPubkey(victimKey)
        assert.ok(victimHub >= 0,
            'the drawn member at rank 1 (' + victimKey.slice(0, 16) + '...) belongs to no venue hub. ' +
            'The venue adopts the roster precisely so every drawn key has a live hub here.')

        await venue.stopHub(victimHub)
        stoppedHub = victimHub
        console.log('ZC3: stopped hub ' + victimHub + ' (' + victimKey.slice(0, 16) + '...), rank 1 of the draw')

        // THE PRECONDITION, ASSERTED. "Stopped AFTER the draw, before it served" is the
        // whole construction, and a poll that fired first would quietly turn this into a
        // round that four members ran and three finished, which is a different claim.
        // The round-start line is written once per started round on a responsible hub,
        // so its absence on the victim is the evidence.
        const victimStarted = venue.logTail('hub' + victimHub)
            .includes('AttestationRound: starting ' + requestId.slice(0, 16) + '...')
        assert.strictEqual(victimStarted, false,
            'hub ' + victimHub + ' had already started a round for ' + requestId.slice(0, 16) +
            '... before it was stopped, so it is not a member that never signed and ZC3 is measuring ' +
            'something else. Its poll fired inside the window; re-run (the poll interval is the ' +
            'window, see the header).\n' + venue.logTail('hub' + victimHub))

        // ---- the round finalizes without it -----------------------------------
        const mirrorRows = await waitForMirrorRowEverywhere(venue, requestId, 15 * 60 * 1000, {
            // The ladder is height-driven, so a still chain never climbs it. Capped well
            // inside the first segment: this drill's whole claim is that no climbing is
            // needed, and mining past the segment would let a LATER slot rescue the round
            // and pass for the wrong reason.
            mineWhileWaiting: { perPoll: 1, maxBlocks: 4 },
        })
        for (const [i, row] of mirrorRows.entries()) {
            assert.strictEqual(String(row.status), 'ok',
                'the mirror row on indexer ' + i + ' carries status ' + row.status +
                ' rather than ok, so the round finalized a non-ok outcome')
        }

        // EXACTLY REDUNDANCY VALID SIGNATURES. Not "at least": the indexer's verifier
        // admits `validSigs >= redundancy`, and the interesting number is how many the
        // federation could actually produce with one drawn member dark. Three is the
        // arithmetic §4.4 states (quorum is measured on the PRE-widening size, so
        // needed stays at redundancy); four would mean the stopped hub signed anyway.
        let signers = mirrorRows[0].signer_pubkeys
        if (typeof signers === 'string') signers = JSON.parse(signers)
        signers = signers.map((s) => String(s).toLowerCase())
        assert.strictEqual(signers.length, REDUNDANCY,
            'the finalized row carries ' + signers.length + ' signature(s) rather than exactly ' +
            REDUNDANCY + ': ' + jsonSafe(signers.map((s) => s.slice(0, 16))) + '\n' + allHubTails(venue))
        assert.ok(!signers.includes(String(victimKey).toLowerCase()),
            'the stopped hub\'s key ' + victimKey.slice(0, 16) + '... signed the row, so it was not ' +
            'actually dark and the round did not have to reach past it')

        // THE HEADROOM MEMBER IS ONE OF THEM. This is what makes the case about §4.1
        // rather than about a three-member set that happened to have three live hubs:
        // without the widened slot the third signature has nowhere to come from.
        const headroomKey = String(draw.responsible[REDUNDANCY]).toLowerCase()
        assert.ok(signers.includes(headroomKey),
            'the headroom member ' + headroomKey.slice(0, 16) + '... did not sign, so the three ' +
            'signatures came from somewhere other than the widened slot: ' +
            jsonSafe(signers.map((s) => s.slice(0, 16))))

        // Every signer was drawn. A signature from outside the set is refused by the
        // verifier, so a row carrying one would be inert and this drill would be
        // asserting against a row no node can admit.
        const drawn = new Set(draw.responsible.map((p) => String(p).toLowerCase()))
        const strays = signers.filter((s) => !drawn.has(s))
        assert.deepStrictEqual(strays, [],
            'the row carries signature(s) from outside the responsible set: ' +
            jsonSafe(strays.map((s) => s.slice(0, 16))))

        // ---- and binds at the same block on both indexers ---------------------
        const applied = await waitForAppliedEverywhere(venue, requestId, 15 * 60 * 1000, {
            // The applier runs in the block loop, so on a chain nobody is mining a
            // delivered, valid, applicable response is never applied. Capped inside the
            // first segment for the same reason as above.
            mineWhileWaiting: { perPoll: 1, maxBlocks: 6 },
        })
        const diffs = diffRows(applied[0], applied[1], APPLIED_FIELDS)
        assert.deepStrictEqual(diffs, [],
            'the two indexers bound the response differently: ' + diffs.join('; ') +
            '. The applier is deterministic by construction, so a difference here is a fork between ' +
            'two nodes reading the same mirror row.')

        const local        = await readRequestRow(venue, 0, requestId)
        const requestBlock = Number(local.block_index)
        const deadline     = Number(local.deadline_block)
        const bindBlock    = Number(applied[0].block_index)

        // THE FIRST LADDER SEGMENT, computed from the V2 shape the spec states: the
        // ladder starts at the REQUEST's own block above the height (startOffset 0), the
        // span runs to the deadline, and the segment is span / (maxSlots + 1). Below the
        // height it started at request + 3 and the first widen arrived a segment later,
        // which is the six-block wait measured on the public testnet. Spelled here rather than taken
        // from `widenArithmetic`, which computes the STAGE-1 geometry and would give a
        // different, wrong boundary.
        const span    = deadline - requestBlock
        const segment = span / 3
        const cutoff  = requestBlock + segment
        assert.ok(bindBlock < cutoff,
            'the response bound at block ' + bindBlock + ', at or past the end of the first ladder ' +
            'segment (' + requestBlock + ' + ' + span + '/3 = ' + cutoff.toFixed(2) + '). Inside the ' +
            'first segment is the point: headroom makes a round with one dark member finalize with no ' +
            'clock at all, and a bind past the cutoff means it waited for the ladder to open a slot ' +
            'instead, which is exactly the delay this spec removes.')
        console.log('ZC3 GREEN: hub ' + victimHub + ' dark, round finalized with ' + signers.length +
            ' signature(s) including the headroom member, bound at ' + bindBlock +
            ' on both indexers (request ' + requestBlock + ', deadline ' + deadline +
            ', first segment ends ' + cutoff.toFixed(2) + ')')
    })
})
