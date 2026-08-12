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
 * XChain Platform E2E - cross-chain call HOP ROUND TRIP (X→Y→X)
 *
 * BTC contract A calls the DOGE bouncer (deployed by xcallDogeSetup.js,
 * index via XCALL_BOUNCER_CONTRACT); the bouncer's crossCallable method
 * crossExecutes BACK to A's crossCallable 'onPong'. The arriving DOGE
 * execution runs at crossHops=1, so the back-call goes out at hops=2,
 * the XCALL_MAX_HOPS cap, and must still be relayed and executed.
 *
 * Proves live: hop accounting across chains, a request EMITTED BY an
 * injected XEXEC execution, both directions of the relay on one logical
 * flow, and callbacks resolving on both chains.
 *
 * Env on top of the BTC regtest e2e env (defaults match the local regtest stack):
 *   XCALL_HUB_PUBKEY         relay hub's Ed25519 pubkey (stake target)
 *   XCALL_BOUNCER_CONTRACT   DOGE-side bouncer contract action_index
 *   XCALL_TARGET_INDEXER_URL=http://localhost:3124
 *   XCALL_TARGET_MINER_URL=http://localhost:3125
 *
 ********************************************************************/

const { expect } = require('chai');
const axios = require('axios');
const { makeSdk, submit, fundedGasAddress, mine, submitOpts } = require('./sdkHelper');

// BTC-side contract: fires the outbound call AND receives the bounced-back
// call. gasLimit on the outbound leg must cover the bouncer's own
// emit.crossExecute pre-pay (500+2000+30000+20000 = 52500); use 100000.
const CONTRACT_A = `
    module.exports = {
        crossCallable: ['onPong'],
        callOut: function(xchain) {
            var id = xchain.emit.crossExecute({
                targetChain:    'DOGE',
                contractIndex:  Number(xchain.getInputParam(0)),
                method:         'bounce',
                params:         [xchain.getInputParam(1)],
                gasLimit:       100000,
                callbackMethod: 'onResult',
                callbackParams: ['hop-ctx'],
                deadlineBlocks: 600
            });
            xchain.state.set('lastCall', id);
            return id;
        },
        onPong: function(xchain) {
            xchain.state.set('pong', xchain.getInputParam(0));
            xchain.state.set('pongHops', String(xchain.getCrossHops()));
            return 'ack';
        },
        onResult: function(xchain) {
            xchain.state.set('result:' + xchain.getInputParam(0), JSON.stringify({
                chain:   xchain.getInputParam(1),
                status:  xchain.getInputParam(2),
                payload: xchain.getInputParam(3),
                echo:    xchain.getInputParam(4)
            }));
        }
    };
`;

const SOURCE_INDEXER_URL = 'http://' + (process.env.INDEXER_URL || 'localhost') + ':' + (process.env.INDEXER_API_PORT || '3024');
const TARGET_INDEXER_URL = process.env.XCALL_TARGET_INDEXER_URL || 'http://localhost:3124';
const TARGET_MINER_URL   = process.env.XCALL_TARGET_MINER_URL   || 'http://localhost:3125';

async function rpc(url, method, params) {
    const res = await axios.post(url, { jsonrpc: '2.0', method, params: params || {}, id: 1 }, { timeout: 15000 });
    if (res.data && res.data.error) throw new Error(method + ': ' + JSON.stringify(res.data.error));
    return res.data ? res.data.result : null;
}

async function mineTarget(count) {
    try { await rpc(TARGET_MINER_URL, 'generate_blocks', { count: count || 1 }); } catch (e) { /* best effort */ }
}

function contractIndexOf(indexed) {
    const a = indexed && Array.isArray(indexed.actions) ? indexed.actions[0] : null;
    return a ? a.action_index : null;
}

async function readState(sdk, contractIndex, key) {
    const state = await sdk.getContractState(contractIndex, key);
    const rows = (state && state.data) || [];
    const row = rows.find(r => r.state_key === key);
    return row ? JSON.parse(row.state_value) : null;
}

async function pumpUntil(label, check, timeoutMs) {
    const deadline = Date.now() + (timeoutMs || 240000);
    let last = null;
    while (Date.now() < deadline) {
        last = await check();
        if (last) return last;
        await mine(1);
        await mineTarget(1);
        await new Promise(r => setTimeout(r, 2000));
    }
    throw new Error('timed out waiting for ' + label);
}

