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
 * XChain Platform E2E - XCALL per-block injection cap drill
 *
 * One BTC EXECUTE bursts 28 crossExecutes at the DOGE target (28 × 32,500
 * pre-pay ≈ 910k gas, inside the 1M EXECUTE ceiling). DOGE mining is HELD
 * while the dispatches confirm + relay, so all 28 become injectable at
 * once; then DOGE mines block-by-block and the drill asserts:
 *
 *   - the first processing block injects EXACTLY the cap (25), and they
 *     are the 25 LOWEST hub mirror ids (deterministic injection order);
 *   - the remaining 3 carry forward to a later block (nothing dropped);
 *   - all 28 results relay back and the callback fires exactly once each
 *     (the caller contract counts deliveries).
 *
 * Needs DB read access (dispatch visibility + execution grouping):
 *   XCALL_DB_HOST=127.0.0.1 XCALL_DB_PORT=13306
 *   HUB_DB_USER/HUB_DB_PASS            (XChain_Hub)
 *   DOGE_IDX_DB_USER/DOGE_IDX_DB_PASS  (XChain_DOGE_Regtest_Indexer)
 * plus the usual XCALL_TARGET_CONTRACT / XCALL_HUB_PUBKEY env.
 *
 ********************************************************************/

const { expect } = require('chai');
const axios = require('axios');
const mariadb = require('mariadb');
const { makeSdk, submit, fundedGasAddress, mine, submitOpts } = require('./sdkHelper');

const BURST = 28;
const CAP   = 25;

const CONTRACT_A = `
    module.exports = {
        crossCallable: [],
        burst: function(xchain) {
            var target = Number(xchain.getInputParam(0));
            var n      = Number(xchain.getInputParam(1));
            var ids = [];
            for (var i = 0; i < n; i++) {
                ids.push(xchain.emit.crossExecute({
                    targetChain:    'DOGE',
                    contractIndex:  target,
                    method:         'onArrival',
                    params:         ['burst-' + i],
                    gasLimit:       10000,
                    callbackMethod: 'onResult',
                    callbackParams: [String(i)],
                    deadlineBlocks: 600
                }));
            }
            xchain.state.set('burstIds', JSON.stringify(ids));
            return String(ids.length);
        },
        onResult: function(xchain) {
            xchain.state.set('done:' + xchain.getInputParam(0), xchain.getInputParam(2));
            xchain.state.set('doneCount', String(Number(xchain.state.get('doneCount') || '0') + 1));
        }
    };
`;

const TARGET_MINER_URL = process.env.XCALL_TARGET_MINER_URL || 'http://localhost:3125';
const DB_HOST = process.env.XCALL_DB_HOST || '127.0.0.1';
const DB_PORT = parseInt(process.env.XCALL_DB_PORT || '13306', 10);
// Hub rows and the DOGE indexer DB can live on separate MariaDB instances (a
// federated relay-hub DB distinct from the node-stack indexer DB). Each endpoint
// defaults to XCALL_DB_HOST/PORT so the co-located single-stack case is unchanged.
const HUB_DB_HOST = process.env.HUB_DB_HOST || DB_HOST;
const HUB_DB_PORT = parseInt(process.env.HUB_DB_PORT || String(DB_PORT), 10);
const HUB_DB_NAME = process.env.HUB_DB_NAME || 'XChain_Hub';
const DOGE_IDX_DB_HOST = process.env.DOGE_IDX_DB_HOST || DB_HOST;
const DOGE_IDX_DB_PORT = parseInt(process.env.DOGE_IDX_DB_PORT || String(DB_PORT), 10);
const DOGE_IDX_DB_NAME = process.env.DOGE_IDX_DB_NAME || 'XChain_DOGE_Regtest_Indexer';

async function rpc(url, method, params) {
    const res = await axios.post(url, { jsonrpc: '2.0', method, params: params || {}, id: 1 }, { timeout: 15000 });
    if (res.data && res.data.error) throw new Error(method + ': ' + JSON.stringify(res.data.error));
    return res.data ? res.data.result : null;
}

async function mineTarget(count) {
    await rpc(TARGET_MINER_URL, 'generate_blocks', { count: count || 1 });
}

async function withConn(host, port, database, user, password, fn) {
    const conn = await mariadb.createConnection({ host, port, database, user, password });
    try { return await fn(conn); } finally { await conn.end().catch(() => {}); }
}
async function hubDb(fn)  { return withConn(HUB_DB_HOST, HUB_DB_PORT, HUB_DB_NAME, process.env.HUB_DB_USER, process.env.HUB_DB_PASS, fn); }
async function dogeIdx(fn){ return withConn(DOGE_IDX_DB_HOST, DOGE_IDX_DB_PORT, DOGE_IDX_DB_NAME, process.env.DOGE_IDX_DB_USER, process.env.DOGE_IDX_DB_PASS, fn); }

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

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

