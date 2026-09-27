'use strict'

// Copyright (c) 2025-2026 Dankest, LLC
//
// SPDX-License-Identifier: AGPL-3.0-or-later

const assert = require('assert')
const zlib = require('zlib')
const {
    corruptFinalChunk,
    reassembledCrc32
} = require('../../../helpers/anchor_fold/corrupt_final_chunk')

function archiveChunks() {
    const json = JSON.stringify({
        matches: [{ transfer_id: 'fixed-transfer', amount: '42' }],
        capability_snapshots: [],
        pad: 'x'.repeat(64)
    })
    const wire = zlib.gzipSync(Buffer.from(json)).toString('base64url')
    const chunkLength = Math.ceil(wire.length / 3)
    return {
        chunks: [
            wire.slice(0, chunkLength),
            wire.slice(chunkLength, chunkLength * 2),
            wire.slice(chunkLength * 2)
        ],
        crc32: (zlib.crc32(Buffer.from(json)) >>> 0).toString(16).padStart(8, '0')
    }
}

describe('final archive chunk corruption', function () {
    it('reassembles clean chunks to the archive JSON crc32', function () {
        const { chunks, crc32 } = archiveChunks()

        assert.strictEqual(reassembledCrc32(chunks), crc32)
    })

    it('changes only the first character of a copied final chunk', function () {
        const { chunks, crc32 } = archiveChunks()
        const original = chunks.slice()
        const corrupted = corruptFinalChunk(chunks)

        assert.notStrictEqual(corrupted, chunks)
        assert.strictEqual(corrupted[0], chunks[0])
        assert.strictEqual(corrupted[1], chunks[1])
        assert.notStrictEqual(corrupted[2], chunks[2])
        assert.notStrictEqual(corrupted[2][0], chunks[2][0])
        assert.strictEqual(corrupted[2].slice(1), chunks[2].slice(1))
        assert.deepStrictEqual(corrupted.map((chunk) => chunk.length), chunks.map((chunk) => chunk.length))
        assert.deepStrictEqual(chunks, original)
        assert.notStrictEqual(reassembledCrc32(corrupted), crc32)
    })

    it('wraps the base64url alphabet from underscore to A', function () {
        assert.deepStrictEqual(corruptFinalChunk(['first', '_z']), ['first', 'Az'])
    })

    it('returns null when the joined wire is not gzip', function () {
        assert.strictEqual(reassembledCrc32(['not-', 'gzip']), null)
    })

    it('refuses values that are not arrays of strings', function () {
        assert.throws(() => corruptFinalChunk('chunks'), /^Error: corruptFinalChunk:/)
        assert.throws(() => corruptFinalChunk(['chunk', 7]), /^Error: corruptFinalChunk:/)
    })

    it('refuses fewer than two chunks', function () {
        assert.throws(() => corruptFinalChunk([]), /^Error: corruptFinalChunk:/)
        assert.throws(() => corruptFinalChunk(['single']), /^Error: corruptFinalChunk:/)
    })

    it('refuses a final chunk shorter than two characters', function () {
        assert.throws(() => corruptFinalChunk(['first', '']), /^Error: corruptFinalChunk:/)
        assert.throws(() => corruptFinalChunk(['first', 'A']), /^Error: corruptFinalChunk:/)
    })
})
