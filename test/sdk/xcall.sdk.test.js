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
 *
 * XChain Platform E2E - cross-CHAIN contract calls (emit.crossExecute)
 *
 * Live relay pipeline against a TWO-chain stack: this suite runs under the
 * BTC regtest env (like every sdk suite) and additionally requires:
 *   - a DOGE regtest stack on the same hub (indexer API reachable at
 *     XCALL_TARGET_INDEXER_URL, default http://localhost:3124; miner at
 *     XCALL_TARGET_MINER_URL, default http://localhost:3125), and
 *   - the hub running in validator mode with the XCALL relay enabled and
 *     LOW relay confirmations (XCHAIN_CONFIRMATIONS_BTC/DOGE=2) + the
 *     regtest seams (XDEX_SEED_LOCAL_VALIDATOR=1).
 *
 * Scenario 1 deliberately targets a NONEXISTENT DOGE contract: that
 * exercises the COMPLETE round trip — on-chain XCALL request → federation
 * confirmation gate → signed dispatch row → DOGE-side XEXEC injection
 * (which records the no_contract failure as the result) → signed result
 * row → BTC-side callback injection — without any DOGE-side setup.
 *
 ********************************************************************/

const { expect } = require('chai');
const axios = require('axios');
const { makeSdk, submit, fundedGasAddress, mine, submitOpts } = require('./sdkHelper');

// Source-side contract (BTC): fires a cross-chain call and records both the
// returned call_id and the eventual callback delivery in state.
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
        },
        checkResult: function(xchain) {
            var r = xchain.crossChain.getCallResult(xchain.getInputParam(0));
            xchain.state.set('read:' + xchain.getInputParam(0), JSON.stringify(r));
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

// Drive BOTH chains forward while polling `check` — the relay needs source
// confirmations (request + result-callback application), target blocks (the
// effective_time barrier + execution depth), and hub poll cycles in between.
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

describe('[sdk] cross-chain calls (emit.crossExecute)', function () {
    this.timeout(0);

    let sdk, deployer, indexA, callId;

    before(async function () {
        sdk = makeSdk();
        deployer = await fundedGasAddress(sdk, 1);
        console.log('    [xcall] deployer=' + deployer.address);
    });

    it('STAKE the relay validator for the cross_chain capability (BTC chain truth)', async function () {
        // BTC resolves the cross_chain validator set from its OWN stakes (root of
        // trust), so the hub's signing pubkey must hold an active capability stake
        // before the BTC side will verify relay signatures. Pass the hub's pubkey
        // via XCALL_HUB_PUBKEY. Re-runs top up the same stake (harmless).
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
            // A prior run already staked this pubkey from a different funding
            // address — the capability stake exists and stays active.
            if (!/SIGNING_PUBKEY \(already in use\)/.test(String(e.message))) throw e;
            console.log('    [xcall] hub pubkey already staked — reusing the active stake');
        }
        await mine(8); // past ACTIVATION_DELAY_BLOCKS (6) so the stake is active at relay snapshot blocks
    });

    it('DEPLOY the source-side contract (A) on BTC', async function () {
        const res = await submit(sdk,
            { action: 'DEPLOY', params: { code: CONTRACT_A, gasLimit: 200000 } },
            { pubkey: deployer.address, change: deployer.address },
            submitOpts({ wif: deployer.wif })
        );
        expect(res.indexed.status).to.equal('valid');
        indexA = contractIndexOf(res.indexed);
        console.log('    [xcall] A=' + indexA);
    });

    it('emit.crossExecute lands a valid on-chain XCALL request with the derived call_id', async function () {
        const res = await submit(sdk,
            { action: 'EXECUTE', params: { contractActionIndex: indexA, method: 'callOut', params: ['999999', 'onArrival'] } },
            { pubkey: deployer.address, change: deployer.address },
            submitOpts({ wif: deployer.wif })
        );
        expect(res.indexed.status).to.equal('valid');
        await mine(1);

        callId = await readState(sdk, indexA, 'lastCall');
        expect(String(callId)).to.match(/^[0-9a-f]{64}$/);
        console.log('    [xcall] call_id=' + String(callId).substring(0, 16) + '...');

        const req = await rpc(SOURCE_INDEXER_URL, 'getcrosschaincall', { call_id: callId });
        expect(req.exists).to.equal(true);
        expect(req.call.target_chain).to.equal('DOGE');
        expect(req.call.target_contract_index).to.equal(999999);
        expect(req.call.gas_limit).to.equal(50000);
        expect(req.call.cross_hops).to.equal(1);
        expect(req.call.request_status).to.equal('pending');
    });

    it('the federation relays the dispatch and DOGE records a no_contract execution', async function () {
        const result = await pumpUntil('DOGE-side execution result', async () => {
            const r = await rpc(TARGET_INDEXER_URL, 'getcrosschaincallresult', { call_id: callId });
            return (r && r.exists === true) ? r : null;
        });
        console.log('    [xcall] DOGE executed: status=' + result.status + ' block=' + result.executed_block_index);
        expect(result.status).to.equal('no_contract');
        expect(result.network).to.equal('regtest');
        expect(result.return_payload_b64 || '').to.equal('');
    });

    it('the result relays back and the callback delivers exactly one no_contract outcome', async function () {
        await pumpUntil('source-side request completion', async () => {
            const r = await rpc(SOURCE_INDEXER_URL, 'getcrosschaincall', { call_id: callId });
            return (r && r.call && r.call.request_status === 'completed') ? r : null;
        });

        const delivered = await pumpUntil('callback state write', async () => {
            return await readState(sdk, indexA, 'result:' + callId);
        }, 60000);
        const outcome = JSON.parse(delivered);
        console.log('    [xcall] callback delivered: ' + delivered);
        expect(outcome.status).to.equal('no_contract');
        expect(outcome.chain).to.equal('DOGE');
        expect(outcome.payload).to.equal('');
        expect(outcome.echo).to.equal('echo-ctx');
    });

    it('xchain.crossChain.getCallResult reads the terminal outcome on-contract', async function () {
        await mine(1); // result visibility starts the block after the terminal flip
        const res = await submit(sdk,
            { action: 'EXECUTE', params: { contractActionIndex: indexA, method: 'checkResult', params: [String(callId)] } },
            { pubkey: deployer.address, change: deployer.address },
            submitOpts({ wif: deployer.wif })
        );
        expect(res.indexed.status).to.equal('valid');
        await mine(1);

        const read = JSON.parse(await readState(sdk, indexA, 'read:' + callId));
        expect(read).to.deep.equal({ status: 'no_contract', payload: '' });
    });
});
