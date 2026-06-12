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
 * XChain Platform E2E - cross-chain call DEADLINE EXPIRY with the hub DOWN
 *
 * Fires a short-deadline (minimum: 10 blocks) crossExecute while the relay
 * hub container is STOPPED, then mines past the deadline. The source
 * indexer must synthesize the XCALL v2 expiry deterministically — flip the
 * request to 'expired' and inject the requester's callback with
 * status='expired' — with NO federation involvement. After the hub comes
 * back, the terminal expiry must hold (exactly-once interlock: no late
 * dispatch, no second callback).
 *
 * VENUE: expects to manage the hub container directly via docker (runs on
 * the stack host). Override the container name via XCALL_HUB_CONTAINER.
 *
 * Env on top of the BTC regtest e2e env:
 *   XCALL_HUB_PUBKEY      relay hub's Ed25519 pubkey (stake target)
 *   XCALL_HUB_CONTAINER   default xchain-node-xchain-hub
 *
 ********************************************************************/

const { expect } = require('chai');
const axios = require('axios');
const { execSync } = require('child_process');
const { makeSdk, submit, fundedGasAddress, mine, submitOpts } = require('./sdkHelper');

// Short-deadline caller: deadlineBlocks 10 is the protocol minimum.
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
                callbackParams: ['expiry-ctx'],
                deadlineBlocks: 10
            });
            xchain.state.set('lastCall', id);
            return id;
        },
        onResult: function(xchain) {
            var key = 'result:' + xchain.getInputParam(0);
            var count = Number(xchain.state.get('count:' + xchain.getInputParam(0)) || '0') + 1;
            xchain.state.set('count:' + xchain.getInputParam(0), String(count));
            xchain.state.set(key, JSON.stringify({
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
const HUB_CONTAINER      = process.env.XCALL_HUB_CONTAINER || 'xchain-node-xchain-hub';

async function rpc(url, method, params) {
    const res = await axios.post(url, { jsonrpc: '2.0', method, params: params || {}, id: 1 }, { timeout: 15000 });
    if (res.data && res.data.error) throw new Error(method + ': ' + JSON.stringify(res.data.error));
    return res.data ? res.data.result : null;
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

async function pumpSourceUntil(label, check, timeoutMs) {
    const deadline = Date.now() + (timeoutMs || 240000);
    let last = null;
    while (Date.now() < deadline) {
        last = await check();
        if (last) return last;
        await mine(1);
        await new Promise(r => setTimeout(r, 2000));
    }
    throw new Error('timed out waiting for ' + label);
}

describe('[sdk] cross-chain call deadline expiry (hub down)', function () {
    this.timeout(0);

    let sdk, deployer, indexA, callId, hubStopped = false;

    before(async function () {
        sdk = makeSdk();
        deployer = await fundedGasAddress(sdk, 1);
        console.log('    [xcall-exp] deployer=' + deployer.address);
    });

    after(async function () {
        // ALWAYS bring the hub back, even when an assertion failed mid-suite.
        if (hubStopped) {
            execSync('docker start ' + HUB_CONTAINER, { stdio: 'inherit' });
            hubStopped = false;
            console.log('    [xcall-exp] hub restarted');
        }
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
            console.log('    [xcall-exp] hub pubkey already staked — reusing the active stake');
        }
        await mine(8);
    });

    it('DEPLOY the short-deadline caller contract on BTC', async function () {
        const res = await submit(sdk,
            { action: 'DEPLOY', params: { code: CONTRACT_A, gasLimit: 200000 } },
            { pubkey: deployer.address, change: deployer.address },
            submitOpts({ wif: deployer.wif })
        );
        expect(res.indexed.status).to.equal('valid');
        indexA = contractIndexOf(res.indexed);
        console.log('    [xcall-exp] A=' + indexA);
    });

    it('STOP the hub, then fire a 10-block-deadline call', async function () {
        execSync('docker stop ' + HUB_CONTAINER, { stdio: 'inherit' });
        hubStopped = true;
        console.log('    [xcall-exp] hub stopped');

        const res = await submit(sdk,
            { action: 'EXECUTE', params: { contractActionIndex: indexA, method: 'callOut', params: ['999999'] } },
            { pubkey: deployer.address, change: deployer.address },
            submitOpts({ wif: deployer.wif })
        );
        expect(res.indexed.status).to.equal('valid');
        await mine(1);

        callId = String(await readState(sdk, indexA, 'lastCall'));
        expect(callId).to.match(/^[0-9a-f]{64}$/);
        console.log('    [xcall-exp] call_id=' + callId.substring(0, 16) + '...');

        const req = await rpc(SOURCE_INDEXER_URL, 'getcrosschaincall', { call_id: callId });
        expect(req.exists).to.equal(true);
        expect(req.call.request_status).to.equal('pending');
    });

    it('mining past the deadline expires the request deterministically (no hub)', async function () {
        const req = await pumpSourceUntil('request expiry', async () => {
            const r = await rpc(SOURCE_INDEXER_URL, 'getcrosschaincall', { call_id: callId });
            return (r && r.call && r.call.request_status === 'expired') ? r : null;
        }, 180000);
        console.log('    [xcall-exp] request_status=' + req.call.request_status);
    });

    it('the expiry callback delivers status=expired exactly once', async function () {
        const delivered = await pumpSourceUntil('expiry callback', async () => {
            return await readState(sdk, indexA, 'result:' + callId);
        }, 90000);
        const outcome = JSON.parse(delivered);
        console.log('    [xcall-exp] callback: ' + delivered);
        expect(outcome.status).to.equal('expired');
        expect(outcome.chain).to.equal('DOGE');
        expect(outcome.payload).to.equal('');
        expect(outcome.echo).to.equal('expiry-ctx');
        expect(await readState(sdk, indexA, 'count:' + callId)).to.equal('1');
    });

    it('after the hub restarts, the terminal expiry holds (no late dispatch, no double callback)', async function () {
        execSync('docker start ' + HUB_CONTAINER, { stdio: 'inherit' });
        hubStopped = false;
        console.log('    [xcall-exp] hub restarted — waiting out relay poll cycles');

        // give the hub several XCALL_POLL_MS (3s) cycles + confirmations to act if it (wrongly) wanted to
        for (let i = 0; i < 6; i++) {
            await mine(1);
            await new Promise(r => setTimeout(r, 3000));
        }

        const req = await rpc(SOURCE_INDEXER_URL, 'getcrosschaincall', { call_id: callId });
        expect(req.call.request_status, 'terminal status').to.equal('expired');

        const target = await rpc(TARGET_INDEXER_URL, 'getcrosschaincallresult', { call_id: callId });
        expect(target && target.exists, 'no DOGE-side execution for an expired call').to.not.equal(true);

        expect(await readState(sdk, indexA, 'count:' + callId), 'callback count').to.equal('1');
    });
});
