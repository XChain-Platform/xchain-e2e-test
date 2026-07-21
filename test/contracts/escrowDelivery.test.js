// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// Escrow Delivery (on-chain): escrow that releases itself on a REAL delivery
// attestation, end to end.
//
//   DEPLOY escrowDelivery(buyer, seller, arbiter, tick, amount, deadlineBlocks,
//                         deliveryMarker)
//   buyer:  DEPOSIT(contract, TICK, amount), EXECUTE "fund"
//   anyone: EXECUTE "requestDelivery" trackingUrl
//              -> ATTEST v0 http_get request against a REAL public URL
//           (off-chain: 3 staked validators fetch the REAL URL through the
//            production http_get provider and sign the live body, exactly
//            like test/actions/realUrlAttestation.test.js)
//           -> indexer verifies 3/3, fulfills, fires onDelivery(request_id)
//              automatically as the attestation callback
//   if the live body contains deliveryMarker: onDelivery auto-pays the
//   seller, no EXECUTE "release" needed. Otherwise: no-op, and the manual
//   fallback path (release/refund/timeout, same authorization as the plain
//   `escrow` template) is what settles it.
//
// This is the first e2e that combines BOTH proven pieces from the showcase
// series: custody (DEPOSIT/fund/settle, proven by escrow/stableVault) and a
// REAL off-chain attestation round trip (proven by realUrlAttestation.test.js)
// - with the attestation's callback directly moving funds, not just state.
//
// The contract source below is a compacted copy of the canonical template at
// xchain-contracts/escrowDelivery/escrowDelivery.js (kept inline so the test
// is self-contained inside the e2e container, same convention as
// stableVault.test.js). Behaviour is identical; the VM unit test
// (escrowDelivery.test.js in xchain-contracts) covers the full matrix
// including the adversarial paths (replay, unauthorized settlement,
// double-settle). This e2e proves the wiring is real: a genuine off-chain
// HTTPS GET, signed by a genuine 3-validator quorum, driving a genuine
// on-chain token transfer with no human "release" call.

const assert = require('assert')
const _path = require('path')
const _fs = require('fs')

const cryptoHelper = require('../cryptoHelper')
const stakeHelper = require('../helpers/stakeHelper')
const gasHelper = require('../helpers/gasHelper')
const vmHelper = require('../helpers/vmHelper')
const attestationHelper = require('../helpers/attestationHelper')

// Resolve the REAL http_get provider the same way realUrlAttestation.test.js does.
const _hubBase = (function () {
    const candidates = [
        process.env.XCHAIN_HUB_PATH,
        _path.resolve(__dirname, '../../xchain-hub'),
        _path.resolve(__dirname, '../../../xchain-hub')
    ].filter(Boolean)
    for (const c of candidates) {
        if (_fs.existsSync(_path.join(c, 'src/providers/http_get.js'))) return c
    }
    return candidates[candidates.length - 1]
})()
const http_get = require(_hubBase + '/src/providers/http_get.js')

// Deterministic public endpoint (fixed resource, no time/counter fields) so
// byte-equality consensus across the 3 mocked validators is satisfiable -
// same endpoint realUrlAttestation.test.js uses.
const REAL_URL = 'https://jsonplaceholder.typicode.com/todos/1'
// A distinctive substring genuinely present in the live body (the fixed
// title field), independent of any JSON key/value spacing assumption.
const MARKER_MATCH = 'delectus aut autem'
// Guaranteed absent from that body - no formatting assumption needed.
const MARKER_NO_MATCH = 'no-such-delivery-token-xyz123'

