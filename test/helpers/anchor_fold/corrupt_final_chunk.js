'use strict'

// Copyright (c) 2025-2026 Dankest, LLC
//
// SPDX-License-Identifier: AGPL-3.0-or-later

const zlib = require('zlib')

const BASE64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
const MAX_ARCHIVE_BYTES = 16 * 1024 * 1024

function reassembledCrc32(chunks) {
    let json
    try {
        const wire = chunks.join('')
        json = zlib.gunzipSync(Buffer.from(wire, 'base64url'), {
            maxOutputLength: MAX_ARCHIVE_BYTES
        }).toString('utf8')
    } catch (error) {
        return null
    }

    return (zlib.crc32(Buffer.from(json, 'utf8')) >>> 0)
        .toString(16)
        .padStart(8, '0')
}

function corruptFinalChunk(chunks) {
    if (!Array.isArray(chunks) || !chunks.every((chunk) => typeof chunk === 'string')) {
        throw new Error('corruptFinalChunk: chunks must be an array of strings')
    }
    if (chunks.length < 2) {
        throw new Error('corruptFinalChunk: at least two chunks are required')
    }

    const finalChunk = chunks[chunks.length - 1]
    if (finalChunk.length < 2) {
        throw new Error('corruptFinalChunk: final chunk must contain at least two characters')
    }

    const alphabetIndex = BASE64URL_ALPHABET.indexOf(finalChunk[0])
    const replacement = BASE64URL_ALPHABET[(alphabetIndex + 1) % BASE64URL_ALPHABET.length]
    const corrupted = chunks.slice()
    corrupted[corrupted.length - 1] = replacement + finalChunk.slice(1)
    return corrupted
}

module.exports = { corruptFinalChunk, reassembledCrc32 }
