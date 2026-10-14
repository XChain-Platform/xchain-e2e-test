/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 *********************************************************************/

'use strict';

const { sleep, S, indexerQuery } = require('./state');

// Poll until the XANC_BUNDLE_DONE back-fill has landed: every named hub's copy
// of EVERY section row carries anchor_txid. Waiting on the back-fill itself
// rather than a fixed settle costs time on a slow gossip round instead of a
// false failure.
async function waitForAnchorBackfill(rows, hubs, timeMax = 30000){
    const deadline = Date.now() + timeMax;
    while (Date.now() < deadline) {
        let missing = false;
        for (const row of rows) {
            for (const hub of hubs) {
                const r = await hub.db.doQuery(
                    'SELECT anchor_txid FROM state_checkpoints WHERE chain = ? AND network = ? AND block_index = ?',
                    [row.chain, row.network, row.block_index]);
                if (!(r.length === 1 && r[0].anchor_txid)) { missing = true; break; }
            }
            if (missing) break;
        }
        if (!missing) return true;
        await sleep(500);
    }
    return false;
}

// Poll until the DOGE indexer has parsed and STORED every section of a bundle,
// which is what findExistingBundle's per-section getanchoraction reads. AT5's
// adopt leg is only meaningful once this is true, and a fixed sleep here is the
// difference between proving adoption and proving a race.
async function waitForBundleIndexed(rows, timeMax = 120000){
    const deadline = Date.now() + timeMax;
    while (Date.now() < deadline) {
        let found = 0;
        for (const row of rows) {
            const r = await indexerQuery(
                'SELECT action_index FROM anchor_actions WHERE version = 0 AND chain = ? AND network = ? ' +
                'AND block_index = ? AND checkpoint_seq = ?',
                [row.chain, row.network, row.block_index, row.checkpoint_seq]);
            if (r.length) found++;
        }
        if (found === rows.length) return true;
        await regtestMinerConnector.generateBlocks(1);
        await sleep(2000);
    }
    return false;
}

// Poll until XANC_FINALIZED has back-filled the archive batch metadata on every
// named hub, the observable end of a SIGN round plus publish plus finalize.
async function waitForArchiveFinalized(matchId, hubs, timeMax = 60000){
    const deadline = Date.now() + timeMax;
    while (Date.now() < deadline) {
        let missing = false;
        for (const hub of hubs) {
            const r = await hub.db.doQuery(
                'SELECT batch_seq, archived_status FROM cross_chain_matches WHERE match_id = ?', [matchId]);
            if (!(r.length === 1 && r[0].batch_seq != null
                  && String(r[0].archived_status) === 'finalized')) { missing = true; break; }
        }
        if (!missing) return true;
        await sleep(500);
    }
    return false;
}

// The election clock is the indexer's committed tip; after mining, wait
// for the decoder/indexer to catch up so failover-window math is exact.
async function waitForTip(minBlock){
    for (let i = 0; i < 60; i++) {
        const b = await S.mvh.hubs[0].resolveBtcLatestBlock();
        if (Number.isFinite(b) && b >= minBlock) return b;
        await sleep(1000);
    }
    throw new Error('indexer tip never reached ' + minBlock);
}

module.exports = { waitForAnchorBackfill, waitForBundleIndexed, waitForArchiveFinalized, waitForTip };
