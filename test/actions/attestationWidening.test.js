// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const assert = require('assert')
const crypto = require('crypto')
const cryptoHelper = require('../cryptoHelper')
const stakeHelper = require('../helpers/stakeHelper')
const gasHelper = require('../helpers/gasHelper')
const vmHelper = require('../helpers/vmHelper')
const attestationHelper = require('../helpers/attestationHelper')

/**
 * ATTEST responsible-set widening, driven on a chain.
 *
 * REPRODUCES A LIVE INCIDENT. On BTC testnet4 (2026-09-02) request 77f37a86...
 * asked for redundancy 3 and drew a responsible set of three whose middle member
 * is a validator that is staked and has never connected to the federation. Two
 * live members can never produce the three signatures finalization requires, so
 * every round died on the consensus round timeout and the request burned its
 * whole deadline window and expired with zero responses.
 *
 * The fix is a liveness ladder: the responsible set widens by one slot per
 * segment of the request's own serviceable span, so the pool permitted to sign
 * grows once the assigned set has demonstrably failed. It does NOT lower the
 * `redundancy` signatures required to finalize.
 *
 * This suite drives BOTH sides of that on a real chain, because a test that only
 * showed the second half would pass just as well against a set that was wide all
 * along:
 *
 *   PHASE A (inside the first segment, widen = 0): a response signed by three
 *     validators, one of which sits OUTSIDE the base set, must be REJECTED. Its
 *     out-of-set signature is filtered, leaving 2 of the 3 required. This is the
 *     incident, and it is the control that proves the ladder is actually gating.
 *   PHASE B (past the second segment boundary, widen >= 1): the byte-identical
 *     signer set must now be ACCEPTED, the request flips to fulfilled, and the
 *     contract's callback fires.
 *
 * Nothing about the request, the signers, or the payload changes between the two
 * phases. The only difference is chain height, which is the whole claim.
 */

