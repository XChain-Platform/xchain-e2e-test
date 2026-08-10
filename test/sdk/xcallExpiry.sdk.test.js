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
 * XChain Platform E2E - cross-chain call DEADLINE EXPIRY under a QUORUM DROP
 *
 * Fires a short-deadline (minimum: 10 blocks) crossExecute while the relay
 * federation is held BELOW QUORUM, then mines past the deadline. The source
 * indexer must synthesize the XCALL v2 expiry deterministically: flip the
 * request to 'expired' and inject the requester's callback with
 * status='expired', with NO federation involvement. Once quorum is restored the
 * terminal expiry must hold (exactly-once interlock: no late dispatch, no
 * second callback).
 *
 * : this drill used to stop ONE named container and call that "the hub
 * down". On a single-hub stack the two are the same; against a federation they
 * are not, and the gap is silent - the surviving hubs still hold quorum, the
 * call dispatches, and the run either times out or reports a green it never
 * earned. The drill now reads the live cross_chain stake snapshot off the
 * source indexer, plans the smallest set of members to stop so the survivors
 * satisfy NEITHER the count quorum NOR the stake-weighted threshold
 * (test/sdk/xcallFederationPlan.js), and refuses to run at all on a venue where
 * that is impossible. Stopping the fewest, heaviest members leaves live hubs
 * standing as under-quorum witnesses, so the expiry is proven against a
 * federation that cannot agree rather than one that is merely absent.
 *
 * The 10-block deadline is the protocol minimum, and that is the point: it is
 * shorter than any relay round, so the window a restored federation could race
 * into is as small as the protocol allows.
 *
 * VENUE: expects to manage the hub containers directly via docker (runs on the
 * stack host). Federation members that are NOT containers (test-host runs relay
 * hub 1 as a host process) are simply left undeclared: the planner learns they
 * exist from the stake snapshot and treats their stake as surviving.
 *
 * Env on top of the BTC regtest e2e env:
 *   XCALL_HUB_PUBKEY        relay hub's Ed25519 pubkey (stake target)
 *   XCALL_HUB_CONTAINERS    federation members this venue can stop, as
 *                           `container=<pubkey>` comma-separated. The pubkey is
 *                           what lets the planner attribute stake to a
 *                           container; declare it for every member you can stop.
 *   XCALL_HUB_CONTAINER     legacy single-hub name (default
 *                           xchain-node-xchain-hub), still honoured, together
 *                           with XCALL_HUB2_CONTAINER / XCALL_HUB3_CONTAINER
 *   XCALL_TARGET_MINER_URL  DOGE regtest miner, so "no target execution" is a
 *                           claim about blocks that were actually produced
 *
 ********************************************************************/

const { expect } = require('chai');
const axios = require('axios');
const { execFileSync } = require('child_process');
const { makeSdk, submit, fundedGasAddress, mine, submitOpts } = require('./sdkHelper');
const federation = require('./xcallFederationPlan');

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
const TARGET_MINER_URL   = process.env.XCALL_TARGET_MINER_URL   || 'http://localhost:3125';

async function rpc(url, method, params) {
    const res = await axios.post(url, { jsonrpc: '2.0', method, params: params || {}, id: 1 }, { timeout: 15000 });
    if (res.data && res.data.error) throw new Error(method + ': ' + JSON.stringify(res.data.error));
    const result = res.data ? res.data.result : null;
    // The federation reads answer an APPLICATION error inside `result` rather than
    // as a JSON-RPC error, so reading `.validators` straight off one yields an
    // EMPTY set indistinguishable from "nobody is staked" - which is exactly the
    // read this drill must never get wrong.
    if (result && typeof result === 'object' && typeof result.error === 'string')
        throw new Error(method + ': ' + result.error);
    return result;
}

// Best-effort target mining, so "no DOGE-side execution" is a claim about a
// chain that was producing blocks and still executed nothing.
async function mineTarget(count) {
    try { await rpc(TARGET_MINER_URL, 'generate_blocks', { count: count || 1 }); } catch (e) { /* best effort */ }
}

// Live cross_chain stake snapshot, tolerant of the one-block lag between the
// indexer's tip and its committed API view (federation reads run off apiView,
// so a read at the just-announced tip legitimately answers "not yet indexed").
async function crossChainSnapshot(attempts) {
    let lastErr = null;
    for (let i = 0; i < (attempts || 40); i++) {
        try {
            const tip = (await rpc(SOURCE_INDEXER_URL, 'getlatestblock', {})).block_index;
            const res = await rpc(SOURCE_INDEXER_URL, 'getstakeweightsbycapability',
                { capability: 'cross_chain', block_index: Number(tip) });
            const rows = res.validators || [];
            if (res.truncated === true) rows.truncated = true;
            return rows;
        } catch (err) {
            lastErr = err;
            if (!/not yet indexed/.test(String(err.message))) throw err;
            await new Promise(r => setTimeout(r, 1500));
        }
    }
    throw lastErr;
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
        await mineTarget(1);
        await new Promise(r => setTimeout(r, 2000));
    }
    throw new Error('timed out waiting for ' + label);
}

