// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// Counterparty Bridge (on-chain): a REAL tokenscan.io balance check driving
// either a mint or a safe no-op.
//
//   DEPLOY counterpartyBridge(cpAsset, xchainTick, maxSupply, decimals)
//     -> initialize emits ISSUE(xchainTick): the contract is the issuer.
//   anyone: EXECUTE "requestClaim"
//              -> ATTEST v0 http_get request against the REAL tokenscan.io
//                 balances API for the CALLER'S OWN address (self-serve:
//                 https://cp20.tokenscan.io/api/balances/{address}/1/500)
//           (off-chain: 3 staked validators fetch the REAL URL through the
//            production http_get provider and sign the live body, exactly
//            like test/actions/realUrlAttestation.test.js)
//           -> indexer verifies 3/3, fulfills, fires onClaim(request_id,
//              address) automatically as the attestation callback
//   if the live body's `data` array contains cpAsset with a positive
//   quantity: onClaim mints that amount and marks the address claimed.
//   Otherwise (as here - see below): no-op, safely retryable.
//
// WHY THIS TEST ONLY EXERCISES THE NO-OP PATH ON-CHAIN: requestClaim() is
// deliberately self-serve - it always queries and mints to
// xchain.getSourceAddress(), never a caller-suppliable destination. A
// regtest address minted by this test harness has never existed on
// Counterparty mainnet, so a REAL GET against it is guaranteed - and was
// independently verified via curl before writing this test - to return
// `{"data":[],"total":0}` (200 OK, empty holdings), never a positive
// balance. There is no way to drive the MINT branch through the contract
// itself without controlling the private key of a real Counterparty
// holder's address, which is out of scope for an automated e2e run.
//
// To still validate the POSITIVE-balance parsing path against live data
// (the thing most worth confirming - does the real body still match the
// documented shape?), the second test fetches tokenscan.io's own published
// example address directly (outside the contract, the same way
// realUrlAttestation.test.js validates a live body's shape) and re-runs the
// exact extraction logic the contract uses against it.
//
// The contract source below is a compacted copy of the canonical template
// at xchain-contracts/counterpartyBridge/counterpartyBridge.js (kept inline
// so the test is self-contained inside the e2e container, same convention
// as escrowDelivery.test.js / stableVault.test.js). Behaviour is identical;
// the VM unit test (counterpartyBridge.test.js in xchain-contracts) covers
// the full matrix including the adversarial paths (replay, double-claim,
// cap enforcement).

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

// tokenscan.io's own published example address (https://tokenscan.io/api#balances)
// - a real wallet with real holdings, used ONLY for the standalone shape check
// in the second test (never as an on-chain caller: we don't control its key).
const REAL_HOLDER_ADDRESS = '1Donatet2LrNpuWByAnH8gc9Wh9zSzZuLC'

// Same extraction logic as counterpartyBridge.js's extractAssetQuantity(),
// duplicated here (not required from the contract, which only exists as an
// inline VM string) to independently re-verify the parsing assumption
// against a live, positive-balance body.
function extractAssetQuantity(payload, asset) {
    var parsed
    try { parsed = JSON.parse(payload) } catch (e) { return null }
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.data)) return null
    for (var i = 0; i < parsed.data.length; i++) {
        var row = parsed.data[i]
        if (row && row.asset === asset && row.quantity !== undefined && row.quantity !== null) {
            return String(row.quantity)
        }
    }
    return null
}

