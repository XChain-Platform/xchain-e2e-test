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
 * AT3, THE DEADLINE. The binding rule's second clause, driven at its boundary.
 *
 * The spec's own test: a row whose first satisfying block is past the deadline is
 * never applied and the expired callback stands; one satisfied at the deadline
 * block is applied.
 *
 * WHY THE BOUNDARY IS ARRANGEABLE HERE AND NOT A RACE. Section 4.1 binds a row at
 * the first block B with `effective_time <= t(B)` and `B <= deadline_block`, and on
 * regtest `t(B)` is the block's RAW stamp: `PROTOCOL_TIME_MTP_NETWORKS.regtest` is
 * false in `xchain-indexer/src/protocol_time.js`, so the median-time-past rule that
 * governs testnet does not apply and a block mined now is stamped now. That single
 * fact is what turns this drill from a race into arithmetic: with the miner paused,
 * mining before the effective time produces blocks that CANNOT satisfy the rule, and
 * mining one block after it produces the first that can, at a height this drill
 * chose.
 *
 * NOTE FOR THE SPEC: §4.1 describes `getBlockTime` as "MTP on testnet and regtest,
 * raw stamp on mainnet". The code says regtest is raw-stamp, deliberately and with
 * its reasons written out. Nothing in this drill depends on the spec's wording being
 * right, because it computes the applying block from the venue's own block stamps
 * rather than from an assumption, but the sentence should be corrected.
 *
 * THE FORWARD MARGIN IS THE FROZEN 120 HERE, not the venue's fast default of 5.
 * Both cases need a usable window between "the row exists" and "a block can satisfy
 * it", and 120s is both the production constant and comfortably longer than the few
 * seconds it takes to mine a dozen empty blocks. It costs this drill two waits of
 * about two minutes and buys a boundary that does not depend on how fast the venue
 * happens to be.
 *
 * MINING IS PAUSED for every height-critical section and resumed in a finally. The
 * regtest miner runs an adaptive auto-mine loop, and one stray block inside the
 * window between "mine up to the deadline minus one" and "mine the deadline block"
 * would move the boundary under the assertion. `pauseMining` is the right barrier
 * for it rather than a slowed cadence: it clears `keepMining` AND awaits the mine
 * queue, so a generation already in flight cannot still land and put the height off
 * by one, and explicit `generateBlocks` calls keep working while it is paused. That
 * combination is what `test/parity/multichain-parity.test.js` relies on to pin an
 * exact baseline height, and this drill needs exactly the same guarantee.
 *
 * SERIALIZED, not parallel: this drill stakes into the one standing regtest roster.
 ********************************************************************/

const assert = require('assert')
const dotenv = require('dotenv')
dotenv.config()

const { AttestMirrorVenue } = require('../helpers/attestMirrorVenue')
const {
    provisionDrillIdentities, startAttestTestServer, deployRequestContract, readContractState,
    readAppliedResponse,
} = require('./mirrorDrillFixture')
const {
    untilOrClearDogeStall, waitForMirrorRowEverywhere, waitForAppliedEverywhere,
    readBlockWindow, readRequestRow, firstSatisfyingBlock, venueTipProbe,
    findEmittedAttestRequest, captureFederationState,
    clearBeforeBroadcast,
    waitForHeightWithClear,
    attestRequestWatermark,
    settleOrReport,
} = require('./mirrorDrillWaits')
const vmHelper = require('../helpers/vmHelper')

const FIXED_BODY = '{"score":3,"meta":"at3-deadline"}'

// The frozen protocol value, used deliberately rather than the venue's fast
// default: see the header.
const FORWARD_S = 120

// Blocks to bury a request so the hubs will fetch it (they wait three
// confirmations and poll rather than subscribe).
const BURIAL_BLOCKS = 6

// Both cases take a generous deadline and the drill mines to the boundary itself,
// so neither depends on the round finalizing within a particular number of blocks.
const DEADLINE_BLOCKS = 30

const CONTRACT_CODE = `
module.exports = {
    ask: function(xchain) {
        var requestId = xchain.attestation.request(
            xchain.getInputParam(0),
            xchain.getInputParam(1),
            'handleResponse',
            [xchain.getInputParam(2)],
            { redundancy: 3, deadlineBlocks: ${DEADLINE_BLOCKS} }
        );
        return requestId;
    },
    handleResponse: function(xchain) {
        // Keyed by the caller's tag, which rides back as the first callback
        // parameter, so two cases can share one contract without overwriting each
        // other's evidence.
        var tag = xchain.getInputParam(4);
        xchain.state.set('request_' + tag, xchain.getInputParam(0));
        xchain.state.set('status_'  + tag, xchain.getInputParam(2));
        xchain.state.set('payload_' + tag, xchain.getInputParam(3));
    }
};
`

