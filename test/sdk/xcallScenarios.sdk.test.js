/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available —
 * contact legal@dankest.llc.
 *
 **********************************************************************
 *
 * XChain Platform E2E - cross-chain call RESULT SCENARIOS
 *
 * Milestone 2 of the XCALL campaign: drives a REAL crossCallable target
 * contract on the DOGE regtest stack (deployed by xcallDogeSetup.js, its
 * index passed via XCALL_TARGET_CONTRACT) through every non-expiry result
 * status the protocol defines:
 *
 *   onArrival  → ok               (returns 'pong:<param>' — proves params arrive)
 *   doRevert   → reverted         (xchain.revert in the target)
 *   hidden     → not_callable     (method exists but is NOT in crossCallable)
 *   bigReturn  → payload_too_large (return exceeds the 1024-byte cap)
 *
 * All four calls are fired up front and relay concurrently — this also
 * exercises multiple in-flight calls against the per-block injection cap.
 *
 * Env on top of the BTC regtest e2e env (defaults match devhost):
 *   XCALL_HUB_PUBKEY        relay hub's Ed25519 pubkey (stake target)
 *   XCALL_TARGET_CONTRACT   DOGE-side crossCallable contract action_index
 *   XCALL_TARGET_INDEXER_URL=http://localhost:3124
 *   XCALL_TARGET_MINER_URL=http://localhost:3125
 *
 ********************************************************************/

const { expect } = require('chai');
const axios = require('axios');
const { makeSdk, submit, fundedGasAddress, mine, submitOpts } = require('./sdkHelper');

// Source-side contract (BTC) — same shape as xcall.sdk.test.js: parameterized
// fire-and-record, callback keyed by call_id so concurrent calls don't collide.
const CONTRACT_A = `
    module.exports = {
        crossCallable: [],
        callOut: function(xchain) {
            var id = xchain.emit.crossExecute({
                targetChain:    'DOGE',
                contractIndex:  Number(xchain.getInputParam(0)),
                method:         xchain.getInputParam(1),
                params:         ['ping'],
                gasLimit:       50000,
                callbackMethod: 'onResult',
                callbackParams: ['echo-ctx'],
                deadlineBlocks: 600
            });
            xchain.state.set('lastCall', id);
            return id;
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

// method → expected terminal result (payload null = don't assert payload)
const SCENARIOS = [
    // return payloads carry the VM's JSON serialization of the return value,
    // so a string return arrives quoted.
    { method: 'onArrival', status: 'ok',                payload: '"pong:ping"' },
    { method: 'doRevert',  status: 'reverted',          payload: null },
    { method: 'hidden',    status: 'not_callable',      payload: '' },
    { method: 'bigReturn', status: 'payload_too_large', payload: '' },
];

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

describe('[sdk] cross-chain call result scenarios (real DOGE target)', function () {
    this.timeout(0);

    let sdk, deployer, indexA, targetContract;
    const callIds = {}; // method → call_id

    before(async function () {
        targetContract = parseInt(process.env.XCALL_TARGET_CONTRACT || '', 10);
        expect(targetContract, 'XCALL_TARGET_CONTRACT env (DOGE target contract action_index from xcallDogeSetup.js)').to.be.a('number').and.to.be.greaterThan(0);
        sdk = makeSdk();
        deployer = await fundedGasAddress(sdk, 1);
        console.log('    [xcall-scn] deployer=' + deployer.address + ' target=' + targetContract);
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
            // A prior run already staked this pubkey (from a different funding
            // address) — the capability stake exists and stays active, which is
            // all the relay needs.
            if (!/SIGNING_PUBKEY \(already in use\)/.test(String(e.message))) throw e;
            console.log('    [xcall-scn] hub pubkey already staked — reusing the active stake');
        }
        await mine(8); // past ACTIVATION_DELAY_BLOCKS (6)
    });

    it('DEPLOY the source-side contract (A) on BTC', async function () {
        const res = await submit(sdk,
            { action: 'DEPLOY', params: { code: CONTRACT_A, gasLimit: 200000 } },
            { pubkey: deployer.address, change: deployer.address },
            submitOpts({ wif: deployer.wif })
        );
        expect(res.indexed.status).to.equal('valid');
        indexA = contractIndexOf(res.indexed);
        console.log('    [xcall-scn] A=' + indexA);
    });

    it('fires all four scenario calls (concurrent in-flight relay)', async function () {
        for (const s of SCENARIOS) {
            const res = await submit(sdk,
                { action: 'EXECUTE', params: { contractActionIndex: indexA, method: 'callOut', params: [String(targetContract), s.method] } },
                { pubkey: deployer.address, change: deployer.address },
                submitOpts({ wif: deployer.wif })
            );
            expect(res.indexed.status, s.method + ' EXECUTE').to.equal('valid');
            await mine(1);
            const id = await readState(sdk, indexA, 'lastCall');
            expect(String(id), s.method + ' call_id').to.match(/^[0-9a-f]{64}$/);
            callIds[s.method] = String(id);
            console.log('    [xcall-scn] ' + s.method + ' call_id=' + String(id).substring(0, 16) + '...');
        }
        expect(new Set(Object.values(callIds)).size, 'distinct call_ids').to.equal(SCENARIOS.length);
    });

    it('DOGE executes each call with the expected status', async function () {
        const results = {};
        await pumpUntil('all four DOGE-side execution results', async () => {
            for (const s of SCENARIOS) {
                if (results[s.method]) continue;
                const r = await rpc(TARGET_INDEXER_URL, 'getcrosschaincallresult', { call_id: callIds[s.method] });
                if (r && r.exists === true) results[s.method] = r;
            }
            return Object.keys(results).length === SCENARIOS.length ? results : null;
        });
        for (const s of SCENARIOS) {
            const r = results[s.method];
            console.log('    [xcall-scn] ' + s.method + ' → ' + r.status + ' (block ' + r.executed_block_index + ')');
            expect(r.status, s.method + ' target status').to.equal(s.status);
            if (s.payload !== null) {
                const decoded = Buffer.from(String(r.return_payload_b64 || ''), 'base64').toString('utf8');
                expect(decoded, s.method + ' target payload').to.equal(s.payload);
            }
        }
    });

    it('each result relays back and the callback delivers the expected outcome exactly once', async function () {
        for (const s of SCENARIOS) {
            await pumpUntil(s.method + ' source-side completion', async () => {
                const r = await rpc(SOURCE_INDEXER_URL, 'getcrosschaincall', { call_id: callIds[s.method] });
                return (r && r.call && r.call.request_status === 'completed') ? r : null;
            });
            const delivered = await pumpUntil(s.method + ' callback state write', async () => {
                return await readState(sdk, indexA, 'result:' + callIds[s.method]);
            }, 90000);
            const outcome = JSON.parse(delivered);
            console.log('    [xcall-scn] ' + s.method + ' callback: ' + delivered);
            expect(outcome.chain, s.method).to.equal('DOGE');
            expect(outcome.status, s.method).to.equal(s.status);
            expect(outcome.echo, s.method).to.equal('echo-ctx');
            if (s.payload !== null) expect(outcome.payload, s.method).to.equal(s.payload);
        }
    });
});
