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
 * ZC5, THE FLAG DAY. Below the height nothing changes; above it a rollback across
 * a bound response restores the ledger.
 *
 * The spec's own test (zero-confirmation-flip §10 ZC5) has two halves and they are
 * driven in two different places, for a measured reason.
 *
 * THE BELOW-HEIGHT HALF IS A UNIT-TIER ASSERTION AND CANNOT BE ANYTHING ELSE
 * (gaps 12). `ATTEST_ZERO_CONF_ACTIVATION.regtest` is 0 and every resolver reads
 * the map directly: no environment variable, no config key, no injected seam. So
 * on this venue there is no block index below the height and no request that can
 * exist below it, exactly as AT6's own skipped case measures for the mirror
 * activation. The below-height behaviour is therefore asserted at a SYNTHETIC
 * height on `testnet`, which is the one network where the widening map is armed
 * (150780), the mirror map is armed (151324) and the zero-conf map is still null:
 * the only combination that reaches the old branches with the mirror-era gate
 * satisfied. If the operator arms testnet, these cases stop testing what they say
 * they test, so the fixture assumption is asserted first rather than assumed.
 *
 * THE ABOVE-HEIGHT HALF IS ON THE VENUE, on the at6 shape (D79): a request served
 * at zero confirmations, bound, then rolled back and re-applied, with the signed
 * roots compared on both nodes either side. at6 itself is untouched.
 *
 * WHAT "RESTORES state_hash" CAN AND CANNOT MEAN HERE, stated so nobody tightens
 * this into an assertion that must fail. A reorg replaces the block at height B
 * with a DIFFERENT block: it has to, or the node would not switch to the competing
 * chain, and an identical block is one the node has already marked invalid. Its
 * coinbase pays a different address, so `block_merkle_root` at B is expected to
 * differ and comparing it across the reorg would be comparing the block rather
 * than the ledger. What must be restored is the LEDGER: `state_root`,
 * `balances_root` and `stakes_root` at B, which carry the applied response, the
 * callback's writes and the settle. Those three are compared across the reorg, all
 * four are compared BETWEEN the two nodes (a fork is a disagreement between
 * nodes), and the block below the reorg point is compared both ways as the control
 * that says the rollback did not reach further than it should have.
 *
 * EXCLUSIVE ON THE SHARED REGTEST CHAIN for the venue half: it orphans blocks out
 * from under whatever else is on that chain. WALL-TIME BUDGET: the unit half is
 * milliseconds and needs no venue at all; the venue half is about 45 minutes,
 * nearly all of it the indexers replaying from genesis.
 ********************************************************************/

const assert = require('assert')
const dotenv = require('dotenv')
dotenv.config()

const { AttestMirrorVenue } = require('../helpers/attestMirrorVenue')
const { loadHubModule } = require('../helpers/multiValidatorHubHelper')
const {
    provisionDrillIdentities, waitForVenueIndexersAtTip, startAttestTestServer, deployRequestContract,
    mineWhile,
} = require('./mirrorDrillFixture')
const {
    APPLIED_FIELDS, STATE_HASH_FIELDS, diffRows, diffStateHashes, untilOrClearDogeStall,
    waitForMirrorRowEverywhere, waitForAppliedEverywhere, waitForHeightWithClear,
    readAppliedResponse, readContractState, readRequestRow,
    venueTipProbe, findEmittedAttestRequest, attestRequestWatermark,
    clearBeforeBroadcast, settleOrReport, allHubTails, jsonSafe,
} = require('./mirrorDrillWaits')
const vmHelper               = require('../helpers/vmHelper')
const cryptoHelper           = require('../cryptoHelper')
const XChainIndexerConnector = require('../../src/XChainIndexerConnector.js')

// ---------------------------------------------------------------------------
// The below-height half: synthetic heights on testnet, no venue.
// ---------------------------------------------------------------------------

