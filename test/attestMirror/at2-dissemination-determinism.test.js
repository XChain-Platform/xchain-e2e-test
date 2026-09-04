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
 * AT2, DISSEMINATION AND DETERMINISM. An indexer following a hub that never ran
 * the round must reach byte-identical applied state.
 *
 * The spec's own test: an indexer follows a hub OUTSIDE the request's responsible
 * set; both indexers produce identical `attests`, callback, reward and state-hash
 * rows; then with that hub's gossip delivery delayed past the forward margin the
 * barrier holds and no block is processed early.
 *
 * WHY THE FIRST HALF IS THE WHOLE POINT. With redundancy 3 on five hubs, two hubs
 * never learn a result from the round: a hub outside the set returns before
 * proposing and drops PREPARE and COMMIT for a request it holds no `pending`
 * for. So a row on such a hub can ONLY have arrived as `ATTEST_RESULT` gossip,
 * verified against that hub's own capability snapshot. An indexer following it
 * that lands the same `action_index` at the same block, pays the same pubkeys the
 * same amounts, and commits the same `state_root` is the dissemination claim and
 * the determinism claim at once, and neither is provable on a single node.
 *
 * THE SET IS READ, NEVER DERIVED. `venue.responsibleSetFromMirror` reads the
 * pubkeys that actually signed out of the finalized row. The alternative,
 * `responsibleSetFor`, re-ranks the set in test code and is a mirror of a
 * consensus rule; on a shared chain it also ranks over the wrong pool, because
 * every other suite's staked keys qualify too and this fixture registers none of
 * them. Reading the signatures cannot be wrong about who signed.
 *
 * WHICH INDEXER IS OUTSIDE IS NOT UNDER THIS DRILL'S CONTROL. The hash ranking
 * decides, so on some requests both indexers happen to follow responsible hubs
 * and the leg is unrunnable ON THAT REQUEST. That is a property of the request
 * id, not of the venue, so the drill makes fresh requests until one places an
 * indexer outside, and refuses with the pubkeys printed if none does. It does
 * NOT fall back to asserting on an inside-following indexer, which would pass
 * while testing nothing.
 *
 * THE SECOND HALF IS SKIPPED, and the reason is a measurement rather than an
 * inconvenience. See the comment on the skipped case: the barrier reads a single
 * GLOBAL stream watermark, so no per-row or per-table delay can make it hold.
 *
 * SERIALIZED, not parallel: this drill stakes into the one standing regtest
 * roster, so two live venues corrupt each other's responsible set.
 ********************************************************************/

const assert = require('assert')
const dotenv = require('dotenv')
dotenv.config()

const { AttestMirrorVenue } = require('../helpers/attestMirrorVenue')
const {
    provisionDrillIdentities, waitForVenueIndexersAtTip, startAttestTestServer, deployRequestContract, readContractState,
} = require('./mirrorDrillFixture')
const {
    APPLIED_FIELDS, STATE_HASH_FIELDS, until, diffRows, diffStateHashes,
    rewardFingerprint, waitForMirrorRowEverywhere, waitForAppliedEverywhere,
    readAttestRewards, happyPathVerdict, findEmittedAttestRequest, captureFederationState,
    clearBeforeBroadcast,
    attestRequestWatermark,
    settleOrReport,
    widenArithmetic,
} = require('./mirrorDrillWaits')
const vmHelper = require('../helpers/vmHelper')
const XChainIndexerConnector = require('../../src/XChainIndexerConnector.js')

const FIXED_BODY = '{"score":7,"meta":"at2-dissemination"}'

// Generous, so the standing indexer's expiry sweep (deadline_block + 1) cannot
// fire mid-drill and mark the request expired underneath the round.
const DEADLINE_BLOCKS = 60

// How many fresh requests to make looking for one whose responsible set leaves an
// indexer outside it. Five hubs, redundancy 3, two indexers on distinct hubs: the
// chance both follow responsible hubs is 3 in 10 per request, so six attempts
// leaves under a thousandth of a chance of an unlucky refusal.
const OUTSIDE_ATTEMPTS = 6

