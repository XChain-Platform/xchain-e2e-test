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
const { drive, CONFIRM_WAIT_MS, PRICE_ROW_WAIT_MS } = require('./constants');

function plain(rows) {
    return JSON.parse(JSON.stringify(rows, (k, v) => (typeof v === 'bigint' ? Number(v) : v)));
}

function ident(name) {
    if (!/^[A-Za-z0-9_]+$/.test(String(name))) throw new Error('AT9: unusable database name');
    return String(name);
}

/**
 * The `prices` row a node wrote for a broadcast transaction, with the batch
 * columns AT9 needs.
 *
 * HELPER GAP, worked around here: `oracleBatchReplay.readPriceActions` selects
 * neither the four v2 batch columns nor the transaction hash, and filters only
 * by round or block. A wire rejected at decompression never records a round
 * number at all (`parseV0` sets `data['ROUND']` from an undefined
 * `firstRound`), so a round filter cannot find the rows this drill is about.
 * Keyed on the transaction hash through the same join `indexerWait.js` uses.
 */
async function readPriceRowByTx(conn, dbName, txid) {
    const db = ident(dbName);
    const rows = await conn.query(
        'SELECT p.action_index, p.version, p.round_number, p.batch_first_round, p.batch_last_round, ' +
        'p.round_count, p.rounds_json, p.sigs_json, p.validation_status, s.status, ' +
        'a.block_index, a.tx_index, a.tx_vout ' +
        'FROM `' + db + '`.prices p ' +
        'JOIN `' + db + '`.actions a ON a.action_index = p.action_index ' +
        'JOIN `' + db + '`.transactions tr ON tr.tx_index = a.tx_index ' +
        'JOIN `' + db + '`.index_transactions itx ON itx.id = tr.tx_hash_id ' +
        'LEFT JOIN `' + db + '`.index_statuses s ON s.id = p.status_id ' +
        'WHERE itx.hash = ?', [txid]);
    return plain(rows);
}

// The verdict a node recorded for one transaction, for an evidence line. Reads
// "(no row)" rather than throwing: the evidence block runs before any assertion
// and its job is to describe a failed run, not to become one.
function statusOf(rows, txid) {
    const row = rows[txid];
    return row ? String(row.status) : '(no row)';
}

async function waitForPriceRow(conn, dbName, txid, label) {
    const result = await waitFor(async () => {
        let rows = [];
        try { rows = await readPriceRowByTx(conn, dbName, txid); } catch (internal) { rows = []; }
        return { ok: rows.length > 0, rows: rows };
    }, { timeoutMs: PRICE_ROW_WAIT_MS, intervalMs: 2000 });
    if (!result.ok) {
        throw new Error('AT9: the ' + label + ' node never wrote a prices row for tx ' + txid +
            ' within ' + result.waitedMs + 'ms. The decoder did not resolve the wire as a PRICE ' +
            'action, or the block loop has not reached it.');
    }
    return result.last.rows[0];
}

async function waitForPushDelivery(node, label) {
    const drained = await node.waitForPushDrain();
    if (!drained.ok) {
        const queue = await node.hubPushQueue();
        throw new Error('AT9: the ' + label + ' node\'s hub push outbox did not drain; ' +
            'ghost-absence reads would be inconclusive. Queue: ' + JSON.stringify(queue));
    }
}

// One wire onto the chain the venue is pointed at, then block until a real
// block carries it. Serialized on purpose: the venue funds ONE publisher
// address, so two in-flight builds would select the same outputs, and a
// second build before the first confirms would spend unconfirmed change.
async function land(S, wire, label) {
    const sent = await drive.broadcastWire(S.venue, wire);
    const mined = await waitFor(async () => {
        let block = null;
        try { block = await S.venue.blockOf(sent.txid); } catch (internal) { block = null; }
        return { ok: block !== null && Number.isFinite(Number(block.height)), block: block };
    }, { timeoutMs: CONFIRM_WAIT_MS, intervalMs: 2000 });
    if (!mined.ok) {
        throw new Error('AT9: the ' + label + ' wire (tx ' + sent.txid + ', ' + sent.wireBytes +
            ' bytes) was broadcast but never reached a block within ' + mined.waitedMs +
            'ms on the ' + S.venue.rail.code + ' regtest chain.');
    }
    const height = Number(mined.last.block.height);
    if (S.targetHeight === null || height > S.targetHeight) S.targetHeight = height;
    return { label: label, wire: wire, wireBytes: sent.wireBytes, txid: sent.txid, height: height };
}

module.exports = {
    plain, ident, readPriceRowByTx, statusOf, waitForPriceRow, waitForPushDelivery, land,
};
