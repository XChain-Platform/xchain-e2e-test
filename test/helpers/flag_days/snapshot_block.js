'use strict';

// Copyright (c) 2025-2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

// Picks the snapshot block a DOGE flag-day federation pins. Its hubs read validators
// from the BTC indexer at that block, so it must be a committed BTC block, and one with
// no capability rows so the suite's seeded rows are the whole set (af1's rule).

// Pure: the highest block in [latest - 1024, latest - 12] not in `occupied`.
function pickUnusedBlock(latest, occupied){
    const floor = Math.max(0, latest - 1024);
    const ceiling = Math.max(0, latest - 12);
    for(let candidate = ceiling; candidate >= floor; candidate--){
        if(!occupied.has(candidate)) return candidate;
    }
    return null;
}

async function latestBtcBlock(url, apiKey){
    if(!url) throw new Error('snapshot_block: BTC_INDEXER_API_URL is not set, so there is no BTC tip to pin');
    const headers = { 'content-type': 'application/json' };
    if(apiKey) headers['x-api-key'] = apiKey;
    const response = await fetch(url, {
        method: 'POST', headers,
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getlatestblock', params: {} })
    });
    if(!response.ok) throw new Error('snapshot_block: the BTC indexer latest-block request answered HTTP ' + response.status);
    const body = await response.json();
    const block = Number(body.result && body.result.block_index);
    if(!Number.isSafeInteger(block) || block < 0) throw new Error('snapshot_block: the BTC indexer returned no committed block');
    return block;
}

// Reads the run's own indexer (where the suites seed capability rows); a positive
// integer override (a suite's env knob) wins.
async function unusedBtcSnapshotBlock({ indexerQuery, env = process.env, override } = {}){
    const pinned = Number(override);
    if(Number.isSafeInteger(pinned) && pinned > 0) return pinned;
    const latest = await latestBtcBlock(env.BTC_INDEXER_API_URL, env.BTC_INDEXER_API_KEY);
    const rows = await indexerQuery(
        'SELECT DISTINCT snapshot_block FROM capability_snapshots WHERE snapshot_block BETWEEN ? AND ?',
        [Math.max(0, latest - 1024), Math.max(0, latest - 12)]);
    const block = pickUnusedBlock(latest, new Set(rows.map((row) => Number(row.snapshot_block))));
    if(block === null) throw new Error('snapshot_block: no unused BTC snapshot block below ' + latest);
    return block;
}

// Pins every hub's signer set to the mesh keys: the chain set at a real BTC block
// seats the venue's stakers, none of them a generated mesh key (as af1 does).
function pinMeshSignerSet(mvh){
    const keys = new Set(mvh.getPubkeys().map((pubkey) => String(pubkey).toLowerCase()));
    for(const hub of mvh.hubs){
        hub.peerManager.setEffectiveSignerSet = () => {};
        hub.peerManager.effectiveSignerSet = new Set(keys);
    }
    return keys;
}

module.exports = { pickUnusedBlock, unusedBtcSnapshotBlock, pinMeshSignerSet };
