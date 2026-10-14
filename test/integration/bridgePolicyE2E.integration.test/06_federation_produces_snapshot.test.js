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

// Covers the multi-hub PBFT policy round. One part of bridgePolicyE2E.integration.test.
//
// The engine only snapshots a policy for a (origin_chain, tick) pair it has SEEN, so a
// pending FUFU lock leg is served first; the transfer round teaches the engine that BTC
// is FUFU's origin, and the policy poll then reads the origin policy back through the
// real gettokenpolicy client and PBFTs a snapshot over it.
//
// Needs a hub MariaDB (provisioned HUB_DB_* or Docker); it brings its own quorum and
// needs no shared regtest chain rail.

const assert = require('assert');
const {
    SETTLE, BS, startDisposableHubDb, seedWeightSnapshot, MultiValidatorHub,
    BridgePendingSource, waitForMesh, waitFor,
    NETWORK, SNAPSHOT, BLOCK, TICK, MEMBER_A, copyRow, legs
} = require('./lib/shared');

const COUNT        = 4;
const PEER_WAIT_MS = 60_000;
const ROUND_MS     = 25_000;
const FED_SRC_IDX  = 6160;

// The origin indexer's own hash over its own membership. The engine recomputes it and
// declines to sign when the two disagree, so serving it correctly is what lets the round
// run at all.
function originPolicy(){
    return {
        allow_list:  null,
        block_list:  [MEMBER_A],
        sleeping:    false,
        policy_hash: BS.policyHash(null, [MEMBER_A], false),
        bridged:     true
    };
}

function pendingLock(){
    return BridgePendingSource.makeLeg({
        transfer_kind: 'lock', src_chain: 'BTC', src_action_index: FED_SRC_IDX,
        src_address: 'mSourceAddressXXXXXXXXXXXXXXXXXXXX',
        dest_chain: 'DOGE', dest_address: 'nDestinationAddressXXXXXXXXXXXXXXX',
        tick: TICK, decimals: 4, amount: '5.0000',
        block_index: SNAPSHOT - 50
    });
}

async function startSource(){
    const source = new BridgePendingSource();
    await source.start();
    source.setPending('shared', {
        network: NETWORK,
        latestBlockIndex: SNAPSHOT,
        transfersByCoin: { BTC: [ pendingLock() ] },
        policiesByCoin: { BTC: { FUFU: originPolicy() } }
    });
    return source;
}

async function startMesh(source){
    const mvh = new MultiValidatorHub({
        count: COUNT, basePort: 26700,
        // The pending source IS this mesh's indexer: named explicitly so a rail host's
        // INDEXER_URL cannot hand the hubs the standing indexer's capability set.
        venue: 'bridgePendingSource', btcIndexerApiUrl: source.urlFor('shared', 'BTC'),
        startCrossChain: true, startAttestation: false,
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

function repointEngines(mvh, source){
    for(const hub of mvh.hubs){
        const eng = hub.crossChainBridge;
        if(!eng || !eng.indexers) continue;
        eng.indexers.BTC  = { url: source.urlFor('shared', 'BTC'),  key: '' };
        eng.indexers.DOGE = { url: source.urlFor('shared', 'DOGE'), key: '' };
    }
}

async function hubHoldsSnapshot(hub){
    try {
        const r = await hub.db.doQuery(
            "SELECT snapshot_id FROM policy_snapshots WHERE origin_chain = 'BTC' AND tick = ? AND status = 'finalized'",
            [TICK]);
        return r.length >= 1;
    } catch(internal){ return false; /* a hub that cannot be read has not persisted it */ }
}

async function waitForSnapshotOnEveryHub(mvh){
    return waitFor(async () => {
        let seen = 0;
        for(const hub of mvh.hubs){
            if(await hubHoldsSnapshot(hub)) seen++;
        }
        return { ok: seen === mvh.hubs.length, seen: seen };
    }, { timeoutMs: ROUND_MS, intervalMs: 200 });
}

async function readFirstSnapshot(mvh){
    const rows = await mvh.hubs[0].db.doQuery(
        'SELECT * FROM policy_snapshots WHERE origin_chain = ? AND tick = ? ORDER BY policy_seq ASC LIMIT 1',
        ['BTC', TICK]);
    return rows[0];
}

describe('XPOLICY: the federation produces the snapshot (multi-hub PBFT)', function(){
    this.timeout(240_000);

    let db, mvh, seed, source, policyRow;

    before(async function(){
        db = await startDisposableHubDb();
        if(!db){
            console.log('Skipping the federated XPOLICY round: no env hub DB and Docker unavailable');
            this.skip();
        }
        source = await startSource();
        mvh = await startMesh(source);
        seed = seedWeights(mvh);
        repointEngines(mvh, source);
        await Promise.all(mvh.hubs.map(h => h.crossChainBridge.poll().catch(() => {})));
        const held = await waitForSnapshotOnEveryHub(mvh);
        if(held.ok) policyRow = await readFirstSnapshot(mvh);
    });

    after(async function(){
        if(seed)   seed.restore();
        if(source) await source.stop();
        if(mvh)    { await mvh.stop(); await mvh.dropDatabases(); }
        if(db)     await db.stop();
    });

    it('finalizes a policy_snapshots row at seq 1 with a 2f+1 signature bundle', function(){
        assert.ok(policyRow, 'the federation finalized no policy_snapshots row');
        assert.strictEqual(policyRow.status, 'finalized');
        assert.strictEqual(Number(policyRow.policy_seq), 1);
        assert.strictEqual(String(policyRow.tick), TICK);
        assert.strictEqual(String(policyRow.origin_chain), 'BTC');
        assert.strictEqual(String(policyRow.policy_hash).toLowerCase(),
            BS.policyHash(null, [MEMBER_A], false),
            'the federated hash is not the hash of the membership the origin served');
        const sigs = JSON.parse(policyRow.validator_signatures || '[]');
        assert.ok(sigs.length >= 3, 'expected >= 3 federated signatures, got ' + sigs.length);
    });

    it('the federated snapshot passes the indexer settle pass and materializes the list', async function(){
        assert.ok(policyRow, 'no finalized snapshot from before()');
        const pubkeys = JSON.parse(policyRow.validator_signatures).map((s, i) => ({
            pubkey: s.pubkey, source: 'f' + i, weight: '1000'
        }));
        const { ctx, state } = SETTLE.makeSettleContext({
            coin: 'DOGE', validators: pubkeys, tokens: copyRow(),
            blockIndex: BLOCK, blockTime: Number(policyRow.effective_time)
        });

        const res = await BS.applyPolicySnapshot(policyRow, ctx);

        assert.strictEqual(res.applied, true,
            'the indexer refused a genuinely federated snapshot (hash or canonical drift?): ' + res.reason);
        const fields = legs(state).map(l => l.fields);
        assert.deepStrictEqual(fields[0], ['LIST', '0', '2', '', MEMBER_A],
            'the materialized list is not the membership the origin served');
        assert.strictEqual(state.settlements[0].transfer_id, policyRow.snapshot_id);
    });
});