// NOTE: minified (short var names, terse messages) to stay well under the
// DEPLOY payload cap; the readable canonical source lives in
// xchain-contracts/escrowDelivery/escrowDelivery.js. Behaviour is identical.
const ESCROW_DELIVERY = `module.exports = {
    initialize: function (x) {
        var b=x.getInputParam(0), s=x.getInputParam(1), a=x.getInputParam(2),
            t=x.getInputParam(3), m=x.getInputParam(4), d=x.getInputParam(5), k=x.getInputParam(6);
        x.require(b && s && a, 'buyer, seller, arbiter required');
        x.require(t, 'tick required');
        x.require(m && x.math.gt(m, '0'), 'amount must be positive');
        x.require(typeof k === 'string' && k.length > 0, 'deliveryMarker required');
        var w = parseInt(d);
        x.require(w > 0, 'deadlineBlocks must be a positive integer');
        x.state.set('buyer', b); x.state.set('seller', s); x.state.set('arbiter', a);
        x.state.set('tick', t); x.state.set('amount', m); x.state.set('window', String(w));
        x.state.set('deliveryMarker', k); x.state.set('status', 'INIT');
    },
    fund: function (x) {
        x.require(x.state.get('status') === 'INIT', 'escrow not awaiting funds');
        var t = x.state.get('tick'), m = x.state.get('amount');
        var h = x.getBalance(x.getContractAddress(), t) || '0';
        x.require(x.math.gte(h, m), 'insufficient deposit');
        x.state.set('deadline', String(x.getBlockHeight() + parseInt(x.state.get('window'))));
        x.state.set('status', 'FUNDED');
    },
    requestDelivery: function (x) {
        x.require(x.state.get('status') === 'FUNDED', 'escrow not funded');
        x.require(!x.state.get('pending'), 'a delivery check is already pending');
        var u = x.getInputParam(0);
        x.require(typeof u === 'string' && u.length > 0, 'trackingUrl required');
        var r = x.attestation.request('http_get', u, 'onDelivery', [], { redundancy: 3, deadlineBlocks: 20 });
        x.state.set('pending', r);
        return r;
    },
    onDelivery: function (x) {
        var r = x.getInputParam(0);
        x.require(r === x.state.get('pending'), 'not the outstanding delivery request');
        if (x.state.get('status') !== 'FUNDED') { x.state.delete('pending'); return 'ignored'; }
        var p = x.attestation.getResponse(r);
        x.require(p !== null, 'no response yet');
        if (p.status !== 'ok' || p.payload.indexOf(x.state.get('deliveryMarker')) === -1) {
            x.state.delete('pending'); return 'not delivered yet';
        }
        x.state.delete('pending');
        pay(x, 'seller', 'DELIVERED');
        return 'delivered';
    },
    release: function (x) { settle(x, ['buyer','arbiter'], 'seller', 'RELEASED', false); },
    refund: function (x) { settle(x, ['seller','arbiter'], 'buyer', 'REFUNDED', false); },
    timeout: function (x) { settle(x, ['buyer'], 'buyer', 'REFUNDED', true); },
    status: function (x) { return x.state.get('status'); }
};
function pay(x, role, term) {
    var t = x.state.get('tick');
    var h = x.getBalance(x.getContractAddress(), t) || '0';
    x.require(x.math.gt(h, '0'), 'nothing to settle');
    x.state.set('status', term);
    x.emit.send({ destination: x.state.get(role), tick: t, quantity: h });
}
function settle(x, roles, role, term, dl) {
    x.require(x.state.get('status') === 'FUNDED', 'escrow not funded / already settled');
    var c = x.getSourceAddress(), ok = false;
    for (var i=0;i<roles.length;i++){ if (c === x.state.get(roles[i])) { ok=true; break; } }
    x.require(ok, 'caller not authorized for this action');
    if (dl) x.require(x.getBlockHeight() >= parseInt(x.state.get('deadline')), 'deadline not reached');
    pay(x, role, term);
}`

