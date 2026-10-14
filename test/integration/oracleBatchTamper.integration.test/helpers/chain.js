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

const { waitFor } = require('../../../helpers/consensusWait');

// ---------------------------------------------------------------------------
// Live-chain reads
//
// HELPER GAP: `OracleBatchReplayNode` resolves the standing stack's indexer
// database for its own use but exposes no accessor for it (`this._live` is
// private, and `liveChainFeeCoordinates` returns only fee coordinates). The
// resolver below is the rig's own discovery path, repeated here so this file can
// read the live node's PRICE verdicts as supporting evidence. Only the database
// NAME is ever printed; the credentials go straight into the driver.
// ---------------------------------------------------------------------------

async function resolveLiveIndexerDb(coin, network) {
    const XChainHubConnector = require('../../../../src/XChainHubConnector.js');
    const hub = new XChainHubConnector(XChainHubConnector.parseEndpoints());
    if (!(await hub.ping())) return null;
    const cfg = await hub.getAllConfig();
    const svc = cfg && cfg[coin] && cfg[coin][network];
    const ixr = svc && svc['xchain-indexer'];
    if (!ixr || !ixr.name) return null;
    return {
        host: process.env.DATABASE_URL || '127.0.0.1',
        port: parseInt(process.env.DATABASE_PORT, 10) || 13306,
        name: ixr.name, user: ixr.user, pass: ixr.pass
    };
}

// Wait until the landing chain has MINED a transaction, so the next broadcast can
// never share its block. Sharing one would leave two of this drill's PRICE actions
// at one block_index, and the replay side attributes verdicts by block.
async function waitMined(venue, txid, timeoutMs) {
    const got = await waitFor(async () => {
        let block = null;
        try { block = await venue.blockOf(txid); } catch (internal) { block = null; }
        return { ok: !!(block && Number.isFinite(Number(block.height))), block: block };
    }, { timeoutMs: timeoutMs || 240_000, intervalMs: 1000 });
    if (!got.ok) throw new Error('AT4: transaction ' + txid + ' was never mined within ' + got.waitedMs + 'ms');
    return got.last.block;
}

function statusHistogram(rows) {
    const out = {};
    for (const r of rows) out[String(r.status)] = (out[String(r.status)] || 0) + 1;
    return out;
}

function describeHistogram(h) {
    return Object.keys(h).map((k) => h[k] + ' x "' + k + '"').join(', ') || 'nothing';
}

module.exports = { resolveLiveIndexerDb, waitMined, statusHistogram, describeHistogram };
