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
 * XChain Platform E2E - XCALL SOURCE-chain (X) reorg retraction drill
 *
 * Companion to xcallReorgDrill.sdk.test.js (which reorgs the TARGET chain
 * and proves XEXEC re-injection). This drill reorgs the SOURCE chain (BTC,
 * where the XCALL was emitted) AFTER the federation has finalized a dispatch
 * row but BEFORE the target has executed it (DOGE mining is held), and proves
 * the 06-13 retraction path:
 *
 *   indexer rollback.js -> hub_client.retractXcallRange(coin, firstActionIndex)
 *     -> hub pushxcallreorg -> CrossChainCallEngine.retractCallsForReorg:
 *        marks cross_chain_calls (source_chain, source_action_index >=) rows
 *        status='retracted' and broadcasts a deletion; mirroring indexers
 *        DELETE the local rows so the call is never dispatched/executed.
 *
 * Asserts (per the code trace):
 *   - hub: the dispatch row for call_id -> status='retracted' (not deleted).
 *     In a shared-DB venue (XCALL_HUB_MIRROR_SHARED=1) the indexer mirror-delete
 *     hits this same row, so 'retracted'-then-deleted (null) is also accepted; a
 *     live 'finalized'/'dispatched' status still fails (retraction never fired);
 *   - source BTC indexer: the xcalls v0 row for call_id is gone, and its
 *     cross_chain_calls mirror row is gone;
 *   - target DOGE indexer: cross_chain_calls mirror row gone, and NO
 *     cross_chain_call_executions row was ever written (DOGE held);
 *   - no callback row on the source chain.
 *
 * SHALLOW/pre-injection case only. A reorg deeper than the relay gate that
 * orphans an ALREADY-executed XEXEC is documented IRREVERSIBLE territory and
 * is out of scope (we hold DOGE so the XEXEC never injects).
 *
 * VENUE: BTC + DOGE regtest with the hub at >= 50a2222 (pushxcallreorg) and
 * both indexers at >= 06e8942 (retractXcallRange wired in rollback.js).
 * Single hub is sufficient (retraction is a hub-endpoint + indexer-rollback
 * path, not a PBFT quorum path). Uses the BTC stack globals stood up by
 * initialCheck (nodeConnector / regtestMinerConnector / indexerDatabase) for
 * the source-chain reorg, exactly like test/actions/reorgBalances.test.js, and
 * direct DB reads for the hub + DOGE indexer (separate DBs).
 *
 * Same DB env as xcallReorgDrill: HUB_DB_USER/PASS, DOGE_IDX_DB_USER/PASS,
 * XCALL_DB_HOST/PORT, plus XCALL_TARGET_CONTRACT.
 *
 ********************************************************************/

const { expect } = require('chai');
const mariadb = require('mariadb');
const cryptoHelper = require('../cryptoHelper');
const { makeSdk, submit, fundedGasAddress, mine, submitOpts } = require('./sdkHelper');