describe('Escrow Delivery: custody + a REAL delivery attestation driving on-chain settlement', function () {
    this.timeout(10 * 60 * 1000)

    const CHAIN = ({ bitcoin: 'BTC', litecoin: 'LTC', dogecoin: 'DOGE' })[COIN] || 'BTC'
    const TICK = 'XCHAIN'
    const AMOUNT = '500'
    const stakedValidators = []

    async function q(sql, params) {
        const conn = await indexerDatabase.getConnection()
        try { return await conn.query(sql, params) }
        finally { await conn.release() }
    }
    async function balanceOf(address, tick) {
        const rows = await q(`SELECT b.amount FROM balances b
            JOIN index_addresses ia ON ia.id=b.address_id
            JOIN index_tickers it ON it.id=b.tick_id
            WHERE ia.address=? AND it.tick=?`, [address, tick])
        return rows.length ? String(rows[0].amount) : null
    }
    async function stateOf(ci, key) {
        const rows = await q(`SELECT state_value FROM contract_state
            WHERE contract_index=? AND state_key=?
            ORDER BY id DESC LIMIT 1`, [ci, key])
        if (!rows.length || rows[0].state_value === null) return null
        let v = String(rows[0].state_value)
        try { v = JSON.parse(v) } catch (e) { /* stored raw */ }
        return v
    }

    async function stakeValidatorFromOwnSource(v) {
        let stakeSource = await cryptoHelper.getNewFundedAddress(
            'esc-del-val', COIN, NETWORK, null, 'legacy', stakedValidators.length, 0.02
        )
        await gasHelper.ensureGasBalance(stakeSource, '2000')
        await stakeHelper.sendStakeV1(stakeSource, '1500.00000000', v.pubkey)
        v.source = stakeSource.address
        stakedValidators.push(v)
        return v
    }

    // Deploys a fresh escrow, funds it, and asks the network to check REAL_URL
    // against `marker`. Returns { ci, contractAddr, requestId, buyer, seller, arbiter }.
    //
    // `run` must be distinct per call: getNewFundedAddress derives addresses
    // deterministically from (label, addressIndex) via a cached per-label HD
    // wallet, so reusing the same label+index across two deployFundAndRequest
    // calls would hand both escrows the SAME buyer/seller/arbiter addresses -
    // their balances would then bleed into each other across tests.
    async function deployFundAndRequest(marker, run) {
        const buyer   = await cryptoHelper.getNewFundedAddress('esc-del-buyer', COIN, NETWORK, null, 'legacy', run, 0.02)
        const seller  = await cryptoHelper.getNewFundedAddress('esc-del-seller', COIN, NETWORK, null, 'legacy', run, 0.02)
        const arbiter = await cryptoHelper.getNewFundedAddress('esc-del-arbiter', COIN, NETWORK, null, 'legacy', run, 0.02)
        await gasHelper.ensureGasBalance(buyer, '2000')

        const params = [buyer.address, seller.address, arbiter.address, TICK, AMOUNT, '144', marker].join('|')
        const dep = await vmHelper.sendDeployV0(buyer, ESCROW_DELIVERY, 500000, params)
        const ci = dep.contract.action_index
        const contractAddr = `C:${CHAIN}:${ci}`
        assert.strictEqual(await stateOf(ci, 'status'), 'INIT')

        await vmHelper.sendDepositV0(buyer, ci, TICK, AMOUNT)
        const fund = await vmHelper.sendExecuteV0(buyer, ci, 'fund', [])
        assert(fund.execution && fund.execution.status === 'valid', 'fund should index a valid execution')
        assert.strictEqual(await stateOf(ci, 'status'), 'FUNDED')

        const req = await vmHelper.sendExecuteV0(buyer, ci, 'requestDelivery', [REAL_URL])
        assert(req.execution && req.execution.status === 'valid', 'requestDelivery should index a valid execution')

        const request = await indexerDatabase.waitForAttestationRequest({
            txHash: req.txHash, requestStatus: 'pending'
        })
        assert(request, 'pending attestation request row should exist')
        assert.strictEqual(request.provider_id, 'http_get')
        assert.strictEqual(request.payload, REAL_URL)

        return { ci, contractAddr, requestId: request.request_id, buyer, seller, arbiter }
    }

    // Real GET + real 3/3-signed ATTEST v1 broadcast (mirrors realUrlAttestation.test.js).
    async function fetchSignAndBroadcast(operator, requestId) {
        const fetched = await http_get.fetch(REAL_URL, { maxResponseBytes: 32768, timeoutMs: 10000 })
        const realBody = fetched.body.toString('utf8')
        const realMeta = String(fetched.meta)
        assert.strictEqual(realMeta, '200', 'expected HTTP 200 from the live endpoint')

        const signers = attestationHelper.computeResponsibleSigners(requestId, 3, stakedValidators)
        assert.strictEqual(signers.length, 3, 'expected 3 responsible signers on a clean chain')
        await attestationHelper.broadcastAttestationResponse(operator, {
            requestId: requestId, providerId: 'http_get', responsePayload: realBody,
            status: 'ok', meta: realMeta, validators: signers
        })

        const response = await indexerDatabase.waitForAttestationResponse({
            requestId: requestId, responseStatus: 'ok', status: 'valid'
        }, 120000)
        assert(response, 'attestation response row should land status=ok / valid')
        assert.strictEqual(response.response_payload, realBody, 'on-chain response_payload should be the live body')
        return realBody
    }

    before(async function () {
        if (COIN_CODE !== 'BTC') {
            console.log('Attestation rides on BTC-only STAKE + EXECUTE; skipping on ' + COIN_CODE)
            this.skip()
            return
        }
        for (let i = 0; i < 3; i++) {
            await stakeValidatorFromOwnSource(new attestationHelper.MockAttestationValidator())
        }
        await regtestMinerConnector.generateBlocks(7)
    })

    it('a matching delivery body auto-releases the escrow to the seller - no release() call', async function () {
        const { ci, contractAddr, requestId, buyer, seller } = await deployFundAndRequest(MARKER_MATCH, 0)
        // getNewFundedAddress auto-seeds every fresh address with 100 XCHAIN
        // gas, so the seller's balance isn't 0 going in - measure the delta.
        const sellerBefore = Number(await balanceOf(seller.address, TICK)) || 0

        await fetchSignAndBroadcast(buyer, requestId)

        // The indexer fires onDelivery(request_id) automatically as the
        // attestation callback - nobody EXECUTEs release().
        let cbStatus = null
        const settleEnd = Date.now() + 60000
        while (Date.now() < settleEnd) {
            cbStatus = await stateOf(ci, 'status')
            if (cbStatus === 'DELIVERED') break
            await new Promise(r => setTimeout(r, 1000))
        }
        assert.strictEqual(cbStatus, 'DELIVERED', 'onDelivery callback should auto-settle the escrow')
        assert.strictEqual(await stateOf(ci, 'pending'), null, 'pending should be cleared')

        const sellerAfter = Number(await balanceOf(seller.address, TICK)) || 0
        assert.strictEqual(sellerAfter - sellerBefore, Number(AMOUNT), 'seller receives the full escrowed amount')
        const held = await balanceOf(contractAddr, TICK)
        assert(held === null || Number(held) === 0, 'the contract holds nothing after auto-settlement')
    })

    it('a non-matching delivery body is a no-op; the arbiter then settles the dispute manually', async function () {
        const { ci, contractAddr, requestId, arbiter, buyer } = await deployFundAndRequest(MARKER_NO_MATCH, 1)

        await fetchSignAndBroadcast(buyer, requestId)

        // The GET itself succeeds (status 'ok'); only the contract's marker
        // check fails, so onDelivery must be a no-op, not a stuck request.
        let cleared = false
        const end = Date.now() + 60000
        while (Date.now() < end) {
            if ((await stateOf(ci, 'pending')) === null) { cleared = true; break }
            await new Promise(r => setTimeout(r, 1000))
        }
        assert(cleared, 'pending should clear once onDelivery runs, even on a non-match')
        assert.strictEqual(await stateOf(ci, 'status'), 'FUNDED', 'no auto-release on a non-matching body')
        assert.strictEqual(await balanceOf(contractAddr, TICK), AMOUNT, 'funds are untouched')

        // getNewFundedAddress auto-seeds every fresh address with 100 XCHAIN
        // gas, so the seller's balance isn't 0 going in - measure the delta.
        const sellerAddr = await stateOf(ci, 'seller')
        const sellerBefore = Number(await balanceOf(sellerAddr, TICK)) || 0

        // Automation isn't the only settlement path: the arbiter resolves it.
        const rel = await vmHelper.sendExecuteV0(arbiter, ci, 'release', [])
        assert(rel.execution && rel.execution.status === 'valid', 'arbiter release should index a valid execution')
        assert.strictEqual(await stateOf(ci, 'status'), 'RELEASED')

        const sellerAfter = Number(await balanceOf(sellerAddr, TICK)) || 0
        assert.strictEqual(sellerAfter - sellerBefore, Number(AMOUNT), 'manual release still pays the seller in full')
    })
})
