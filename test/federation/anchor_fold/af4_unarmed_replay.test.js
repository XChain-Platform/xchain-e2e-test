'use strict';

// Copyright (c) 2025-2026 Dankest, LLC
//
// SPDX-License-Identifier: AGPL-3.0-or-later

const assert = require('assert');

const { startDisposableHubDb } = require('../../helpers/disposableHubDb');
const { OracleBatchReplayNode } = require('../../helpers/oracleBatchReplay');
const { anchorRowsDigest } = require('../../helpers/anchor_fold/anchor_fold_readings');
const { normalizeAnchorRowsForDigest } = require('../../helpers/anchor_fold/normalize_digest_rows');

function assertReplayIdentical(firstDigest, replayDigest) {
    assert.strictEqual(replayDigest, firstDigest, 'unarmed replay reproduced byte-identical anchor_actions rows');
}

async function startReplayNode(label, hubDb, basePort) {
    const node = new OracleBatchReplayNode({
        label: label,
        coin: 'dogecoin',
        network: 'regtest',
        hubDb: hubDb,
        basePort: basePort
    });
    try {
        if (await node.up()) return { node: node, reason: null };
        return { node: node, reason: node.unavailable };
    } catch (err) {
        return { node: node, reason: label + ' node failed to build: ' + (err && err.message) };
    }
}

async function readAnchorRows(node, targetHeight) {
    const database = '`' + node.indexerDbName + '`';
    return node._conn.query(
        'SELECT * FROM ' + database + '.anchor_actions ' +
        'WHERE block_index_doge <= ? ORDER BY action_index, section_index',
        [targetHeight]
    );
}

function assertChainCoverage(rows) {
    assert.ok(rows.some((row) => Number(row.version) === 0),
        'unmodified regtest chain carries v0 bundle rows');
    assert.ok(rows.some((row) => Number(row.version) === 1 || Number(row.version) === 2),
        'unmodified regtest chain carries v1 or v2 archive batch rows');
}

function digestRows(rows) {
    return anchorRowsDigest(normalizeAnchorRowsForDigest(rows));
}

async function runReplayComparison() {
    const hubDb = await startDisposableHubDb();
    if (!hubDb) return { reason: 'no env hub DB and Docker unavailable' };

    let firstNode = null;
    let replayNode = null;
    try {
        const first = await startReplayNode('anchorfirst', hubDb, 61200);
        firstNode = first.node;
        if (first.reason) return { reason: first.reason };

        const targetHeight = (await firstNode.decoderHeight()).height;
        await firstNode.waitForHeight(targetHeight);
        const firstRows = await readAnchorRows(firstNode, targetHeight);
        assertChainCoverage(firstRows);
        const firstDigest = digestRows(firstRows);

        await firstNode.down();
        firstNode = null;
        const replay = await startReplayNode('anchorreplay', hubDb, 61300);
        replayNode = replay.node;
        if (replay.reason) return { reason: replay.reason };

        await replayNode.waitForHeight(targetHeight);
        const replayRows = await readAnchorRows(replayNode, targetHeight);
        const replayDigest = digestRows(replayRows);
        assertReplayIdentical(firstDigest, replayDigest);
        return { targetHeight: targetHeight, rows: firstRows.length, digest: firstDigest };
    } finally {
        if (replayNode) await replayNode.down();
        if (firstNode) await firstNode.down();
        await hubDb.stop();
    }
}

describe('ANCHOR fold unarmed replay', function () {
    this.timeout(0);

    it('replays v0 bundles and archive batches to byte-identical anchor_actions rows', async function () {
        assert.strictEqual(process.env.XC_ANCHOR_FOLD_REGTEST_ACTIVATION, undefined,
            'the fold activation override remains unset');
        const result = await runReplayComparison();
        if (result.reason) {
            console.log('Skipping ANCHOR fold unarmed replay: ' + result.reason);
            this.skip();
        }
        console.log('    replayed ' + result.rows + ' anchor_actions rows through block ' +
            result.targetHeight + ' with digest ' + result.digest);
    });
});
