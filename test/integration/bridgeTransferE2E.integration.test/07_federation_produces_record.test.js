/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 ********************************************************************/

'use strict';

// Covers the multi-hub PBFT transfer round. One part of bridgeTransferE2E.integration.test.
//
// Everything in the other parts proves the two repositories agree about a record. This
// proves the federation PRODUCES that record: four hubs discover a confirmed leg through
// the real getpendingbridgetransfers client, independently re-validate it, and PBFT it to
// a persisted bridge_transfers row, which is then applied by the same indexer pass.
//
// Needs a hub MariaDB (provisioned HUB_DB_* or Docker). It brings its own quorum and its
// own validator registry, so it does NOT need the shared regtest chain rail.

const assert = require('assert');
const {
    SETTLE, BS, startDisposableHubDb, seedWeightSnapshot, MultiValidatorHub,
    BridgePendingSource, waitForMesh, waitFor,
    NETWORK, SNAPSHOT, BLOCK, DEST_ADDR, SRC_ADDR, XCHAIN_ROW
} = require('./lib/shared');

const COUNT        = 4;
const PEER_WAIT_MS = 60_000;
const ROUND_MS     = 20_000;
const FED_AMOUNT   = '7.00000000';
const FED_SRC_IDX  = 5150;

function pendingLock(){
    return BridgePendingSource.makeLeg({
        transfer_kind: 'lock', src_chain: 'BTC', src_action_index: FED_SRC_IDX,
        src_address: SRC_ADDR, dest_chain: 'DOGE', dest_address: DEST_ADDR,
        tick: 'XCHAIN', decimals: 8, amount: FED_AMOUNT,
        // Well below SNAPSHOT so the leg is past BTC's regtest depth however
        // the venue resolves confirmations.
        block_index: SNAPSHOT - 50
    });
}

async function startSource(){
    const source = new BridgePendingSource();
    await source.start();
    source.setPending('shared', {
        network: NETWORK,
        latestBlockIndex: SNAPSHOT,
        transfersByCoin: { BTC: [ pendingLock() ] }
    });
    return source;
}

async function startMesh(){
    const mvh = new MultiValidatorHub({
        count: COUNT, basePort: 26500,
        startCrossChain: true, startAttestation: false,
        // The bridge engine reads its anchor from the hub's BTC latest block, which
        // seedWeightSnapshot pins; the override is the no-BTC fallback and is set so the
        // engine never idles on a null anchor before the seed lands.
        extraP2pConfig: { XDEX_SNAPSHOT_BLOCK: String(SNAPSHOT) }
    });
    await mvh.start();
    await waitForMesh(mvh, { timeoutMs: PEER_WAIT_MS });
    return mvh;
}

function seedWeights(mvh){
    return seedWeightSnapshot(mvh, {
        blockIndex: SNAPSHOT, network: NETWORK,
        validators: mvh.identities.map((id, i) => ({
            pubkey: id.pubkeyHex, source: 's' + i, weight: '1000'
        }))
    });
}

// Past the hub's BRIDGE_PROOF_READY_SNAPSHOT flag day (regtest: genesis) a BTC leg is
// held until a BTC checkpoint at or above its block exists, and every follower demands
// the stamp equal its own first covering checkpoint. One identical row at SNAPSHOT on
// every hub keeps the stamp at SNAPSHOT, the block the round used before.
async function seedCheckpoints(mvh){
    for(const hub of mvh.hubs){
        await hub.db.doQuery(
            'INSERT INTO state_checkpoints (chain, network, block_index, block_hash, ledger_hash, ' +
            'actions_hash, contract_hash, checkpoint_seq, snapshot_block, validator_signatures) ' +
            'VALUES (?,?,?,?,?,?,?,?,?,?)',
            ['BTC', NETWORK, SNAPSHOT, 'cc'.repeat(32), 'dd'.repeat(32), 'ee'.repeat(32),
                'ff'.repeat(32), SNAPSHOT / 6, SNAPSHOT, '[]']);
    }
}

// Point every hub's BRIDGE engine at the pending source. The harness repoints the DEX
// engine's map only, and the bridge engine resolved its own (empty) map at construction.
function repointEngines(mvh, source){
    for(const hub of mvh.hubs){
        const eng = hub.crossChainBridge;
        if(!eng || !eng.indexers) continue;
        eng.indexers.BTC  = { url: source.urlFor('shared', 'BTC'),  key: '' };
        eng.indexers.DOGE = { url: source.urlFor('shared', 'DOGE'), key: '' };
    }
}

async function hubHoldsRow(hub){
    try {
        const r = await hub.db.doQuery(
            "SELECT transfer_id FROM bridge_transfers WHERE src_chain = 'BTC' AND src_action_index = ? AND status = 'finalized'",
            [FED_SRC_IDX]);
        return r.length >= 1;
    } catch(internal){ return false; /* a hub that cannot be read has not persisted it */ }
}

