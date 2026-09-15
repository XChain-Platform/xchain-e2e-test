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
const cryptoHelper = require('../../cryptoHelper')
const stakeHelper = require('../../helpers/stakeHelper')
const gasHelper = require('../../helpers/gasHelper')
const vmHelper = require('../../helpers/vmHelper')
const attestationHelper = require('../../helpers/attestationHelper')

const state = {
    operatorAddr: null,
    validator: null,
    contractIndex: null,
    requestId: null,
    extraValidators: null,
    stakedValidators: []
}

const CONTRACT_CODE = `
module.exports = {
    meta: { name: 'Attest Asker', description: 'Requests a URL attestation from the oracle federation.', version: '1.0.0' },
    askOracle: function(xchain) {
        var url = xchain.getInputParam(0);
        var requestId = xchain.attestation.request(
            'http_get',
            url,
            'handleResponse',
            ['ctx-42'],
            { redundancy: 1, deadlineBlocks: 10 }
        );
        xchain.state.set('pending_request_id', requestId);
        return requestId;
    },
    handleResponse: function(xchain) {
        xchain.state.set('callback_request_id', xchain.getInputParam(0));
        xchain.state.set('callback_provider_id', xchain.getInputParam(1));
        xchain.state.set('callback_status', xchain.getInputParam(2));
        xchain.state.set('callback_payload', xchain.getInputParam(3));
        xchain.state.set('callback_context', xchain.getInputParam(4));
    },
    askOracleExpiring: function(xchain) {
        var url = xchain.getInputParam(0);
        var requestId = xchain.attestation.request(
            'http_get',
            url,
            'handleExpiry',
            ['ctx-expiry'],
            { redundancy: 1, deadlineBlocks: 2 }
        );
        xchain.state.set('expiring_request_id', requestId);
        return requestId;
    },
    askOracleQuorum: function(xchain) {
        var url = xchain.getInputParam(0);
        var requestId = xchain.attestation.request(
            'http_get',
            url,
            'handleResponse',
            ['ctx-quorum'],
            { redundancy: 3, deadlineBlocks: 20 }
        );
        xchain.state.set('quorum_request_id', requestId);
        return requestId;
    },
    handleExpiry: function(xchain) {
        xchain.state.set('expiry_request_id', xchain.getInputParam(0));
        xchain.state.set('expiry_provider_id', xchain.getInputParam(1));
        xchain.state.set('expiry_status', xchain.getInputParam(2));
        xchain.state.set('expiry_payload', xchain.getInputParam(3));
        xchain.state.set('expiry_context', xchain.getInputParam(4));
    }
};
`

// Full set of attestation validators staked on this chain, in stake order. The
// indexer's responsible-set computation runs over EVERY staked attestation key at
// the request's block, so the test must mirror that whole set to predict which keys
// are responsible for a given request_id (see computeResponsibleSigners).

// Stake a validator from its OWN distinct funded source. SWQ source-dedup (active on
// regtest at block 0) collapses every key sharing a staking source into ONE slot in a
// request's responsible set, so staking all validators from one operator address would
// leave only a single survivor (the redundancy=3 cap-at-1/3 bug). A distinct source per
// validator keeps them all eligible. Does NOT advance blocks; the caller mines past the
// activation delay once after staking a batch.
async function stakeValidatorFromOwnSource(v) {
    // Distinct HD address index per validator (0,1,2,…). cryptoHelper caches ONE
    // wallet/mnemonic per label, so reusing label 'attest-val' at addressIndex 0 every
    // time would derive the SAME address → same staking source → SWQ dedup collapses
    // them back to one slot (the exact bug this fix targets). Indexing by the current
    // count gives each validator a genuinely distinct source address.
    let stakeSource = await cryptoHelper.getNewFundedAddress(
        'attest-val', COIN, NETWORK, null, 'legacy', state.stakedValidators.length, 0.02
    )
    // Enough XCHAIN to stake 15000 + cover the STAKE protocol fee. 15000 clears BOTH
    // the attestation capability min_stake (1000) and the http_get PROVIDER floor
    // (10000), which the responsible-set derivation enforces at/above
    // STAKE_WEIGHTED_QUORUM (armed at genesis on regtest).
    await gasHelper.ensureGasBalance(stakeSource, '20000')
    await stakeHelper.sendStakeV1(stakeSource, '15000.00000000', v.pubkey)
    v.source = stakeSource.address
    state.stakedValidators.push(v)
    // Session-wide registration: later suites on this shared chain must include
    // these keys when they mirror the indexer's responsible-set ranking, or the
    // ranking selects keys they cannot sign with (see attestationHelper).
    attestationHelper.registerStakedValidator(v)
    return v
}

async function prepareAttestation(context) {
    if (state.contractIndex) return
    // Attestation framework rides on STAKE + EXECUTE (both BTC-only protocol features).
    if (COIN_CODE !== 'BTC') {
        console.log('Attestation framework requires BTC chain; skipping on ' + COIN_CODE)
        context.skip()
        return
    }

    // Fund an operator address that'll own the contract AND broadcast the response actions.
    // (Validators are staked from their OWN distinct sources; see stakeValidatorFromOwnSource.)
    const operatorAddr = await cryptoHelper.getNewFundedAddress(
        'attest-op', COIN, NETWORK, null, 'legacy', 0, 0.02
    )
    // Enough XCHAIN for: DEPLOY gas + many EXECUTE gas + response-broadcast fees
    await gasHelper.ensureGasBalance(operatorAddr, '5000')

    // Spin up an in-process validator (real keypair) and stake its pubkey from its own
    // funded source so the indexer's hasCapability('attestation', ...) check passes and
    // it survives SWQ source-dedup into request responsible sets.
    const validator = new attestationHelper.MockAttestationValidator()
    await stakeValidatorFromOwnSource(validator)
    // Advance past activation delay AND the snapshot burial, so the stake is
    // selectable into a responsible set (see ATTESTATION_STAKE_VISIBLE_BLOCKS).
    await regtestMinerConnector.generateBlocks(stakeHelper.ATTESTATION_STAKE_VISIBLE_BLOCKS)
    // The encoder refuses UTXO selection while the tracker trails the node, so the
    // next tx build races these blocks unless the tracker is caught up first.
    await utxoTrackerConnector.waitForSync()

    // Deploy the test contract
    const deploy = await vmHelper.sendDeployV0(operatorAddr, CONTRACT_CODE, 500000)
    assert(deploy.contract, 'contract should deploy')
    assert.strictEqual(deploy.contract.status, 'valid', 'deploy status: ' + deploy.contract.status)
    state.operatorAddr = operatorAddr
    state.validator = validator
    state.contractIndex = deploy.contract.action_index
}

module.exports = { state, prepareAttestation, stakeValidatorFromOwnSource }
