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
 * XChain Platform E2E - cross-chain call 2f+1 QUORUM fault drills
 *
 * Against a standing 3-validator hub federation (N=3 → quorum 2, all three
 * pubkeys holding active cross_chain stakes on BTC):
 *
 *   1. one hub down (2/3 alive = quorum still reachable) → the relay MUST
 *      still complete, surviving leader rotation via view-change when the
 *      dead hub owned a round;
 *   2. two hubs down (1/3 alive < quorum)               → the relay MUST
 *      stall — no under-quorum row may reach the indexers;
 *   3. hubs restarted                                   → the stalled call
 *      recovers and completes.
 *
 * VENUE: manages hub containers via docker (runs on the stack host).
 * Container names via XCALL_HUB2_CONTAINER / XCALL_HUB3_CONTAINER.
 *
 ********************************************************************/

const { expect } = require('chai');
const axios = require('axios');
const { execSync } = require('child_process');
const { makeSdk, submit, fundedGasAddress, mine, submitOpts } = require('./sdkHelper');

const CONTRACT_A = `
    module.exports = {
        crossCallable: [],
        callOut: function(xchain) {
            var id = xchain.emit.crossExecute({
                targetChain:    'DOGE',
                contractIndex:  Number(xchain.getInputParam(0)),
                method:         'onArrival',
                params:         ['ping'],
                gasLimit:       50000,
                callbackMethod: 'onResult',
                callbackParams: ['quorum-ctx'],
                deadlineBlocks: 4000
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
const HUB2 = process.env.XCALL_HUB2_CONTAINER || 'xchain-hub-2';
const HUB3 = process.env.XCALL_HUB3_CONTAINER || 'xchain-hub-3';

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

describe('[sdk] cross-chain call 2f+1 quorum fault drills (N=3 federation)', function () {
    this.timeout(0);

    let sdk, deployer, indexA;
    let stalled = null;          // call_id left pending by the two-down drill
    const downed = new Set();

    function hubStop(name)  { execSync('docker stop '  + name, { stdio: 'inherit' }); downed.add(name); }
    function hubStart(name) { execSync('docker start ' + name, { stdio: 'inherit' }); downed.delete(name); }

    async function fireCall(label) {
        const res = await submit(sdk,
            { action: 'EXECUTE', params: { contractActionIndex: indexA, method: 'callOut', params: ['999999'] } },
            { pubkey: deployer.address, change: deployer.address },
            submitOpts({ wif: deployer.wif })
        );
        expect(res.indexed.status, label + ' EXECUTE').to.equal('valid');
        await mine(1);
        const id = String(await readState(sdk, indexA, 'lastCall'));
        expect(id, label + ' call_id').to.match(/^[0-9a-f]{64}$/);
        console.log('    [xcall-q] ' + label + ' call_id=' + id.substring(0, 16) + '...');
        return id;
    }

    before(async function () {
        sdk = makeSdk();
        deployer = await fundedGasAddress(sdk, 1);
        console.log('    [xcall-q] deployer=' + deployer.address);
    });

    after(async function () {
        // ALWAYS restore the full federation, even when an assertion failed.
        for (const name of [...downed]) hubStart(name);
    });

    it('DEPLOY the caller contract on BTC', async function () {
        const res = await submit(sdk,
            { action: 'DEPLOY', params: { code: CONTRACT_A, gasLimit: 200000 } },
            { pubkey: deployer.address, change: deployer.address },
            submitOpts({ wif: deployer.wif })
        );
        expect(res.indexed.status).to.equal('valid');
        indexA = contractIndexOf(res.indexed);
        console.log('    [xcall-q] A=' + indexA);
    });

    it('with ONE hub down (2/3 = quorum) the relay still completes', async function () {
        hubStop(HUB3);
        console.log('    [xcall-q] ' + HUB3 + ' stopped — 2 of 3 validators alive');

        const callId = await fireCall('one-down');
        // generous window: if the dead hub owns the PBFT round, the view-change
        // timeout must rotate leadership before the round can finalize
        await pumpUntil('one-down completion', async () => {
            const r = await rpc(SOURCE_INDEXER_URL, 'getcrosschaincall', { call_id: callId });
            return (r && r.call && r.call.request_status === 'completed') ? r : null;
        }, 420000);
        const delivered = JSON.parse(await pumpUntil('one-down callback', async () => {
            return await readState(sdk, indexA, 'result:' + callId);
        }, 60000));
        expect(delivered.status).to.equal('no_contract');
        console.log('    [xcall-q] one-down relay completed: ' + delivered.status);
    });

    it('with TWO hubs down (1/3 < quorum) the relay stalls — no under-quorum row reaches the indexers', async function () {
        hubStop(HUB2);
        console.log('    [xcall-q] ' + HUB2 + ' stopped too — 1 of 3 validators alive (< quorum 2)');

        const callId = await fireCall('two-down');

        // hold the window open ~90s (30 poll cycles): the request must stay
        // pending and the DOGE side must never execute
        for (let i = 0; i < 18; i++) {
            await mine(1);
            await mineTarget(1);
            await new Promise(r => setTimeout(r, 3000));
        }
        const req = await rpc(SOURCE_INDEXER_URL, 'getcrosschaincall', { call_id: callId });
        expect(req.call.request_status, 'request must stay pending').to.equal('pending');
        const target = await rpc(TARGET_INDEXER_URL, 'getcrosschaincallresult', { call_id: callId });
        expect(target && target.exists, 'no DOGE-side execution under quorum loss').to.not.equal(true);
        console.log('    [xcall-q] two-down call stalled as required (still pending after 90s)');
        stalled = callId;
    });

    it('restarting the hubs recovers the stalled call to completion', async function () {
        expect(stalled, 'stalled call_id from the previous test').to.match(/^[0-9a-f]{64}$/);
        hubStart(HUB2);
        hubStart(HUB3);
        console.log('    [xcall-q] federation restored — 3 of 3 alive');

        await pumpUntil('stalled call completion after recovery', async () => {
            const r = await rpc(SOURCE_INDEXER_URL, 'getcrosschaincall', { call_id: stalled });
            return (r && r.call && r.call.request_status === 'completed') ? r : null;
        }, 420000);
        const delivered = JSON.parse(await pumpUntil('recovered callback', async () => {
            return await readState(sdk, indexA, 'result:' + stalled);
        }, 60000));
        expect(delivered.status).to.equal('no_contract');
        console.log('    [xcall-q] recovered relay completed: ' + delivered.status);
    });
});
