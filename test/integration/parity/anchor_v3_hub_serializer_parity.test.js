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
const HUB_ROOT = path.join(ROOT, 'xchain-hub');
const PAYLOAD_PATH = path.join(HUB_ROOT, 'src/anchor/publisher/fold/v3_payload.js');
const FIXTURE_PATH = path.join(HUB_ROOT, 'test/fixtures/anchor_canonical_vectors.json');

const { parseAnchorV3 } = require('../../helpers/anchor_fold/parse_anchor_v3');

let buildAnchorV3Payload;
let golden;

function sha256(value) {
    return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function fixtureArray(bundle, field) {
    if (Array.isArray(bundle[field])) return bundle[field];
    assert.strictEqual(bundle[field], `same as bundle_v3.${field}`,
        `${field} fixture reference`);
    return golden.fixture.bundle_v3[field];
}

function materializedBundle(bundle) {
    return Object.assign({}, bundle, {
        sections: fixtureArray(bundle, 'sections'),
        attest_sigs: fixtureArray(bundle, 'attest_sigs')
    });
}

function expectedArchive(bundle) {
    return {
        wrapperSectionIndex: bundle.wrapper_section_index,
        matchBatchSeq: bundle.match_batch_seq,
        matchCount: bundle.match_count,
        batchCrc32: bundle.batch_crc32,
        totalChunks: bundle.total_chunks,
        archiveB64: bundle.archive_b64
    };
}

describe('ANCHOR v3 hub serializer parity', function () {
    before(function () {
        if (!fs.existsSync(HUB_ROOT)) {
            const reason = 'xchain-hub sibling is absent at ' + HUB_ROOT;
            console.log('ANCHOR v3 hub serializer parity: ' + reason + '; skipping');
            if (process.env.XCHAIN_REQUIRE_SIBLINGS === '1') throw new Error(reason);
            this.skip();
            return;
        }
        ({ buildAnchorV3Payload } = require(PAYLOAD_PATH));
        golden = require(FIXTURE_PATH);
    });

    it('serializes the archive-bearing fixture byte for byte and by sha256', function () {
        const actual = buildAnchorV3Payload(golden.fixture.bundle_v3);
        assert.strictEqual(actual, golden.vectors.v3, 'archive-bearing v3 bytes');
        assert.strictEqual(sha256(actual), sha256(golden.vectors.v3),
            'archive-bearing v3 sha256');
    });

    it('serializes the archive-free fixture byte for byte and by sha256', function () {
        const bundle = materializedBundle(golden.fixture.bundle_v3_no_archive);
        const actual = buildAnchorV3Payload(bundle);
        assert.strictEqual(actual, golden.vectors.v3_no_archive, 'archive-free v3 bytes');
        assert.strictEqual(sha256(actual), sha256(golden.vectors.v3_no_archive),
            'archive-free v3 sha256');
    });

    it('parses the frozen v3 vector back to its folded fixture fields', function () {
        const bundle = golden.fixture.bundle_v3;
        const parsed = parseAnchorV3(golden.vectors.v3);
        assert.strictEqual(parsed.sections.length, bundle.sections.length, 'section count');
        assert.strictEqual(parsed.archiveCount, bundle.archive_count, 'archive count');
        assert.deepStrictEqual(parsed.archive, expectedArchive(bundle), 'archive fields');
        assert.strictEqual(parsed.publisher, bundle.publisher, 'publisher');
    });
});