const CONTRACT_A = `
    module.exports = {
        crossCallable: [],
        callOut: function(xchain) {
            var id = xchain.emit.crossExecute({
                targetChain:    'DOGE',
                contractIndex:  Number(xchain.getInputParam(0)),
                method:         'onArrival',
                params:         ['src-reorg-ping'],
                gasLimit:       50000,
                callbackMethod: 'onResult',
                callbackParams: ['src-reorg-ctx'],
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

// In a co-located ("shared-DB") venue the source indexer's hub-mirror DB IS the
// relay/hub DB, so rollback's mirror-delete (hub_db_sync.js) removes the row from
// the very table this drill reads as "the hub row". Retraction is then observable
// as a DELETE, not a status flip the row retains. Set XCALL_HUB_MIRROR_SHARED=1
// for that venue: the assertion then accepts the row being gone (null) as well as
// 'retracted', but still fails on a live status ('finalized'/'dispatched') that
// means retraction never fired. The default (separate hub + indexer DBs) keeps
// the strict 'retracted'-retained check.
const HUB_MIRROR_SHARED = process.env.XCALL_HUB_MIRROR_SHARED === '1' || process.env.XCALL_HUB_MIRROR_SHARED === 'true';

async function withConn(host, port, database, user, password, fn) {
    const conn = await mariadb.createConnection({ host, port, database, user, password });
    try { return await fn(conn); } finally { await conn.end().catch(() => {}); }
}
async function hubDb(fn)   { return withConn(HUB_DB_HOST, HUB_DB_PORT, HUB_DB_NAME, process.env.HUB_DB_USER, process.env.HUB_DB_PASS, fn); }
async function dogeIdx(fn) { return withConn(DOGE_IDX_DB_HOST, DOGE_IDX_DB_PORT, DOGE_IDX_DB_NAME, process.env.DOGE_IDX_DB_USER, process.env.DOGE_IDX_DB_PASS, fn); }

// Source (BTC) indexer DB: the global indexerDatabase that initialCheck stands
// up for the primary stack (COIN=bitcoin).
async function btcIdx(sql, params) {
    const db = global.indexerDatabase;
    const conn = await db.getConnection();
    try { return await conn.query(sql, params); } finally { await conn.release(); }
}
async function btcCount(sql, params) { return Number((await btcIdx(sql, params))[0].n); }

function contractIndexOf(indexed) {
    const a = indexed && Array.isArray(indexed.actions) ? indexed.actions[0] : null;
    return a ? a.action_index : null;
}
async function readState(sdk, contractIndex, key) {
    const state = await sdk.getContractState(contractIndex, key);
    const rows = (state && state.data) || [];
    const row = rows.find(r => r.state_key === key);
    // state_value is stored JSON-encoded (the VM's xchain.state.set serializes),
    // so a string value comes back quoted ("21f8..."); parse it to match the
    // sibling target-reorg drill and keep callId a bare 64-hex string.
    return row ? JSON.parse(row.state_value) : null;
}
async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

describe('[sdk] XCALL source-chain reorg retraction (pre-execution)', function () {
    this.timeout(0);

    let sdk, deployer, indexA, targetContract, callId, srcBlock;

    before(async function () {
        targetContract = parseInt(process.env.XCALL_TARGET_CONTRACT || '', 10);
        expect(targetContract, 'XCALL_TARGET_CONTRACT env').to.be.a('number').and.to.be.greaterThan(0);
        expect(process.env.HUB_DB_USER, 'HUB_DB_USER env').to.be.a('string').and.to.not.equal('');
        expect(process.env.DOGE_IDX_DB_USER, 'DOGE_IDX_DB_USER env').to.be.a('string').and.to.not.equal('');
        expect(global.nodeConnector, 'nodeConnector global (initialCheck)').to.be.an('object');
        expect(global.indexerDatabase, 'indexerDatabase global (initialCheck)').to.be.an('object');
        sdk = makeSdk();
        deployer = await fundedGasAddress(sdk, 1);
        console.log('    [xcall-srcreorg] deployer=' + deployer.address + ' target=' + targetContract);
    });

    it('DEPLOY the caller and fire one cross-chain call on BTC', async function () {
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

        // Resolve the BTC block that carries the emitted XCALL v0 request, the
        // block we will orphan. Poll briefly for the xcalls row to be indexed.
        const deadline = Date.now() + 60000;
        while (Date.now() < deadline) {
            const rows = await btcIdx('SELECT block_index FROM xcalls WHERE call_id = ? AND version = 0 LIMIT 1', [callId]);
            if (rows.length && rows[0].block_index != null) { srcBlock = Number(rows[0].block_index); break; }
            await mine(1); await sleep(1500);
        }
        expect(srcBlock, 'XCALL v0 indexed on BTC').to.be.a('number').and.to.be.greaterThan(0);
        console.log('    [xcall-srcreorg] call_id=' + callId.substring(0, 16) + '... emitted at BTC block ' + srcBlock);
    });

    it('bury the request to confirmation depth so the dispatch finalizes (DOGE held)', async function () {
        // Mine BTC past the relay gate; DOGE is never mined, so the XEXEC cannot inject.
        const deadline = Date.now() + 240000;
        let n = 0;
        while (Date.now() < deadline) {
            await mine(1);
            await sleep(2000);
            n = await hubDb(async (c) => Number((await c.query(
                "SELECT COUNT(*) n FROM cross_chain_calls WHERE phase = 'dispatch' AND status = 'finalized' AND call_id = ?",
                [callId]))[0].n));
            if (n === 1) break;
        }
        expect(n, 'dispatch finalized on the hub').to.equal(1);

        // DOGE held: no execution row yet (the precondition the retraction protects).
        const execNow = await dogeIdx(async (c) => Number((await c.query(
            'SELECT COUNT(*) n FROM cross_chain_call_executions WHERE call_id = ?', [callId]))[0].n));
        expect(execNow, 'no XEXEC injected before the reorg (DOGE held)').to.equal(0);
        console.log('    [xcall-srcreorg] dispatch finalized; DOGE held, no execution yet');
    });

    it('orphaning the source block retracts the dispatch and the call never reaches DOGE', async function () {
        const node  = global.nodeConnector;
        const miner = global.regtestMinerConnector;

        // Pause auto-mining so the orphaned XCALL tx cannot be re-mined from the
        // mempool, then build an EMPTY competing chain (generateBlock(addr, []))
        // longer than the original tip (same mechanism as reorgBalances.test.js).
        await miner.pauseMining();
        try {
            const tipBefore = await node.getBlockCount();
            const srcHash   = await node.getBlockHash(srcBlock);
            const payout    = (await cryptoHelper.getNewAddress('xcall-srcreorg-miner', COIN, NETWORK, null, 'legacy', 0)).address;

            await node.invalidateBlock(srcHash);
            expect(await node.getBlockCount(), 'node rolled back below the XCALL block').to.equal(srcBlock - 1);

            const need = tipBefore - (srcBlock - 1) + 2;
            for (let i = 0; i < need; i++) await node.generateBlock(payout, []);
            expect(await node.getBlockCount(), 'competing chain overtakes the original tip').to.be.greaterThan(tipBefore);
            expect(await node.getBlockHash(srcBlock), 'the chain actually reorged').to.not.equal(srcHash);
            console.log('    [xcall-srcreorg] BTC reorged onto an empty branch; waiting for rollback.js + hub retraction');

            // Wait for node -> decoder -> indexer rollback -> retractXcallRange -> hub
            // retraction -> broadcastDeletion -> mirror DELETE to propagate.
            const deadline = Date.now() + 180000;
            let hubStatus = null, btcMirror = -1;
            while (Date.now() < deadline) {
                await sleep(3000);
                const hr = await hubDb(async (c) => c.query(
                    "SELECT status FROM cross_chain_calls WHERE call_id = ? AND phase = 'dispatch' LIMIT 1", [callId]));
                hubStatus = hr.length ? hr[0].status : null;
                btcMirror = await btcCount('SELECT COUNT(*) n FROM cross_chain_calls WHERE call_id = ?', [callId]);
                // Separate-DB: wait for the retained 'retracted' flip. Shared-DB: the
                // flip is immediately followed by the mirror-delete, so the row is gone
                // (null) once it finalized (it started 'finalized', never null).
                const retracted = hubStatus === 'retracted' || (HUB_MIRROR_SHARED && hubStatus === null);
                if (retracted && btcMirror === 0) break;
            }

            if (HUB_MIRROR_SHARED) {
                // Shared-DB venue: a flip to 'retracted' immediately followed by the
                // mirror-delete is the expected outcome, so the row may already be gone
                // (null). A live status ('finalized'/'dispatched') means retraction
                // never fired.
                expect(hubStatus, 'hub dispatch row retracted (or retracted+mirror-deleted in shared-DB venue)').to.be.oneOf(['retracted', null]);
            } else {
                // Hub keeps the row but flips it to 'retracted' (audit continuity).
                expect(hubStatus, 'hub dispatch row marked retracted').to.equal('retracted');
            }

            expect(await btcCount('SELECT COUNT(*) n FROM xcalls WHERE call_id = ?', [callId]),
                'source xcalls row removed by rollback').to.equal(0);
            expect(btcMirror, 'source cross_chain_calls mirror deleted').to.equal(0);

            expect(await btcCount('SELECT COUNT(*) n FROM cross_chain_call_callbacks WHERE call_id = ?', [callId]),
                'no callback on the source chain').to.equal(0);

            const dogeMirror = await dogeIdx(async (c) => Number((await c.query(
                'SELECT COUNT(*) n FROM cross_chain_calls WHERE call_id = ?', [callId]))[0].n));
            const dogeExec = await dogeIdx(async (c) => Number((await c.query(
                'SELECT COUNT(*) n FROM cross_chain_call_executions WHERE call_id = ?', [callId]))[0].n));
            expect(dogeMirror, 'target cross_chain_calls mirror deleted').to.equal(0);
            expect(dogeExec, 'target never executed the retracted call').to.equal(0);

            console.log('    [xcall-srcreorg] retracted cleanly: hub=retracted, mirrors gone, no exec, no callback');
        } finally {
            await miner.resumeMining();
        }
    });
});
