'use strict'

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const assert = require('assert')
const { mineWithConnector } = require('../../sdk/helpers/mine')

describe('SDK mine helper', function () {
    it('propagates a miner refusal unchanged', async function () {
        const refusal = new Error('mining refused')
        const connector = { generateBlocks: async () => { throw refusal } }
        await assert.rejects(() => mineWithConnector(connector, 3), (error) => error === refusal)
    })

    it('rejects a partial or missing block count', async function () {
        await assert.rejects(() => mineWithConnector({ generateBlocks: async () => ({ count: 2 }) }, 3),
            /reported 2 blocks, expected 3/)
        await assert.rejects(() => mineWithConnector({ generateBlocks: async () => undefined }, 1),
            /reported undefined blocks, expected 1/)
    })

    it('returns an exact successful result', async function () {
        const result = { count: 3, hashes: ['a', 'b', 'c'] }
        let requested = null
        const connector = { generateBlocks: async (blocks) => { requested = blocks; return result } }
        assert.strictEqual(await mineWithConnector(connector, 3), result)
        assert.strictEqual(requested, 3)
    })
})
