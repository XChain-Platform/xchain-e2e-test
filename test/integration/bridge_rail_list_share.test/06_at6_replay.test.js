/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 *********************************************************************/

'use strict';

const {
    assert,
    state,
    needsFederation,
    bridgeRailSuite,
} = require('./support');

const HASH_SQL = 'SELECT b.block_index AS block_index, t1.hash AS ledger, t2.hash AS actions, ' +
    't3.hash AS contract, t4.hash AS state FROM blocks b ' +
    'LEFT JOIN index_transactions t1 ON (t1.id = b.ledger_hash_id) ' +
    'LEFT JOIN index_transactions t2 ON (t2.id = b.actions_hash_id) ' +
    'LEFT JOIN index_transactions t3 ON (t3.id = b.contract_hash_id) ' +
    'LEFT JOIN index_transactions t4 ON (t4.id = b.state_hash_id) ' +
    'WHERE b.block_index >= ? ORDER BY b.block_index ASC';

function hashRows(rows) {
    return rows.map((row) => [Number(row.block_index), String(row.ledger), String(row.actions),
        String(row.contract), String(row.state)].join(':'));
}

async function assertReplayMatches(chain) {
    const M = state.listShare.home;
    const first = Number(M.seq1['admit_block_' + chain.toLowerCase()]);
    assert.ok(first > 0, chain + ' has no signed effective height for seq 1');
    const tipBefore = Number((await state.venue.venueTips())[chain]);
    const handle = await state.venue.replayIndexer(chain);
    try {
        const live = hashRows(await state.venue.queryIndexerDb(chain, HASH_SQL, [first]));
        const replayed = hashRows(await handle.queryDb(HASH_SQL, [first]));
        assert.ok(replayed.length > 0, 'the ' + chain + ' replay holds no block from ' + first);
        const last = Number(replayed[replayed.length - 1].split(':')[0]);
        assert.ok(last >= tipBefore, 'the ' + chain + ' replay stopped at ' + last + ', below the tip ' + tipBefore);
        const compared = Math.min(live.length, replayed.length);
        assert.ok(compared >= tipBefore - first + 1,
            'only ' + compared + ' blocks compare from ' + first + ' to ' + tipBefore);
        for (let i = 0; i < compared; i++) {
            assert.strictEqual(replayed[i], live[i], chain + ' replay differs from the live indexer at row ' + i);
        }
        const mirrors = await handle.queryDb('SELECT COUNT(*) AS n FROM list_share_mirrors', []);
        assert.ok(Number(mirrors[0].n) >= 1, 'the ' + chain + ' replay rebuilt no shared-list mirror');
        return { chain, from: first, to: tipBefore, blocks: compared };
    } finally {
        await handle.stop();
    }
}

bridgeRailSuite('list_share AT6: a replay reproduces the venue ledgers', function () {
    it('list_share AT6: a BTC replay matches every block hash from the first effective height to the tip', async function () {
        this.timeout(0);
        if (needsFederation(this, 'list_share AT6 BTC replay')) return;
        assert.ok(state.listShare.home.seq2, 'AT3 must have applied a second version');
        state.evidence.at6_btc = await assertReplayMatches('BTC');
    });

    it('list_share AT6: an LTC replay matches every block hash from the first effective height to the tip', async function () {
        this.timeout(0);
        if (needsFederation(this, 'list_share AT6 LTC replay')) return;
        assert.ok(state.listShare.home.seq2, 'AT3 must have applied a second version');
        state.evidence.at6_ltc = await assertReplayMatches('LTC');
    });
});
