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

const assert = require('assert')
const fs = require('fs').promises
const os = require('os')
const path = require('path')

const { withFalsified, expectRed } = require('../../../helpers/anchor_fold/falsify')

describe('anchor fold falsification helpers', function () {
    let scratchDir
    let scratchFile

    before(async function () {
        scratchDir = await fs.mkdtemp(path.join(os.tmpdir(), 'anchor-fold-falsify-'))
        scratchFile = path.join(scratchDir, 'subject.txt')
    })

    after(async function () {
        await fs.rm(scratchDir, { recursive: true, force: true })
    })

    it('makes the replacement visible and restores identical bytes on success', async function () {
        const original = Buffer.from([0x00, 0x61, 0x6c, 0x70, 0x68, 0x61, 0xff])
        await fs.writeFile(scratchFile, original)

        const result = await withFalsified({ file: scratchFile, find: 'alpha', replace: 'beta' }, async () => {
            assert.deepStrictEqual(await fs.readFile(scratchFile), Buffer.from([0x00, 0x62, 0x65, 0x74, 0x61, 0xff]))
            return 'observed'
        })

        assert.strictEqual(result, 'observed')
        assert.deepStrictEqual(await fs.readFile(scratchFile), original)
    })

    it('restores identical bytes and rethrows when the callback fails', async function () {
        const original = Buffer.from('before target after')
        const failure = new Error('driver failed')
        await fs.writeFile(scratchFile, original)

        await assert.rejects(
            withFalsified({ file: scratchFile, find: 'target', replace: 'changed' }, async () => {
                throw failure
            }),
            (error) => error === failure,
        )
        assert.deepStrictEqual(await fs.readFile(scratchFile), original)
    })

    it('names the file when restored bytes fail verification', async function () {
        const original = Buffer.from('before target after')
        const readFile = fs.readFile
        let reads = 0
        await fs.writeFile(scratchFile, original)
        fs.readFile = async (...args) => {
            const bytes = await readFile(...args)
            reads += 1
            return reads === 2 ? Buffer.concat([bytes, Buffer.from('changed')]) : bytes
        }

        try {
            await assert.rejects(
                withFalsified({ file: scratchFile, find: 'target', replace: 'changed' }, async () => {}),
                (error) => error.message.includes(scratchFile),
            )
        } finally {
            fs.readFile = readFile
        }
        assert.deepStrictEqual(await fs.readFile(scratchFile), original)
    })

    it('refuses a missing match without touching the file', async function () {
        const original = Buffer.from('one target')
        await fs.writeFile(scratchFile, original)

        await assert.rejects(
            withFalsified({ file: scratchFile, find: 'missing', replace: 'changed' }, async () => {}),
            /zero times/,
        )
        assert.deepStrictEqual(await fs.readFile(scratchFile), original)
    })

    it('refuses duplicate matches without touching the file', async function () {
        const original = Buffer.from('target and target')
        await fs.writeFile(scratchFile, original)

        await assert.rejects(
            withFalsified({ file: scratchFile, find: 'target', replace: 'changed' }, async () => {}),
            /more than once/,
        )
        assert.deepStrictEqual(await fs.readFile(scratchFile), original)
    })

    it('accepts a rejection whose message matches', async function () {
        const pattern = /red reason/g
        pattern.lastIndex = 100
        await expectRed(async () => { throw new Error('expected red reason') }, pattern)
    })

    it('rejects a callback that resolves', async function () {
        await assert.rejects(expectRed(async () => 'green', /red reason/), /resolved/)
    })

    it('rejects a rejection with the wrong message', async function () {
        await assert.rejects(
            expectRed(async () => { throw new Error('different reason') }, /red reason/),
            /Expected rejection message/,
        )
    })
})