const CONTRACT_CODE = `
module.exports = {
    ask: function(xchain) {
        var requestId = xchain.attestation.request(
            xchain.getInputParam(0),
            xchain.getInputParam(1),
            'handleResponse',
            ['ctx-at2'],
            { redundancy: 3, deadlineBlocks: ${DEADLINE_BLOCKS} }
        );
        xchain.state.set('pending_request_id', requestId);
        return requestId;
    },
    handleResponse: function(xchain) {
        xchain.state.set('callback_request_id',  xchain.getInputParam(0));
        xchain.state.set('callback_provider_id', xchain.getInputParam(1));
        xchain.state.set('callback_status',      xchain.getInputParam(2));
        xchain.state.set('callback_payload',     xchain.getInputParam(3));
        xchain.state.set('callback_context',     xchain.getInputParam(4));
    }
};
`

describe('AT2: a hub outside the responsible set disseminates the response, identically', function () {
    // The staking prologue, five hubs, two indexers, and up to six PBFT rounds
    // while the drill looks for a request that places an indexer outside the set.
    this.timeout(90 * 60 * 1000)

    let venue      = null
    let up         = false
    let testServer = null
    let testUrl    = null
    let contract   = null

    before(async function () {
        // REAL TLS, not http. The provider refuses a non-https payload before it
        // does any network work, so a plain-HTTP server here resolves every round
        // provider_error, which reads downstream as a missing mirror row.
        testServer = await startAttestTestServer({ body: FIXED_BODY })
        testUrl    = testServer.url

        // Staked BEFORE the venue exists: the venue does not stake, it takes the
        // identities and expects them already selectable.
        const staked = await provisionDrillIdentities({ label: 'at2', count: 5, redundancy: 3 })

        // needsLlm is false: AT2 says nothing about the llm provider and one
        // `http_get` request carries the whole claim, so requiring a model
        // credential here would make the drill unrunnable on a box for no gain.
        venue = new AttestMirrorVenue({ label: 'at2', identities: staked.identities, hubExtraEnv: testServer.hubEnv })
        up = await venue.start()
        if (!up) {
            console.log('AT2 SKIPPED: ' + venue.unavailable)
            this.skip()
            return
        }

        // BEFORE ANY REQUEST. The venue's indexers replay the borrowed chain from
        // scratch, so at this point they are far behind the tip. A request made now
        // sits at a block they have not reached, and its response reads as "not
        // applied" when the node simply has not got there yet.
        await waitForVenueIndexersAtTip(venue)

        contract = await deployRequestContract({ label: 'at2', code: CONTRACT_CODE })
    })

    after(async function () {
        if (testServer) await testServer.close()
        if (venue) await venue.stop()
    })

    /**
     * Drive one request to a finalized, mirrored row on both indexers.
     *
     * Returns the request id and the signer set actually carried by the row.
     * Deliberately does NOT assert applied state: the caller decides whether this
     * request is the one it wants, and a request that placed no indexer outside
     * the responsible set is discarded rather than asserted on.
     */
    async function driveOneRequest (attempt) {
        // Watermark FIRST: see attestRequestWatermark for why the execute's own
        // action index cannot be trusted as the correlation input.
        const sinceAction = await attestRequestWatermark(contract.contractIndex)
        await clearBeforeBroadcast()
        const exec = await vmHelper.sendExecuteV0(
            contract.owner, contract.contractIndex, 'ask', ['http_get', testUrl])
        assert.strictEqual(exec.execution.status, 'valid',
            'attempt ' + attempt + ': the EXECUTE that emits the request came back ' +
            exec.execution.status + '. A responsible set smaller than redundancy is rejected at ' +
            'admission and rolls the EXECUTE back, so this is the shape a short stake roster takes.')

        const request = await findEmittedAttestRequest(
            contract.contractIndex, sinceAction + 1, { label: 'attempt ' + attempt })
        const requestId = request.requestId

        // The hubs wait three confirmations before they fetch a request, and they
        // poll rather than subscribe.
        await regtestMinerConnector.generateBlocks(6)
        await settleOrReport('at2')

        const rows = await waitForMirrorRowEverywhere(venue, requestId, null, {
            // MINES WHILE WAITING, because the widening ladder is height-driven and a
            // still chain sits at widen 0 forever: a draw containing a key no live hub
            // holds then never finalizes. Capped below the deadline so the wait cannot
            // run the request into its own expiry sweep.
            mineWhileWaiting: { perPoll: 1, maxBlocks: widenArithmetic(DEADLINE_BLOCKS).safeCap },
        })
        for (let i = 0; i < rows.length; i++) {
            assert.strictEqual(String(rows[i].status), 'ok',
                'attempt ' + attempt + ': mirror row status is ' + rows[i].status + ' on indexer ' + i)
        }

        const signers = await venue.responsibleSetFromMirror(0, requestId)
        assert.ok(Array.isArray(signers) && signers.length > 0,
            'attempt ' + attempt + ': the mirror row for ' + requestId + ' carries no signer_pubkeys, ' +
            'so who signed it cannot be established and the outside-hub premise cannot be checked')
        return { requestId: requestId, signers: signers, rows: rows, widen: rows[0].widen }
    }

    it('applies a gossiped response identically on an indexer whose hub never ran the round', async function () {
        let chosen  = null
        let outside = null
        const tried = []

        for (let attempt = 1; attempt <= OUTSIDE_ATTEMPTS && !chosen; attempt++) {
            const driven = await driveOneRequest(attempt)
            tried.push(driven.requestId.slice(0, 12))

            // THE PREMISE NEEDS THE HAPPY PATH, so a widened round is skipped rather
            // than asserted on. With the ladder widened, "did not sign" stops implying
            // "was never responsible", and the whole point of this case is that the
            // hub in question never ran the round. Skipping LOUDLY beats quietly
            // testing a different code path than the acceptance sentence names.
            const path = happyPathVerdict({
                widen: driven.widen, signers: driven.signers, ownPubkeys: venue.getPubkeys(),
            })
            if (!path.happy) {
                console.log('AT2 SKIPPED on request ' + driven.requestId.slice(0, 12) + ': ' + path.why)
                this.skip()
                return
            }

            try {
                outside = venue.pickIndexerOutsideResponsibleSet(driven.signers)
                chosen  = driven
            } catch (e) {
                // Not a failure: this REQUEST cannot carry the leg, because the hash
                // ranking put both followed hubs in the set. Say so and make another.
                console.log('AT2: request ' + driven.requestId.slice(0, 12) +
                    ' put both followed hubs inside the responsible set; making another')
            }
        }
        assert.ok(chosen, 'AT2 drove ' + tried.length + ' requests (' + tried.join(', ') +
            ') and every one of them ranked BOTH followed hubs into the responsible set, so no ' +
            'indexer was ever outside it and the dissemination leg could not be driven. This is ' +
            'about the hash ranking rather than the venue; raising OUTSIDE_ATTEMPTS is the fix if ' +
            'it ever recurs.')

        const requestId = chosen.requestId
        const inside    = venue.indexers.find((ix) => ix.index !== outside.index)
        assert.ok(inside, 'the venue stood up fewer than two indexers, so nothing can be compared')
        console.log('AT2: request ' + requestId.slice(0, 12) + ' signed by ' +
            chosen.signers.length + ' hubs; indexer ' + outside.index + ' follows hub ' +
            outside.followsHub + ', which is OUTSIDE that set')

        // THE PREMISE, asserted rather than assumed. `pickIndexerOutsideResponsibleSet`
        // throws when nothing is outside, but it compares what it was given, so the
        // claim is restated here against the row's own signer list.
        const signerSet = new Set(chosen.signers.map((s) => String(s).toLowerCase()))
        assert.ok(!signerSet.has(String(outside.hubPubkey).toLowerCase()),
            'the hub indexer ' + outside.index + ' follows is in the signer set after all, so this ' +
            'row could have reached it through the round rather than through gossip')

        // DISSEMINATION, at the hub. The outside hub SERVES the row on its own
        // snapshot route, which is what an indexer bootstraps from. Read through the
        // route rather than the hub's table: a hub whose HTTP surface never came up
        // would pass a direct database read and serve nothing.
        const served = await until(async () => {
            const snap = await venue.hubSnapshot(outside.followsHub).catch(() => null)
            const hit  = snap && Array.isArray(snap.rows) &&
                snap.rows.find((r) => String(r.request_id) === requestId)
            return { ok: !!hit, row: hit, snap: snap }
        }, 5 * 60 * 1000)
        assert.ok(served.ok,
            'hub ' + outside.followsHub + ', which ran no round for ' + requestId + ', does not serve ' +
            'the row on /hub-db/snapshot/attestation_responses. Either ATTEST_RESULT gossip did not ' +
            'reach it or its verifier refused the row, and in both cases an indexer following it ' +
            'would never see the response.\n' + venue.logTail('hub' + outside.followsHub))
        assert.strictEqual(String(served.row.response_hash), String(chosen.rows[0].response_hash),
            'the outside hub serves a DIFFERENT response hash than the round produced, so the ' +
            'federation did not converge on one answer')

        // IDENTICAL `attests` ROWS. Every field, including the locally minted
        // action_index: two nodes agreeing on that is a statement about the applier
        // running at the same pipeline position in the same block on both.
        const applied = await waitForAppliedEverywhere(venue, requestId)
        const a0 = applied[outside.index]
        const a1 = applied[inside.index]
        const rowDiffs = diffRows(a0, a1, APPLIED_FIELDS)
        assert.deepStrictEqual(rowDiffs, [],
            'the outside-following indexer ' + outside.index + ' and the inside-following indexer ' +
            inside.index + ' hold different applied rows for ' + requestId + ': ' + rowDiffs.join('; ') +
            '. A differing block_index is a divergent applying block, which is the fork the forward ' +
            'margin and the barrier exist to prevent; a differing action_index with the same block is ' +
            'the applier running at a different pipeline position.')
        assert.strictEqual(a0.tx_index, null,
            'the applied row on the outside-following indexer carries tx_index ' + a0.tx_index +
            ' rather than NULL, so something gave the response a transaction')
        const appliedBlock = Number(a0.block_index)
        console.log('AT2: both indexers applied ' + requestId.slice(0, 12) + ' as action ' +
            a0.action_index + ' at block ' + appliedBlock)

        // IDENTICAL CALLBACK EFFECT, read out of contract state on both nodes. The
        // applied row proves the applier ran; this proves what it injected.
        const state0 = await readContractState(venue, outside.index, contract.contractIndex)
        const state1 = await readContractState(venue, inside.index,  contract.contractIndex)
        for (const key of ['callback_request_id', 'callback_provider_id', 'callback_status',
                           'callback_payload', 'callback_context']) {
            assert.strictEqual(String(state0[key]), String(state1[key]),
                'the two indexers disagree about contract state ' + key + ' after the callback: ' +
                state0[key] + ' vs ' + state1[key])
        }
        assert.strictEqual(JSON.parse(state0.callback_status), 'ok',
            'callback_status on the outside-following indexer is ' + state0.callback_status)
        assert.strictEqual(JSON.parse(state0.callback_payload), FIXED_BODY,
            'the callback payload is not the body the provider served')

        // IDENTICAL REWARD ROWS. Compared as (type, pubkey, amount, block) rather
        // than row for row, because the surrogate keys are per-database
        // autoincrements and would differ on every honest run.
        const rewards0 = rewardFingerprint(await readAttestRewards(venue, outside.index, appliedBlock))
        const rewards1 = rewardFingerprint(await readAttestRewards(venue, inside.index,  appliedBlock))
        assert.ok(rewards0.length > 0,
            'no attest_fee rows at block ' + appliedBlock + ' on the outside-following indexer, so the ' +
            'applier fired the callback without settling the request fee to the signers')
        assert.deepStrictEqual(rewards0, rewards1,
            'the two indexers paid different rewards at block ' + appliedBlock + ':\n  outside: ' +
            rewards0.join('\n  outside: ') + '\n  inside:  ' + rewards1.join('\n  inside:  '))

        // IDENTICAL STATE-HASH ROWS at the applying block, which is the only one of
        // these four assertions that would catch a divergence in something this
        // drill did not think to read.
        const conn0 = new XChainIndexerConnector('127.0.0.1', venue.indexers[outside.index].apiPort, null)
        const conn1 = new XChainIndexerConnector('127.0.0.1', venue.indexers[inside.index].apiPort, null)
        const h0 = await conn0.call('getblockhashes', { block_index: appliedBlock })
        const h1 = await conn1.call('getblockhashes', { block_index: appliedBlock })
        assert.ok(h0 && !h0.error, 'indexer ' + outside.index + ' would not report block hashes at ' +
            appliedBlock + ': ' + JSON.stringify(h0))
        assert.ok(h1 && !h1.error, 'indexer ' + inside.index + ' would not report block hashes at ' +
            appliedBlock + ': ' + JSON.stringify(h1))
        const hashDiffs = diffStateHashes(h0, h1)
        assert.deepStrictEqual(hashDiffs, [],
            'the two indexers disagree on ' + hashDiffs.join('; ') + ' at the applying block ' +
            appliedBlock + ', which is a fork rather than lag')
        console.log('AT2: no divergence at block ' + appliedBlock + '; ' +
            STATE_HASH_FIELDS.length + ' hash fields identical, state_root ' +
            String(h0.state_root).slice(0, 16) + '...')
    })

    /**
     * PARKED ON A MEASUREMENT, not on convenience, and it needs an operator ruling
     * rather than work.
     *
     * AT2's second clause reads: with that hub's gossip delivery delayed past the
     * forward margin, the barrier holds and no block is processed early. The venue
     * has the delay lever (`venue.delayHubGossip`, a byte-level P2P proxy that
     * leaves the hub's `/hub-db/*` surface serving), so the injection is available.
     * The BARRIER is what cannot respond to it.
     *
     * Measured in `xchain-indexer/src/hub_db_sync.js`: the barrier's predicate is
     *
     *     streamWatermark >= blockTime + attestResponseWatermarkGraceS
     *
     * and `streamWatermark` is ONE GLOBAL scalar, advanced only by the followed
     * hub's `watermark` heartbeat frames. It is not per table and it is not per
     * row. So while the followed hub is alive and heart-beating, the barrier is
     * satisfied no matter which rows have or have not arrived, and while the hub is
     * dead every barrier starves together. The module says as much in its own
     * comment: an empty mirror is indistinguishable from a mirror that has not been
     * told about the row that binds at this very block.
     *
     * What a delay past the forward margin therefore produces is not a hold. The
     * outside hub gets the row late, its indexer passes the intervening blocks with
     * the barrier satisfied and the row absent, and the row then binds at the first
     * LATER block satisfying §4.1. That is a divergent applying block between the
     * two nodes, i.e. exactly the fork the margin exists to prevent, and it is
     * observable as a difference rather than as a park.
     *
     * THIS ALSO BEARS ON THE PENDING AT0 RULING, and the finding cuts against
     * option 1 there: a route-level injection withholding only
     * `attestation_responses` would not make this barrier hold either, for the same
     * reason, and it would not make AT0 park at all, since the heartbeat would keep
     * every barrier satisfied. The lever that DOES name this barrier without any
     * venue change is grace asymmetry: `new AttestMirrorVenue({graces: {attestResponse: N}})`
     * leaves every other barrier at 0, and a watermark lagging by less than N then
     * fails this barrier's predicate alone.
     *
     * So there are two honest ways to close this clause and both are the operator's:
     *   1. re-word it to the property the design has, namely that with the margin
     *      above the gossip delay both nodes bind at the same block, and below it
     *      they diverge (the drill above proves the first half today);
     *   2. keep the wording and rule that the barrier should hold on per-row
     *      completeness, which is a design change to the watermark, not a test.
     */
    it.skip('holds the barrier when delivery is delayed past the forward margin (DRIVEN in at2b, see comment)',
        async function () {
            // NOT a pending question any more: the operator ruled on 2026-09-04 and the
            // lever was built, so this clause IS driven, in
            // `at2b-forward-margin.test.js`. It lives there rather than here because it
            // needs one indexer running a RAISED `attestResponse` grace, and a raised
            // grace makes every freshly mined block wait that grace out on that node,
            // which would tax the dozens of blocks the case above mines while it hunts
            // for a request whose responsible set leaves an indexer outside it.
            //
            // The comment above still records WHY the delay alone is not enough, and
            // that reasoning is now in the spec at section 4.2 as well.
            assert.fail('unreachable: this clause is driven in at2b-forward-margin.test.js')
        })
})
