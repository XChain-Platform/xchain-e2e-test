// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const assert = require('assert')
const fs = require('fs')
const path = require('path')
const { protocol, assertVendored } = require('./support/environment')

// Read one bare literal out of a sibling source file. Unlike readLiteral this accepts
// numeric separators (the wallet writes 12_000_000), which Number() would reject.
function readSourceLiteral(relPath, pattern, label) {
    const abs = path.join(__dirname, '../../../../', relPath)
    assert.ok(fs.existsSync(abs), relPath + ' is missing; this tripwire needs the full sibling tree')
    const hit = pattern.exec(fs.readFileSync(abs, 'utf8'))
    assert.ok(hit, label + ' is no longer a bare literal declaration; re-point this guard')
    return Number(hit[1].replace(/_/g, ''))
}

// Every surface that bounds a multi-part FILE re-declares these two caps. The
// indexer and the SDK vendor them; the explorer readers and the wallet declare bare
// literals, which are read as source because the wallet is an ESM package this suite
// cannot require and the explorer literals are not exported.
const COPIES = [
    {
        name: 'MULTIPART_FILE_MAX_PARTS',
        sources: [
            ['xchain-explorer/src/action-detail/multipart_detail.js', /^const MULTIPART_FILE_MAX_PARTS = (\d+);$/m],
            ['xchain-wallet/packages/core/src/flows/fileSizeLimits.js', /^export const MULTIPART_FILE_MAX_PARTS = (\d+);$/m],
            ['xchain-wallet/packages/core/src/flows/gatedMultipartBatch.js', /^const MULTIPART_FILE_MAX_PARTS = (\d+);$/m],
        ],
    },
    {
        name: 'MULTIPART_FILE_MAX_BYTES',
        sources: [
            ['xchain-explorer/src/action-detail/multipart_detail.js', /^const MULTIPART_FILE_MAX_BYTES = (\d+);$/m],
            ['xchain-explorer/src/explorer/multipart_file.js', /^const MULTIPART_FILE_MAX_BYTES = (\d+);$/m],
            ['xchain-wallet/packages/core/src/flows/fileSizeLimits.js', /^export const MULTIPART_FILE_MAX_BYTES = ([\d_]+);$/m],
            ['xchain-wallet/packages/core/src/flows/gatedMultipartBatch.js', /^const MULTIPART_FILE_MAX_BYTES = (\d+);$/m],
            ['xchain-wallet/packages/core/src/flows/multipartSupport.js', /^const MULTIPART_FILE_MAX_BYTES = ([\d_]+);$/m],
        ],
    },
]

void describe('Multi-part FILE caps (MULTIPART_FILE_MAX_PARTS / MULTIPART_FILE_MAX_BYTES)', () => {

    COPIES.forEach(({ name, sources }) => {
        it(`[regression:p0] ${name} === canonical across vendored copies + explorer + wallet`, () => {
            assertVendored(name, ['xchain-indexer', 'xchain-sdk'])
            sources.forEach(([relPath, pattern]) => {
                // A one-sided edit to a reader copy would change which multi-part
                // files it accepts or assembles without the other services noticing.
                assert.strictEqual(readSourceLiteral(relPath, pattern, relPath + ' ' + name), protocol[name],
                    relPath + ' ' + name + ' drifted from the canonical protocol constant')
            })
        })
    })
})
