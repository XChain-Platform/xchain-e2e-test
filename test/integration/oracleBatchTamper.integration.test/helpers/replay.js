'use strict';

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
 ********************************************************************/

const { OracleBatchReplayNode, readPriceActions, connectTo } = require('../../../helpers/oracleBatchReplay');
const { waitFor } = require('../../../helpers/consensusWait');
const { PRICE_GRACE_S } = require('./constants');
const { resolveLiveIndexerDb } = require('./chain');
const { bail } = require('./federation');
const s = require('./state');

// A node built from nothing reads the same chain. Returns false (after bailing)
// when it cannot be built.
async function startReplayNode() {
    s.replayNode = new OracleBatchReplayNode({
        label: 'tamper', hubDb: s.hubDb, basePort: 61200, priceGraceS: PRICE_GRACE_S });
    let up = false;
    try { up = await s.replayNode.up(); }
    catch (err) { await bail('replay node failed to build: ' + (err && err.message)); return false; }
    if (!up) { await bail(s.replayNode.unavailable); return false; }
    return true;
}

async function replayChain() {
    console.log('  AT4: replay node built; replaying the chain to block ' + s.targetHeight + '...');
    await s.replayNode.waitForHeight(s.targetHeight);
    // The verdict is written inside the block transaction, but the hub push that
    // follows it is asynchronous. What the reads below need is one PRICE action
    // per landed block, which is a query, so poll for exactly that rather than
    // settling blind. Same 15s budget. Timing out is not fatal here: the three
    // drill assertions already fail loudly on a missing verdict ('the replaying
    // node recorded NO PRICE action at block N'), naming the block.
    await waitFor(async () => {
        const rows    = await s.replayNode.priceActions({ minBlock: s.minBlock });
        const heights = Object.keys(s.landed).map((n) => s.landed[n].height);
        const judged  = heights.filter((h) => rows.some((r) => Number(r.block_index) === h));
        return { ok: judged.length === heights.length, seen: judged.length + '/' + heights.length };
    }, { timeoutMs: 15_000, intervalMs: 1000 });

    s.replayPriceRows = await s.replayNode.priceActions({ minBlock: s.minBlock });
    for (const name of Object.keys(s.landed)) {
        const at = s.replayPriceRows.filter((r) => Number(r.block_index) === s.landed[name].height);
        s.replayStatus[name] = (at.length === 1) ? String(at[0].status)
            : (at.length === 0 ? null : 'AMBIGUOUS(' + at.length + ' PRICE actions in block ' +
                s.landed[name].height + ')');
    }
}

// Supporting evidence, not the claim: the live node's own PRICE rows over the
// same block range, read straight out of its database.
async function readLivePriceRows() {
    try {
        s.liveDb = await resolveLiveIndexerDb('dogecoin', 'regtest');
        if (s.liveDb) {
            s.liveConn      = await connectTo(s.liveDb);
            s.livePriceRows = await readPriceActions(s.liveConn, s.liveDb.name, { minBlock: s.minBlock });
        } else {
            s.liveDbError = 'the stack hub carries no indexer database for dogecoin/regtest';
        }
    } catch (e) { s.liveDbError = (e && e.message) || String(e); }
}

function diffPriceRows() {
    if (s.livePriceRows.length === 0) return;
    const key = (r) => r.block_index + ':' + r.tx_index + ':' + r.tx_vout;
    const liveInRange = s.livePriceRows.filter((r) => Number(r.block_index) <= s.targetHeight);
    const replayByKey = new Map(s.replayPriceRows
        .filter((r) => Number(r.block_index) <= s.targetHeight).map((r) => [key(r), r]));
    s.priceRowDiff = { compared: 0, agreed: 0, disagreed: [], missing: [] };
    for (const l of liveInRange) {
        s.priceRowDiff.compared++;
        const r = replayByKey.get(key(l));
        if (!r) { s.priceRowDiff.missing.push(key(l)); continue; }
        if (String(r.status) === String(l.status)) s.priceRowDiff.agreed++;
        else s.priceRowDiff.disagreed.push({ at: key(l), live: String(l.status), replay: String(r.status) });
    }
}

module.exports = { startReplayNode, replayChain, readLivePriceRows, diffPriceRows };