describe('Attestation: responsible-set widening rescues a set with a non-serving member', function () {

    // deadlineBlocks 30 with confirmations 3 leaves a 27-block serviceable span,
    // split into three 9-block segments (maxSlots 2 + 1). Long enough that both
    // phases are comfortably observable without racing a segment boundary; the
    // live incident's 10-block window is proven in the unit suites instead.
    const DEADLINE_BLOCKS = 30
    const CONFIRMATIONS   = 3
    const MAX_SLOTS       = 2
    const REDUNDANCY      = 3
    // How many validators of our own to stake. The chain also carries validators
    // from earlier suites whose keys we do not hold; those are real non-signers and
    // the ranking below accounts for them.
    const OWNED           = 6

    let operatorAddr  = null
    let contractIndex = null
    const owned = []            // MockAttestationValidator[], keys we can sign with

    const CONTRACT_CODE = `
module.exports = {
    askWidening: function(xchain) {
        var url = xchain.getInputParam(0);
        var requestId = xchain.attestation.request(
            'http_get',
            url,
            'handleResponse',
            ['ctx-widen'],
            { redundancy: ${REDUNDANCY}, deadlineBlocks: ${DEADLINE_BLOCKS} }
        );
        xchain.state.set('widen_request_id', requestId);
        return requestId;
    },
    handleResponse: function(xchain) {
        xchain.state.set('widen_callback_status', xchain.getInputParam(2));
        xchain.state.set('widen_callback_payload', xchain.getInputParam(3));
        xchain.state.set('widen_callback_context', xchain.getInputParam(4));
    }
};
`

    // Mirror of attest_responsible_widening_activation.widenSlots, so the suite
    // predicts the ladder from chain height instead of trusting it.
    function widenSlots(atBlock, requestBlock, deadlineBlock) {
        const start = requestBlock + CONFIRMATIONS
        const span  = deadlineBlock - start
        if (!(span > 0)) return 0
        const elapsed = atBlock - start
        if (!(elapsed > 0)) return 0
        return Math.max(0, Math.min(Math.floor(elapsed / (span / (MAX_SLOTS + 1))), MAX_SLOTS))
    }

    // Rank the FULL live attestation set the indexer will rank over, not just our
    // own keys: a foreign key that outranks ours takes a real slot, and predicting
    // the set from our own validators alone is a mistake these suites have made
    // before, which surfaces as an unexplained shortfall in valid signatures.
    function rank(requestId, validators) {
        const withHash = validators.map(v => ({
            pubkey: String(v.pubkey).toLowerCase(),
            source: (v.source != null ? String(v.source) : null),
            hash: crypto.createHash('sha256').update(String(requestId), 'utf8')
                .update(String(v.pubkey).toLowerCase(), 'utf8').digest('hex')
        }))
        withHash.sort((a, b) => (a.hash < b.hash) ? -1 : (a.hash > b.hash ? 1 : 0))
        // SWQ source-dedup (armed at genesis on regtest): one slot per staking source.
        const seen = new Set()
        return withHash.filter(v => {
            if (v.source === null) return true
            if (seen.has(v.source)) return false
            seen.add(v.source)
            return true
        })
    }

    async function stakeOwnedValidator() {
        const v = new attestationHelper.MockAttestationValidator()
        const stakeSource = await cryptoHelper.getNewFundedAddress(
            'widen-val', COIN, NETWORK, null, 'legacy', owned.length, 0.02
        )
        // 15000 clears both the attestation capability floor (1000) and the
        // http_get provider floor (10000) the weighted path enforces.
        await gasHelper.ensureGasBalance(stakeSource, '20000')
        await stakeHelper.sendStakeV1(stakeSource, '15000.00000000', v.pubkey)
        v.source = stakeSource.address
        owned.push(v)
        attestationHelper.registerStakedValidator(v)
        return v
    }

    before(async function () {
        if (COIN_CODE !== 'BTC') {
            console.log('Attestation widening requires BTC chain; skipping on ' + COIN_CODE)
            this.skip()
            return
        }
        operatorAddr = await cryptoHelper.getNewFundedAddress(
            'widen-op', COIN, NETWORK, null, 'legacy', 0, 0.02
        )
        await gasHelper.ensureGasBalance(operatorAddr, '8000')

        for (let i = 0; i < OWNED; i++) await stakeOwnedValidator()
        await regtestMinerConnector.generateBlocks(stakeHelper.ATTESTATION_STAKE_VISIBLE_BLOCKS)
        await utxoTrackerConnector.waitForSync()

        const deploy = await vmHelper.sendDeployV0(operatorAddr, CONTRACT_CODE, 500000)
        assert.strictEqual(deploy.contract.status, 'valid', 'deploy status: ' + deploy.contract.status)
        contractIndex = deploy.contract.action_index
    })

    it('rejects an out-of-set signature before the ladder opens, then accepts the SAME set after it', async function () {
        const ownedKeys = new Set(owned.map(v => String(v.pubkey).toLowerCase()))
        let request = null
        let signers = null
        let ranked  = null

        // Find a request whose geometry demonstrates the ladder: at least one of our
        // signable keys must sit OUTSIDE the base REDUNDANCY slots but INSIDE the
        // widened set, or phase A has nothing to reject. Each EXECUTE mints a fresh
        // request_id and therefore a fresh ranking, so this converges quickly.
        for (let attempt = 0; attempt < 8 && !signers; attempt++) {
            const exec = await vmHelper.sendExecuteV0(operatorAddr, contractIndex, 'askWidening',
                ['https://example.com/widen/' + attempt])
            assert.strictEqual(exec.execution.status, 'valid', 'execute status: ' + exec.execution.status)
            const row = await indexerDatabase.waitForAttestationRequest({
                txHash: exec.txHash, requestStatus: 'pending'
            })
            assert(row, 'request row should exist as pending')
            assert.strictEqual(Number(row.redundancy), REDUNDANCY)

            const pool = await indexerConnector.getCapabilityValidators('attestation', Number(row.block_index))
            const r = rank(row.request_id, pool.validators || pool)
            const base   = r.slice(0, REDUNDANCY).map(x => x.pubkey)
            const widen  = r.slice(0, REDUNDANCY + MAX_SLOTS).map(x => x.pubkey)
            const inBase = base.filter(pk => ownedKeys.has(pk))
            const extra  = widen.slice(REDUNDANCY).filter(pk => ownedKeys.has(pk))

            if (inBase.length >= REDUNDANCY - 1 && extra.length >= 1) {
                // Deliberately short of the base set by one, made up from a widened slot:
                // exactly the shape of a set holding one member that never signs.
                signers = inBase.slice(0, REDUNDANCY - 1).concat(extra.slice(0, 1))
                request = row
                ranked  = { base, widen }
            } else {
                console.log('  geometry attempt ' + attempt + ': ownedInBase=' + inBase.length +
                            ' ownedInWidenedTail=' + extra.length + '; re-executing for a fresh ranking')
            }
        }
        assert(signers, 'could not find a request geometry with an owned key outside the base set')

        const requestBlock  = Number(request.block_index)
        const deadlineBlock = Number(request.deadline_block)
        const signerObjs = signers.map(pk => owned.find(v => String(v.pubkey).toLowerCase() === pk))
        assert.strictEqual(signerObjs.filter(Boolean).length, REDUNDANCY, 'all signers must be keys we hold')
        console.log('  base set   : ' + ranked.base.map(p => p.slice(0, 12)).join(' '))
        console.log('  widened set: ' + ranked.widen.map(p => p.slice(0, 12)).join(' '))
        console.log('  signing as : ' + signers.map(p => p.slice(0, 12)).join(' ') + '  (one is outside the base set)')

        // ---- PHASE A: inside the first segment, the ladder has granted nothing ----
        let tip = await nodeConnector.getBlockCount()
        const phaseATarget = requestBlock + CONFIRMATIONS + 1
        if (tip < phaseATarget) {
            await regtestMinerConnector.generateBlocks(phaseATarget - tip)
            await utxoTrackerConnector.waitForSync()
        }
        tip = await nodeConnector.getBlockCount()
        assert.strictEqual(widenSlots(tip, requestBlock, deadlineBlock), 0,
            'phase A must run at widen 0 (tip ' + tip + ', request ' + requestBlock + ')')

        await attestationHelper.broadcastAttestationResponse(operatorAddr, {
            requestId:       request.request_id,
            providerId:      'http_get',
            responsePayload: '{"widen":"phaseA"}',
            status:          'ok',
            meta:            '200',
            validators:      signerObjs
        })
        const rejected = await indexerDatabase.waitForAttestationResponse({
            requestId: request.request_id
        })
        assert(rejected, 'phase A response row should exist')
        assert.match(String(rejected.status), /insufficient valid signatures/,
            'phase A must be rejected for insufficient signatures, got: ' + rejected.status)
        const stillPending = await indexerDatabase.checkAttestationRequest({
            requestId: request.request_id, requestStatus: 'pending'
        })
        assert(stillPending, 'the request must still be pending after the rejected response')

        // ---- PHASE B: past the segment boundary, the same signers are in the set ----
        const phaseBTarget = requestBlock + CONFIRMATIONS +
            Math.ceil((deadlineBlock - (requestBlock + CONFIRMATIONS)) / (MAX_SLOTS + 1)) + 1
        tip = await nodeConnector.getBlockCount()
        if (tip < phaseBTarget) {
            await regtestMinerConnector.generateBlocks(phaseBTarget - tip)
            await utxoTrackerConnector.waitForSync()
        }
        tip = await nodeConnector.getBlockCount()
        assert.ok(widenSlots(tip, requestBlock, deadlineBlock) >= 1,
            'phase B must run at widen >= 1 (tip ' + tip + ')')
        assert.ok(tip < deadlineBlock, 'phase B must still be inside the deadline window')

        await attestationHelper.broadcastAttestationResponse(operatorAddr, {
            requestId:       request.request_id,
            providerId:      'http_get',
            responsePayload: '{"widen":"phaseB"}',
            status:          'ok',
            meta:            '200',
            validators:      signerObjs
        })
        const accepted = await indexerDatabase.waitForAttestationResponse({
            requestId: request.request_id, responseStatus: 'ok', status: 'valid'
        })
        assert(accepted, 'phase B response must land valid: the widened set admits the same signers')

        const sigs = await indexerDatabase.getAttestationValidatorSignatures(accepted.action_index)
        assert.strictEqual(sigs.length, REDUNDANCY, 'all ' + REDUNDANCY + ' signatures must count once widened')

        const fulfilled = await indexerDatabase.checkAttestationRequest({
            requestId: request.request_id, requestStatus: 'fulfilled'
        })
        assert(fulfilled, 'request must flip to fulfilled')

        const cbStatus  = await indexerDatabase.getContractState(contractIndex, 'widen_callback_status')
        const cbContext = await indexerDatabase.getContractState(contractIndex, 'widen_callback_context')
        assert(cbStatus, 'callback must have fired')
        assert.strictEqual(JSON.parse(cbStatus.state_value), 'ok')
        assert.strictEqual(JSON.parse(cbContext.state_value), 'ctx-widen')
    })
})
