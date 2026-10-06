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
const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');

const ROOT = path.resolve(__dirname, '../../../..');

const VECTOR_PATHS = [
    'xchain-documentation/protocol/test-vectors/anchor_canonical.json',
    'xchain-hub/test/fixtures/anchor_canonical_vectors.json',
    'xchain-indexer/test/fixtures/anchor_canonical_vectors.json'
];

const GOLDEN = require(path.join(ROOT, VECTOR_PATHS[0]));
const sdkLight = require(path.join(ROOT, 'xchain-sdk/src/protocol/light_client.js'));

function sha256(relativePath) {
    return crypto.createHash('sha256')
        .update(fs.readFileSync(path.join(ROOT, relativePath)))
        .digest('hex');
}

function fixtureArray(bundle, field) {
    if (Array.isArray(bundle[field])) return bundle[field];
    assert.strictEqual(bundle[field], `same as bundle_v3.${field}`,
        `${field} fixture reference`);
    return GOLDEN.fixture.bundle_v3[field];
}

function normalizedSections(bundle) {
    const sections = fixtureArray(bundle, 'sections').map(section => Object.assign({}, section, {
        validator_signatures: section.validator_signatures.slice()
            .sort((a, b) => a.pubkey.localeCompare(b.pubkey))
    })).sort((a, b) => a.chain.localeCompare(b.chain));
    // The parser hangs the archive header on the one section signed over it,
    // counted in wire order, which is this chain order.
    const archive = expectedArchive(bundle);
    if (archive) {
        sections[archive.wrapper_section_index].fold_archive = {
            match_batch_seq: archive.match_batch_seq,
            match_count: archive.match_count,
            batch_crc32: archive.batch_crc32,
            total_chunks: archive.total_chunks
        };
    }
    return sections;
}

function expectedArchive(bundle) {
    if (bundle.archive_count === 0) return null;
    return {
        wrapper_section_index: bundle.wrapper_section_index,
        match_batch_seq: bundle.match_batch_seq,
        match_count: bundle.match_count,
        batch_crc32: bundle.batch_crc32,
        total_chunks: bundle.total_chunks,
        archive_b64: bundle.archive_b64
    };
}

function assertParsedVector(wire, bundle) {
    const parsed = sdkLight.parseAnchorV3(wire);
    const sections = normalizedSections(bundle);
    assert.strictEqual(parsed.version, 3, 'VERSION');
    assert.strictEqual(parsed.network, bundle.network, 'NETWORK');
    assert.strictEqual(parsed.snapshot_block, bundle.snapshot_block, 'SNAPSHOT_BLOCK');
    assert.strictEqual(parsed.section_count, sections.length, 'SECTION_COUNT');
    assert.deepStrictEqual(parsed.sections, sections, 'sections');
    assert.strictEqual(parsed.archive_count, bundle.archive_count, 'ARCHIVE_COUNT');
    assert.deepStrictEqual(parsed.archive, expectedArchive(bundle), 'archive fields');
    assert.strictEqual(parsed.publisher, bundle.publisher, 'PUBLISHER');
    assert.deepStrictEqual(parsed.publisher_attestations, fixtureArray(bundle, 'attest_sigs'),
        'publisher attestations');
}

describe('ANCHOR v3 frozen vector parity', function () {
    const withArchive = GOLDEN.fixture.bundle_v3;
    const withoutArchive = GOLDEN.fixture.bundle_v3_no_archive;

    it('keeps all three frozen vector copies sha256-equal', function () {
        const hashes = VECTOR_PATHS.map(sha256);
        assert.strictEqual(hashes[1], hashes[0], 'hub vector hash');
        assert.strictEqual(hashes[2], hashes[0], 'indexer vector hash');
    });

    it('parses the archive-bearing v3 vector into the frozen fixture', function () {
        assertParsedVector(GOLDEN.vectors.v3, withArchive);
    });

    it('parses the archive-free v3 vector into the frozen fixture', function () {
        assertParsedVector(GOLDEN.vectors.v3_no_archive, withoutArchive);
    });

    it('refuses ARCHIVE_COUNT 2 with an ARCHIVE_COUNT error', function () {
        const marker = [withArchive.archive_count, withArchive.wrapper_section_index,
            withArchive.match_batch_seq, withArchive.match_count, withArchive.batch_crc32,
            withArchive.total_chunks, withArchive.archive_b64].join('|');
        const malformed = GOLDEN.vectors.v3.replace('|' + marker + '|',
            '|2|' + marker.split('|').slice(1).join('|') + '|');
        assert.notStrictEqual(malformed, GOLDEN.vectors.v3, 'archive marker must be replaced');
        assert.throws(() => sdkLight.parseAnchorV3(malformed), /ARCHIVE_COUNT/);
    });
});
