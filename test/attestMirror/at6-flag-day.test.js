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
 * AT6, THE FLAG DAY. Above the height the chain stops being a delivery route for
 * a response, and the money moves accordingly.
 *
 * The spec's own test: a request below the height is served on chain as today; at
 * or above it an on-chain v1 is `invalid`, the mirror row applies, `attest_bcast`
 * is not written and the `attest_fee` split carries the whole escrow.
 *
 * THE BELOW-HEIGHT HALF IS NOT DRIVABLE ON REGTEST AND IS SKIPPED, with the
 * measurement in the skipped case's comment. In short:
 * `ATTEST_RESPONSE_MIRROR_ACTIVATION.regtest` is 0 and the resolver is a plain
 * `requestBlock >= threshold` over a module-level constant with no environment
 * variable, no config key and no injected seam, so every regtest request that can
 * exist is mirror-era. There is no legal block index below 0.
 *
 * WHAT THE DRIVEN CASE PROVES, and why the ordering inside it is the interesting
 * part. A stale hub still running the legacy publisher would broadcast an on-chain
 * v1 for a mirror-era request. If the chain handler accepted it, the callback would
 * fire twice and the escrow would settle twice, once from the chain and once from
 * the applier. So the drill broadcasts exactly that transaction, WHILE THE REQUEST
 * IS STILL PENDING, which is the moment it would do the damage, and then requires
 * that the mirror row applies anyway. Two v1 rows end up in `attests` for one
 * request and telling them apart is the assertion: the chain one carries a
 * transaction position, the synthesized one carries NULL.
 *
 * THE SIGNATURES ON THAT v1 ARE DELIBERATELY NOT REAL, and the assertion is what
 * makes that sound. The flag-day gate is the FIRST request-derived branch in the
 * handler, before signature verification, so a structurally valid wire is enough to
 * reach it. The drill asserts the EXACT verdict string; had the rejection come from
 * the signatures instead, the string would be a different one and the case would
 * fail. Signing with the real responsible keys would prove nothing extra and would
 * put a second implementation of the canonical in the test tree.
 *
 * ON THE FEE ASSERTIONS AND THE SHARED ROSTER: the split is over the responsible
 * set the INDEXER recomputes, which is drawn from every qualifying staked key on
 * the chain and is not this drill's to control. So nothing here asserts who was
 * paid or how many were paid. It asserts the two things the flag day actually
 * changes: no `attest_bcast` row exists at all, and the amounts paid add back up to
 * the escrow rather than to the escrow minus a broadcast carve-out.
 *
 * SERIALIZED, not parallel: this drill stakes into the one standing regtest roster.
 ********************************************************************/

const assert = require('assert')
const http   = require('http')
const mathjs = require('mathjs')
const dotenv = require('dotenv')
dotenv.config()

const { AttestMirrorVenue } = require('../helpers/attestMirrorVenue')
const {
    stakeDrillIdentities, deployRequestContract, readContractState, withWedgeClear,
} = require('./mirrorDrillFixture')
const {
    untilOrClearDogeStall, waitForMirrorRowEverywhere,
    readAttestRewards, readResponseRows, readRequestRow, venueTipProbe,
    findEmittedAttestRequest, captureFederationState,
    clearBeforeBroadcast,
    attestRequestWatermark,
    settleOrReport,
} = require('./mirrorDrillWaits')
const vmHelper          = require('../helpers/vmHelper')
const cryptoHelper      = require('../cryptoHelper')
const attestationHelper = require('../helpers/attestationHelper')

const FIXED_BODY = '{"score":19,"meta":"at6-flagday"}'

// The verdict the chain handler pins for an on-chain v1 whose request is
// mirror-era. Spelled out because it IS the observable: it is a stored verdict a
// replay re-derives, so a change to the string is a consensus change.
const MIRROR_ERA_VERDICT = 'invalid: ATTEST v1 after mirror activation'

// The verdict that would appear instead if the gate were ordered after the
// already-terminal check. Named so the ordering assertion can say what it caught.
const ALREADY_VERDICT_PREFIX = 'invalid: REQUEST already'

const DEADLINE_BLOCKS = 60
const BURIAL_BLOCKS   = 6

// The per-signer split floors at 8 decimals, so the pool keeps a remainder of at
// most one unit in the last place per signer. Anything beyond that is a carve-out.
const FEE_DECIMALS = 8

