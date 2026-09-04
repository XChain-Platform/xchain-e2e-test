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
 * AT4, REORGS. The applied rows are ordinary chain state and must move with the
 * chain, in both directions.
 *
 * The spec's own test: removing the request rolls back the applied rows on both
 * nodes and nothing re-binds; a reorg that keeps the request re-binds at the same
 * block on both.
 *
 * WHY THERE IS NO RETRACTION PATH TO TEST, and why that makes this drill the whole
 * safety argument for it. The mirror row is never retracted: it is inert without a
 * pending local request, and the applied rows hang off an action minted at the
 * applying block, so the ordinary reorg machinery deletes them with everything else
 * at that height. The design therefore rests on two claims that only a real reorg
 * can establish, and this drill is where they are established.
 *
 * THE ORDER OF THE TWO CASES IS DELIBERATE and is the reverse of the spec's
 * sentence. The removal case invalidates the block carrying its own request, which
 * orphans everything above it; run first, it would take the other case's rows with
 * it. Run second, its invalidation point sits above everything the keep case
 * touched, so the two are independent. The spec's ordering is prose, not a
 * requirement.
 *
 * THIS DRILL REORGS THE SHARED REGTEST CHAIN. It is not merely serialized like its
 * neighbours, it is exclusive: a few blocks are orphaned out from under whatever
 * else is on that chain. Nothing else may be running against this venue.
 *
 * ONE HONEST LIMIT, stated because a reader will hit it. Invalidating a block
 * returns its transactions to the mempool, and there is no reliable way to evict
 * them, so the EXECUTE that emitted the removed request WILL be mined again once
 * the auto-miner resumes, re-creating the same request id at a new height (the id
 * is derived from the transaction hash, which does not change). Every assertion in
 * the removal case therefore runs with mining PAUSED and against an explicitly
 * EMPTY competing chain, which is the window in which the request genuinely does
 * not exist. What happens after the miner resumes is the keep case's claim, not
 * this one's.
 ********************************************************************/

const assert = require('assert')
const http   = require('http')
const dotenv = require('dotenv')
dotenv.config()

const { AttestMirrorVenue } = require('../helpers/attestMirrorVenue')
const {
    stakeDrillIdentities, deployRequestContract, readContractState,
    readAppliedResponse,
} = require('./mirrorDrillFixture')
const {
    APPLIED_FIELDS, untilOrClearDogeStall, diffRows,
    waitForMirrorRowEverywhere, waitForAppliedEverywhere,
    readRequestRow, venueTipProbe, findEmittedAttestRequest, captureFederationState,
    clearBeforeBroadcast,
    waitForHeightWithClear,
    attestRequestWatermark,
    settleOrReport,
} = require('./mirrorDrillWaits')
const vmHelper     = require('../helpers/vmHelper')
const cryptoHelper = require('../cryptoHelper')

const FIXED_BODY = '{"score":11,"meta":"at4-reorg"}'

// Generous, so nothing under test is racing the expiry sweep while blocks are
// being orphaned and remade.
const DEADLINE_BLOCKS = 80

const BURIAL_BLOCKS = 6

