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
 * ZC2, THE RE-MINE. Serving at zero confirmations means a request can reorg under
 * a round that already ran, and the operator accepted that spend as a cost of
 * business (ruling 2026-09-07). What must NOT happen is paying twice.
 *
 * The spec's own test (zero-confirmation-flip §10 ZC2), on the keep case of
 * `at4-reorg.test.js`: the pre-reorg row re-binds; exactly one `attest_fee` split
 * exists after 25 further blocks; `fetch_count` on every responsible hub reads one
 * more than it did before this request existed.
 *
 * WHAT ACTUALLY PROTECTS THE SECOND FETCH, and it is not the cache (§0 fact 2,
 * D40). The durable `attestation_fetch_cache` is time-windowed at `retryAfterMs`,
 * 123 s at this train's defaults, which is shorter than one live block; on mainnet
 * it is empty long before a reorg is noticed. What refuses the second round is the
 * hub's `finalized` ring (10000 rids, `AttestationConsensus.js:495`), which is
 * keyed on the request id, and the request id is content-derived from the
 * transaction hash and is therefore REORG-STABLE (D3). So the re-mined request is
 * the same request, the ring refuses to start a second round for it, and no second
 * fetch happens at all. That is why this drill asserts `fetch_count` and not a
 * cache-hit counter: a cache-hit assertion would pass on regtest for 123 s and be
 * false on every live network.
 *
 * EXCLUSIVE ON THE SHARED REGTEST CHAIN, not merely serialized: it orphans blocks
 * out from under whatever else is on that chain, exactly as AT4 does. Nothing else
 * may be running against this venue or this chain.
 *
 * NO BURIAL BLOCKS, and that is the flip itself. AT4 mines four before the hubs
 * will look at a request; above the zero-conf height the hub serves at tip N, so
 * the round is already finished when the reorg is staged and the reorg stays well
 * inside the standing utxo-tracker's twelve-block undo window with room to spare.
 *
 * WALL-TIME BUDGET: about 45 minutes, most of it the venue's indexers replaying
 * the borrowed chain from genesis plus the 25-block settle.
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
    APPLIED_FIELDS, untilOrClearDogeStall, diffRows,
    waitForMirrorRowEverywhere, waitForAppliedEverywhere, waitForHeightWithClear,
    readAppliedResponse, readContractState, readRequestRow, readAttestRewards, rawAttestRewards,
    venueTipProbe, findEmittedAttestRequest, attestRequestWatermark,
    clearBeforeBroadcast, settleOrReport, feeLines, allHubTails, jsonSafe,
} = require('./mirrorDrillWaits')
const vmHelper     = require('../helpers/vmHelper')
const cryptoHelper = require('../cryptoHelper')

const FIXED_BODY = '{"score":13,"meta":"zc2-remine"}'

const POLL_MS   = 3000
const FORWARD_S = 3

// Generous, so nothing under test races the expiry sweep while blocks are being
// orphaned, remade and then mined 25 deep.
const DEADLINE_BLOCKS = 90

// How far past the orphan point the competing chain is built. Two is enough to make
// it strictly longer than what it replaces, which is what makes the node switch.
const COMPETING_OVERSHOOT = 2

// The standing BTC utxo-tracker's reorg recovery window (xchain-utxo-tracker
// DEFAULT_UNDO_BLOCKS for BTC). A reorg deeper than this halts that tracker for
// every drill after this one.
const TRACKER_UNDO_BLOCKS = 12

// The blocks mined after the re-bind before the reward assertion. The spec's own
// figure: long enough that a second settle triggered by anything late would have
// landed and be visible, rather than being absent because nothing has run yet.
const SETTLE_BLOCKS = 25

// A REAL ESCROW, because the money half of this drill is a statement about how many
// times an escrow is split. Without feeTick/feeAmount the request is fee=none,
// fee_amount is NULL and there is no attest_fee row to count. Chosen so the split
// leaves a positive whole share at every responsible-set size the ladder can reach:
// XCHAIN's ISSUE row carries decimals 0 on this chain (measured 2026-09-05), so a
// unit here is a whole XCHAIN and 6 divides usefully by 3, 4, 5 and 6.
const FEE_XCHAIN = '6'