describe('[sdk] XCALL per-block injection cap (25 + carry-forward)', function () {
    this.timeout(0);

    let sdk, deployer, indexA, targetContract, callIds = [];

    before(async function () {
        targetContract = parseInt(process.env.XCALL_TARGET_CONTRACT || '', 10);
        expect(targetContract, 'XCALL_TARGET_CONTRACT env').to.be.a('number').and.to.be.greaterThan(0);
        expect(process.env.HUB_DB_USER, 'HUB_DB_USER env (hub mirror reads)').to.be.a('string').and.to.not.equal('');
        sdk = makeSdk();
        deployer = await fundedGasAddress(sdk, 1);
        console.log('    [xcall-cap] deployer=' + deployer.address + ' target=' + targetContract);

        // Drain injection-competing debris from earlier runs: a dispatch that is
        // mirrored on the DOGE indexer but NOT yet executed there would inject ahead
        // of this run's calls (lower hub ids) and break the first-batch assertion.
        // Gate on the DOGE indexer's OWN tables, because injection reads the local
        // mirror: a relay-hub dispatch that never synced into this indexer's mirror
        // cannot inject and must not be counted (else the drain burns its whole
        // deadline on debris that mining can never clear), and a call already
        // executed locally no longer competes regardless of its hub result state.
        const drainDeadline = Date.now() + 300000;
        while (Date.now() < drainDeadline) {
            const competing = await dogeIdx(async (c) => Number((await c.query(
                `SELECT COUNT(*) n FROM cross_chain_calls d
                 WHERE d.phase = 'dispatch' AND d.target_chain = 'DOGE'
                   AND NOT EXISTS (SELECT 1 FROM cross_chain_call_executions e WHERE e.call_id = d.call_id)`))[0].n));
            if (competing === 0) break;
            console.log('    [xcall-cap] draining ' + competing + ' un-executed call(s) from earlier runs...');
            await mine(1);
            await mineTarget(1);
            await sleep(3000);
        }
    });

    it('DEPLOY the burst caller and fire ' + BURST + ' calls in ONE execution', async function () {
        const dep = await submit(sdk,
            { action: 'DEPLOY', params: { code: CONTRACT_A, gasLimit: 200000 } },
            { pubkey: deployer.address, change: deployer.address },
            submitOpts({ wif: deployer.wif })
        );
        expect(dep.indexed.status).to.equal('valid');
        indexA = contractIndexOf(dep.indexed);
        console.log('    [xcall-cap] A=' + indexA);

        // EXECUTE carries no wire GAS_LIMIT, so execution bills against the
        // protocol ceiling (1M), which covers the 28 × 32,500 pre-pays.
        //
        // The SDK action-waiter can mis-attribute a federated relay action's
        // "SIGNING_PUBKEY (already in use)" (the hub signing pubkey is reused
        // across the 28 dispatch signatures) to THIS EXECUTE even though the burst
        // itself lands and round-trips. Tolerate that one error and confirm the
        // EXECUTE's effect via contract state below instead of the waiter's verdict.
        try {
            const res = await submit(sdk,
                { action: 'EXECUTE', params: { contractActionIndex: indexA, method: 'burst', params: [String(targetContract), String(BURST)] } },
                { pubkey: deployer.address, change: deployer.address },
                submitOpts({ wif: deployer.wif })
            );
            expect(res.indexed.status, 'burst EXECUTE').to.equal('valid');
        } catch (e) {
            if (!/SIGNING_PUBKEY \(already in use\)/.test(String(e.message))) throw e;
            console.log('    [xcall-cap] waiter mis-attributed SIGNING_PUBKEY; confirming burst via state');
        }
        await mine(1);

        // The EXECUTE may have landed even if the waiter threw, so poll for the
        // burst to be indexed. state.set stores the value JSON-encoded and the
        // contract stringifies the array itself, so there are two decode levels.
        const burstDeadline = Date.now() + 60000;
        while (Date.now() < burstDeadline) {
            const raw = await readState(sdk, indexA, 'burstIds');
            if (raw != null) { callIds = JSON.parse(raw); if (callIds.length === BURST) break; }
            await mine(1);
            await sleep(2000);
        }
        expect(callIds, 'burst call ids').to.be.an('array').with.length(BURST);
        expect(new Set(callIds).size, 'distinct ids').to.equal(BURST);
        console.log('    [xcall-cap] ' + BURST + ' calls emitted from one EXECUTE');
    });

    it('all dispatches finalize while DOGE mining is held', async function () {
        const placeholders = callIds.map(() => '?').join(',');
        const deadline = Date.now() + 240000;
        let n = 0;
        while (Date.now() < deadline) {
            await mine(1);                                   // BTC only: confirmations + relay
            await sleep(2000);
            n = await hubDb(async (c) => {
                const rows = await c.query(
                    `SELECT COUNT(*) n FROM cross_chain_calls WHERE phase = 'dispatch' AND status = 'finalized' AND call_id IN (${placeholders})`,
                    callIds);
                return Number(rows[0].n);
            });
            if (n === BURST) break;
        }
        expect(n, 'finalized dispatch rows').to.equal(BURST);

        const executedEarly = await dogeIdx(async (c) => {
            const rows = await c.query(
                `SELECT COUNT(*) n FROM cross_chain_call_executions WHERE call_id IN (${placeholders})`, callIds);
            return Number(rows[0].n);
        });
        expect(executedEarly, 'no executions before DOGE mines').to.equal(0);
        console.log('    [xcall-cap] all ' + BURST + ' dispatches finalized, zero executed; releasing DOGE mining');
    });

    it('the first DOGE block injects exactly the cap, in (snapshot_block, call_id) order; the rest carry forward', async function () {
        const placeholders = callIds.map(() => '?').join(',');

        // release DOGE mining block-by-block until everything executed
        const deadline = Date.now() + 240000;
        let rows = [];
        while (Date.now() < deadline) {
            await mineTarget(1);
            await sleep(3000);
            rows = await dogeIdx(async (c) => c.query(
                `SELECT call_id, block_index FROM cross_chain_call_executions WHERE call_id IN (${placeholders})`,
                callIds));
            if (rows.length === BURST) break;
        }
        expect(rows.length, 'all calls executed (none dropped)').to.equal(BURST);

        // group by execution block
        const byBlock = new Map();
        for (const r of rows) {
            const b = Number(r.block_index);
            if (!byBlock.has(b)) byBlock.set(b, []);
            byBlock.get(b).push(String(r.call_id));
        }
        const blocks = [...byBlock.keys()].sort((a, b) => a - b);
        const counts = blocks.map(b => byBlock.get(b).length);
        console.log('    [xcall-cap] injection batches: ' + blocks.map((b, i) => b + '=' + counts[i]).join(', '));

        expect(Math.max(...counts), 'per-block injection cap').to.be.at.most(CAP);
        expect(counts[0], 'first batch fills the cap').to.equal(CAP);
        expect(blocks.length, 'carry-forward to a later block').to.be.at.least(2);

        // deterministic order: the first batch must be the CAP lowest by
        // (snapshot_block, call_id): quorum-agreed content, identical on every
        // hub, so the order no longer depends on which hub DB an indexer mirrors
        const hubRows = await hubDb(async (c) => c.query(
            `SELECT call_id, snapshot_block FROM cross_chain_calls WHERE phase = 'dispatch' AND call_id IN (${placeholders})`,
            callIds));
        const firstBatch = new Set(byBlock.get(blocks[0]));
        const sortedByKey = hubRows
            .map(r => [String(r.call_id), Number(r.snapshot_block)])
            .sort((a, b) => (a[1] - b[1]) || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
            .map(e => e[0]);
        const expectedFirst = new Set(sortedByKey.slice(0, CAP));
        expect(firstBatch, 'first batch = lowest (snapshot_block, call_id)').to.deep.equal(expectedFirst);
    });

    it('all results relay back and every callback fires exactly once', async function () {
        const deadline = Date.now() + 300000;
        let done = 0;
        while (Date.now() < deadline) {
            await mine(1);
            await mineTarget(1);
            await sleep(2000);
            done = Number(await readState(sdk, indexA, 'doneCount') || 0);
            if (done === BURST) break;
        }
        expect(done, 'callback deliveries').to.equal(BURST);
        // exactly-once: every per-call marker exists (callback param 0 is the
        // CALL_ID), and the counter equals the marker count (a double delivery
        // would over-increment the counter past BURST)
        for (const id of callIds) {
            const v = await readState(sdk, indexA, 'done:' + id);
            expect(v, 'done:' + id.substring(0, 12)).to.not.equal(null);
        }
        console.log('    [xcall-cap] ' + BURST + '/' + BURST + ' callbacks delivered exactly once');
    });
});
