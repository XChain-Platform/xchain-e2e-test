'use strict'

// Step functions for the below-height half of zc5_flag_day.test.js: synthetic
// heights on testnet, no venue. Pure extraction: bodies are unchanged.

const assert = require('assert')

const { loadHubModule } = require('../../helpers/multiValidatorHubHelper')
const { jsonSafe } = require('./mirrorDrillWaits')
const {
    T_REQ_BLOCK, T_DEADLINE, TESTNET_ZERO_CONF_HEIGHT, R_REQ_BLOCK, R_DEADLINE,
} = require('./zc5_fixture')

function loadBelowModules (ctx) {
    // REQUIRED HERE, not at module scope, and the reason is this file's other half:
    // pulling xchain-indexer's utility into the harness loads the whole action module
    // tree, and a venue-only run has no use for it. The hub modules resolve through
    // the same loader every other drill uses, so a relocated checkout moves them all
    // together.
    ctx.zc  = loadHubModule('src/attestation/attest_zero_conf_gate.js')
    ctx.wid = loadHubModule('src/consensus/gates/attest_responsible_widening_gate.js')
    // The indexer's own copy of the selector. `INDEXER_COIN`/`INDEXER_NETWORK` are
    // read when the module initialises, and are set only if the harness has not
    // already set them, so this cannot move a value another suite is relying on.
    if (!process.env.INDEXER_COIN)    process.env.INDEXER_COIN = 'BTC'
    if (!process.env.INDEXER_NETWORK) process.env.INDEXER_NETWORK = 'regtest'
    ctx.Utility = require('../../../../xchain-indexer/src/utility.js')
}

function assertFixtureAssumption (ctx) {
    const { zc, wid } = ctx
    // THE ASSUMPTION EVERY CASE BELOW RESTS ON. If the operator arms testnet (the
    // frontier's own row 19), these cases would silently start testing the
    // above-height branch while still claiming to test the below-height one,
    // which is the most dangerous direction for a flag-day test to fail in.
    assert.strictEqual(zc.ATTEST_ZERO_CONF_ACTIVATION.testnet, TESTNET_ZERO_CONF_HEIGHT,
        'ATTEST_ZERO_CONF_ACTIVATION.testnet moved from the pinned height ' +
        TESTNET_ZERO_CONF_HEIGHT + ' to ' + zc.ATTEST_ZERO_CONF_ACTIVATION.testnet +
        '; resize the synthetic below-height window before trusting these cases')
    assert.ok(T_DEADLINE < TESTNET_ZERO_CONF_HEIGHT,
        'the synthetic request window reaches testnet zero-conf activation at ' +
        TESTNET_ZERO_CONF_HEIGHT + '; these cases no longer exercise the below-height branch')
    assert.strictEqual(zc.isZeroConfActive(T_REQ_BLOCK, 'testnet'), false)
    assert.ok(Number.isInteger(wid.ATTEST_RESPONSIBLE_WIDENING_ACTIVATION.testnet) &&
              T_REQ_BLOCK >= wid.ATTEST_RESPONSIBLE_WIDENING_ACTIVATION.testnet,
        'the testnet request block ' + T_REQ_BLOCK + ' is below the widening height ' +
        wid.ATTEST_RESPONSIBLE_WIDENING_ACTIVATION.testnet + ', so widenSlots returns 0 through ' +
        'its ARMING guard rather than through the stage-1 ladder and the cases below would pass ' +
        'for the wrong reason')
    // And the above-height side really is above it, or every twin below is vacuous.
    assert.strictEqual(zc.isZeroConfActive(R_REQ_BLOCK, 'regtest'), true)
}

function assertConfirmationsFor () {
    const AttestationRound = loadHubModule('src/attestation/round.js')
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
}

function assertWidenHeadroom (wid) {
    // AT THE REQUEST'S OWN BLOCK is the discriminator, and it is the branch §4.1
    // exists for: stage 1 computes elapsed = 0 and returns 0, so headroom would be
    // inert on exactly the block it is for; V2 returns its headroom instead.
    assert.strictEqual(wid.widenSlots(T_REQ_BLOCK, T_REQ_BLOCK, T_DEADLINE, 'testnet'), 0,
        'below the height the ladder must still return 0 at the request block. A 1 here means the ' +
        'V2 early return is reachable below the flag day, which forks a mixed fleet on WHO MAY SIGN.')
    assert.strictEqual(wid.widenSlots(R_REQ_BLOCK, R_REQ_BLOCK, R_DEADLINE, 'regtest'),
        wid.ATTEST_RESPONSIBLE_WIDENING_V2.headroom,
        'above the height the ladder must return the headroom slot at the request block')
}

