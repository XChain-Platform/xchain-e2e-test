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
 * XChain Platform E2E - XCALL target-chain (Y) reorg replay drill
 *
 * Reorgs DOGE below an executed XEXEC while the execution is still at
 * depth 1 — UNDER the 2-conf relay gate, so the result leg has not been
 * signed yet (executions deeper than the gate are documented IRREVERSIBLE,
 * same posture as the DEX). The drill asserts:
 *
 *   - the rollback removes the orphaned execution row and the new-branch
 *     reprocessing re-injects the XEXEC deterministically (exactly one
 *     execution row, on a new block);
 *   - the result then relays once and the callback fires exactly once
 *     (counter contract) — the reorg cannot double-deliver.
 *
 * VENUE: drives dogecoind directly (invalidateblock) via docker exec on
 * the stack host. DOGE mining is held manually throughout, as in the cap
 * drill. Needs the same DB env as xcallCapDrill plus the node container
 * name (XCALL_DOGE_NODE_CONTAINER, default the xchain-node name).
 *
 ********************************************************************/

const { expect } = require('chai');
const axios = require('axios');
const mariadb = require('mariadb');
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
                params:         ['reorg-ping'],
                gasLimit:       50000,
                callbackMethod: 'onResult',
                callbackParams: ['reorg-ctx'],
                deadlineBlocks: 600
            });
            xchain.state.set('lastCall', id);
            return id;
        },
        onResult: function(xchain) {
            xchain.state.set('result:' + xchain.getInputParam(0), JSON.stringify({
                status: xchain.getInputParam(2), payload: xchain.getInputParam(3)
            }));
            xchain.state.set('count:' + xchain.getInputParam(0),
                String(Number(xchain.state.get('count:' + xchain.getInputParam(0)) || '0') + 1));
        }
    };
