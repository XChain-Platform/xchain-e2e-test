'use strict'

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const crypto = require('crypto')
const fs = require('fs').promises

function sha256(bytes) {
    return crypto.createHash('sha256').update(bytes).digest('hex')
}

function uniqueMatch(contents, find, file) {
    const needle = Buffer.from(find)
    const index = contents.indexOf(needle)
    if (needle.length === 0 || index === -1)
        throw new Error(`${file}: find occurs zero times`)
    if (contents.indexOf(needle, index + 1) !== -1)
        throw new Error(`${file}: find occurs more than once`)
    return { index, needle }
}

async function withFalsified({ file, find, replace }, fn) {
    const original = await fs.readFile(file)
    const originalHash = sha256(original)
    const { index, needle } = uniqueMatch(original, find, file)
    const changed = Buffer.concat([
        original.subarray(0, index),
        Buffer.from(replace),
        original.subarray(index + needle.length),
    ])

    await fs.writeFile(file, changed)
    try {
        return await fn()
    } finally {
        await fs.writeFile(file, original)
        const restored = await fs.readFile(file)
        if (sha256(restored) !== originalHash)
            throw new Error(`Restored file sha256 differs: ${file}`)
    }
}

async function expectRed(fn, pattern) {
    let rejected = false
    let rejection
    try {
        await fn()
    } catch (error) {
        rejected = true
        rejection = error
    }
    if (!rejected) throw new Error('Expected function to reject, but it resolved')
    const message = rejection && rejection.message !== undefined
        ? String(rejection.message)
        : String(rejection)
    if (!new RegExp(pattern.source, pattern.flags).test(message))
        throw new Error(`Expected rejection message ${JSON.stringify(message)} to match ${pattern}`)
}

module.exports = { withFalsified, expectRed }