const CONTRACT_CODE = `
module.exports = {
    ask: function(xchain) {
        var requestId = xchain.attestation.request(
            xchain.getInputParam(0),
            xchain.getInputParam(1),
            'handleResponse',
            ['ctx-at6'],
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

describe('AT6: above the flag day the chain cannot deliver a response, and the escrow reflects it', function () {
    this.timeout(90 * 60 * 1000)

    let venue       = null
    let up          = false
    let httpServer  = null
    let testUrl     = null
    let contract    = null
    let broadcaster = null

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

        const staked = await stakeDrillIdentities({ label: 'at6', count: 5 })
        venue = new AttestMirrorVenue({ label: 'at6', identities: staked.identities })
        up = await venue.start()
        if (!up) {
            console.log('AT6 SKIPPED: ' + venue.unavailable)
            this.skip()
            return
        }
        contract = await deployRequestContract({ label: 'at6', code: CONTRACT_CODE })

        // Whoever relays an on-chain v1 pays its transaction fee and nothing else;
        // it is deliberately NOT one of the stakers, so the escrow assertions cannot
        // be confused by the relayer also being a payee.
        // WRAPPED, and safe to retry: `getNewFundedAddress` mints gas internally
        // (100 XCHAIN seed) so it reaches a `status=valid` wait and starves under the
        // wedge, and it is keyed by label, so a second attempt re-funds this same
        // relayer rather than minting another identity.
        broadcaster = await withWedgeClear('funding the at6 relayer',
            () => cryptoHelper.getNewFundedAddress('at6-relayer', COIN, NETWORK, null, 'legacy', 0, 0.02))
        await regtestMinerConnector.generateBlocks(2)
        await settleOrReport('at6')
    })

    after(async function () {
        if (httpServer) await new Promise((r) => httpServer.close(() => r()))
        if (venue) await venue.stop()
    })

    /** The wire a stale legacy publisher would put on chain for this request. */
    async function broadcastStaleOnChainResponse (requestId, label) {
        const validators = [
            new attestationHelper.MockAttestationValidator(),
            new attestationHelper.MockAttestationValidator(),
            new attestationHelper.MockAttestationValidator(),
        ]
        const sent = await attestationHelper.broadcastAttestationResponse(broadcaster, {
            requestId: requestId,
            providerId: 'http_get',
            responsePayload: FIXED_BODY,
            status: 'ok',
            meta: '',
            validators: validators,
            network: NETWORK,
        })
        await regtestMinerConnector.generateBlocks(1)
        await settleOrReport('at6')
        assert.ok(sent && sent.txHash,
            label + ': the on-chain ATTEST v1 was not broadcast, so the gate was never offered anything')
        return String(sent.txHash)
    }

    it('refuses an on-chain v1, applies the mirror row anyway, and settles the whole escrow', async function () {
        // Watermark FIRST: see attestRequestWatermark for why the execute's own
        // action index cannot be trusted as the correlation input.
        const sinceAction = await attestRequestWatermark(contract.contractIndex)
        await clearBeforeBroadcast()
        const exec = await vmHelper.sendExecuteV0(
            contract.owner, contract.contractIndex, 'ask', ['http_get', testUrl])
        assert.strictEqual(exec.execution.status, 'valid',
            'the EXECUTE that emits the request came back ' + exec.execution.status)

        const request = await findEmittedAttestRequest(
            contract.contractIndex, sinceAction + 1, { label: 'at6 first' })
        const requestId = request.requestId

        await regtestMinerConnector.generateBlocks(BURIAL_BLOCKS)
        await settleOrReport('at6')
        await waitForMirrorRowEverywhere(venue, requestId)

        // THE STALE BROADCAST, while the request is still pending, which is the only
        // moment at which accepting it would double-deliver.
        await broadcastStaleOnChainResponse(requestId, 'pending')

        // Both rows now exist, or will shortly: the refused chain row and the
        // applied mirror row. Waiting for the applied one is waiting for a v1 with a
        // NULL transaction position, because the chain row is a v1 too.
        const settled = await untilOrClearDogeStall(async () => {
            await regtestMinerConnector.generateBlocks(1)
            const perIndexer = []
            for (const ix of venue.indexers) perIndexer.push(await readResponseRows(venue, ix.index, requestId))
            const ok = perIndexer.every((rows) =>
                rows.some((r) => r.tx_index === null) && rows.some((r) => r.tx_index !== null))
            return { ok: ok, perIndexer: perIndexer }
        }, { timeoutMs: 15 * 60 * 1000, intervalMs: 3000, tipProbe: venueTipProbe(venue, 0) })
        assert.ok(settled.ok,
            'the two v1 rows this case needs did not both appear on both indexers. Rows seen: ' +
            JSON.stringify((settled.perIndexer || []).map((rows) =>
                rows.map((r) => ({ action: r.action_index, tx: r.tx_index, verdict: r.verdict })))) +
            '\n' + venue.logTail('indexer0'))

        for (const ix of venue.indexers) {
            const rows    = settled.perIndexer[ix.index]
            const onChain = rows.filter((r) => r.tx_index !== null)
            const applied = rows.filter((r) => r.tx_index === null)

            // THE GATE. The exact string, because it is a stored verdict a replay
            // re-derives; and asserting it exactly is also what rules out the
            // rejection having come from the deliberately fake signatures, which
            // would read as a different string entirely.
            assert.strictEqual(String(onChain[0].verdict), MIRROR_ERA_VERDICT,
                'indexer ' + ix.index + ' recorded the on-chain v1 as "' + onChain[0].verdict +
                '" rather than "' + MIRROR_ERA_VERDICT + '". Above the height the chain handler must refuse ' +
                'it before every other request-derived branch, or a stale hub double-delivers.')
            assert.strictEqual(onChain[0].validator_signatures, null,
                'indexer ' + ix.index + ' stored signatures for a refused on-chain v1')
            assert.strictEqual(onChain[0].callback_execute_action_index, null,
                'indexer ' + ix.index + ' fired a callback from the REFUSED on-chain v1, which is the ' +
                'double-delivery this gate exists to prevent')

            // AND THE MIRROR STILL LANDS. The refusal must not consume the request.
            assert.ok(applied[0].callback_execute_action_index !== null,
                'indexer ' + ix.index + ' applied the mirror row without injecting a callback')
            assert.strictEqual(String(applied[0].response_payload), FIXED_BODY,
                'indexer ' + ix.index + ' applied a body other than the one the provider served')

            const req = await readRequestRow(venue, ix.index, requestId)
            assert.strictEqual(String(req.request_status), 'fulfilled',
                'indexer ' + ix.index + ' left the request ' + req.request_status +
                ' after the mirror row applied')
        }

        const state = await readContractState(venue, 0, contract.contractIndex)
        assert.strictEqual(JSON.parse(state.callback_status), 'ok',
            'the callback did not fire from the mirror row (status ' + state.callback_status + ')')

        // ---- the money ----------------------------------------------------
        const local = await readRequestRow(venue, 0, requestId)
        const escrow = String(local.fee_amount)
        assert.ok(mathjs.bignumber(escrow).gt(mathjs.bignumber('0')),
            'this request escrowed no fee (' + escrow + '), so the split assertions below would pass ' +
            'trivially and prove nothing about the retired carve-out')

        for (const ix of venue.indexers) {
            const rewards = await readAttestRewards(venue, ix.index, { roundReference: Number(local.action_index) })
            const bcast   = rewards.filter((r) => String(r.reward_type) === 'attest_bcast')
            const fees    = rewards.filter((r) => String(r.reward_type) === 'attest_fee')

            // NOT WRITTEN AT ALL is the claim, and zero is not a cardinality claim
            // about any roster: it is the absence of a row type.
            assert.deepStrictEqual(bcast, [],
                'indexer ' + ix.index + ' wrote ' + bcast.length + ' attest_bcast row(s) for a mirror-era ' +
                'request. Nobody broadcasts above the height, so the reimbursement is retired and the row ' +
                'type must not appear: ' + JSON.stringify(bcast))

            assert.ok(fees.length > 0,
                'indexer ' + ix.index + ' paid no attest_fee at all, so the escrow went nowhere')

            // THE WHOLE ESCROW. Deliberately expressed as a residual rather than as
            // an expected per-signer amount: the number of payees comes from the
            // responsible set the indexer recomputed, which is not this drill's to
            // predict, so the drill divides by the count it actually found.
            const paid = fees.reduce((acc, r) => acc.add(mathjs.bignumber(String(r.amount))),
                mathjs.bignumber('0'))
            const residual = mathjs.bignumber(escrow).sub(paid)
            const dust = mathjs.bignumber(String(fees.length)).mul(mathjs.bignumber('1e-' + FEE_DECIMALS))
            assert.ok(residual.gte(mathjs.bignumber('0')),
                'indexer ' + ix.index + ' paid ' + paid.toString() + ' out of an escrow of ' + escrow +
                ', which is MORE than was escrowed')
            assert.ok(residual.lt(dust),
                'indexer ' + ix.index + ' paid ' + paid.toString() + ' of the ' + escrow + ' escrow across ' +
                fees.length + ' attest_fee rows, leaving ' + residual.toString() + ' behind. The only ' +
                'shortfall the split may leave is the floor remainder, under ' + dust.toString() +
                '. Anything larger means a carve-out was still taken out of the pool, which is exactly what ' +
                'the flag day retires.')
            console.log('AT6: indexer ' + ix.index + ' split ' + paid.toString() + ' of ' + escrow +
                ' across ' + fees.length + ' attest_fee rows, no attest_bcast')
        }
    })

    it('still refuses an on-chain v1 for the SAME reason once the request is fulfilled', async function () {
        // The ordering half, and it is cheap now that a fulfilled mirror-era request
        // exists. Every request-derived branch below the gate also rejects, so an
        // ordering fault could not admit the action; what it WOULD do is record a
        // different reason for the same wire depending on the request's incidental
        // state, and the reason is consensus. This case is what notices that.
        // Watermark FIRST: see attestRequestWatermark for why the execute's own
        // action index cannot be trusted as the correlation input.
        const sinceAction = await attestRequestWatermark(contract.contractIndex)
        await clearBeforeBroadcast()
        const exec = await vmHelper.sendExecuteV0(
            contract.owner, contract.contractIndex, 'ask', ['http_get', testUrl])
        assert.strictEqual(exec.execution.status, 'valid',
            'the second EXECUTE came back ' + exec.execution.status)
        const request = await findEmittedAttestRequest(
            contract.contractIndex, sinceAction + 1, { label: 'at6 second' })
        const requestId = request.requestId

        await regtestMinerConnector.generateBlocks(BURIAL_BLOCKS)
        await settleOrReport('at6')
        await waitForMirrorRowEverywhere(venue, requestId)

        // Let it reach a terminal state FIRST this time.
        const done = await untilOrClearDogeStall(async () => {
            await regtestMinerConnector.generateBlocks(1)
            const req = await readRequestRow(venue, 0, requestId)
            return { ok: !!req && String(req.request_status) === 'fulfilled', req: req }
        }, { timeoutMs: 15 * 60 * 1000, intervalMs: 3000, tipProbe: venueTipProbe(venue, 0) })
        assert.ok(done.ok, 'the second request never reached fulfilled: ' +
            JSON.stringify(done.req) + '\n' + venue.logTail('indexer0'))

        await broadcastStaleOnChainResponse(requestId, 'fulfilled')

        const seen = await untilOrClearDogeStall(async () => {
            await regtestMinerConnector.generateBlocks(1)
            const rows = await readResponseRows(venue, 0, requestId)
            return { ok: rows.some((r) => r.tx_index !== null), rows: rows }
        }, { timeoutMs: 10 * 60 * 1000, intervalMs: 3000, tipProbe: venueTipProbe(venue, 0) })
        assert.ok(seen.ok, 'the second on-chain v1 never appeared on the venue indexer')

        const onChain = seen.rows.filter((r) => r.tx_index !== null)[0]
        assert.strictEqual(String(onChain.verdict), MIRROR_ERA_VERDICT,
            'the refusal for an already-fulfilled mirror-era request reads "' + onChain.verdict +
            '". It must still be the flag-day reason: the gate is deliberately the FIRST request-derived ' +
            'branch so that one wire gets one stored verdict regardless of the request\'s incidental state.')
        assert.ok(!String(onChain.verdict).startsWith(ALREADY_VERDICT_PREFIX),
            'the already-terminal branch answered first, which makes the stored verdict depend on timing')
        console.log('AT6: a second on-chain v1 against a fulfilled request also reads ' + MIRROR_ERA_VERDICT)
    })

    /**
     * NOT DRIVABLE ON REGTEST, and this is a measurement rather than an omission.
     *
     * AT6's first clause asks for a request BELOW the activation height, served on
     * chain exactly as it is today. On regtest there is no such request and there
     * cannot be one:
     *
     *   ATTEST_RESPONSE_MIRROR_ACTIVATION = { mainnet: null, testnet: null, regtest: 0 }
     *   isResponseMirrorActive(requestBlock, network) => requestBlock >= threshold
     *
     * The map is a module-level constant in `xchain-indexer/src/attest_response_mirror_activation.js`
     * and its twin in the hub, and the resolver reads it directly: no environment
     * variable, no config key, no injected parameter. Regtest is armed at 0 and no
     * block index is below 0, so every regtest request that can exist is mirror-era.
     * The unit tiers on both sides reach this case by mutating the exported object
     * or stubbing the exported function in-process, which an out-of-process venue
     * child cannot do.
     *
     * THREE WAYS TO CLOSE IT, all of them the operator's rather than this drill's:
     *   1. accept the in-process coverage as the whole of the below-height claim.
     *      The hub's era-partition guard already sweeps heights either side of a
     *      temporarily raised regtest activation, and the indexer's ATTEST battery
     *      drives the legacy path with the gate stubbed off;
     *   2. give the activation resolver a regtest-only override on the pattern
     *      `ATTEST_RESPONSE_FORWARD_S_OVERRIDE` already sets, which would make this
     *      case drivable as written, at the cost of an env-settable seam in a
     *      consensus constant;
     *   3. drive it on testnet after the height is armed, where a genuine below is
     *      the whole history that precedes it. That is AT-T1's territory.
     *
     * Option 2 is the only one that makes THIS drill green, and it is a change to a
     * consensus surface, so it is not a test author's call to make.
     */
    it.skip('serves a request below the activation height on chain (not drivable on regtest: see comment)',
        async function () {
            assert.fail('unreachable: regtest is armed at height 0')
        })
})