describe('AT3: the deadline decides whether a mirrored response ever binds', function () {
    // The staking prologue, five hubs, two indexers, two PBFT rounds and two
    // waits of a forward margin.
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

        const staked = await provisionDrillIdentities({ label: 'at3', count: 5, redundancy: 3 })
        venue = new AttestMirrorVenue({ label: 'at3', identities: staked.identities, forwardS: FORWARD_S, hubExtraEnv: testServer.hubEnv })
        up = await venue.start()
        if (!up) {
            console.log('AT3 SKIPPED: ' + venue.unavailable)
            this.skip()
            return
        }
        contract = await deployRequestContract({ label: 'at3', code: CONTRACT_CODE })
    })

    after(async function () {
        // Mining is resumed by each case's own finally; this is the belt to that
        // brace, because a case that threw before its finally would otherwise leave
        // the shared venue's miner paused for every drill after it.
        try { await regtestMinerConnector.resumeMining() } catch (_) { /* never paused */ }
        if (testServer) await testServer.close()
        if (venue) await venue.stop()
    })

    /**
     * Emit a request, bury it, and wait for the finalized row to reach both
     * indexers WITHOUT mining past the burial.
     *
     * Not mining while the round runs is what keeps the deadline arithmetic this
     * drill depends on: the chain sits still at a known height until the drill
     * itself decides to move it.
     */
    async function driveToMirrorRow (tag) {
        // Watermark FIRST: see attestRequestWatermark for why the execute's own
        // action index cannot be trusted as the correlation input.
        const sinceAction = await attestRequestWatermark(contract.contractIndex)
        await clearBeforeBroadcast()
        const exec = await vmHelper.sendExecuteV0(
            contract.owner, contract.contractIndex, 'ask', ['http_get', testUrl, tag])
        assert.strictEqual(exec.execution.status, 'valid',
            tag + ': the EXECUTE that emits the request came back ' + exec.execution.status)

        const request = await findEmittedAttestRequest(
            contract.contractIndex, sinceAction + 1, { label: tag })
        const requestId = request.requestId

        await regtestMinerConnector.generateBlocks(BURIAL_BLOCKS)
        await settleOrReport('at3')

        // NO KEEP-MINING HERE, DELIBERATELY, and this is an opt-out rather than an
        // omission. Every other drill mines while waiting so the height-driven
        // widening ladder can climb. This drill's entire subject is the deadline
        // boundary: it counts blocks to place the applying block exactly at or past
        // the deadline, so a wait that mined would move the boundary under the
        // assertion. The cost is that a draw containing a key no live hub holds
        // cannot finalize here and the drill fails with the capture saying so, which
        // is the correct trade for a drill about heights.
        const rows = await waitForMirrorRowEverywhere(venue, requestId)
        assert.strictEqual(String(rows[0].status), 'ok',
            tag + ': the round did not produce an ok response, so the deadline is not what is under test')

        const local = await readRequestRow(venue, 0, requestId)
        assert.ok(local, tag + ': the venue indexer holds no v0 request row for ' + requestId)

        const effectiveTime = Number(rows[0].effective_time)
        assert.ok(Number.isFinite(effectiveTime) && effectiveTime > 0,
            tag + ': the mirror row carries no usable effective_time (' + rows[0].effective_time + ')')

        return {
            requestId: requestId,
            effectiveTime: effectiveTime,
            deadlineBlock: Number(local.deadline_block),
            requestBlock: Number(local.block_index),
        }
    }

    /** The chain's own height, asked of the node rather than of any indexer. */
    async function chainHeight () { return Number(await nodeConnector.getBlockCount()) }

    /**
     * Mine `count` blocks and refuse if the effective time has passed while doing
     * it, because every block this drill mines BEFORE the effective time is a block
     * that must not satisfy the rule. Checked rather than assumed: if the venue is
     * slow enough that the margin elapses mid-loop, this drill's premise is gone and
     * it must say so instead of asserting something it no longer arranged.
     */
    async function mineBefore (effectiveTime, count, label) {
        for (let i = 0; i < count; i++) {
            await regtestMinerConnector.generateBlocks(1)
            const now = Math.floor(Date.now() / 1000)
            assert.ok(now < effectiveTime,
                label + ': the forward margin elapsed after ' + i + ' of ' + count + ' blocks (now ' + now +
                ', effective_time ' + effectiveTime + '), so a block this drill mined to be UNSATISFYING may ' +
                'satisfy the rule instead. The premise is gone; nothing about the deadline was tested. Raise ' +
                'FORWARD_S or investigate why mining ' + count + ' empty blocks took over ' + FORWARD_S + 's.')
        }
    }

    it('never applies a row whose first satisfying block would be past the deadline', async function () {
        const tag = 'expire'
        const driven = await driveToMirrorRow(tag)

        await regtestMinerConnector.pauseMining()
        try {
            // Straight past the deadline, every block stamped before the effective
            // time, so no block at or below the deadline can ever satisfy the rule
            // and no block above it is eligible at all.
            const from = await chainHeight()
            const to   = driven.deadlineBlock + 1
            assert.ok(to > from,
                tag + ': the chain is already at ' + from + ', past the deadline ' + driven.deadlineBlock +
                ', so the expiry has already happened and this case arranged nothing')
            await mineBefore(driven.effectiveTime, to - from, tag)
        } finally {
            await regtestMinerConnector.resumeMining()
        }
        await settleOrReport('at3')

        // Both indexers past the expiry block, so the sweep has run on both.
        for (const ix of venue.indexers) await waitForHeightWithClear(venue, ix.index, driven.deadlineBlock + 1)

        // THE PRECONDITION, MEASURED rather than trusted: no block in the request's
        // whole eligible window reached the effective time. Without this the case
        // could pass because the row was late rather than because the deadline
        // foreclosed it.
        const window = await readBlockWindow(venue, 0, driven.requestBlock, driven.deadlineBlock)
        const wouldBind = firstSatisfyingBlock(window, driven.effectiveTime, driven.deadlineBlock)
        assert.strictEqual(wouldBind, null,
            tag + ': block ' + wouldBind + ' is at or below the deadline ' + driven.deadlineBlock +
            ' and DID reach the effective time ' + driven.effectiveTime + ', so the row was applicable after ' +
            'all and this case is not testing the deadline')

        for (const ix of venue.indexers) {
            const req = await readRequestRow(venue, ix.index, driven.requestId)
            assert.strictEqual(String(req.request_status), 'expired',
                tag + ': indexer ' + ix.index + ' reports request_status ' + req.request_status +
                ' rather than expired at block ' + (driven.deadlineBlock + 1) + '\n' +
                venue.logTail('indexer' + ix.index))
            assert.strictEqual(Number(req.resolved_block), driven.deadlineBlock + 1,
                tag + ': the expiry resolved at block ' + req.resolved_block + ' rather than at deadline_block + 1')

            const applied = await readAppliedResponse(venue, ix.index, driven.requestId)
            assert.strictEqual(applied, null,
                tag + ': indexer ' + ix.index + ' APPLIED the response anyway, as action ' +
                (applied && applied.action_index) + ' at block ' + (applied && applied.block_index) +
                '. A row whose first satisfying block is past the deadline must never be applied.')
        }

        // THE EXPIRED CALLBACK STANDS. Status is the literal 'expired' and the
        // payload is empty, which is what the expiry injects; a mirror apply would
        // have written 'ok' and a body over the top of it.
        const state = await readContractState(venue, 0, contract.contractIndex)
        assert.strictEqual(JSON.parse(state['status_' + tag]), 'expired',
            tag + ': the contract carries callback status ' + state['status_' + tag] + ' rather than expired')
        assert.strictEqual(JSON.parse(state['payload_' + tag]), '',
            tag + ': the expired callback carried a payload, so something answered it')

        // AND IT KEEPS STANDING once the effective time genuinely passes. Without
        // this the case only proves the row was early, not that the deadline
        // permanently forecloses it.
        const elapsed = await untilOrClearDogeStall(
            async () => ({ ok: Math.floor(Date.now() / 1000) > driven.effectiveTime }),
            { timeoutMs: (FORWARD_S + 120) * 1000, intervalMs: 5000, tipProbe: venueTipProbe(venue, 0) })
        assert.ok(elapsed.ok, tag + ': wall clock never passed the effective time ' + driven.effectiveTime)
        await regtestMinerConnector.generateBlocks(5)
        await settleOrReport('at3')
        for (const ix of venue.indexers) await waitForHeightWithClear(venue, ix.index, driven.deadlineBlock + 6)

        for (const ix of venue.indexers) {
            const applied = await readAppliedResponse(venue, ix.index, driven.requestId)
            assert.strictEqual(applied, null,
                tag + ': indexer ' + ix.index + ' applied the response at block ' + (applied && applied.block_index) +
                ', AFTER the effective time passed. The deadline must foreclose the row permanently: the ' +
                'applicability read is (effective_time <= t(B) AND B <= deadline_block), and the second half ' +
                'can never be true again.')
            const req = await readRequestRow(venue, ix.index, driven.requestId)
            assert.strictEqual(String(req.request_status), 'expired',
                tag + ': the request left the expired state on indexer ' + ix.index + ' (now ' + req.request_status + ')')
        }
        console.log('AT3: request ' + driven.requestId.slice(0, 12) + ' expired at block ' +
            (driven.deadlineBlock + 1) + ' and stayed unapplied past its effective time')
    })

    it('applies a row whose first satisfying block IS the deadline block', async function () {
        const tag = 'boundary'
        const driven = await driveToMirrorRow(tag)

        await regtestMinerConnector.pauseMining()
        try {
            // Up to one block BELOW the deadline, all stamped before the effective
            // time so none of them can bind.
            const from = await chainHeight()
            const need = (driven.deadlineBlock - 1) - from
            assert.ok(need >= 0,
                tag + ': the chain is at ' + from + ' and the deadline is ' + driven.deadlineBlock +
                ', so there is no room left to place the boundary block deliberately')
            if (need > 0) await mineBefore(driven.effectiveTime, need, tag)

            const atFloor = await chainHeight()
            assert.strictEqual(atFloor, driven.deadlineBlock - 1,
                tag + ': the chain is at ' + atFloor + ' rather than one below the deadline (' +
                (driven.deadlineBlock - 1) + '), so the next block will not be the deadline block. The ' +
                'auto-miner is the usual cause and it is meant to be paused here.')

            // Wait out the forward margin with the chain STILL, then mine exactly one
            // block. On regtest that block is stamped now, so it is the first block
            // whose protocol time reaches the effective time, and its height is the
            // deadline.
            const elapsed = await untilOrClearDogeStall(
                async () => ({ ok: Math.floor(Date.now() / 1000) > driven.effectiveTime }),
                { timeoutMs: (FORWARD_S + 120) * 1000, intervalMs: 5000, tipProbe: venueTipProbe(venue, 0) })
            assert.ok(elapsed.ok, tag + ': wall clock never passed the effective time ' + driven.effectiveTime)

            await regtestMinerConnector.generateBlocks(1)
            const atDeadline = await chainHeight()
            assert.strictEqual(atDeadline, driven.deadlineBlock,
                tag + ': the block just mined is height ' + atDeadline + ', not the deadline block ' +
                driven.deadlineBlock)
        } finally {
            await regtestMinerConnector.resumeMining()
        }
        await settleOrReport('at3')

        const applied = await waitForAppliedEverywhere(venue, driven.requestId)

        // The measured prediction, from the venue's own block stamps: §4.1 says the
        // first satisfying block binds, and here that block is the deadline itself.
        const window = await readBlockWindow(venue, 0, driven.requestBlock, driven.deadlineBlock)
        const predicted = firstSatisfyingBlock(window, driven.effectiveTime, driven.deadlineBlock)
        assert.strictEqual(predicted, driven.deadlineBlock,
            tag + ': the first satisfying block computed from the chain is ' + predicted +
            ', not the deadline block ' + driven.deadlineBlock + ', so this case did not arrange the boundary ' +
            'it exists to drive')

        for (const ix of venue.indexers) {
            assert.strictEqual(Number(applied[ix.index].block_index), driven.deadlineBlock,
                tag + ': indexer ' + ix.index + ' applied at block ' + applied[ix.index].block_index +
                ' rather than at the deadline block ' + driven.deadlineBlock + '. Inclusive means inclusive: ' +
                'a row satisfied exactly at the deadline binds there.')
            const req = await readRequestRow(venue, ix.index, driven.requestId)
            assert.strictEqual(String(req.request_status), 'fulfilled',
                tag + ': indexer ' + ix.index + ' reports request_status ' + req.request_status +
                ' rather than fulfilled')
        }

        const state = await readContractState(venue, 0, contract.contractIndex)
        assert.strictEqual(JSON.parse(state['status_' + tag]), 'ok',
            tag + ': the callback fired with status ' + state['status_' + tag])
        assert.strictEqual(JSON.parse(state['payload_' + tag]), FIXED_BODY,
            tag + ': the callback payload is not the body the provider served')
        console.log('AT3: request ' + driven.requestId.slice(0, 12) + ' bound at its deadline block ' +
            driven.deadlineBlock + ' on both indexers')
    })
})