// How far past the orphan point the competing chain is built. Two is enough to
// make it strictly longer than what it replaces, which is what makes the node
// switch to it.
const COMPETING_OVERSHOOT = 2

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
        var tag = xchain.getInputParam(4);
        xchain.state.set('request_' + tag, xchain.getInputParam(0));
        xchain.state.set('status_'  + tag, xchain.getInputParam(2));
        xchain.state.set('payload_' + tag, xchain.getInputParam(3));
    }
};
`

describe('AT4: a reorg moves the applied response with the chain, in both directions', function () {
    this.timeout(90 * 60 * 1000)

    let venue      = null
    let up         = false
    let httpServer = null
    let testUrl    = null
    let contract   = null
    let minerAddr  = null

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

        const staked = await stakeDrillIdentities({ label: 'at4', count: 5 })
        venue = new AttestMirrorVenue({ label: 'at4', identities: staked.identities })
        up = await venue.start()
        if (!up) {
            console.log('AT4 SKIPPED: ' + venue.unavailable)
            this.skip()
            return
        }
        contract = await deployRequestContract({ label: 'at4', code: CONTRACT_CODE })
        // The competing chain's coinbase destination. Its own address, so the
        // orphaned chain's coinbases and the new one's are never confused.
        minerAddr = (await cryptoHelper.getNewAddress('at4-miner', COIN, NETWORK, null, 'legacy', 0)).address
    })

    after(async function () {
        try { await regtestMinerConnector.resumeMining() } catch (_) { /* never paused */ }
        if (httpServer) await new Promise((r) => httpServer.close(() => r()))
        if (venue) await venue.stop()
    })

    /** Drive one tagged request all the way to an applied response on both nodes. */
    async function driveToApplied (tag) {
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
        await settleOrReport('at4')
        await waitForMirrorRowEverywhere(venue, requestId)

        // The applier binds at the first block past the effective time; with the
        // venue's short forward margin that is a block or two away, so keep the
        // chain moving until it lands.
        const nudged = await untilOrClearDogeStall(async () => {
            await regtestMinerConnector.generateBlocks(1)
            const applied = await readAppliedResponse(venue, 0, requestId)
            return { ok: !!applied, applied: applied }
        }, { timeoutMs: 10 * 60 * 1000, intervalMs: 3000, tipProbe: venueTipProbe(venue, 0) })
        assert.ok(nudged.ok, tag + ': the response never applied on indexer 0 before the reorg could be staged\n' +
            venue.logTail('indexer0'))

        await settleOrReport('at4')
        const applied = await waitForAppliedEverywhere(venue, requestId)
        const local   = await readRequestRow(venue, 0, requestId)
        return {
            tag: tag,
            requestId: requestId,
            requestBlock: Number(local.block_index),
            appliedBlock: Number(applied[0].block_index),
            applied: applied,
        }
    }

    /**
     * Orphan everything at and above `height` and replace it with EMPTY blocks.
     *
     * `generateBlock(address, [])` mines a block containing its coinbase and
     * nothing else, ignoring the mempool entirely, which is what keeps a
     * transaction that just returned to the mempool from being mined straight back
     * into the replacement chain.
     */
    async function orphanFrom (height, label) {
        const tipBefore = Number(await nodeConnector.getBlockCount())
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
            label + ': the competing chain reached ' + tipAfter + ', which does not overtake ' + tipBefore +
            ', so the node would not switch to it')
        assert.notStrictEqual(await nodeConnector.getBlockHash(height), hash,
            label + ': block ' + height + ' still has its original hash, so nothing actually reorged')
        return { tipBefore: tipBefore, tipAfter: tipAfter, orphanedHash: hash }
    }

    // DECLARED FIRST on purpose: see the header. This case invalidates the applying
    // block, which sits above nothing the other case needs.
    it('re-binds at the same block on both nodes when the reorg keeps the request', async function () {
        const driven = await driveToApplied('keep')
        const before = driven.applied

        await regtestMinerConnector.pauseMining()
        let reorg = null
        try {
            // The APPLYING block, not the request's. The request survives at a lower
            // height, the mirror row is untouched, and the response therefore has to
            // find its way back on the new chain by itself.
            reorg = await orphanFrom(driven.appliedBlock, 'keep')
            console.log('AT4 keep: orphaned the applying block ' + driven.appliedBlock +
                ' and rebuilt to ' + reorg.tipAfter)

            const reapplied = await untilOrClearDogeStall(async () => {
                const rows = []
                for (const ix of venue.indexers) rows.push(await readAppliedResponse(venue, ix.index, driven.requestId))
                return { ok: rows.every((r) => r && Number(r.block_index) === driven.appliedBlock), rows: rows }
            }, { timeoutMs: 15 * 60 * 1000, tipProbe: venueTipProbe(venue, 0) })
            assert.ok(reapplied.ok,
                'keep: the response did not come back at block ' + driven.appliedBlock + ' on both nodes after ' +
                'the reorg; they hold ' + JSON.stringify(reapplied.rows.map((r) => (r ? r.block_index : null))) +
                '. The mirror row is still there and the request is still pending, so the applier had ' +
                'everything it needed.\n' + venue.logTail('indexer0') + '\n' + venue.logTail('indexer1'))

            // SAME BLOCK ON BOTH is the claim, and the two nodes agreeing with EACH
            // OTHER is the half that makes it a determinism statement rather than a
            // repetition statement.
            const diffs = diffRows(reapplied.rows[0], reapplied.rows[1], APPLIED_FIELDS)
            assert.deepStrictEqual(diffs, [],
                'keep: the two nodes re-bound the response differently after the reorg: ' + diffs.join('; '))
            assert.strictEqual(String(reapplied.rows[0].tx_hash), String(before[0].tx_hash),
                'keep: the synthetic TX_HASH changed across the reorg (' + before[0].tx_hash + ' to ' +
                reapplied.rows[0].tx_hash + '). It is derived from the tag, network and request id, none of ' +
                'which a reorg touches, so a change means it is being derived from something chain-dependent.')

            const state = await readContractState(venue, 0, contract.contractIndex)
            assert.strictEqual(JSON.parse(state['status_keep']), 'ok',
                'keep: the callback did not re-fire after the reorg (state ' + state['status_keep'] + ')')
            console.log('AT4 keep: re-bound at block ' + driven.appliedBlock + ' on both nodes, same synthetic hash')
        } finally {
            await regtestMinerConnector.resumeMining()
        }
    })

    it('rolls the applied rows back on both nodes when the reorg removes the request, and nothing re-binds', async function () {
        const driven = await driveToApplied('gone')

        await regtestMinerConnector.pauseMining()
        try {
            // The REQUEST's own block. Everything above it goes, the applied response
            // included, and the competing chain is empty so the EXECUTE cannot be
            // mined back in while the assertions run.
            const reorg = await orphanFrom(driven.requestBlock, 'gone')
            console.log('AT4 gone: orphaned the request block ' + driven.requestBlock +
                ' and rebuilt to ' + reorg.tipAfter)

            const rolled = await untilOrClearDogeStall(async () => {
                const applied = []
                const requests = []
                for (const ix of venue.indexers) {
                    applied.push(await readAppliedResponse(venue, ix.index, driven.requestId))
                    requests.push(await readRequestRow(venue, ix.index, driven.requestId))
                }
                return {
                    ok: applied.every((a) => a === null) && requests.every((r) => r === null),
                    applied: applied, requests: requests,
                }
            }, { timeoutMs: 15 * 60 * 1000, tipProbe: venueTipProbe(venue, 0) })
            assert.ok(rolled.ok,
                'gone: the reorg did not remove both the request and its applied response on both nodes. ' +
                'applied ' + JSON.stringify(rolled.applied.map((a) => (a ? a.block_index : null))) +
                ', requests ' + JSON.stringify(rolled.requests.map((r) => (r ? r.request_status : null))) +
                '. The applied rows hang off an action minted at the applying block, so they must be deleted ' +
                'with it by the ordinary rollback.\n' + venue.logTail('indexer0'))

            // The contract's callback state went with it. This is the assertion that
            // would catch a rollback that removed the rows but left their effects.
            const state = await readContractState(venue, 0, contract.contractIndex)
            assert.strictEqual(state['status_gone'], undefined,
                'gone: the contract still carries callback state ' + state['status_gone'] +
                ' from a callback whose action was rolled back')

            // THE ROW SURVIVED, which is what makes the next assertion mean anything.
            // The mirror table is exempt from rollback by design: it is hub state, not
            // chain state, and it is inert rather than retracted.
            for (const ix of venue.indexers) {
                const rows = await venue.readMirrorRows(ix.index, { requestId: driven.requestId })
                assert.strictEqual(rows.length, 1,
                    'gone: indexer ' + ix.index + ' no longer holds the mirror row. It must survive the reorg; ' +
                    'the design has no retraction path precisely because an unbound row is harmless.')
            }

            // NOTHING RE-BINDS. The row is applicable by time and its request is gone,
            // so blocks keep coming and it stays unapplied.
            for (let i = 0; i < 4; i++) await nodeConnector.generateBlock(minerAddr, [])
            const tip = Number(await nodeConnector.getBlockCount())
            for (const ix of venue.indexers) await waitForHeightWithClear(venue, ix.index, tip)
            for (const ix of venue.indexers) {
                const applied = await readAppliedResponse(venue, ix.index, driven.requestId)
                assert.strictEqual(applied, null,
                    'gone: indexer ' + ix.index + ' bound the response at block ' + (applied && applied.block_index) +
                    ' on the new chain, with no pending local request for it. The applicability read is driven ' +
                    'from the LOCAL request rows exactly so that this cannot happen.')
            }
            console.log('AT4 gone: request and response rolled back on both nodes, mirror row intact and inert ' +
                'across ' + (tip - driven.requestBlock) + ' further blocks')
        } finally {
            // The EXECUTE returns to the mempool here and will be mined again; see the
            // header. Everything asserted above was asserted while it could not be.
            await regtestMinerConnector.resumeMining()
        }
    })
})