// A testnet request block: above the widening height (150780) and above the mirror
// height (151324), with the zero-conf map still null. Any height in that band works;
// these three pin one request's whole window.
const T_REQ_BLOCK = 151400
const T_DEADLINE  = 151500

// The regtest counterparts, where every request is above the zero-conf height because
// the map is armed at genesis. Present so every below-height assertion has an
// above-height twin that gives a DIFFERENT answer: an assertion whose expected value
// is the same on both sides of a flag day is not testing the flag day.
const R_REQ_BLOCK = 100
const R_DEADLINE  = 200

// The ledger roots a rollback must restore. `block_merkle_root` is deliberately NOT
// here: it is a property of the BLOCK, and the reorg replaces the block on purpose
// (see the header). It is still compared between the two nodes, where it must agree.
const LEDGER_ROOT_FIELDS = Object.freeze(['state_root', 'balances_root', 'stakes_root'])

describe('ZC5 below the height: the flag day leaves every rule where it was', function () {
    this.timeout(60 * 1000)

    let zc      = null
    let wid     = null
    let Utility = null

    before(function () {
        // REQUIRED HERE, not at module scope, and the reason is this file's other half:
        // pulling xchain-indexer's utility into the harness loads the whole action module
        // tree, and a venue-only run has no use for it. The hub modules resolve through
        // the same loader every other drill uses, so a relocated checkout moves them all
        // together.
        zc      = loadHubModule('src/attest_zero_conf_activation.js')
        wid     = loadHubModule('src/attest_responsible_widening_activation.js')
        // The indexer's own copy of the selector. `INDEXER_COIN`/`INDEXER_NETWORK` are
        // read when the module initialises, and are set only if the harness has not
        // already set them, so this cannot move a value another suite is relying on.
        if (!process.env.INDEXER_COIN)    process.env.INDEXER_COIN = 'BTC'
        if (!process.env.INDEXER_NETWORK) process.env.INDEXER_NETWORK = 'regtest'
        Utility = require('../../../xchain-indexer/src/utility.js')
    })

    it('holds the fixture assumption: testnet is armed for mirror and widening, not zero-conf',
        function () {
            // THE ASSUMPTION EVERY CASE BELOW RESTS ON. If the operator arms testnet (the
            // frontier's own row 19), these cases would silently start testing the
            // above-height branch while still claiming to test the below-height one,
            // which is the most dangerous direction for a flag-day test to fail in.
            assert.strictEqual(zc.ATTEST_ZERO_CONF_ACTIVATION.testnet, null,
                'ATTEST_ZERO_CONF_ACTIVATION.testnet is no longer null (' +
                zc.ATTEST_ZERO_CONF_ACTIVATION.testnet + '), so testnet is not a below-height venue any ' +
                'more and this whole describe block is asserting the wrong branch. Move these cases to ' +
                'a network that is still null, or retire them with the height.')
            assert.strictEqual(zc.isZeroConfActive(T_REQ_BLOCK, 'testnet'), false)
            assert.ok(Number.isInteger(wid.ATTEST_RESPONSIBLE_WIDENING_ACTIVATION.testnet) &&
                      T_REQ_BLOCK >= wid.ATTEST_RESPONSIBLE_WIDENING_ACTIVATION.testnet,
                'the testnet request block ' + T_REQ_BLOCK + ' is below the widening height ' +
                wid.ATTEST_RESPONSIBLE_WIDENING_ACTIVATION.testnet + ', so widenSlots returns 0 through ' +
                'its ARMING guard rather than through the stage-1 ladder and the cases below would pass ' +
                'for the wrong reason')
            // And the above-height side really is above it, or every twin below is vacuous.
            assert.strictEqual(zc.isZeroConfActive(R_REQ_BLOCK, 'regtest'), true)
        })

    it('confirmationsFor returns the constructor value below the height and 0 above it', function () {
        const AttestationRound = loadHubModule('src/AttestationRound.js')
        // A STUB HUB, not a live one: `confirmationsFor` reads exactly two things, the
        // constructor's tunable and the hub's network, and standing up a hub to ask it a
        // question about a synthetic height would make the answer depend on a venue.
        const stub = (network) => ({
            network: network, db: null,
            getPeerManager: () => null, getIdentity: () => null,
            p2pConfig: { ATTESTATION_CONFIRMATIONS: '3' },
        })

        const testnet = new AttestationRound(stub('testnet'), null)
        assert.strictEqual(testnet.confirmations, 3,
            'the constructor did not take ATTESTATION_CONFIRMATIONS=3, so the comparison below is ' +
            'against the wrong number')
        assert.strictEqual(testnet.confirmationsFor(T_REQ_BLOCK), testnet.confirmations,
            'below the height confirmationsFor must hand back the operator tunable untouched: that is ' +
            'what keeps a mixed fleet agreeing on the leader slot and the model index for every ' +
            'request below the flag day')

        const regtest = new AttestationRound(stub('regtest'), null)
        assert.strictEqual(regtest.confirmationsFor(R_REQ_BLOCK), 0,
            'above the height confirmationsFor must be 0 regardless of the tunable, or the hub is ' +
            'still waiting for confirmations on a request it is supposed to serve at the tip')
        assert.strictEqual(regtest.confirmations, 3,
            'the constructor value must survive: the boot line reports it and the legacy era uses it')
    })

    it('widenSlots runs the stage-1 ladder below the height and the V2 headroom above it', function () {
        // AT THE REQUEST'S OWN BLOCK is the discriminator, and it is the branch §4.1
        // exists for: stage 1 computes elapsed = 0 and returns 0, so headroom would be
        // inert on exactly the block it is for; V2 returns its headroom instead.
        assert.strictEqual(wid.widenSlots(T_REQ_BLOCK, T_REQ_BLOCK, T_DEADLINE, 'testnet'), 0,
            'below the height the ladder must still return 0 at the request block. A 1 here means the ' +
            'V2 early return is reachable below the flag day, which forks a mixed fleet on WHO MAY SIGN.')
        assert.strictEqual(wid.widenSlots(R_REQ_BLOCK, R_REQ_BLOCK, R_DEADLINE, 'regtest'),
            wid.ATTEST_RESPONSIBLE_WIDENING_V2.headroom,
            'above the height the ladder must return the headroom slot at the request block')

        // The stage-1 geometry, spelled from the frozen constants rather than from
        // literals, so a change to either constant fails here instead of quietly
        // redefining what "stage 1" means.
        const conf    = wid.ATTEST_RESPONSIBLE_WIDENING.confirmations
        const slots   = wid.ATTEST_RESPONSIBLE_WIDENING.maxSlots
        const start   = T_REQ_BLOCK + conf
        const segment = (T_DEADLINE - start) / (slots + 1)
        const at = (n) => wid.widenSlots(n, T_REQ_BLOCK, T_DEADLINE, 'testnet')
        assert.strictEqual(at(start), 0, 'stage 1 opens no slot at the ladder start')
        assert.strictEqual(at(Math.ceil(start + segment) - 1), 0,
            'stage 1 opened its first slot before the end of the first segment')
        assert.strictEqual(at(Math.ceil(start + segment)), 1,
            'stage 1 did not open its first slot at the end of the first segment, which is the ' +
            'six-block wait measured on the public testnet on a ten-block deadline')
        assert.strictEqual(at(Math.ceil(start + 2 * segment)), slots,
            'stage 1 did not reach its cap at the end of the second segment')
        assert.strictEqual(at(T_DEADLINE), slots,
            'stage 1 climbed past its own cap of ' + slots)
    })

    it('the selector carries no candidate list below the height and one above it', function () {
        const util = new Utility()
        const crypto = require('crypto')
        const body = 'zc5'
        const hash = crypto.createHash('sha256').update(Buffer.from(body, 'utf8')).digest('hex')
        const reqId = 'e'.repeat(64)

        const mirrorRow = (effectiveTime, responseHash) => ({
            request_id: reqId, provider_id: 'http_get', status: 'ok',
            response_payload: body, response_hash: responseHash || hash, meta: '',
            effective_time: effectiveTime,
            signer_pubkeys: JSON.stringify(['a'.repeat(64)]),
            signatures: JSON.stringify([{ pubkey: 'a'.repeat(64), sig: '1'.repeat(128) }]),
            widen: 0,
        })
        const requestRow = (blockIndex, deadline) => ({
            request_id: reqId, action_index: 11, provider_id: 'http_get',
            request_status: 'pending', deadline_block: deadline, block_index: blockIndex,
            redundancy: 1, contract_index: 5, callback_method: 'onResult', callback_params_json: '[]',
        })

        // TWO rows for one request, which is the whole point: below the height the loser
        // of the tie-break is DISCARDED and the item is the single choice, so a first row
        // that turns out inert strands the request until its deadline. That is the
        // behaviour a mixed fleet must keep agreeing on below the flag day (D11).
        const time = 1700000000
        const rows = [mirrorRow(time, 'b'.repeat(64)), mirrorRow(time - 5, 'a'.repeat(64))]

        const below = util.selectApplicableAttestationResponses(
            rows, [requestRow(T_REQ_BLOCK, T_DEADLINE)], T_REQ_BLOCK + 10, time, 'testnet')
        assert.strictEqual(below.length, 1, 'the selector returned ' + below.length + ' item(s) for one request')
        assert.strictEqual(Object.prototype.hasOwnProperty.call(below[0], 'candidates'), false,
            'the below-height item carries a `candidates` key. The item SHAPE is what a mixed fleet ' +
            'agrees on: an old indexer has no such key, and adding one below the height is how the two ' +
            'start binding different rows for the same request.')
        assert.strictEqual(Number(below[0].response.effective_time), time - 5,
            'the below-height item did not choose the smaller effective_time')

        const above = util.selectApplicableAttestationResponses(
            rows, [requestRow(R_REQ_BLOCK, R_DEADLINE)], R_REQ_BLOCK + 10, time, 'regtest')
        assert.strictEqual(above.length, 1, 'the selector returned ' + above.length + ' item(s) for one request')
        assert.ok(Array.isArray(above[0].candidates) && above[0].candidates.length === 2,
            'the above-height item does not carry both rows as candidates: ' + jsonSafe(above[0].candidates))
        assert.strictEqual(Number(above[0].candidates[0].effective_time), time - 5,
            'the candidate list is not sorted by effective_time ascending')
        assert.strictEqual(Number(above[0].response.effective_time),
            Number(above[0].candidates[0].effective_time),
            'the item response is not the head of its own candidate list')
    })
})

