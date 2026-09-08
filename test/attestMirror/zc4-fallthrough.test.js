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
 * ZC4, THE FALL-THROUGH. A first mirror row that no node may admit must not strand
 * a request that holds a second, valid one.
 *
 * The spec's own test (zero-confirmation-flip §10 ZC4): the injector writes a row
 * for the request with a SMALLER `effective_time` and signatures from outside the
 * set; both indexers log `SKIPPED (invalid: insufficient valid signatures ...)` for
 * it and bind the honest row at the same block; the injected row stays in the
 * table; the block's apply count is 1.
 *
 * THE DEFECT, before §5. `selectApplicableAttestationResponses` picked ONE row per
 * request, the smallest `effective_time`, and `_applyMirroredResponse` wrote
 * nothing at all when the verifier refused it: no action, no verdict, no mark on
 * the request. The refusal is deterministic, so the next block selected the same
 * inert row again, and again, until the deadline. A request with a perfectly good
 * second row (a round that finalized twice under two leader slots)
 * stranded and expired. Above the zero-conf height the selector carries the whole
 * sorted candidate list inside the one item it still returns, and the pass tries
 * them in order.
 *
 * WHY A ROW HAS TO BE INJECTED AT ALL. No honest federation produces an
 * unadmittable row: five hubs agreeing on an artifact is the only way one is
 * normally made. The lever is `writeInertMirrorRow` (attestMirrorVenue.js, beside
 * `withholdMirrorTable`), which writes into the hub tables where a finalized row
 * lives and then drops each follower's socket so the row travels the ordinary
 * mirror path: `attestation_responses` is a FULL_REPAGE table, so every reconnect
 * re-pages it from id 0 and the injected row arrives with the rest. A row that
 * appeared only in a hub table and never reached a follower would prove nothing.
 *
 * WHAT MAKES THE INJECTED ROW WRONG, and it is exactly one thing. It is a CLONE of
 * the honest row: same network, same payload, same response hash, same provider,
 * same status. Only the signers and the stamp differ. Every cheaper skip in
 * `_applyMirroredResponse` (provider mismatch, non-terminal status, signature
 * format, body cap, response_hash echo) is therefore passed, and the row reaches
 * the verifier and is refused there, on the responsible-set gate, with the string
 * §10 names. A row carrying garbage would be refused too, with the same string,
 * and the drill could not tell the two apart; the signatures are real ed25519
 * signatures over the hub's own canonical (`signMirrorRowAs`), made by keys the
 * chain never staked.
 *
 * THE WITHHOLD IS PART OF THE CONSTRUCTION, not a fault injection. Both indexers
 * are starved of `attestation_responses` from before the request until after the
 * injection, so the honest row cannot bind while the drill is still assembling the
 * pair. Released, both rows arrive in one re-page and the applier sees the
 * candidate list §5 is about. At the venue's zero grace a withhold parks nothing:
 * the watermark still passes, so blocks keep processing (at0b's header measures
 * this).
 *
 * SERIALIZED, not chain-exclusive: it adopts the standing roster and orphans
 * nothing. WALL-TIME BUDGET: about 35 minutes, nearly all of it the venue's two
 * indexers replaying the borrowed chain from genesis.
 ********************************************************************/

const assert = require('assert')
const dotenv = require('dotenv')
dotenv.config()

const { AttestMirrorVenue, writeInertMirrorRow } = require('../helpers/attestMirrorVenue')
const { ValidatorIdentity } = require('../helpers/multiValidatorHubHelper')
const {
    provisionDrillIdentities, waitForVenueIndexersAtTip, startAttestTestServer, deployRequestContract,
    mineWhile,
} = require('./mirrorDrillFixture')
const {
    APPLIED_FIELDS, diffRows, until, untilOrClearDogeStall, queryDb,
    readAppliedResponse, readContractState, readRequestRow,
    venueTipProbe, findEmittedAttestRequest, attestRequestWatermark,
    clearBeforeBroadcast, settleOrReport, allHubTails, jsonSafe,
} = require('./mirrorDrillWaits')
const vmHelper = require('../helpers/vmHelper')

const FIXED_BODY = '{"score":31,"meta":"zc4-fallthrough"}'

const POLL_MS   = 3000
const FORWARD_S = 3

const DEADLINE_BLOCKS = 60
const REDUNDANCY      = 3

// The mirrored table this drill starves and then releases.
const MIRROR_TABLE = 'attestation_responses'

// The verdict the injected row must be refused with, as a PREFIX: the verifier
// appends the counts (`(0/3)`), and the counts are a function of how many of the
// injected signers happened to hold the capability, which is not what is being
// pinned. The reason string itself is consensus state and is what §10 names.
const SKIP_REASON_PREFIX = 'invalid: insufficient valid signatures'

