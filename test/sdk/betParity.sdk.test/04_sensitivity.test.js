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

const { expect } = require('chai');
const { releaseClock } = require('../betHelper');
const { state, bQuery, compareHashes } = require('./support/bet_parity_support');

async function cleanUpParityVenue() {
    if (state.mirrorTimer) { clearInterval(state.mirrorTimer); state.mirrorTimer = null; }
    try { await global.regtestMinerConnector.resumeMining(); } catch (e) { /* best effort */ }
    await releaseClock();
    if (state.nodeB && state.nodeB.pool) {
        try { await state.nodeB.pool.end(); } catch (e) { /* best effort */ }
    }
}

describe('[sdk] BET two-node state-hash parity (§12 E8: the fleet leg)', function () {
    after(async function () {
        await cleanUpParityVenue();
    });

    it('sensitivity: a one-node divergence at the latch block is actually caught', async function () {
        if (!state.following) this.skip();
        const { latchBlock } = state;
        // Everything above is a green comparison, and a comparison that cannot
        // fail is worth nothing. So corrupt node B's committed ledger hash at the
        // latch block INSIDE a transaction, re-run the very same comparison over
        // that connection's view, and require it to report the divergence - then
        // roll back and require it to come back clean. Node B's own database, its
        // own connection, never committed.
        const conn = await state.nodeB.getConnection();
        const tq = (sql, params) => conn.query(sql, params);
        try {
            await conn.beginTransaction();
            const before = await compareHashes(latchBlock, latchBlock, tq);
            expect(before, 'the latch block agrees before the corruption').to.deep.equal([]);

            await conn.query(
                'UPDATE index_transactions SET hash = ? WHERE id = ' +
                '(SELECT ledger_hash_id FROM blocks WHERE block_index = ?)',
                ['de' + 'ad'.repeat(31), latchBlock]);

            const during = await compareHashes(latchBlock, latchBlock, tq);
            expect(during.length, 'the corrupted latch block is reported as divergent').to.equal(1);
            expect(during[0].block, 'reported against the latch block').to.equal(latchBlock);
            expect(during[0].field, 'reported against the hash that moved').to.equal('ledger_hash');
        } finally {
            try { await conn.rollback(); } catch (e) { /* best effort */ }
            try { await conn.release(); } catch (e) { /* best effort */ }
        }

        const after = await compareHashes(latchBlock, latchBlock);
        expect(after, 'node B is untouched once the transaction is rolled back').to.deep.equal([]);
    });
});