const CONTRACT_CODE = `
module.exports = {
    ask: function(xchain) {
        var requestId = xchain.attestation.request(
            xchain.getInputParam(0),
            xchain.getInputParam(1),
            'handleResponse',
            ['ctx-zc2'],
            { redundancy: 3, deadlineBlocks: ${DEADLINE_BLOCKS}, feeTick: 'XCHAIN', feeAmount: '${FEE_XCHAIN}' }
        );
        return requestId;
    },
    handleResponse: function(xchain) {
        xchain.state.set('callback_status',  xchain.getInputParam(2));
        xchain.state.set('callback_payload', xchain.getInputParam(3));
    }
};
`

describe('ZC2: a re-mined request re-binds once and is paid for once', function () {
    this.timeout(90 * 60 * 1000)

    let venue      = null
    let up         = false
    let testServer = null
    let testUrl    = null
    let contract   = null
    let minerAddr  = null

    before(async function () {
        // REAL TLS, not http. The provider refuses a non-https payload before it does
        // any network work, so a plain-HTTP server resolves every round provider_error,
        // which reads downstream as a missing mirror row.
        testServer = await startAttestTestServer({ body: FIXED_BODY })
        testUrl    = testServer.url

        const staked = await provisionDrillIdentities({ label: 'zc2', count: 5, redundancy: 3 })
        venue = new AttestMirrorVenue({
            label: 'zc2', identities: staked.identities, hubExtraEnv: testServer.hubEnv,
            attestationPollMs: POLL_MS, forwardS: FORWARD_S,
        })
        up = await venue.start()
        if (!up) {
            console.log('ZC2 SKIPPED: ' + venue.unavailable)
            this.skip()
            return
        }

        // BEFORE ANY REQUEST. The venue's indexers replay the borrowed chain from
        // scratch, so at this point they are far behind the tip.
        await waitForVenueIndexersAtTip(venue)
        contract = await deployRequestContract({ label: 'zc2', code: CONTRACT_CODE })
        // The competing chain's coinbase destination. Its own address, so the orphaned
        // chain's coinbases and the new one's are never confused.
        minerAddr = (await cryptoHelper.getNewAddress('zc2-miner', COIN, NETWORK, null, 'legacy', 0)).address
    })

    after(async function () {
        try { await regtestMinerConnector.resumeMining() } catch (e) {
            console.log('ZC2 teardown: resumeMining failed (' + (e && e.message) +
                '); the shared miner may still be paused')
        }
        if (testServer) await testServer.close()
        if (venue) await venue.stop()
    })

    /**
     * Orphan everything at and above `height` and replace it with EMPTY blocks.
     *
     * `generateBlock(address, [])` mines a block containing its coinbase and nothing
     * else, ignoring the mempool entirely, which keeps a transaction that just
     * returned to the mempool from being mined straight back into the replacement
     * chain. Copied from AT4 deliberately rather than shared: the reorg mechanics are
     * the thing under test in both, and a shared copy would let a change to one
     * silently change what the other proves.
     */
    async function orphanFrom (height, label) {
        const tipBefore = Number(await nodeConnector.getBlockCount())
        const depth = tipBefore - height + 1
        assert.ok(depth <= TRACKER_UNDO_BLOCKS,
            label + ': orphaning from ' + height + ' at tip ' + tipBefore + ' is ' + depth +
            ' blocks deep, past the standing utxo-tracker\'s ' + TRACKER_UNDO_BLOCKS + '-block undo ' +
            'window; the tracker would halt and need a resync. Fewer blocks must land between the ' +
            'request and the reorg.')
        const hash = await nodeConnector.getBlockHash(height)
        await nodeConnector.invalidateBlock(hash)
        const rolled = Number(await nodeConnector.getBlockCount())
        assert.strictEqual(rolled, height - 1,
            label + ': the node sits at ' + rolled + ' after invalidating block ' + height +
            ', expected ' + (height - 1))

        const need = tipBefore - (height - 1) + COMPETING_OVERSHOOT
        for (let i = 0; i < need; i++) await nodeConnector.generateBlock(minerAddr, [])
        const tipAfter = Number(await nodeConnector.getBlockCount())
        assert.ok(tipAfter > tipBefore,
            label + ': the competing chain reached ' + tipAfter + ', which does not overtake ' +
            tipBefore + ', so the node would not switch to it')
        assert.notStrictEqual(await nodeConnector.getBlockHash(height), hash,
            label + ': block ' + height + ' still has its original hash, so nothing actually reorged')
        return { tipBefore: tipBefore, tipAfter: tipAfter, orphanedHash: hash }
    }

    /**
     * Leave the stack QUIESCENT before handing back to the harness.
     *
     * The global afterEach barrier gives the stack 15 s to reach mempool-empty with
     * the tracker level with the node, and fails the case if it does not. A deliberate
     * reorg is the one thing on this venue that legitimately leaves the tracker tens
     * of blocks behind, so the case waits the tracker in itself.
     */
    async function settleAfterReorg (label) {
        const status = await utxoTrackerConnector.quiesce({
            timeoutMs: 4 * 60 * 1000, pollMs: 500, regtestMiner: regtestMinerConnector,
        }).catch((e) => ({ ready: false, error: String(e && e.message) }))
        if (!status || !status.ready) {
            console.log('ZC2 ' + label + ': the stack did not settle after the reorg (' +
                JSON.stringify(status) + '); the harness barrier will say so')
        }
    }

    it('re-binds the pre-reorg row, splits the escrow once, and never re-fetches', async function () {
        // ---- the baseline, before this request can exist ----------------------
        //
        // A DELTA, NOT AN ABSOLUTE, and this is a measurement rather than a hedge.
        // `fetch_count` is monotonic for the hub process's life and counts every paid
        // provider call it made, including calls for STALE pending requests the shared
        // regtest chain carries from earlier aborted runs: the venue's own log-buffer
        // note records those being retried every poll for the rest of their deadlines.
        // An absolute of 1 is therefore a statement about what else happens to be on
        // the chain today, while the delta is the property ZC2 names: the re-mine did
        // not re-pay the provider. Both are printed so the absolute is on the record.
        const before = {}
        for (const hub of venue.hubs) {
            const s = await venue.attestationStatsOf(hub.index)
            assert.ok(!s.error, 'hub ' + hub.index + ' would not answer getattestationstats before the ' +
                'request was made (' + s.error + '), so the fetch baseline cannot be taken and the ' +
                'assertion below would be reading half a measurement')
            before[hub.index] = Number(s.fetch_count)
            assert.ok(Number.isFinite(before[hub.index]),
                'hub ' + hub.index + ' reports no fetch_count in getattestationstats: ' + jsonSafe(s))
        }
        console.log('ZC2 baseline fetch_count per hub: ' + jsonSafe(before))

        // ---- drive one request all the way to applied -------------------------
        const sinceAction = await attestRequestWatermark(contract.contractIndex)
        await clearBeforeBroadcast()
        const exec = await mineWhile(() => vmHelper.sendExecuteV0(
            contract.owner, contract.contractIndex, 'ask', ['http_get', testUrl]))
        assert.strictEqual(exec.execution.status, 'valid',
            'the EXECUTE that emits the request came back ' + exec.execution.status)

        const request   = await findEmittedAttestRequest(
            contract.contractIndex, sinceAction + 1, { label: 'zc2' })
        const requestId = request.requestId
        await settleOrReport('zc2')

        // THE DRAW, while the request is still pending: `getattestationresponsibleset`
        // answers for pending requests only, and the fetch assertion below is about the
        // hubs that owed a round rather than about all five.
        let draw = null
        for (const hub of venue.hubs) {
            const got = await venue.responsibleSetFromHub(hub.index, requestId)
            if (!got.error) { draw = got; break }
        }
        assert.ok(draw, 'no venue hub could resolve the responsible set for ' + requestId +
            ' while it was pending, so ZC2 cannot say which hubs owed a fetch\n' + allHubTails(venue))
        const responsibleHubs = draw.responsible
            .map((pk) => venue.hubIndexForPubkey(pk))
            .filter((i) => i >= 0)
        assert.strictEqual(responsibleHubs.length, draw.responsible.length,
            'the draw includes a key no venue hub signs with: ' +
            jsonSafe(draw.responsible.map((p) => p.slice(0, 16))))
        console.log('ZC2: request ' + requestId.slice(0, 12) + ', drawn hubs ' +
            jsonSafe(responsibleHubs) + ' (redundancy ' + draw.redundancy + ', widen ' + draw.widen + ')')

        // NO MINING UNDER THIS WAIT. Above the zero-conf height the ladder already
        // carries its headroom slot at the request's own block, so a still chain
        // finalizes; and every block mined here is depth the reorg below has to undo
        // inside the tracker's twelve-block window.
        await waitForMirrorRowEverywhere(venue, requestId)

        // ONE BLOCK AT A TIME, AND ONLY ONCE INDEXER 0 HAS PARSED THE LAST ONE. Mining
        // on a fixed cadence outruns the venue indexer and piles up depth between the
        // request and the reorg, which is what blows the tracker window.
        const probe  = venueTipProbe(venue, 0)
        const nudged = await untilOrClearDogeStall(async () => {
            const applied = await readAppliedResponse(venue, 0, requestId)
            if (applied) return { ok: true, applied: applied }
            const tip = Number(await nodeConnector.getBlockCount())
            const at  = await probe().catch(() => null)
            if (at && Number(at.height) >= tip) await regtestMinerConnector.generateBlocks(1)
            return { ok: false, applied: null }
        }, { timeoutMs: 10 * 60 * 1000, intervalMs: 3000, tipProbe: probe })
        assert.ok(nudged.ok, 'the response never applied on indexer 0 before the reorg could be staged\n' +
            venue.logTail('indexer0'))

        await settleOrReport('zc2')
        const beforeRows   = await waitForAppliedEverywhere(venue, requestId)
        const local        = await readRequestRow(venue, 0, requestId)
        const requestBlock = Number(local.block_index)
        const appliedBlock = Number(beforeRows[0].block_index)
        const roundRef     = Number(local.action_index)
        console.log('ZC2: request at ' + requestBlock + ', response bound at ' + appliedBlock +
            ', round_reference ' + roundRef)

        // ---- the reorg: keep the request, orphan the applying block -----------
        await regtestMinerConnector.pauseMining()
        try {
            const reorg = await orphanFrom(appliedBlock, 'keep')
            console.log('ZC2: orphaned the applying block ' + appliedBlock + ' and rebuilt to ' +
                reorg.tipAfter)

            const reapplied = await untilOrClearDogeStall(async () => {
                const rows = []
                for (const ix of venue.indexers) rows.push(await readAppliedResponse(venue, ix.index, requestId))
                return { ok: rows.every((r) => r && Number(r.block_index) === appliedBlock), rows: rows }
            }, { timeoutMs: 15 * 60 * 1000, tipProbe: venueTipProbe(venue, 0) })
            assert.ok(reapplied.ok,
                'the response did not come back at block ' + appliedBlock + ' on both nodes after the ' +
                'reorg; they hold ' + jsonSafe(reapplied.rows.map((r) => (r ? r.block_index : null))) +
                '. The mirror row is rollback-exempt and the request is pending again, so the applier ' +
                'had everything it needed.\n' + venue.logTail('indexer0') + '\n' + venue.logTail('indexer1'))

            const diffs = diffRows(reapplied.rows[0], reapplied.rows[1], APPLIED_FIELDS)
            assert.deepStrictEqual(diffs, [],
                'the two nodes re-bound the response differently after the reorg: ' + diffs.join('; '))
            for (const field of ['response_hash', 'action_index']) {
                assert.strictEqual(String(reapplied.rows[0][field]), String(beforeRows[0][field]),
                    field + ' changed across the reorg (' + beforeRows[0][field] + ' to ' +
                    reapplied.rows[0][field] + '). The response is derived from the tag, network and ' +
                    'request id, none of which a reorg touches.')
            }

            const state = await readContractState(venue, 0, contract.contractIndex)
            assert.strictEqual(JSON.parse(state.callback_status), 'ok',
                'the callback did not re-fire after the reorg (state ' + state.callback_status + ')')
        } finally {
            await regtestMinerConnector.resumeMining()
            await settleAfterReorg('keep')
        }

        // ---- the money: exactly one split, 25 blocks later --------------------
        //
        // MINED OUT, not read straight away. A second settle would be written by a
        // second apply, and a second apply needs a block to run in; reading the table
        // the moment the first one lands proves only that nothing has had the chance
        // to go wrong yet.
        await regtestMinerConnector.generateBlocks(SETTLE_BLOCKS)
        await settleOrReport('zc2')
        const tip = Number(await nodeConnector.getBlockCount())
        for (const ix of venue.indexers) await waitForHeightWithClear(venue, ix.index, tip)

        for (const ix of venue.indexers) {
            const rewards = await readAttestRewards(venue, ix.index, { roundReference: roundRef })
            const fees    = rewards.filter((r) => String(r.reward_type) === 'attest_fee')
            const raw     = fees.length > 0 ? '' : await rawAttestRewards(venue, ix.index)
            assert.ok(fees.length > 0,
                'indexer ' + ix.index + ' holds no attest_fee row for round_reference ' + roundRef +
                ' after the re-bind, so the escrow went nowhere and "exactly one split" would pass ' +
                'vacuously\n' + feeLines(venue, 'indexer' + ix.index) + '\n' + raw)

            // ONE SET, counted by the BLOCK the rows were written at. Every row of one
            // split shares the applying block, so a second settle (the failure this whole
            // drill exists to catch: a re-mine that pays the set twice out of one escrow)
            // shows up as a second distinct block_index under the same round_reference.
            // Counting ROWS instead would fail on an honest split of any size.
            const blocks = [...new Set(fees.map((r) => Number(r.block_index)))].sort((a, b) => a - b)
            assert.deepStrictEqual(blocks, [Number(appliedBlock)],
                'indexer ' + ix.index + ' holds attest_fee rows for round_reference ' + roundRef +
                ' at block(s) ' + jsonSafe(blocks) + ' rather than only at the re-bound block ' +
                appliedBlock + '. More than one block means the escrow was split more than once for ' +
                'one request, which is the double-payment a re-mine must not cause; a different ' +
                'single block means the rollback did not take the first split with it. Rows: ' +
                jsonSafe(fees))

            // The payees are distinct: a set paid twice inside ONE block would show a
            // pubkey twice and the block count above could not see it.
            const payees = fees.map((r) => String(r.pubkey).toLowerCase())
            assert.strictEqual(new Set(payees).size, payees.length,
                'indexer ' + ix.index + ' paid a pubkey more than once in the same split: ' +
                jsonSafe(payees))
            console.log('ZC2: indexer ' + ix.index + ' holds one attest_fee split at block ' +
                appliedBlock + ' across ' + fees.length + ' payee(s)')
        }

        // ---- the fetch: paid for once ----------------------------------------
        const after = {}
        for (const hub of venue.hubs) {
            const s = await venue.attestationStatsOf(hub.index)
            assert.ok(!s.error, 'hub ' + hub.index + ' would not answer getattestationstats after the ' +
                'reorg (' + s.error + ')')
            after[hub.index] = Number(s.fetch_count)
        }
        console.log('ZC2 fetch_count per hub: before ' + jsonSafe(before) + ', after ' + jsonSafe(after))

        for (const hubIndex of responsibleHubs) {
            const delta = after[hubIndex] - before[hubIndex]
            assert.strictEqual(delta, 1,
                'responsible hub ' + hubIndex + ' issued ' + delta + ' paid provider fetch(es) across ' +
                'this request (fetch_count ' + before[hubIndex] + ' to ' + after[hubIndex] + '). ' +
                'Exactly one is the claim: the request id is content-derived and therefore ' +
                'reorg-stable, so the re-mined request is the SAME request and the finalized ring ' +
                'refuses a second round for it outright. Two means the ring did not hold and the ' +
                'federation re-paid the provider for work it already had.\n' +
                venue.logTail('hub' + hubIndex))
        }
        const outsiders = venue.hubs
            .map((h) => h.index)
            .filter((i) => !responsibleHubs.includes(i))
            .filter((i) => after[i] - before[i] !== 0)
        assert.deepStrictEqual(outsiders, [],
            'hub(s) ' + jsonSafe(outsiders) + ' fetched from the provider without being in the ' +
            'responsible set, so a hub outside the draw is paying for work it was never asked to do')

        console.log('ZC2 GREEN: re-bound at ' + appliedBlock + ' on both nodes, one attest_fee split, ' +
            'one fetch on each of hubs ' + jsonSafe(responsibleHubs))
    })
})
