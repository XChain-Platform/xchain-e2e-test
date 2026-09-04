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
 * AT2's SECOND CLAUSE: delivery delayed past the forward margin must hold the
 * barrier, not fork the ledger.
 *
 * The spec's own words: with that hub's delivery delayed past the forward margin,
 * the barrier holds and no block is processed early.
 *
 * WHY THIS IS A SEPARATE FILE FROM at2. The clause needs one indexer running a
 * RAISED `attestResponse` grace, and a raised grace makes every freshly mined
 * block wait that grace out on that node. at2's dissemination case mines dozens of
 * blocks looking for a request whose responsible set leaves an indexer outside it,
 * so carrying the grace there would add the grace to every one of them. Two files,
 * two venues, each fast at what it does.
 *
 * WHAT MAKES THE HOLD HAPPEN, and this is the part that had to be measured rather
 * than assumed. Every mirror barrier in `xchain-indexer/src/hub_db_sync.js` tests
 * one thing:
 *
 *     streamWatermark >= blockTime + grace
 *
 * against a SINGLE GLOBAL watermark that advances on the followed hub's heartbeat.
 * It is not per table and it cannot see which rows have arrived; the module says so
 * itself, that an empty mirror is indistinguishable from a mirror that has not been
 * told about the row binding at this very block. Two consequences follow and the
 * whole design of this drill rests on them:
 *
 *   - WITHHOLDING ROWS ALONE CANNOT HOLD A BLOCK. The mirror route keeps serving
 *     its watermark, so the barrier stays satisfied and the block is processed
 *     without the row. That is not a hold, it is the fork.
 *   - THE GRACE IS THE ONLY PER-BARRIER TERM, so it is what turns delivery lag into
 *     a wait instead of a divergence, and it is what makes the wait attributable to
 *     THIS barrier by name.
 *
 * So the drill arms a delivery delay LONGER than the forward margin, which is
 * exactly the fault the margin is supposed to absorb and, on its own, does not; and
 * it runs the affected indexer with a grace longer than the delay. The claim then
 * has two halves that must both hold: the barrier reports itself while it waits,
 * and when the block finally lands, the response bound at the SAME block on both
 * nodes. The second half is what "no block is processed early" means in terms a
 * ledger can be checked against.
 *
 * WHAT IS NOT DRIVEN HERE, deliberately: the spec's falsification, lowering the
 * margin below the injected delay. Its expected outcome is a real divergence
 * between two nodes, so it needs its own venue and it leaves that venue forked.
 * The property is already implied by the measurement above (with the grace under
 * the delay the block processes without the row), and driving a deliberate fork on
 * the shared chain earns nothing this file does not already say.
 ********************************************************************/

const assert = require('assert')
const http   = require('http')
const dotenv = require('dotenv')
dotenv.config()

const { AttestMirrorVenue } = require('../helpers/attestMirrorVenue')
const {
    stakeDrillIdentities, deployRequestContract,
} = require('./mirrorDrillFixture')
const {
    APPLIED_FIELDS, until, untilOrClearDogeStall, diffRows, diffStateHashes,
    waitForMirrorRowEverywhere, waitForAppliedEverywhere, venueTipProbe,
    findEmittedAttestRequest, captureFederationState,
    clearBeforeBroadcast,
    allHubTails,
    attestRequestWatermark,
    settleOrReport,
    widenArithmetic,
} = require('./mirrorDrillWaits')
const vmHelper = require('../helpers/vmHelper')
const XChainIndexerConnector = require('../../src/XChainIndexerConnector.js')

const FIXED_BODY = '{"score":23,"meta":"at2b-margin"}'

const BARRIER_REASON = 'attest_response_sync_barrier'
const PARKED_CLASSES = ['barrier_defer', 'wedged']
const MIRROR_TABLE   = 'attestation_responses'

const DEADLINE_BLOCKS = 60
const BURIAL_BLOCKS   = 6