describe('[sdk] cross-chain call deadline expiry (federation below quorum)', function () {
    this.timeout(0);

    let sdk, deployer, indexA, callId, drop = null;
    const stopped = new Set();

    // docker takes argv, never a shell line: a container name is operator env,
    // and the planner's name check is the only thing between it and this call.
    function dockerStop(name)  { execFileSync('docker', ['stop', name],  { stdio: 'inherit' }); stopped.add(name); }
    function dockerStart(name) { execFileSync('docker', ['start', name], { stdio: 'inherit' }); stopped.delete(name); }
    function dockerRunning(name) {
        return String(execFileSync('docker', ['inspect', '-f', '{{.State.Running}}', name])).trim() === 'true';
    }

    before(async function () {
        sdk = makeSdk();
        deployer = await fundedGasAddress(sdk, 1);
        console.log('    [xcall-exp] deployer=' + deployer.address);
    });

    after(async function () {
        // ALWAYS restore the whole federation, even when an assertion failed
        // mid-suite: a drill that leaves a venue under quorum breaks every
        // XCALL suite that runs after it.
        for (const name of [...stopped]) {
            try { dockerStart(name); } catch (e) { console.error('    [xcall-exp] FAILED to restart ' + name + ': ' + e.message); }
        }
        if (!stopped.size) console.log('    [xcall-exp] federation restored');
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
            console.log('    [xcall-exp] hub pubkey already staked, reusing the active stake');
        }
        await mine(8);
    });

    it('PLAN the quorum drop against the live federation (refuses a venue it cannot drop)', async function () {
        const spec = federation.parseFederationSpec(process.env);
        const snapshot = await crossChainSnapshot();
        const view = federation.summarizeSnapshot(snapshot);
        console.log('    [xcall-exp] federation: ' + view.n + ' staked source(s) from ' + spec.source);

        // A member declared with a pubkey that is not in the snapshot is not a
        // qualifying validator here. Stopping it would remove no stake, and the
        // planner would then quietly plan around it, so say it out loud: the
        // operator either mis-declared the pair or never staked that hub.
        const unstaked = spec.members.filter(m => m.pubkey && !view.sourceByPubkey.has(m.pubkey));
        expect(unstaked.map(m => m.container + '=' + m.pubkey.substring(0, 16) + '...'),
            'declared members with no active cross_chain stake (run test/sdk/xcallStakeValidators.js)').to.deep.equal([]);

        drop = federation.planQuorumDrop({ snapshot, stoppable: spec.members });
        console.log('    [xcall-exp] quorum=' + drop.countQuorum + '/' + drop.n
            + ' -> stopping [' + drop.stop.join(', ') + '], '
            + drop.survivingSources + ' source(s) left standing');
        expect(drop.stop.length, 'the plan must actually stop something').to.be.above(0);
        expect(drop.survivingSources, 'survivors must be under the count quorum').to.be.below(drop.countQuorum);
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

    it('DROP the federation below quorum, then fire a 10-block-deadline call', async function () {
        expect(drop, 'the planning step must have run').to.not.equal(null);
        for (const name of drop.stop) dockerStop(name);
        console.log('    [xcall-exp] ' + drop.stop.length + ' member(s) stopped, '
            + drop.survivingSources + ' of ' + drop.n + ' alive (< quorum ' + drop.countQuorum + ')');

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

    it('the surviving under-quorum members dispatch nothing before the deadline', async function () {
        // Three blocks only: the deadline is ten, and this window must close well
        // inside it or the assertion below stops meaning "did not dispatch" and
        // starts meaning "already expired".
        for (let i = 0; i < 3; i++) {
            await mine(1);
            await mineTarget(1);
            await new Promise(r => setTimeout(r, 3000));
        }
        const req = await rpc(SOURCE_INDEXER_URL, 'getcrosschaincall', { call_id: callId });
        expect(req.call.request_status, 'request must still be pending under quorum loss').to.equal('pending');
        const target = await rpc(TARGET_INDEXER_URL, 'getcrosschaincallresult', { call_id: callId });
        expect(target && target.exists, 'no DOGE-side execution under quorum loss').to.not.equal(true);
    });

    it('mining past the deadline expires the request deterministically (no quorum)', async function () {
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

    it('with quorum RESTORED, the terminal expiry holds (no late dispatch, no double callback)', async function () {
        const restored = [...stopped];
        for (const name of restored) dockerStart(name);
        // Assert the restore before asserting what a restored federation did NOT
        // do: against a still-dead federation this whole test is vacuous, which
        // is the same shape of unearned green  was filed for.
        for (const name of restored) expect(dockerRunning(name), name + ' back up').to.equal(true);
        console.log('    [xcall-exp] ' + restored.length + ' member(s) restarted, quorum '
            + drop.countQuorum + '/' + drop.n + ' reachable again');

        // Give the whole federation several XCALL_POLL_MS cycles + confirmations
        // to act if it (wrongly) still wanted to.
        for (let i = 0; i < 10; i++) {
            await mine(1);
            await mineTarget(1);
            await new Promise(r => setTimeout(r, 3000));
        }

        const req = await rpc(SOURCE_INDEXER_URL, 'getcrosschaincall', { call_id: callId });
        expect(req.call.request_status, 'terminal status').to.equal('expired');

        const target = await rpc(TARGET_INDEXER_URL, 'getcrosschaincallresult', { call_id: callId });
        expect(target && target.exists, 'no DOGE-side execution for an expired call').to.not.equal(true);

        expect(await readState(sdk, indexA, 'count:' + callId), 'callback count').to.equal('1');
    });
});
