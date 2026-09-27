/*********************************************************************
 *
 * Copyright (c) 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 ********************************************************************/

'use strict';

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const {
    makeAnchorParseContext,
    anchorParseArgs
} = require('../../helpers/anchor_fold/anchor_parse_stub');
const { expectedFoldRows } = require('../../helpers/anchor_fold/expected_fold_rows');

const ROOT = path.resolve(__dirname, '../../../..');
const INDEXER_ANCHOR = path.join(ROOT, 'xchain-indexer/src/actions/anchor/index.js');
const VECTOR_PATH = path.join(
    ROOT, 'xchain-documentation/protocol/test-vectors/anchor_canonical.json');
const ACTIVATION_ENV = 'XC_ANCHOR_FOLD_REGTEST_ACTIVATION';

function restoreEnvironment(hadActivation, activation){
    if(hadActivation) process.env[ACTIVATION_ENV] = activation;
    else delete process.env[ACTIVATION_ENV];
}

function restoreRequireCache(before){
    for(const key of Object.keys(require.cache)){
        if(!before.has(key)) delete require.cache[key];
    }
    for(const [key, value] of before) require.cache[key] = value;
}

async function withActivatedAnchor(run){
    const hadActivation = Object.prototype.hasOwnProperty.call(process.env, ACTIVATION_ENV);
    const activation = process.env[ACTIVATION_ENV];
    const before = new Map(Object.entries(require.cache));
    process.env[ACTIVATION_ENV] = '0';
    try {
        delete require.cache[require.resolve(INDEXER_ANCHOR)];
        return await run(require(INDEXER_ANCHOR));
    } finally {
        restoreEnvironment(hadActivation, activation);
        restoreRequireCache(before);
    }
}

function fixtureSections(bundle){
    const sections = Array.isArray(bundle.sections)
        ? bundle.sections : require(VECTOR_PATH).fixture.bundle_v3.sections;
    return sections.slice().sort((a, b) => a.chain.localeCompare(b.chain));
}

function expectedRows(bundle){
    return expectedFoldRows(Object.assign({}, bundle, { sections: fixtureSections(bundle) }));
}

async function parseVector(vectorName, fixtureName){
    const golden = require(VECTOR_PATH);
    const { action, rows } = makeAnchorParseContext({ coin: 'DOGE', network: 'regtest' });
    const args = anchorParseArgs(golden.vectors[vectorName], {
        blockIndex: 1000000000,
        txHash: 'anchor-v3-' + vectorName,
        source: 'anchor-v3-publisher'
    });
    await withActivatedAnchor(async Anchor => {
        await new Anchor(action).parse(args.params, args.data, args.error);
    });
    return { bundle: golden.fixture[fixtureName], rows };
}

function actualRows(rows, sectionCount){
    const chainRows = rows.slice(0, sectionCount).map(row => ({
        section_index: row.SECTION_INDEX,
        chain: row.CHAIN,
        checkpoint_seq: Number(row.CHECKPOINT_SEQ)
    }));
    if(rows.length === sectionCount) return { chainRows, archiveRow: null };
    const archive = rows[sectionCount];
    return { chainRows, archiveRow: {
        section_index: archive.SECTION_INDEX,
        match_batch_seq: Number(archive.MATCH_BATCH_SEQ),
        match_count: Number(archive.MATCH_COUNT),
        batch_crc32: archive.BATCH_CRC32,
        total_chunks: Number(archive.TOTAL_CHUNKS)
    } };
}

describe('ANCHOR v3 indexer parse parity', function () {
    before(function () {
        if(fs.existsSync(INDEXER_ANCHOR)) return;
        console.log('skipped: sibling indexer is absent');
        this.skip();
    });

    it('records the frozen archive-bearing vector in wire order', async function () {
        const { bundle, rows } = await parseVector('v3', 'bundle_v3');
        const expected = expectedRows(bundle);
        assert.strictEqual(rows.length, expected.chainRows.length + 1, 'one archive row');
        assert.deepStrictEqual(actualRows(rows, expected.chainRows.length), expected);
        assert.deepStrictEqual(rows.map(row => row.STATUS),
            rows.map(() => 'unverified'), 'unverified rows');
    });

    it('records no archive row for the frozen archive-free vector', async function () {
        const { bundle, rows } = await parseVector('v3_no_archive', 'bundle_v3_no_archive');
        const expected = expectedRows(bundle);
        assert.strictEqual(rows.length, expected.chainRows.length, 'no archive row');
        assert.deepStrictEqual(actualRows(rows, expected.chainRows.length), expected);
        assert.ok(rows.every(row => row.STATUS === 'unverified'), 'unverified chain rows');
    });
});