// The forward margin, left at the venue's fast default so the delay below can
// exceed it without the drill waiting out the frozen 120.
const FORWARD_S = 5

// Delivery delay, comfortably PAST the forward margin: by the time the row reaches
// this indexer its signed effective time is long gone, so the margin has already
// failed to cover it and only the barrier can.
const DELIVERY_DELAY_MS = 25_000

// The grace on the affected indexer, above the delay so the wait can absorb it.
const BARRIER_GRACE_S = 70

// The indexer whose delivery is delayed. Its peer keeps every grace at zero and an
// unfiltered feed, which is what makes "one waiting, one not" attributable.
const DELAYED = 1
const PROMPT  = 0

const CONTRACT_CODE = `
module.exports = {
    ask: function(xchain) {
        var requestId = xchain.attestation.request(
            xchain.getInputParam(0),
            xchain.getInputParam(1),
            'handleResponse',
            ['ctx-at2b'],
            { redundancy: 3, deadlineBlocks: ${DEADLINE_BLOCKS} }
        );
        return requestId;
    },
    handleResponse: function(xchain) {
        xchain.state.set('callback_status',  xchain.getInputParam(2));
        xchain.state.set('callback_payload', xchain.getInputParam(3));
    }
};
`

describe('AT2 second clause: delivery past the forward margin holds the barrier and forks nothing', function () {
    this.timeout(90 * 60 * 1000)

    let venue      = null
    let up         = false
    let httpServer = null
    let testUrl    = null
    let contract   = null

    async function statusOf (i) {
        const s = await venue.statusOf(i)
        return {
            height: (s.body && s.body.indexerBlock !== undefined) ? Number(s.body.indexerBlock) : null,
            decoder: (s.body && s.body.decoderBlock !== undefined) ? Number(s.body.decoderBlock) : null,
            reason: s.body && s.body.stallReason,
            klass: s.body && s.body.stallClass,
        }
    }

    before(async function () {
        await new Promise((resolve) => {
            httpServer = http.createServer((_req, res) => {
                res.writeHead(200, { 'Content-Type': 'application/json' })
                res.end(FIXED_BODY)
            })
            httpServer.listen(0, '127.0.0.1', () => {
                testUrl = 'http://127.0.0.1:' + httpServer.address().port + '/score'
                resolve()
            })
        })

        const staked = await stakeDrillIdentities({ label: 'at2b', count: 5 })
        venue = new AttestMirrorVenue({
            label: 'at2b',
            identities: staked.identities,
            forwardS: FORWARD_S,
            indexerGraces: { [DELAYED]: { attestResponse: BARRIER_GRACE_S } },
        })
        up = await venue.start()
        if (!up) {
            console.log('AT2b SKIPPED: ' + venue.unavailable)
            this.skip()
            return
        }
        contract = await deployRequestContract({ label: 'at2b', code: CONTRACT_CODE })
    })

    after(async function () {
        if (venue) {
            try { venue.releaseMirrorTable(DELAYED, MIRROR_TABLE) } catch (_) { /* never armed */ }
            await venue.stop()
        }
        if (httpServer) await new Promise((r) => httpServer.close(() => r()))
    })

    it('waits on the named barrier and still binds at the same block on both nodes', async function () {
        // Armed BEFORE the request, so the row is delayed from the moment it exists
        // rather than after this indexer has already seen it.
        venue.delayMirrorTable(DELAYED, MIRROR_TABLE, DELIVERY_DELAY_MS)
        console.log('AT2b: delaying ' + MIRROR_TABLE + ' by ' + DELIVERY_DELAY_MS + 'ms on indexer ' +
            DELAYED + ' mirror edge; the forward margin is ' + FORWARD_S +
            's, so the row will arrive with its effective time already past')

        // Watermark FIRST: see attestRequestWatermark for why the execute's own
        // action index cannot be trusted as the correlation input.
        const sinceAction = await attestRequestWatermark(contract.contractIndex)
        await clearBeforeBroadcast()
        const exec = await vmHelper.sendExecuteV0(
            contract.owner, contract.contractIndex, 'ask', ['http_get', testUrl])
        assert.strictEqual(exec.execution.status, 'valid',
            'the EXECUTE that emits the request came back ' + exec.execution.status)
        const request = await findEmittedAttestRequest(
            contract.contractIndex, sinceAction + 1, { label: 'at2b' })
        const requestId = request.requestId

        await regtestMinerConnector.generateBlocks(BURIAL_BLOCKS)
        await settleOrReport('at2b')

        // CAPTURED WHILE THE REQUEST IS STILL PENDING, which is the only window in
        // which the responsible set is readable at all: `getattestationresponsibleset`
        // answers for pending requests only. This drill cannot get the capture for
        // free the way its neighbours do, because it deliberately does NOT use
        // `waitForMirrorRowEverywhere` (one of its two indexers is being starved on
        // purpose, so "both hold the row" is not the condition it waits for), and the
        // capture lives inside that helper. Without this call the one reading that
        // separates a mirror fault from a dead-member draw is missing from exactly the
        // drill most likely to need it.
        try { await captureFederationState(venue, requestId, 'before the round settles') }
        catch (e) { console.log('FEDERATION STATE (before): unreadable, ' + (e && e.message)) }

        // The PROMPT indexer's mirror is untouched, so it gets the row on the ordinary
        // path and this establishes the round finalized at all.
        // MINES WHILE WAITING for the same reason its neighbours do: the widening
        // ladder is height-driven, so a still chain never leaves widen 0 and a draw
        // holding a key no live hub holds can never finalize. This drill cannot use
        // the shared row wait (one of its indexers is starved on purpose), so it
        // carries the same option on its own loop.
        const prompt = await untilOrClearDogeStall(async () => {
            const rows = await venue.readMirrorRows(PROMPT, { requestId: requestId })
            return { ok: rows.length === 1, rows: rows }
        }, {
            timeoutMs: 10 * 60 * 1000,
            tipProbe: venueTipProbe(venue, PROMPT),
            mineWhileWaiting: { perPoll: 1, maxBlocks: widenArithmetic(DEADLINE_BLOCKS).safeCap },
        })

        // AND AGAIN whichever way that went, because a round that never finalized and
        // a row that never arrived look identical from the indexer side.
        let after = null
        try {
            after = await captureFederationState(venue, requestId,
                prompt.ok ? 'row present on the unfiltered indexer' : 'row MISSING')
        } catch (e) { console.log('FEDERATION STATE (after): unreadable, ' + (e && e.message)) }
        const verdict = after ? after.verdict : 'capture did not run'

        assert.ok(prompt.ok,
            'the unfiltered indexer never received the mirror row, so the round did not finalize and the ' +
            'delay is not what is under test. Hub finalization: ' + verdict + '. NO hub ' +
            'holding one means the round never reached quorum, which a redundancy-sized draw including a ' +
            'staked key belonging to no running hub does exactly, and the responsible set printed above ' +
            'says whether that is what happened.\n' + allHubTails(venue))
        console.log('AT2b: the unfiltered indexer holds the row; effective_time ' +
            prompt.rows[0].effective_time)

        // THE HOLD, BY NAME. A fresh block is what arms the barrier, and while the
        // delayed row is in flight the affected indexer must report THIS barrier and
        // not a neighbouring one.
        await regtestMinerConnector.generateBlocks(1)
        const held = await until(async () => {
            const a = await statusOf(DELAYED)
            return { ok: a.reason === BARRIER_REASON && PARKED_CLASSES.includes(a.klass), a: a }
        }, 6 * 60 * 1000)
        assert.ok(held.ok,
            'indexer ' + DELAYED + ' never reported ' + BARRIER_REASON + ' while its delivery was delayed. ' +
            'Last status ' + JSON.stringify(held.a) + '; proxy ' +
            JSON.stringify(venue.mirrorProxyStats(DELAYED)) + '\n' + venue.logTail('indexer' + DELAYED))
        console.log('AT2b: indexer ' + DELAYED + ' waiting at block ' + held.a.height + ' of ' +
            held.a.decoder + ' on ' + held.a.reason + ' (' + held.a.klass + ')')

        // THE INJECTION FIRED. Without this the wait could be the grace alone on a
        // venue where nothing was ever delayed.
        const stats = venue.mirrorProxyStats(DELAYED)
        assert.ok(stats.framesHeld > 0 || stats.snapshotRowsHeld > 0,
            'the mirror proxy on indexer ' + DELAYED + ' reports holding nothing, so the delay never ' +
            'applied and this case is only observing a grace: ' + JSON.stringify(stats))
        console.log('AT2b: proxy held ' + stats.framesHeld + ' stream frame(s) and ' +
            stats.snapshotRowsHeld + ' snapshot row(s)')

        // NO BLOCK PROCESSED EARLY, expressed as the thing a ledger can be checked
        // against: both nodes bound the response at the SAME block, so the wait
        // absorbed the delay instead of the delayed node skipping past it and binding
        // later.
        const applied = await waitForAppliedEverywhere(venue, requestId, 20 * 60 * 1000)
        const diffs = diffRows(applied[PROMPT], applied[DELAYED], APPLIED_FIELDS)
        assert.deepStrictEqual(diffs, [],
            'the delayed indexer bound the response differently from its peer: ' + diffs.join('; ') +
            '. A differing block_index here is the precise failure this clause exists to rule out: the ' +
            'block was processed before the row arrived, and the two nodes fired the callback at ' +
            'different heights.')
        const at = Number(applied[PROMPT].block_index)
        console.log('AT2b: both nodes bound at block ' + at + ' despite a ' + DELIVERY_DELAY_MS +
            'ms delivery delay against a ' + FORWARD_S + 's margin')

        // And the ledger agrees, not merely the row.
        const conn0 = new XChainIndexerConnector('127.0.0.1', venue.indexers[PROMPT].apiPort, null)
        const conn1 = new XChainIndexerConnector('127.0.0.1', venue.indexers[DELAYED].apiPort, null)
        const h0 = await conn0.call('getblockhashes', { block_index: at })
        const h1 = await conn1.call('getblockhashes', { block_index: at })
        assert.ok(h0 && !h0.error, 'the prompt indexer would not report hashes at ' + at)
        assert.ok(h1 && !h1.error, 'the delayed indexer would not report hashes at ' + at)
        const hashDiffs = diffStateHashes(h0, h1)
        assert.deepStrictEqual(hashDiffs, [],
            'the two nodes disagree at the applying block ' + at + ': ' + hashDiffs.join('; '))
        console.log('AT2b: no divergence at block ' + at + '; state_root ' +
            String(h0.state_root).slice(0, 16) + '... identical')
    })

    it('clears the barrier once the delay is released', async function () {
        // The wait must be a wait rather than a wedge: with the filter gone the node
        // stops reporting the barrier and keeps up.
        venue.releaseMirrorTable(DELAYED, MIRROR_TABLE)
        await regtestMinerConnector.generateBlocks(2)
        await settleOrReport('at2b')

        const clear = await untilOrClearDogeStall(async () => {
            const a = await statusOf(DELAYED)
            const b = await statusOf(PROMPT)
            return { ok: a.height !== null && b.height !== null && a.height >= b.height, a: a, b: b }
        }, { timeoutMs: 15 * 60 * 1000, tipProbe: venueTipProbe(venue, PROMPT) })
        assert.ok(clear.ok,
            'the delayed indexer never caught its peer after the delay was released: ' +
            JSON.stringify(clear) + '\n' + venue.logTail('indexer' + DELAYED))
        console.log('AT2b: released; indexer ' + DELAYED + ' caught up to ' + clear.a.height +
            ' with stallReason ' + String(clear.a.reason))
    })
})