// Poll the PERSISTED row on every hub rather than a finalize event: the write is started
// by an un-awaited handler, so an event-count poll clears while the INSERT is still in
// flight (the trap multiHubCrossSettleE2E documents).
async function waitForRowOnEveryHub(mvh){
    return waitFor(async () => {
        let seen = 0;
        for(const hub of mvh.hubs){
            if(await hubHoldsRow(hub)) seen++;
        }
        return { ok: seen === mvh.hubs.length, seen: seen };
    }, { timeoutMs: ROUND_MS, intervalMs: 200 });
}

async function readTransferRow(mvh){
    const rows = await mvh.hubs[0].db.doQuery(
        'SELECT * FROM bridge_transfers WHERE src_chain = ? AND src_action_index = ? LIMIT 1',
        ['BTC', FED_SRC_IDX]);
    return rows[0];
}

function federatedValidators(row){
    return JSON.parse(row.validator_signatures).map((s, i) => ({
        pubkey: s.pubkey, source: 'f' + i, weight: '1000'
    }));
}

function settleContextFor(row, extra){
    return SETTLE.makeSettleContext(Object.assign({
        coin: 'DOGE', validators: federatedValidators(row), tokens: XCHAIN_ROW,
        blockIndex: BLOCK, blockTime: Number(row.effective_time),
        proof: SETTLE.buildEscrowProof({
            destChain: 'DOGE', tick: 'XCHAIN', balance: '50',
            height: Number(row.snapshot_block)
        })
    }, extra || {}));
}

function flipLastHexDigit(sig){
    const s = String(sig);
    return s.slice(0, -1) + (s.slice(-1) === '0' ? '1' : '0');
}

function tamperBundle(row){
    const tampered = Object.assign({}, row);
    tampered.validator_signatures = JSON.stringify(
        JSON.parse(row.validator_signatures).map(s => ({ pubkey: s.pubkey, sig: flipLastHexDigit(s.sig) })));
    return tampered;
}

describe('XBRIDGE transfer: the federation produces the record (multi-hub PBFT)', function(){
    this.timeout(240_000);

    let db, mvh, seed, source, transferRow;

    before(async function(){
        db = await startDisposableHubDb();
        if(!db){
            console.log('Skipping the federated XBRIDGE round: no env hub DB and Docker unavailable');
            this.skip();
        }
        source = await startSource();
        mvh = await startMesh();
        seed = seedWeights(mvh);
        await seedCheckpoints(mvh);
        repointEngines(mvh, source);
        await Promise.all(mvh.hubs.map(h => h.crossChainBridge.poll().catch(() => {})));
        const held = await waitForRowOnEveryHub(mvh);
        if(held.ok) transferRow = await readTransferRow(mvh);
    });

    after(async function(){
        if(seed)   seed.restore();
        if(source) await source.stop();
        if(mvh)    { await mvh.stop(); await mvh.dropDatabases(); }
        if(db)     await db.stop();
    });

    it('finalizes a bridge_transfers row carrying a 2f+1 signature bundle', function(){
        assert.ok(transferRow, 'the federation finalized no bridge_transfers row');
        assert.strictEqual(transferRow.status, 'finalized');
        assert.strictEqual(String(transferRow.tick), 'XCHAIN');
        assert.strictEqual(String(transferRow.dest_address), DEST_ADDR);
        assert.strictEqual(String(transferRow.src_chain), 'BTC');
        assert.strictEqual(Number(transferRow.src_action_index), FED_SRC_IDX);
        const sigs = JSON.parse(transferRow.validator_signatures || '[]');
        assert.ok(sigs.length >= 3, 'expected >= 3 federated signatures, got ' + sigs.length);
    });

    it('the federated row passes the indexer settle pass and mints the exact credit', async function(){
        assert.ok(transferRow, 'no finalized row from before()');
        // The row's own effective_time carries the hub's relay margin, so the applying
        // block's protocol time is taken from it rather than from a constant that would
        // make the row perpetually not-yet-due.
        const { ctx, state } = settleContextFor(transferRow);

        const res = await BS.applyBridgeTransfer(transferRow, ctx);

        assert.strictEqual(res.applied, true,
            'the indexer refused a genuinely federated record (canonical or quorum drift?): ' + res.reason);
        assert.deepStrictEqual(state.credits, [['XCHAIN', FED_AMOUNT, DEST_ADDR]]);
        assert.strictEqual(state.settlements[0].transfer_id, transferRow.transfer_id);
    });

    it('a tampered federated bundle applies nothing', async function(){
        assert.ok(transferRow, 'no finalized row from before()');
        const { ctx, state } = settleContextFor(transferRow);

        const res = await BS.applyBridgeTransfer(tamperBundle(transferRow), ctx);

        assert.strictEqual(res.applied, false, 'a tampered federated bundle was applied');
        assert.deepStrictEqual(state.credits, []);
    });
});