// ---------------------------------------------------------------------------
// The above-height half: a rollback across a bound zero-conf response.
// ---------------------------------------------------------------------------

const FIXED_BODY = '{"score":41,"meta":"zc5-flagday"}'

const POLL_MS   = 3000
const FORWARD_S = 3

const DEADLINE_BLOCKS = 80
const COMPETING_OVERSHOOT = 2
const TRACKER_UNDO_BLOCKS = 12

const CONTRACT_CODE = `
module.exports = {
    meta: { name: 'Zero Conf Flag Day Asker', description: 'Requests an attestation across the zero-conf flag day boundary.', version: '1.0.0' },
    ask: function(xchain) {
        var requestId = xchain.attestation.request(
            xchain.getInputParam(0),
            xchain.getInputParam(1),
            'handleResponse',
            ['ctx-zc5'],
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

describe('ZC5 above the height: a rollback across a bound response restores the ledger', function () {
    this.timeout(90 * 60 * 1000)

    let venue      = null
    let up         = false
    let testServer = null
    let testUrl    = null
    let contract   = null
    let minerAddr  = null

    before(async function () {
        testServer = await startAttestTestServer({ body: FIXED_BODY })
        testUrl    = testServer.url

        const staked = await provisionDrillIdentities({ label: 'zc5', count: 5, redundancy: 3 })
        venue = new AttestMirrorVenue({
            label: 'zc5', identities: staked.identities, hubExtraEnv: testServer.hubEnv,
            attestationPollMs: POLL_MS, forwardS: FORWARD_S,
        })
        up = await venue.start()
        if (!up) {
            console.log('ZC5 SKIPPED: ' + venue.unavailable)
            this.skip()
            return
        }
        await waitForVenueIndexersAtTip(venue)
        contract = await deployRequestContract({ label: 'zc5', code: CONTRACT_CODE })
        // The competing chain's coinbase destination. Its own address, so the orphaned
        // chain's coinbases and the new one's are never confused, and so the replacement
        // block cannot be the invalidated block over again.
        minerAddr = (await cryptoHelper.getNewAddress('zc5-miner', COIN, NETWORK, null, 'legacy', 0)).address
    })

    after(async function () {
        try { await regtestMinerConnector.resumeMining() } catch (e) {
            console.log('ZC5 teardown: resumeMining failed (' + (e && e.message) +
                '); the shared miner may still be paused')
        }
        if (testServer) await testServer.close()
        if (venue) await venue.stop()
    })

    /** Every signed root one venue indexer reports at a height. */
    async function rootsAt (indexerIndex, height) {
        const ix   = venue.indexers[indexerIndex]
        const conn = new XChainIndexerConnector('127.0.0.1', ix.apiPort, null)
        const got  = await conn.call('getblockhashes', { block_index: Number(height) })
        assert.ok(got && !got.error,
            'indexer ' + indexerIndex + ' would not report hashes at ' + height + ': ' + jsonSafe(got))
        return got
    }

    /** Orphan everything at and above `height` and replace it with EMPTY blocks. */
    async function orphanFrom (height, label) {
        const tipBefore = Number(await nodeConnector.getBlockCount())
        const depth = tipBefore - height + 1
        assert.ok(depth <= TRACKER_UNDO_BLOCKS,
            label + ': orphaning from ' + height + ' at tip ' + tipBefore + ' is ' + depth +
            ' blocks deep, past the standing utxo-tracker\'s ' + TRACKER_UNDO_BLOCKS + '-block undo ' +
            'window; the tracker would halt and need a resync.')
        const hash = await nodeConnector.getBlockHash(height)
        await nodeConnector.invalidateBlock(hash)
        const rolled = Number(await nodeConnector.getBlockCount())
        assert.strictEqual(rolled, height - 1,
            label + ': the node sits at ' + rolled + ' after invalidating block ' + height)
        const need = tipBefore - (height - 1) + COMPETING_OVERSHOOT
        for (let i = 0; i < need; i++) await nodeConnector.generateBlock(minerAddr, [])
        const tipAfter = Number(await nodeConnector.getBlockCount())
        assert.ok(tipAfter > tipBefore,
            label + ': the competing chain reached ' + tipAfter + ', which does not overtake ' + tipBefore)
        assert.notStrictEqual(await nodeConnector.getBlockHash(height), hash,
            label + ': block ' + height + ' still has its original hash, so nothing actually reorged')
        return { tipBefore: tipBefore, tipAfter: tipAfter }
    }

    async function settleAfterReorg (label) {
        const status = await utxoTrackerConnector.quiesce({
            timeoutMs: 4 * 60 * 1000, pollMs: 500, regtestMiner: regtestMinerConnector,
        }).catch((e) => ({ ready: false, error: String(e && e.message) }))
        if (!status || !status.ready) {
            console.log('ZC5 ' + label + ': the stack did not settle after the reorg (' +
                JSON.stringify(status) + '); the harness barrier will say so')
        }
    }

    it('re-applies at the same block with the ledger roots restored and no fork', async function () {
        const sinceAction = await attestRequestWatermark(contract.contractIndex)
        await clearBeforeBroadcast()
        const exec = await mineWhile(() => vmHelper.sendExecuteV0(
            contract.owner, contract.contractIndex, 'ask', ['http_get', testUrl]))
        assert.strictEqual(exec.execution.status, 'valid',
            'the EXECUTE that emits the request came back ' + exec.execution.status)

        const request   = await findEmittedAttestRequest(
            contract.contractIndex, sinceAction + 1, { label: 'zc5' })
        const requestId = request.requestId
        await settleOrReport('zc5')

        // NO BURIAL AND NO MINING UNDER THE WAIT. Above the height the hub serves at the
        // tip and the ladder already carries its headroom slot at the request's own
        // block, so a still chain finalizes; and every block mined here is depth the
        // reorg below has to undo inside the tracker's twelve-block window.
        await waitForMirrorRowEverywhere(venue, requestId)

        const probe  = venueTipProbe(venue, 0)
        const nudged = await untilOrClearDogeStall(async () => {
            const applied = await readAppliedResponse(venue, 0, requestId)
            if (applied) return { ok: true }
            const tip = Number(await nodeConnector.getBlockCount())
            const at  = await probe().catch(() => null)
            if (at && Number(at.height) >= tip) await regtestMinerConnector.generateBlocks(1)
            return { ok: false }
        }, { timeoutMs: 10 * 60 * 1000, intervalMs: 3000, tipProbe: probe })
        assert.ok(nudged.ok, 'the response never applied on indexer 0 before the reorg could be staged\n' +
            venue.logTail('indexer0') + '\n' + allHubTails(venue))

        await settleOrReport('zc5')
        const beforeRows = await waitForAppliedEverywhere(venue, requestId)
        const local      = await readRequestRow(venue, 0, requestId)
        const B          = Number(beforeRows[0].block_index)
        console.log('ZC5: request at ' + local.block_index + ', response bound at ' + B)

        // BOTH NODES LEVEL AT B BEFORE ANYTHING IS READ. A root read off a node that has
        // not committed B yet is not a reading of B at all.
        for (const ix of venue.indexers) await waitForHeightWithClear(venue, ix.index, B)
        const pre = {
            below: [await rootsAt(0, B - 1), await rootsAt(1, B - 1)],
            at:    [await rootsAt(0, B),     await rootsAt(1, B)],
        }
        const preFork = diffStateHashes(pre.at[0], pre.at[1])
        assert.deepStrictEqual(preFork, [],
            'the two indexers already disagreed at block ' + B + ' BEFORE the reorg: ' +
            preFork.join('; ') + '. Nothing this case does afterwards would be interpretable.')
        console.log('ZC5: pre-reorg state_root at ' + B + ' is ' +
            String(pre.at[0].state_root).slice(0, 16) + '... on both nodes')

        await regtestMinerConnector.pauseMining()
        try {
            const reorg = await orphanFrom(B, 'zc5')
            console.log('ZC5: orphaned the applying block ' + B + ' and rebuilt to ' + reorg.tipAfter)

            const reapplied = await untilOrClearDogeStall(async () => {
                const rows = []
                for (const ix of venue.indexers) rows.push(await readAppliedResponse(venue, ix.index, requestId))
                return { ok: rows.every((r) => r && Number(r.block_index) === B), rows: rows }
            }, { timeoutMs: 15 * 60 * 1000, tipProbe: venueTipProbe(venue, 0) })
            assert.ok(reapplied.ok,
                'the response did not come back at block ' + B + ' on both nodes after the reorg; they ' +
                'hold ' + jsonSafe(reapplied.rows.map((r) => (r ? r.block_index : null))) + '\n' +
                venue.logTail('indexer0') + '\n' + venue.logTail('indexer1'))

            const rowDiffs = diffRows(reapplied.rows[0], reapplied.rows[1], APPLIED_FIELDS)
            assert.deepStrictEqual(rowDiffs, [],
                'the two nodes re-bound the response differently: ' + rowDiffs.join('; '))
            const acrossDiffs = diffRows(beforeRows[0], reapplied.rows[0], APPLIED_FIELDS)
            assert.deepStrictEqual(acrossDiffs, [],
                'the re-applied row differs from the pre-reorg one: ' + acrossDiffs.join('; ') +
                '. Everything in it is derived from the request id, the tag and the network, none of ' +
                'which a reorg touches, so a difference means something chain-dependent is leaking in.')

            for (const ix of venue.indexers) await waitForHeightWithClear(venue, ix.index, B)
            const post = {
                below: [await rootsAt(0, B - 1), await rootsAt(1, B - 1)],
                at:    [await rootsAt(0, B),     await rootsAt(1, B)],
            }

            // NO FORK: the two nodes agree on every signed root at the re-applied block,
            // block_merkle_root included, because they indexed the same chain.
            const postFork = diffStateHashes(post.at[0], post.at[1])
            assert.deepStrictEqual(postFork, [],
                'the two indexers disagree at block ' + B + ' after the re-apply: ' + postFork.join('; ') +
                '. That is a fork rather than lag: both committed the same block of the same chain and ' +
                'the applier is a pure function of the mirror row and local state.')

            // THE CONTROL: nothing below the reorg point moved. A rollback that reached
            // too far would show here first, and without it a restored root at B could be
            // a restored root on a ledger that lost something underneath it.
            for (const i of [0, 1]) {
                const drift = diffRows(pre.below[i], post.below[i], STATE_HASH_FIELDS)
                assert.deepStrictEqual(drift, [],
                    'indexer ' + i + ' changed its roots at block ' + (B - 1) + ', BELOW the orphan ' +
                    'point: ' + drift.join('; ') + '. That block was never orphaned, so the rollback ' +
                    'reached further than the reorg did.')
            }

            // AND THE LEDGER IS RESTORED at the re-applied block. `block_merkle_root` is
            // excluded on purpose (see the header): the replacement block is a different
            // block by construction, and comparing it would be comparing the block rather
            // than the state the response wrote into it.
            for (const i of [0, 1]) {
                const restored = diffRows(pre.at[i], post.at[i], LEDGER_ROOT_FIELDS)
                assert.deepStrictEqual(restored, [],
                    'indexer ' + i + ' committed different ledger roots at block ' + B + ' after the ' +
                    're-apply: ' + restored.join('; ') + '. The same response bound at the same block ' +
                    'from the same rollback-exempt mirror row, so state_root, balances_root and ' +
                    'stakes_root must come back byte for byte. The one legitimate way they can differ ' +
                    'is a replacement block carrying transactions the original did not; the competing ' +
                    'chain here is mined EMPTY precisely so it cannot.')
            }
            console.log('ZC5: ledger roots at ' + B + ' restored on both nodes (state_root ' +
                String(post.at[0].state_root).slice(0, 16) + '...), block_merkle_root ' +
                (String(pre.at[0].block_merkle_root) === String(post.at[0].block_merkle_root)
                    ? 'unchanged' : 'replaced with the block, as expected'))

            const state = await readContractState(venue, 0, contract.contractIndex)
            assert.strictEqual(JSON.parse(state.callback_status), 'ok',
                'the callback did not re-fire after the reorg (state ' + state.callback_status + ')')
            console.log('ZC5 GREEN: re-applied at ' + B + ' with the ledger restored and no divergence')
        } finally {
            await regtestMinerConnector.resumeMining()
            await settleAfterReorg('zc5')
        }
    })
})