// NOTE: minified (short var names, terse messages) to stay well under the
// DEPLOY payload cap; the readable canonical source lives in
// xchain-contracts/counterpartyBridge/counterpartyBridge.js. Behaviour is
// identical.
const COUNTERPARTY_BRIDGE = `function fD(v,d){var s=String(v),n=s.charAt(0)==='-';if(n)s=s.substring(1);var i=s.indexOf('.');if(i<0)return v;var f=s.substring(i+1);if(f.length<=d)return v;var k=d>0?'.'+f.substring(0,d):'';var o=s.substring(0,i)+k;return n?'-'+o:o;}
function eA(p,a){var j;try{j=JSON.parse(p);}catch(e){return null;}if(!j||typeof j!=='object'||!Array.isArray(j.data))return null;for(var i=0;i<j.data.length;i++){var r=j.data[i];if(r&&r.asset===a&&r.quantity!==undefined&&r.quantity!==null)return String(r.quantity);}return null;}
module.exports = {
    initialize: function (x) {
        var ca=x.getInputParam(0), xt=x.getInputParam(1), ms=x.getInputParam(2), dc=x.getInputParam(3)||'8';
        x.require(ca&&ca.length>0,'cpAsset required');
        x.require(xt&&xt.length>0,'xchainTick required');
        x.require(ms&&x.math.gt(ms,'0'),'maxSupply must be positive');
        var di=parseInt(dc);
        x.require(String(di)===String(dc)&&di>=0&&di<=18,'decimals must be an integer 0-18');
        x.state.set('cpAsset',ca); x.state.set('xchainTick',xt); x.state.set('maxSupply',ms);
        x.state.set('decimals',dc); x.state.set('totalClaimed','0');
        x.emit.issue({ tick: xt, maxSupply: ms, maxMint: ms, decimals: dc, description: 'bridge of '+ca });
    },
    requestClaim: function (x) {
        var c = x.getSourceAddress();
        x.require(!x.state.get('claimed:'+c),'already claimed');
        x.require(!x.state.get('pending:'+c),'a claim check is already pending for this address');
        var u = 'https://cp20.tokenscan.io/api/balances/'+c+'/1/500';
        var r = x.attestation.request('http_get', u, 'onClaim', [c], { redundancy: 3, deadlineBlocks: 20 });
        x.state.set('pending:'+c, r);
        return r;
    },
    onClaim: function (x) {
        var r = x.getInputParam(0), a = x.getInputParam(4);
        x.require(r === x.state.get('pending:'+a),'not the outstanding claim request for this address');
        if (x.state.get('claimed:'+a)) { x.state.delete('pending:'+a); return 'ignored'; }
        var p = x.attestation.getResponse(r);
        x.require(p !== null, 'no response yet');
        if (p.status !== 'ok') { x.state.delete('pending:'+a); return 'not confirmed'; }
        var b = eA(p.payload, x.state.get('cpAsset'));
        if (b === null || !x.math.gt(b,'0')) { x.state.delete('pending:'+a); return 'no balance to claim'; }
        var dc = parseInt(x.state.get('decimals'));
        var am = fD(b, dc);
        x.require(x.math.gt(am,'0'), 'balance below one token unit');
        var tc = x.math.add(x.state.get('totalClaimed'), am);
        x.require(x.math.lte(tc, x.state.get('maxSupply')), 'bridge maxSupply exhausted');
        x.state.set('claimed:'+a, am);
        x.state.set('totalClaimed', tc);
        x.state.delete('pending:'+a);
        x.emit.mint({ tick: x.state.get('xchainTick'), quantity: am, destination: a });
        return am;
    },
    claimed: function (x) {
        var a = x.getInputParam(0);
        x.require(typeof a==='string'&&a.length>0,'address required');
        return x.state.get('claimed:'+a) || '0';
    },
    info: function (x) {
        return JSON.stringify({ cpAsset:x.state.get('cpAsset'), xchainTick:x.state.get('xchainTick'), decimals:x.state.get('decimals'), maxSupply:x.state.get('maxSupply'), totalClaimed:x.state.get('totalClaimed') });
    }
};`

