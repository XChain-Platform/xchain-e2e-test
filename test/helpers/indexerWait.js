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
 * Deterministic wait for "the indexer has DECIDED this transaction".
 *
 * A test that asserts a rejection ("no token was created", "the recipient was
 * not credited", "the row count did not change") has no positive row to wait
 * for, so these tests historically slept a fixed interval and hoped the indexer
 * had got there. That passes or fails on how busy the stack is.
 *
 * The decision itself IS observable, though, one level up from the per-action
 * tables: the indexer writes an `actions` row for every action it parses,
 * VALID OR INVALID (test/actions/negative.test.js waits on exactly those
 * invalid rows through db.js waitForSend/waitForIssue). So the presence of an
 * actions row for the broadcast txid means the block has been parsed and the
 * accept/reject verdict is written; only then does "nothing happened" say
 * anything at all.
 *
 * This is the wait the fixed settles were approximating, and it fails loudly
 * (rather than passing vacuously) when the indexer never records the tx.
 ********************************************************************/

'use strict';

const DEFAULT_TIMEOUT_MS  = 60000;
const DEFAULT_INTERVAL_MS = 500;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Read the indexer's own actions rows for a broadcast txid. Joins are the same
// ones src/db.js uses to resolve an action back to its transaction hash.
async function actionRowsForTx(txHash, db) {
    const database = db || global.indexerDatabase;
    if (!database) throw new Error('waitForTxIndexed: no indexerDatabase (pass opts.db)');
    const connection = await database.getConnection();
    try {
        return await connection.query(
            'SELECT act.action_index FROM actions act ' +
            'JOIN transactions tr ON act.tx_index = tr.tx_index ' +
            'JOIN index_transactions itx ON itx.id = tr.tx_hash_id ' +
            'WHERE itx.hash = ?', [txHash]);
    } finally {
        await connection.release();
    }
}

/**
 * Block until the indexer has written at least `minActions` actions rows for
 * `txHash`. Throws on the deadline: a settle that silently expired is how a
 * rejection assertion becomes vacuous, so this one has to be loud.
 *
 * @param txHash  the broadcast transaction hash
 * @param opts    {timeoutMs, intervalMs, minActions, db}
 * @returns the actions rows
 */
async function waitForTxIndexed(txHash, opts) {
    opts = opts || {};
    const timeoutMs  = opts.timeoutMs  === undefined ? DEFAULT_TIMEOUT_MS  : opts.timeoutMs;
    const intervalMs = opts.intervalMs === undefined ? DEFAULT_INTERVAL_MS : opts.intervalMs;
    const minActions = opts.minActions === undefined ? 1 : opts.minActions;
    const deadline = Date.now() + timeoutMs;
    let rows = [];
    let lastErr = null;

    for (;;) {
        try { rows = await actionRowsForTx(txHash, opts.db); lastErr = null; }
        // A read that cannot answer is not an answer: keep polling and carry the
        // error into the give-up message so a wedged pool is not read as "absent".
        catch (err) { rows = []; lastErr = err; }
        if (rows.length >= minActions) return rows;
        if (Date.now() >= deadline) {
            throw new Error('indexer never recorded ' + minActions + ' action row(s) for tx ' + txHash +
                ' within ' + timeoutMs + 'ms (saw ' + rows.length + ')' +
                (lastErr ? '; last read failed: ' + lastErr.message : ''));
        }
        await sleep(intervalMs);
    }
}

module.exports = { actionRowsForTx, waitForTxIndexed };