function assertStage1Ladder (wid) {
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
}

function assertWidenSlots (ctx) {
    assertWidenHeadroom(ctx.wid)
    assertStage1Ladder(ctx.wid)
}

const SEL_BODY = 'zc5'
const SEL_REQ_ID = 'e'.repeat(64)

function selectorRows () {
    const crypto = require('crypto')
    const hash = crypto.createHash('sha256').update(Buffer.from(SEL_BODY, 'utf8')).digest('hex')

    const mirrorRow = (effectiveTime, responseHash) => ({
        request_id: SEL_REQ_ID, provider_id: 'http_get', status: 'ok',
        response_payload: SEL_BODY, response_hash: responseHash || hash, meta: '',
        effective_time: effectiveTime,
        signer_pubkeys: JSON.stringify(['a'.repeat(64)]),
        signatures: JSON.stringify([{ pubkey: 'a'.repeat(64), sig: '1'.repeat(128) }]),
        widen: 0,
    })

    // TWO rows for one request, which is the whole point: below the height the loser
    // of the tie-break is DISCARDED and the item is the single choice, so a first row
    // that turns out inert strands the request until its deadline. That is the
    // behaviour a mixed fleet must keep agreeing on below the flag day (D11).
    const time = 1700000000
    return { time: time, rows: [mirrorRow(time, 'b'.repeat(64)), mirrorRow(time - 5, 'a'.repeat(64))] }
}

function selectorRequestRow (blockIndex, deadline) {
    return {
        request_id: SEL_REQ_ID, action_index: 11, provider_id: 'http_get',
        request_status: 'pending', deadline_block: deadline, block_index: blockIndex,
        redundancy: 1, contract_index: 5, callback_method: 'onResult', callback_params_json: '[]',
    }
}

function assertSelectorBelow (util, rows, time) {
    const below = util.selectApplicableAttestationResponses(
        rows, [selectorRequestRow(T_REQ_BLOCK, T_DEADLINE)], T_REQ_BLOCK + 10, time, 'testnet')
    assert.strictEqual(below.length, 1, 'the selector returned ' + below.length + ' item(s) for one request')
    assert.strictEqual(Object.prototype.hasOwnProperty.call(below[0], 'candidates'), false,
        'the below-height item carries a `candidates` key. The item SHAPE is what a mixed fleet ' +
        'agrees on: an old indexer has no such key, and adding one below the height is how the two ' +
        'start binding different rows for the same request.')
    assert.strictEqual(Number(below[0].response.effective_time), time - 5,
        'the below-height item did not choose the smaller effective_time')
}

function assertSelectorAbove (util, rows, time) {
    const above = util.selectApplicableAttestationResponses(
        rows, [selectorRequestRow(R_REQ_BLOCK, R_DEADLINE)], R_REQ_BLOCK + 10, time, 'regtest')
    assert.strictEqual(above.length, 1, 'the selector returned ' + above.length + ' item(s) for one request')
    assert.ok(Array.isArray(above[0].candidates) && above[0].candidates.length === 2,
        'the above-height item does not carry both rows as candidates: ' + jsonSafe(above[0].candidates))
    assert.strictEqual(Number(above[0].candidates[0].effective_time), time - 5,
        'the candidate list is not sorted by effective_time ascending')
    assert.strictEqual(Number(above[0].response.effective_time),
        Number(above[0].candidates[0].effective_time),
        'the item response is not the head of its own candidate list')
}

function assertSelectorCandidates (ctx) {
    const util = new ctx.Utility()
    const { time, rows } = selectorRows()
    assertSelectorBelow(util, rows, time)
    assertSelectorAbove(util, rows, time)
}

module.exports = {
    loadBelowModules, assertFixtureAssumption, assertConfirmationsFor,
    assertWidenSlots, assertSelectorCandidates,
}