describe('Counterparty Bridge: a REAL tokenscan.io balance check driving a mint or a safe no-op', function () {
    this.timeout(10 * 60 * 1000)

    const rand = () => String.fromCharCode(65 + Math.floor(Math.random() * 26))
    const CP_ASSET = 'CPBRIDGETEST'
    const XCHAIN_TICK = 'CPB' + rand() + rand() + rand()
    const MAX_SUPPLY = '1000000'
    const DECIMALS = '8'
    const stakedValidators = []

    async function q(sql, params) {
        const conn = await indexerDatabase.getConnection()
        try { return await conn.query(sql, params) }
        finally { await conn.release() }
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
            'cpbridge-val', COIN, NETWORK, null, 'legacy', stakedValidators.length, 0.02
        )
        await gasHelper.ensureGasBalance(stakeSource, '2000')
        await stakeHelper.sendStakeV1(stakeSource, '1500.00000000', v.pubkey)
        v.source = stakeSource.address
        stakedValidators.push(v)
        return v
    }

    // Real GET + real 3/3-signed ATTEST v1 broadcast (mirrors realUrlAttestation.test.js).
    async function fetchSignAndBroadcast(operator, requestId, url) {
        const fetched = await http_get.fetch(url, { maxResponseBytes: 65536, timeoutMs: 10000 })
        const realBody = fetched.body.toString('utf8')
        const realMeta = String(fetched.meta)
        assert.strictEqual(realMeta, '200', 'expected HTTP 200 from the live tokenscan.io endpoint')

        const signers = attestationHelper.computeResponsibleSigners(requestId, 3, stakedValidators)
        assert.strictEqual(signers.length, 3, 'expected 3 responsible signers on a clean chain')
        await attestationHelper.broadcastAttestationResponse(operator, {
            requestId: requestId, providerId: 'http_get', responsePayload: realBody,
            status: 'ok', meta: realMeta, validators: signers
        })

        const response = await indexerDatabase.waitForAttestationResponse({
            requestId: requestId, responseStatus: 'ok', status: 'valid'
        }, 240000)
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

    it('a fresh regtest address settles a REAL tokenscan.io check and is a harmless no-op (no real Counterparty history)', async function () {
        const claimer = await cryptoHelper.getNewFundedAddress('cpbridge-claimer', COIN, NETWORK, null, 'legacy', 0, 0.02)
        await gasHelper.ensureGasBalance(claimer, '5000')

        const params = [CP_ASSET, XCHAIN_TICK, MAX_SUPPLY, DECIMALS].join('|')
        const dep = await vmHelper.sendDeployV0(claimer, COUNTERPARTY_BRIDGE, 500000, params)
        assert.strictEqual(dep.contract.status, 'valid', 'deploy status: ' + dep.contract.status)
        const ci = dep.contract.action_index
        assert.strictEqual(await stateOf(ci, 'totalClaimed'), '0')

        const expectedUrl = 'https://cp20.tokenscan.io/api/balances/' + claimer.address + '/1/500'
        const req = await vmHelper.sendExecuteV0(claimer, ci, 'requestClaim', [])
        assert(req.execution && req.execution.status === 'valid', 'requestClaim should index a valid execution')

        const request = await indexerDatabase.waitForAttestationRequest({
            txHash: req.txHash, requestStatus: 'pending'
        })
        assert(request, 'pending attestation request row should exist')
        assert.strictEqual(request.provider_id, 'http_get')
        assert.strictEqual(request.payload, expectedUrl, 'the real per-address tokenscan.io URL should be the request payload')

        const realBody = await fetchSignAndBroadcast(claimer, request.request_id, expectedUrl)

        // A brand-new regtest address has no real Counterparty history: the
        // live response's data array must not contain our cpAsset. (Verified
        // independently via curl before writing this test: tokenscan.io
        // returns {"data":[],"total":0} - 200 OK, empty holdings - for
        // addresses it has never seen.)
        const parsed = JSON.parse(realBody)
        assert(Array.isArray(parsed.data), 'live body should have a data array (documented shape)')
        assert(parsed.data.every(row => row.asset !== CP_ASSET), 'a fresh regtest address should not hold our test asset')

        // onClaim fires automatically as the attestation callback - nobody
        // EXECUTEs a claim confirmation.
        let cleared = false
        const end = Date.now() + 180000
        while (Date.now() < end) {
            if ((await stateOf(ci, 'pending:' + claimer.address)) === null) { cleared = true; break }
            await new Promise(r => setTimeout(r, 1000))
        }
        assert(cleared, 'pending should clear once onClaim runs, even on a no-balance response')
        assert.strictEqual(await stateOf(ci, 'claimed:' + claimer.address), null, 'no mint should have happened')
        assert.strictEqual(await stateOf(ci, 'totalClaimed'), '0', 'totalClaimed stays at zero')
    })

    it('the live balances API still matches the documented shape for a wallet that actually holds assets', async function () {
        // Standalone real GET (not through the contract - requestClaim() is
        // self-serve and we don't control this address's private key) against
        // tokenscan.io's own published example address, re-running the exact
        // extraction logic the contract uses.
        const url = 'https://cp20.tokenscan.io/api/balances/' + REAL_HOLDER_ADDRESS + '/1/500'
        const fetched = await http_get.fetch(url, { maxResponseBytes: 65536, timeoutMs: 10000 })
        assert.strictEqual(String(fetched.meta), '200', 'expected HTTP 200 from the live tokenscan.io endpoint')
        const body = fetched.body.toString('utf8')

        const parsed = JSON.parse(body)
        assert.strictEqual(parsed.address, REAL_HOLDER_ADDRESS)
        assert(Array.isArray(parsed.data) && parsed.data.length > 0, 'a real known holder should have a non-empty data array')

        const first = parsed.data[0]
        assert.strictEqual(typeof first.asset, 'string')
        assert.strictEqual(typeof first.quantity, 'string')

        // The contract's extraction logic, run against this live positive-
        // balance body, must find that exact quantity for that exact asset.
        const extracted = extractAssetQuantity(body, first.asset)
        assert.strictEqual(extracted, first.quantity, 'extractAssetQuantity should read the real quantity straight out of the live body')
        assert(Number(extracted) > 0, 'a real holding should be a positive quantity')
    })
})
