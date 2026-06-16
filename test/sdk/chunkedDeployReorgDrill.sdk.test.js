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
 * XChain Platform E2E - Chunked DEPLOY reorg drill
 *
 * Proves the chunked-DEPLOY reorg-safety property the handler relies on
 * (deploy.js): "assembly never consumes a chunk that does not precede it →
 * any reorg dropping a chunk also drops the dependent DEPLOY, so rollback
 * needs no bespoke logic." A v2 assembling DEPLOY reads only VALID v4 chunk
 * carriers at a LOWER action_index, so the carriers are strictly below the
 * contract in block order. Orphaning the FIRST chunk's block therefore orphans
 * every chunk AND the dependent contract.
 *
 * The drill:
 *   1. Chunk-deploys a large contract (DEPLOY v4 carriers + assembling DEPLOY v2)
 *      and runs it, so the contract is live with seeded + executed state.
 *   2. Orphans the block carrying the FIRST chunk carrier by building an EMPTY
 *      competing chain (auto-mining held, generateBlock(addr, []) — same
 *      mechanism as reorgBalances.test.js / xcallSourceReorgDrill), and asserts
 *      rollback.js cascaded the removal: NO deploy_chunks rows, NO contracts row,
 *      and NO contract_state for that code_hash survive on the orphan branch.
 *   3. Resumes mining so the orphaned txs re-mine from the mempool (they chain
 *      via the deployer's change UTXOs, so they confirm in dependency order) and
 *      asserts the contract reassembles DETERMINISTICALLY — same code_hash and
 *      byte-identical constructor/execution state — proving a reorg cannot
 *      corrupt a chunk-assembled contract.
 *
 * VENUE: BTC (or LTC) regtest stack stood up by initialCheck. Uses the same
 * stack globals as xcallSourceReorgDrill (nodeConnector / regtestMinerConnector /
 * indexerDatabase). DOGE regtest is skipped (fast-chain mining model). Needs
 * Node 22 (real isolated-vm via the indexer DB layer).
 *
 * Run (host with regtest stack + Node 22):
 *     COIN=bitcoin NETWORK=regtest npm run test:sdk:chunked-reorg
 *
 ********************************************************************/

'use strict';

const { expect } = require('chai');
const cryptoHelper = require('../cryptoHelper');
const { makeSdk, submit, fundedGasAddress, mine, submitOpts } = require('./sdkHelper');
const { chunkHelper } = require('xchain-sdk');

// A contract too large for a single DEPLOY: a ~7 KB string literal pads the source
// past the base64 single-action budget, forcing ≥2 chunks. The string survives (it is
// code, not a comment); `padlen` proves byte-exact reassembly and `increment` proves
// the assembled contract runs. No xchain.* calls in module scope so readManifest is
// clean and the constructor initializes state.
const PAD = 'x'.repeat(7000);
const SRC = [
    'var PAD = "' + PAD + '";',
    'module.exports = {',
    '  initialize: function (xchain) {',
    '    var start = xchain.getInputParam(0);',
    '    xchain.state.set("count", String(parseInt(start) || 0));',
    '    xchain.state.set("padlen", String(PAD.length));',
    '  },',
    '  increment: function() {',
    '    xchain.state.set("count", String(parseInt(xchain.state.get("count")) + 1));',
    '  }',
    '};'
].join('\n');

const GAS_LIMIT = 400000;
const START     = 5;

function haveConnectors() {
    return global.nodeConnector && global.regtestMinerConnector && global.indexerDatabase;
}

// Indexer DB reads against the primary stack's global pool (initialCheck), exactly
// like xcallSourceReorgDrill's btcIdx helper.
async function idxQuery(sql, params) {
    const conn = await global.indexerDatabase.getConnection();
    try { return await conn.query(sql, params); } finally { await conn.release(); }
}
async function idxCount(sql, params) { return Number((await idxQuery(sql, params))[0].n); }

function contractIndexOf(indexed) {
    const list = indexed && Array.isArray(indexed.actions) ? indexed.actions : [];
    const deploy = list.find(a => (a.action === 'DEPLOY')) || list[0] || null;
    return deploy ? deploy.action_index : null;
}

async function readState(sdk, contractIndex, key) {
    const state = await sdk.getContractState(contractIndex, key);
    const rows = (state && state.data) || [];
    const row = rows.find(r => r.state_key === key);
    return row ? JSON.parse(row.state_value) : undefined;
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

describe('[sdk] chunked DEPLOY reorg drill (orphaned chunk → assembled contract rolls back)', function () {
    this.timeout(0);

    let sdk, deployer, plan, contractIndex, codeHash, firstChunkBlock;

    before(async function () {
        if (!haveConnectors()) this.skip();
        // Reorg via an empty competing chain is a BTC/LTC mechanism; DOGE regtest uses a
        // different (fast-chain) mining model — skip it, as reorgBalances.test.js does.
        if (global.COIN_CODE === 'DOGE') this.skip();
        sdk = makeSdk();
        deployer = await fundedGasAddress(sdk, 1);

        plan = chunkHelper.planDeploy(SRC, { gasLimit: GAS_LIMIT, constructorParams: [String(START)] });
        expect(plan.single, 'source must NOT fit a single DEPLOY (else not testing chunking)').to.equal(false);
        expect(plan.totalChunks, 'expected ≥2 chunks').to.be.greaterThan(1);
        codeHash = plan.codeHash;
        console.log('    [chunk-reorg] deployer=' + deployer.address +
                    ' source=' + Buffer.byteLength(SRC, 'utf8') + ' B → ' + plan.totalChunks +
                    ' chunks, hash=' + codeHash.slice(0, 12));
    });

    it('chunk-deploys a large contract and runs it (live + seeded + executed state)', async function () {
        // Upload each base64 slice as its own confirmed DEPLOY v4 carrier block.
        for (let i = 0; i < plan.parts.length; i++) {
            const res = await submit(sdk,
                { action: 'DEPLOY', params: { version: '4', codeHash, chunkIndex: i, totalChunks: plan.totalChunks, codePart: plan.parts[i] } },
                { pubkey: deployer.address, change: deployer.address },
                submitOpts({ wif: deployer.wif }));
            expect(res.indexed.status, 'DEPLOY v4 carrier ' + i + ' indexed').to.equal('valid');
            await mine(1);
        }

        // Assemble via DEPLOY v2 (CODE_HASH) + run the constructor.
        const asm = await submit(sdk,
            { action: 'DEPLOY', params: { version: '2', codeHash, gasLimit: GAS_LIMIT, constructorParams: [String(START)] } },
            { pubkey: deployer.address, change: deployer.address },
            submitOpts({ wif: deployer.wif }));
        expect(asm.indexed.status, 'assembling DEPLOY v2 indexed').to.equal('valid');
        contractIndex = contractIndexOf(asm.indexed);
        expect(contractIndex, 'contract action_index').to.not.equal(null);
        await mine(1);

        // Run a method so the contract has post-constructor state too.
        const exec = await submit(sdk,
            { action: 'EXECUTE', params: { contractActionIndex: contractIndex, method: 'increment', params: [] } },
            { pubkey: deployer.address, change: deployer.address },
            submitOpts({ wif: deployer.wif }));
        expect(exec.indexed.status, 'EXECUTE increment indexed').to.equal('valid');
        await mine(1);

        // Byte-exact reassembly + execution confirmed.
        expect(await readState(sdk, contractIndex, 'padlen'), 'padlen matches the reassembled source').to.equal(String(PAD.length));
        expect(await readState(sdk, contractIndex, 'count'), 'increment ran on the assembled contract').to.equal(String(START + 1));

        // Resolve the block carrying the FIRST chunk carrier — the one we orphan. All chunk
        // rows are indexed by now (the contract assembled from them), so MIN() is populated.
        const rows = await idxQuery('SELECT MIN(block_index) AS n FROM deploy_chunks WHERE code_hash = ?', [codeHash]);
        firstChunkBlock = Number(rows[0].n);
        expect(firstChunkBlock, 'first chunk carrier block resolved').to.be.a('number').and.to.be.greaterThan(0);

        // Sanity: chunks + contract + state are all present BEFORE the reorg.
        expect(await idxCount('SELECT COUNT(*) n FROM deploy_chunks WHERE code_hash = ?', [codeHash]),
            'all chunk carriers present pre-reorg').to.equal(plan.totalChunks);
        expect(await idxCount("SELECT COUNT(*) n FROM contracts WHERE code_hash = ? AND status_id = (SELECT id FROM index_statuses WHERE status='valid')", [codeHash]),
            'assembled contract present + valid pre-reorg').to.equal(1);
        console.log('    [chunk-reorg] contractIndex=' + contractIndex + ' firstChunkBlock=' + firstChunkBlock);
    });

    it('orphaning the first chunk block rolls back the chunks AND the dependent contract', async function () {
        const node  = global.nodeConnector;
        const miner = global.regtestMinerConnector;

        // Hold auto-mining so the orphaned txs are NOT re-mined yet, then build an EMPTY
        // competing chain longer than the original tip (generateBlock(addr, [])).
        await miner.setMiningTime(3600000, 3600000);
        try {
            const tipBefore = await node.getBlockCount();
            const chunkHash = await node.getBlockHash(firstChunkBlock);
            const payout    = (await cryptoHelper.getNewAddress('chunk-reorg-miner', COIN, NETWORK, null, 'legacy', 0)).address;

            await node.invalidateBlock(chunkHash);
            expect(await node.getBlockCount(), 'node rolled back below the first chunk block').to.equal(firstChunkBlock - 1);

            const need = tipBefore - (firstChunkBlock - 1) + 2;
            for (let i = 0; i < need; i++) await node.generateBlock(payout, []);
            expect(await node.getBlockCount(), 'competing chain overtakes the original tip').to.be.greaterThan(tipBefore);
            expect(await node.getBlockHash(firstChunkBlock), 'the chain actually reorged').to.not.equal(chunkHash);
            console.log('    [chunk-reorg] reorged onto an empty branch; waiting for decoder → indexer rollback');

            // Wait for node → decoder → indexer rollback.js to delete block_index >= firstChunkBlock
            // across deploy_chunks / contracts / contract_state.
            const deadline = Date.now() + 180000;
            let chunks = -1, contracts = -1, state = -1;
            while (Date.now() < deadline) {
                await sleep(3000);
                chunks    = await idxCount('SELECT COUNT(*) n FROM deploy_chunks WHERE code_hash = ?', [codeHash]);
                contracts = await idxCount('SELECT COUNT(*) n FROM contracts WHERE code_hash = ?', [codeHash]);
                state     = await idxCount('SELECT COUNT(*) n FROM contract_state WHERE contract_index = ?', [contractIndex]);
                if (chunks === 0 && contracts === 0 && state === 0) break;
            }
            expect(chunks, 'all chunk carriers removed by rollback').to.equal(0);
            expect(contracts, 'the dependent assembled contract removed by rollback').to.equal(0);
            expect(state, 'the contract state removed by rollback').to.equal(0);
            console.log('    [chunk-reorg] rollback clean — chunks, contract, and state all gone on the orphan branch');
        } finally {
            // Leave auto-mining ON for the re-injection phase (mempool drains naturally).
            await miner.setDefaultMiningTime();
        }
    });

    it('re-mining the orphaned txs reassembles the contract DETERMINISTICALLY (same hash + state)', async function () {
        // Auto-mining resumed in the previous phase's finally. The orphaned chunk carriers,
        // the assembling DEPLOY, and the EXECUTE are back in the mempool; they chain via the
        // deployer's change UTXOs, so they re-confirm in dependency order and the contract
        // reassembles. A reorg must not change WHAT gets built — only WHERE.
        const deadline = Date.now() + 240000;
        let row = null;
        while (Date.now() < deadline) {
            await mine(1);
            await sleep(2000);
            const rows = await idxQuery(
                "SELECT action_index FROM contracts WHERE code_hash = ? AND status_id = (SELECT id FROM index_statuses WHERE status='valid') LIMIT 1",
                [codeHash]);
            if (rows.length) { row = rows[0]; break; }
        }
        expect(row, 'contract reassembled on the new branch').to.not.equal(null);

        // The re-mined contract has a NEW action_index (different block/tx position) but the
        // SAME code_hash (deterministic reassembly) and byte-identical state.
        const newIndex = Number(row.action_index);
        expect(await idxCount('SELECT COUNT(*) n FROM deploy_chunks WHERE code_hash = ?', [codeHash]),
            'all chunk carriers re-indexed on the new branch').to.equal(plan.totalChunks);
        expect(await readState(sdk, newIndex, 'padlen'), 'reassembled source byte-exact after the reorg').to.equal(String(PAD.length));
        expect(await readState(sdk, newIndex, 'count'), 'constructor + increment replayed deterministically').to.equal(String(START + 1));
        console.log('    [chunk-reorg] reassembled deterministically — newIndex=' + newIndex + ' hash=' + codeHash.slice(0, 12) + ' (reorg safe)');
    });
});