const CONTRACT_CODE = `
module.exports = {
    meta: { name: 'Zero Conf Fallthrough Asker', description: 'Requests an attestation that falls through zero-conf onto the confirmed path.', version: '1.0.0' },
    ask: function(xchain) {
        var requestId = xchain.attestation.request(
            xchain.getInputParam(0),
            xchain.getInputParam(1),
            'handleResponse',
            ['ctx-zc4'],
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

describe('ZC4: the applier falls through an inert row to the honest one', function () {
    this.timeout(75 * 60 * 1000)

    let venue      = null
    let up         = false
    let testServer = null
    let testUrl    = null
    let contract   = null
    let staked     = null
    let withheld   = false

    before(async function () {
        testServer = await startAttestTestServer({ body: FIXED_BODY })
        testUrl    = testServer.url

        staked = await provisionDrillIdentities({ label: 'zc4', count: 5, redundancy: REDUNDANCY })
        venue = new AttestMirrorVenue({
            label: 'zc4', identities: staked.identities, hubExtraEnv: testServer.hubEnv,
            attestationPollMs: POLL_MS, forwardS: FORWARD_S,
        })
        up = await venue.start()
        if (!up) {
            console.log('ZC4 SKIPPED: ' + venue.unavailable)
            this.skip()
            return
        }
        await waitForVenueIndexersAtTip(venue)
        contract = await deployRequestContract({ label: 'zc4', code: CONTRACT_CODE })
    })

    after(async function () {
        // Released whatever happened, so a venue left standing by a failing case is not
        // one whose mirrors are permanently starved.
        if (venue && withheld) {
            for (const ix of venue.indexers) {
                try { venue.releaseMirrorTable(ix.index, MIRROR_TABLE) } catch (_) { /* venue is going away */ }
            }
        }
        if (testServer) await testServer.close()
        if (venue) await venue.stop()
    })

    /**
     * `redundancy` keys the chain never staked.
     *
     * The venue's own observer hubs first: they are real participants in the mesh and
     * are deliberately unstaked, which is the closest thing to a plausible signer that
     * still cannot be in any responsible set. There are only `count - seated` of them
     * and the seated roster changes size between runs, so the list is topped up with
     * freshly generated keys rather than made conditional on a roster this drill does
     * not control. Both kinds are outside the set for the same reason and the refusal
     * cannot tell them apart.
     */
    function outsideSigners () {
        const observerKeys = new Set((staked.observers || []).map((p) => String(p).toLowerCase()))
        const out = staked.identities.filter((id) => observerKeys.has(String(id.pubkeyHex).toLowerCase()))
        while (out.length < REDUNDANCY) out.push(ValidatorIdentity.generate())
        return out.slice(0, REDUNDANCY)
    }

    it('skips the inert candidate, binds the honest row in the same block, and keeps the inert one',
        async function () {
            // STARVED BEFORE THE REQUEST EXISTS. Applied after the row is finalized, the
            // honest row could already have bound and there would be nothing left to fall
            // through to.
            for (const ix of venue.indexers) venue.withholdMirrorTable(ix.index, MIRROR_TABLE)
            withheld = true
            console.log('ZC4: withheld ' + MIRROR_TABLE + ' on both indexers')

            const sinceAction = await attestRequestWatermark(contract.contractIndex)
            await clearBeforeBroadcast()
            const exec = await mineWhile(() => vmHelper.sendExecuteV0(
                contract.owner, contract.contractIndex, 'ask', ['http_get', testUrl]))
            assert.strictEqual(exec.execution.status, 'valid',
                'the EXECUTE that emits the request came back ' + exec.execution.status)

            const request   = await findEmittedAttestRequest(
                contract.contractIndex, sinceAction + 1, { label: 'zc4' })
            const requestId = request.requestId
            await settleOrReport('zc4')

            // THE REQUEST'S OWN BLOCK, from the local row rather than from the mirror
            // row's informational `request_block_index`, which the hub's writer is
            // allowed to leave NULL (D44). It selects whether the injected row's
            // canonical carries the EQUIV header, so a NULL there would sign the wrong
            // bytes and the row would be refused for a reason this drill is not testing.
            const requestRow = await readRequestRow(venue, 0, requestId)
            assert.ok(requestRow, 'the venue indexer holds no v0 request row for ' + requestId)

            // THE HONEST ROW, READ OFF THE HUBS. The indexers are starved, so waiting for
            // it there would wait forever; the hubs are the source and this is the only
            // place it exists right now.
            const honest = await until(async () => {
                for (const hub of venue.hubs) {
                    const rows = await venue.hubMirrorRows(hub.index, { requestId: requestId })
                    if (rows.length > 0) return { ok: true, hub: hub.index, row: rows[0] }
                }
                return { ok: false }
            }, 10 * 60 * 1000, 2000)
            assert.ok(honest.ok,
                'no venue hub finalized a row for ' + requestId + ', so there is no honest row for the ' +
                'injected one to lose the tie-break to and the fall-through has nothing to fall to.\n' +
                allHubTails(venue))
            const honestEffective = Number(honest.row.effective_time)
            console.log('ZC4: hub ' + honest.hub + ' finalized ' + requestId.slice(0, 12) +
                ' with effective_time ' + honestEffective)

            // ---- the injection ------------------------------------------------
            //
            // ONE SECOND EARLIER, which is the smallest difference that still sorts
            // first: the selector orders candidates (effective_time ASC, response_hash
            // ASC), so this row is the HEAD of the list and the one the pre-§5 selector
            // would have picked and re-picked at every block until the deadline.
            const signers = outsideSigners()
            const injected = await writeInertMirrorRow(venue, {
                request: { request_id: requestId, block_index: requestRow.block_index },
                effectiveTime: honestEffective - 1,
                signers: signers,
            })
            console.log('ZC4: injected an inert row at effective_time ' + (honestEffective - 1) +
                ' signed by ' + jsonSafe(signers.map((s) => s.pubkeyHex.slice(0, 16))) +
                ', written ' + jsonSafe(injected.written))

            // ---- let both rows reach both indexers ----------------------------
            for (const ix of venue.indexers) venue.releaseMirrorTable(ix.index, MIRROR_TABLE)
            withheld = false

            const paired = await untilOrClearDogeStall(async () => {
                const counts = []
                for (const ix of venue.indexers) {
                    counts.push((await venue.readMirrorRows(ix.index, { requestId: requestId })).length)
                }
                return { ok: counts.every((c) => c >= 2), counts: counts }
            }, { timeoutMs: 10 * 60 * 1000, intervalMs: 2000, tipProbe: venueTipProbe(venue, 0) })
            assert.ok(paired.ok,
                'both mirror rows did not reach both indexers after the release: counts ' +
                jsonSafe(paired.counts) + '. The release drops the socket so the mirror re-bootstraps, ' +
                'and attestation_responses re-pages from id 0, so a count under two means the injected ' +
                'row never left the hub table.\n' + venue.logTail('indexer0'))
            console.log('ZC4: both indexers hold ' + jsonSafe(paired.counts) + ' rows for the request')

            // ---- the applier runs -----------------------------------------------
            const bound = await untilOrClearDogeStall(async () => {
                await regtestMinerConnector.generateBlocks(1)
                const rows = []
                for (const ix of venue.indexers) rows.push(await readAppliedResponse(venue, ix.index, requestId))
                return { ok: rows.every((r) => r && r.action_index !== undefined), rows: rows }
            }, { timeoutMs: 15 * 60 * 1000, intervalMs: 3000, tipProbe: venueTipProbe(venue, 0) })
            assert.ok(bound.ok,
                'the response was never applied on both indexers. The honest row is valid and ' +
                'applicable, so a request left pending here is the pre-§5 behaviour: the selector kept ' +
                'choosing the inert head and the applier wrote nothing.\n' +
                venue.logTail('indexer0') + '\n' + venue.logTail('indexer1'))

            const diffs = diffRows(bound.rows[0], bound.rows[1], APPLIED_FIELDS)
            assert.deepStrictEqual(diffs, [],
                'the two indexers bound different rows or bound at different blocks: ' + diffs.join('; ') +
                '. The candidate order is built from two SIGNED fields, so every node walks the same ' +
                'sequence and stops at the same place; a difference here is a fork.')

            const bindBlock = Number(bound.rows[0].block_index)

            // THE HONEST ROW IS THE ONE THAT BOUND, identified by its response hash and
            // its stamp rather than by elimination. Reading the applied row's own
            // effective_time is not possible (`attests` does not carry it), so the check
            // is that exactly one mirror row is the injected one and the request settled
            // with the honest payload.
            assert.strictEqual(String(bound.rows[0].response_hash).toLowerCase(),
                String(honest.row.response_hash).toLowerCase(),
                'the applier bound a response hash that is not the honest row\'s')

            // ---- the inert row was skipped, on BOTH nodes ---------------------
            //
            // The reason string is consensus state: every node skips the same row for the
            // same reason, and `_applyMirroredResponse` logs it once per attempt. Matched
            // on the request id AND the reason, because a skip for any other reason (a
            // provider mismatch, a bad hash) would mean the injected row was refused
            // before it ever reached the responsible-set gate and the drill would be
            // asserting a different mechanism.
            const wantSkip = 'id=' + requestId.slice(0, 16) + '...'
            for (const ix of venue.indexers) {
                const tail  = venue.logTail('indexer' + ix.index)
                const lines = tail.split('\n').filter((l) =>
                    l.includes('ATTEST mirror') && l.includes(wantSkip) && l.includes('SKIPPED ('))
                assert.ok(lines.length > 0,
                    'indexer ' + ix.index + ' logged no SKIPPED line for ' + wantSkip + ' at all. The ' +
                    'injected row is the head of the candidate list, so the applier must have tried it ' +
                    'and refused it before reaching the honest one; no line means it was never tried, ' +
                    'which is the single-candidate selector.\n' + tail)
                const matching = lines.filter((l) => l.includes('SKIPPED (' + SKIP_REASON_PREFIX))
                assert.ok(matching.length > 0,
                    'indexer ' + ix.index + ' skipped the injected row for a reason other than "' +
                    SKIP_REASON_PREFIX + '": ' + jsonSafe(lines) + '. Every cheaper skip in the applier ' +
                    '(provider, status, signature format, body cap, response_hash echo) is passed by ' +
                    'construction, because the injected row is a clone of the honest one with only its ' +
                    'signers and stamp changed. A different reason means the clone drifted.')
                console.log('ZC4: indexer ' + ix.index + ' logged ' + matching.length +
                    ' skip(s): ' + matching[0].trim())
            }

            // ---- the inert row is still there ---------------------------------
            //
            // The mirror is insert-only and rollback-exempt: a row that cannot be
            // admitted is INERT, never retracted, and it stays for audit and for the
            // on-chain batch. An applier that deleted what it could not use would also
            // delete the second honest row of a two-leader round.
            for (const ix of venue.indexers) {
                const rows = await venue.readMirrorRows(ix.index, { requestId: requestId })
                const still = rows.filter((r) => Number(r.effective_time) === honestEffective - 1)
                assert.strictEqual(still.length, 1,
                    'indexer ' + ix.index + ' no longer holds the injected row at effective_time ' +
                    (honestEffective - 1) + ' (rows: ' +
                    jsonSafe(rows.map((r) => Number(r.effective_time))) + '). A skipped row must stay ' +
                    'in the table: the design has no retraction path precisely because an unbound row ' +
                    'is harmless.')
            }

            // ---- and the block applied exactly one ------------------------------
            //
            // THE ASSERTION THAT CATCHES HOSTILE F1. The handler re-gates on
            // data['MIRROR_REQUEST'], an in-memory snapshot read once per block, so a
            // selector that returned TWO items for one request would bind twice: two
            // response rows, two fee splits, two callbacks and two actions under the same
            // synthetic TX_HASH. The candidate list rides INSIDE one item exactly so this
            // cannot happen, and this is where that is checked.
            for (const ix of venue.indexers) {
                const rows = await queryDb(venue, ix.indexerDbName,
                    'SELECT COUNT(*) AS n FROM actions a ' +
                    'JOIN index_actions ia ON ia.id = a.action_id ' +
                    'WHERE a.block_index = ? AND ia.action = ? AND a.action_format = 1',
                    [bindBlock, 'ATTEST'])
                const n = Number(rows && rows[0] ? rows[0].n : -1)
                assert.strictEqual(n, 1,
                    'indexer ' + ix.index + ' minted ' + n + ' ATTEST format-1 action(s) at block ' +
                    bindBlock + ' rather than exactly one. A skipped candidate must write NOTHING, not ' +
                    'even an action index, and one request must be dispatched at most once per block.')
            }

            // RE-READ, not the row captured before the injection: the claim is what the
            // request looks like NOW, and the earlier read was taken while it was pending.
            const settledRow = await readRequestRow(venue, 0, requestId)
            assert.strictEqual(String(settledRow.request_status), 'fulfilled',
                'the request is ' + settledRow.request_status + ' after the honest row bound')
            const state = await readContractState(venue, 0, contract.contractIndex)
            assert.strictEqual(JSON.parse(state.callback_status), 'ok',
                'the callback did not fire from the honest row (status ' + state.callback_status + ')')
            assert.strictEqual(JSON.parse(state.callback_payload), FIXED_BODY,
                'the callback carried a body other than the one the provider served')

            console.log('ZC4 GREEN: the inert head was skipped on both indexers, the honest row bound at ' +
                bindBlock + ' with one ATTEST format-1 action, and the inert row is still in the mirror')
        })
})