describe('[sdk] cross-chain call hop round trip (BTC→DOGE→BTC)', function () {
    this.timeout(0);

    let sdk, deployer, indexA, bouncerContract, callId, backId;

    before(async function () {
        bouncerContract = parseInt(process.env.XCALL_BOUNCER_CONTRACT || '', 10);
        expect(bouncerContract, 'XCALL_BOUNCER_CONTRACT env (DOGE bouncer action_index from xcallDogeSetup.js)').to.be.a('number').and.to.be.greaterThan(0);
        sdk = makeSdk();
        deployer = await fundedGasAddress(sdk, 1);
        console.log('    [xcall-hop] deployer=' + deployer.address + ' bouncer=' + bouncerContract);
    });

    it('STAKE the relay validator for the cross_chain capability (idempotent top-up)', async function () {
        const hubPubkey = process.env.XCALL_HUB_PUBKEY;
        expect(hubPubkey, 'XCALL_HUB_PUBKEY env (the relay hub\'s Ed25519 pubkey)').to.match(/^[0-9a-f]{64}$/);
        try {
            const res = await submit(sdk,
                { action: 'STAKE', params: { amount: '5000.00000000', signingPubkey: hubPubkey } },
                { pubkey: deployer.address, change: deployer.address },
                submitOpts({ wif: deployer.wif })
            );
            expect(res.indexed.status).to.equal('valid');
        } catch (e) {
            if (!/SIGNING_PUBKEY \(already in use\)/.test(String(e.message))) throw e;
            console.log('    [xcall-hop] hub pubkey already staked; reusing the active stake');
        }
        await mine(8);
    });

    it('DEPLOY the BTC-side contract (A) with a crossCallable return method', async function () {
        const res = await submit(sdk,
            { action: 'DEPLOY', params: { code: CONTRACT_A, gasLimit: 200000 } },
            { pubkey: deployer.address, change: deployer.address },
            submitOpts({ wif: deployer.wif })
        );
        expect(res.indexed.status).to.equal('valid');
        indexA = contractIndexOf(res.indexed);
        console.log('    [xcall-hop] A=' + indexA);
    });

    it('fires the outbound BTC→DOGE call (hops=1)', async function () {
        const res = await submit(sdk,
            { action: 'EXECUTE', params: { contractActionIndex: indexA, method: 'callOut', params: [String(bouncerContract), String(indexA)] } },
            { pubkey: deployer.address, change: deployer.address },
            submitOpts({ wif: deployer.wif })
        );
        expect(res.indexed.status).to.equal('valid');
        await mine(1);

        callId = String(await readState(sdk, indexA, 'lastCall'));
        expect(callId).to.match(/^[0-9a-f]{64}$/);
        console.log('    [xcall-hop] outbound call_id=' + callId.substring(0, 16) + '...');

        const req = await rpc(SOURCE_INDEXER_URL, 'getcrosschaincall', { call_id: callId });
        expect(req.exists).to.equal(true);
        expect(req.call.cross_hops).to.equal(1);
        expect(req.call.target_chain).to.equal('DOGE');
    });

    it('the bouncer executes ok and emits the back-call at hops=2', async function () {
        const result = await pumpUntil('DOGE-side bounce execution', async () => {
            const r = await rpc(TARGET_INDEXER_URL, 'getcrosschaincallresult', { call_id: callId });
            return (r && r.exists === true) ? r : null;
        });
        expect(result.status, 'bounce execution').to.equal('ok');

        // the bouncer returns the back-call id (JSON-quoted by the VM)
        backId = JSON.parse(Buffer.from(String(result.return_payload_b64 || ''), 'base64').toString('utf8'));
        expect(String(backId), 'back-call id from bounce return').to.match(/^[0-9a-f]{64}$/);
        console.log('    [xcall-hop] back call_id=' + String(backId).substring(0, 16) + '...');

        // the back-call request row lives on the DOGE side (its origin chain)
        const backReq = await rpc(TARGET_INDEXER_URL, 'getcrosschaincall', { call_id: backId });
        expect(backReq.exists, 'back-call request on DOGE').to.equal(true);
        expect(backReq.call.cross_hops, 'back-call hops').to.equal(2);
        expect(backReq.call.target_chain).to.equal('BTC');
        expect(backReq.call.target_contract_index).to.equal(Number(indexA));
    });

    it('the back-call lands on BTC: onPong executes and returns ack', async function () {
        const result = await pumpUntil('BTC-side onPong execution', async () => {
            const r = await rpc(SOURCE_INDEXER_URL, 'getcrosschaincallresult', { call_id: backId });
            return (r && r.exists === true) ? r : null;
        });
        expect(result.status, 'onPong execution').to.equal('ok');
        const decoded = Buffer.from(String(result.return_payload_b64 || ''), 'base64').toString('utf8');
        expect(decoded).to.equal('"ack"');

        const pong = await pumpUntil('pong state write on A', async () => {
            return await readState(sdk, indexA, 'pong');
        }, 60000);
        expect(pong).to.equal('from-doge');
        const pongHops = await readState(sdk, indexA, 'pongHops');
        expect(pongHops, 'crossHops seen by onPong').to.equal('2');
        console.log('    [xcall-hop] pong=' + pong + ' hops=' + pongHops);
    });

    it('both legs complete with exactly-once callbacks on their origin chains', async function () {
        // outbound leg: completed on BTC + A records the bounce return (the back-call id)
        await pumpUntil('outbound completion on BTC', async () => {
            const r = await rpc(SOURCE_INDEXER_URL, 'getcrosschaincall', { call_id: callId });
            return (r && r.call && r.call.request_status === 'completed') ? r : null;
        });
        const outDelivered = JSON.parse(await pumpUntil('outbound callback on A', async () => {
            return await readState(sdk, indexA, 'result:' + callId);
        }, 90000));
        expect(outDelivered.status).to.equal('ok');
        expect(outDelivered.chain).to.equal('DOGE');
        expect(outDelivered.echo).to.equal('hop-ctx');
        expect(JSON.parse(outDelivered.payload)).to.equal(backId);

        // back leg: completed on DOGE (its origin)
        await pumpUntil('back-call completion on DOGE', async () => {
            const r = await rpc(TARGET_INDEXER_URL, 'getcrosschaincall', { call_id: backId });
            return (r && r.call && r.call.request_status === 'completed') ? r : null;
        });
        console.log('    [xcall-hop] both legs completed');
    });
});