`;

const SOURCE_INDEXER_URL = 'http://' + (process.env.INDEXER_URL || 'localhost') + ':' + (process.env.INDEXER_API_PORT || '3024');
const TARGET_MINER_URL   = process.env.XCALL_TARGET_MINER_URL || 'http://localhost:3125';
const DOGE_NODE          = process.env.XCALL_DOGE_NODE_CONTAINER || 'xchain-node-dogecoin-regtest-node';
const DB_HOST = process.env.XCALL_DB_HOST || '127.0.0.1';
const DB_PORT = parseInt(process.env.XCALL_DB_PORT || '13306', 10);

function dogeCli(cmd) {
    return execSync('docker exec ' + DOGE_NODE + ' dogecoin-cli -conf=/etc/dogecoin/dogecoin.conf ' + cmd,
                    { encoding: 'utf8' }).trim();
}

async function rpc(url, method, params) {
    const res = await axios.post(url, { jsonrpc: '2.0', method, params: params || {}, id: 1 }, { timeout: 15000 });
    if (res.data && res.data.error) throw new Error(method + ': ' + JSON.stringify(res.data.error));
    return res.data ? res.data.result : null;
}

async function mineTarget(count) {
    await rpc(TARGET_MINER_URL, 'generate_blocks', { count: count || 1 });
}

async function withConn(database, user, password, fn) {
    const conn = await mariadb.createConnection({ host: DB_HOST, port: DB_PORT, database, user, password });
    try { return await fn(conn); } finally { await conn.end().catch(() => {}); }
}
async function hubDb(fn)  { return withConn('XChain_Hub', process.env.HUB_DB_USER, process.env.HUB_DB_PASS, fn); }
async function dogeIdx(fn){ return withConn('XChain_DOGE_Regtest_Indexer', process.env.DOGE_IDX_DB_USER, process.env.DOGE_IDX_DB_PASS, fn); }

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

describe('[sdk] XCALL target-chain reorg replay (pre-confirmation)', function () {
    this.timeout(0);

    let sdk, deployer, indexA, targetContract, callId, executedBlock, executedHash;

    before(async function () {
        targetContract = parseInt(process.env.XCALL_TARGET_CONTRACT || '', 10);
        expect(targetContract, 'XCALL_TARGET_CONTRACT env').to.be.a('number').and.to.be.greaterThan(0);
        expect(process.env.HUB_DB_USER, 'HUB_DB_USER env').to.be.a('string').and.to.not.equal('');
        sdk = makeSdk();
        deployer = await fundedGasAddress(sdk, 1);
        console.log('    [xcall-reorg] deployer=' + deployer.address + ' target=' + targetContract);
    });

    it('DEPLOY the caller and fire one call; hold DOGE until the dispatch finalizes', async function () {
        const dep = await submit(sdk,
            { action: 'DEPLOY', params: { code: CONTRACT_A, gasLimit: 200000 } },
            { pubkey: deployer.address, change: deployer.address },
            submitOpts({ wif: deployer.wif })
        );
        expect(dep.indexed.status).to.equal('valid');
        indexA = contractIndexOf(dep.indexed);

        const res = await submit(sdk,
            { action: 'EXECUTE', params: { contractActionIndex: indexA, method: 'callOut', params: [String(targetContract)] } },
            { pubkey: deployer.address, change: deployer.address },
            submitOpts({ wif: deployer.wif })
        );
        expect(res.indexed.status).to.equal('valid');
        await mine(1);
        callId = String(await readState(sdk, indexA, 'lastCall'));
        expect(callId).to.match(/^[0-9a-f]{64}$/);
        console.log('    [xcall-reorg] call_id=' + callId.substring(0, 16) + '...');

        const deadline = Date.now() + 240000;
        let n = 0;
        while (Date.now() < deadline) {
            await mine(1);                                    // BTC only
            await sleep(2000);
            n = await hubDb(async (c) => Number((await c.query(
                "SELECT COUNT(*) n FROM cross_chain_calls WHERE phase = 'dispatch' AND status = 'finalized' AND call_id = ?",
                [callId]))[0].n));
            if (n === 1) break;
        }
        expect(n, 'dispatch finalized').to.equal(1);
    });

    it('one DOGE block executes the call at depth 1 (below the relay gate)', async function () {
        await mineTarget(1);
        const deadline = Date.now() + 60000;
        let row = null;
        while (Date.now() < deadline && !row) {
            await sleep(2000);
            const rows = await dogeIdx(async (c) => c.query(
                'SELECT block_index FROM cross_chain_call_executions WHERE call_id = ?', [callId]));
            row = rows[0] || null;
        }
        expect(row, 'execution row').to.not.equal(null);
        executedBlock = Number(row.block_index);
        executedHash  = dogeCli('getblockhash ' + executedBlock);
        console.log('    [xcall-reorg] executed at DOGE block ' + executedBlock + ' (' + executedHash.substring(0, 16) + '...)');

        // depth 1 — the result leg must NOT be signed yet
        const resultRows = await hubDb(async (c) => c.query(
            "SELECT COUNT(*) n FROM cross_chain_calls WHERE phase = 'result' AND call_id = ?", [callId]));
        expect(Number(resultRows[0].n), 'no result relay below confirmation depth').to.equal(0);
    });

    it('invalidating the executed block rolls back and the new branch re-injects exactly once', async function () {
        dogeCli('invalidateblock ' + executedHash);
        console.log('    [xcall-reorg] block ' + executedBlock + ' invalidated — mining the replacement branch');
        await mineTarget(3);

        // Deterministic replay re-injects at the SAME HEIGHT on the new branch
        // (the first new-branch block processed) — distinguish branches by
        // block HASH, never height.
        const deadline = Date.now() + 180000;
        let rows = [], rowBranchHash = null;
        while (Date.now() < deadline) {
            await sleep(3000);
            rows = await dogeIdx(async (c) => c.query(
                'SELECT block_index FROM cross_chain_call_executions WHERE call_id = ?', [callId]));
            if (rows.length === 1) {
                rowBranchHash = dogeCli('getblockhash ' + Number(rows[0].block_index));
                if (rowBranchHash !== executedHash) break;     // row exists on the NEW branch
                rowBranchHash = null;                          // stale pre-rollback row — keep waiting
            }
            await mineTarget(1);
        }
        expect(dogeCli('getblockhash ' + executedBlock), 'the chain actually reorged').to.not.equal(executedHash);
        expect(rows.length, 'exactly one execution row after replay').to.equal(1);
        expect(rowBranchHash, 'execution recorded on a new-branch block').to.be.a('string');
        console.log('    [xcall-reorg] re-injected at DOGE block ' + Number(rows[0].block_index) +
                    ' (' + String(rowBranchHash).substring(0, 16) + '... — new branch, ' +
                    (Number(rows[0].block_index) === executedBlock ? 'same height' : 'different height') + ')');
    });

    it('the result relays once and the callback fires exactly once', async function () {
        const deadline = Date.now() + 300000;
        let req = null;
        while (Date.now() < deadline) {
            await mine(1);
            await mineTarget(1);
            await sleep(2000);
            const r = await rpc(SOURCE_INDEXER_URL, 'getcrosschaincall', { call_id: callId });
            if (r && r.call && r.call.request_status === 'completed') { req = r; break; }
        }
        expect(req, 'request completed').to.not.equal(null);

        const delivered = JSON.parse(await (async () => {
            const dl = Date.now() + 60000;
            while (Date.now() < dl) {
                const v = await readState(sdk, indexA, 'result:' + callId);
                if (v) return v;
                await mine(1);
                await sleep(2000);
            }
            throw new Error('callback never delivered');
        })());
        expect(delivered.status).to.equal('ok');
        expect(await readState(sdk, indexA, 'count:' + callId), 'exactly-once').to.equal('1');

        const resultRows = await hubDb(async (c) => c.query(
            "SELECT COUNT(*) n FROM cross_chain_calls WHERE phase = 'result' AND call_id = ?", [callId]));
        expect(Number(resultRows[0].n), 'single result relay row').to.equal(1);
        console.log('    [xcall-reorg] result relayed once, callback exactly once — replay clean');
    });
});
