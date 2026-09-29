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
    if(Array.isArray(bundle.sections)) return bundle.sections;
    return require(VECTOR_PATH).fixture.bundle_v3.sections;
}

function fixtureSectionsInWireOrder(bundle, wire){
    const sections = fixtureSections(bundle);
    const byPrefix = new Map(sections.map(section => [
        section.chain + '|' + section.block_index, section
    ]));
    const fields = String(wire).split('|');
    const ordered = [];
    for(let index = 0; index < fields.length - 1; index++){
        const section = byPrefix.get(fields[index] + '|' + fields[index + 1]);
        if(section) ordered.push(section);
    }
    assert.strictEqual(ordered.length, sections.length, 'fixture sections in wire');
    return ordered;
}

function expectedRows(bundle, wire){
    const sections = fixtureSectionsInWireOrder(bundle, wire);
    const chainRows = sections.map((section, sectionIndex) => ({
        section_index: sectionIndex,
        chain: section.chain,
        checkpoint_seq: section.checkpoint_seq
    }));
    const archiveRow = bundle.archive_count === 0 ? null : {
        section_index: chainRows.length,
        match_batch_seq: bundle.match_batch_seq,
        match_count: bundle.match_count,
        batch_crc32: bundle.batch_crc32,
        total_chunks: bundle.total_chunks
    };
    return { chainRows, archiveRow };
}

async function parseVector(vectorName, fixtureName){
    const golden = require(VECTOR_PATH);
    const bundle = golden.fixture[fixtureName];
    const wire = golden.vectors[vectorName];
    const { action, rows } = makeAnchorParseContext({ coin: 'DOGE', network: 'regtest' });
    action.indexerDb.getArchiveHeadsByAuthorAndSeq = async () => [];
    const args = anchorParseArgs(wire, {
        blockIndex: 1000000000,
        txHash: 'anchor-v3-' + vectorName,
        source: 'anchor-v3-publisher'
    });
    await withActivatedAnchor(async Anchor => {
        await new Anchor(action).parse(args.params, args.data, args.error);
    });
    return { bundle, rows, wire };
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
        const { bundle, rows, wire } = await parseVector('v3', 'bundle_v3');
        const expected = expectedRows(bundle, wire);
        assert.strictEqual(rows.length, expected.chainRows.length + 1, 'one archive row');
        assert.deepStrictEqual(actualRows(rows, expected.chainRows.length), expected);
        assert.ok(rows.every(row => row.STATUS === 'unverified'), 'unverified rows');
    });

    it('records no archive row for the frozen archive-free vector', async function () {
        const { bundle, rows, wire } = await parseVector('v3_no_archive', 'bundle_v3_no_archive');
        const expected = expectedRows(bundle, wire);
        assert.strictEqual(rows.length, expected.chainRows.length, 'no archive row');
        assert.deepStrictEqual(actualRows(rows, expected.chainRows.length), expected);
        assert.ok(rows.every(row => row.STATUS === 'unverified'), 'unverified chain rows');
    });
});
