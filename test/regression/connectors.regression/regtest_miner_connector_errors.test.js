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
const { mockAxiosPost, RegtestMinerConnector } = require('./support/environment')

void describe('RegtestMinerConnector', function () {

    // The miner reports failure as a truthy `{error}` result, not an HTTP
    // error, so every method must throw rather than return it as a payload.
    it('[regression:p0] R-CONN-010d : sendFunds throws on an {error} envelope instead of returning it', async function () {
        const stub = mockAxiosPost({ error: 'There was a problem sending funds: boom' })
        try {
            const miner = new RegtestMinerConnector('localhost', 3033)
            await assert.rejects(
                () => miner.sendFunds('addr1', 1.0),
                /There was a problem sending funds: boom/
            )
        } finally {
            stub.restore()
        }
    })

    it('[regression:p0] R-CONN-010e : generateBlocks throws on an {error} envelope instead of returning it', async function () {
        const stub = mockAxiosPost({ error: 'There was a problem generating blocks: boom' })
        try {
            const miner = new RegtestMinerConnector('localhost', 3033)
            await assert.rejects(
                () => miner.generateBlocks(2),
                /There was a problem generating blocks: boom/
            )
        } finally {
            stub.restore()
        }
    })

    it('[regression:p0] R-CONN-010f : setDefaultMiningTime/pauseMining/resumeMining throw on an {error} envelope', async function () {
        const stub = mockAxiosPost({ error: 'boom' })
        try {
            const miner = new RegtestMinerConnector('localhost', 3033)
            await assert.rejects(() => miner.setDefaultMiningTime(), /boom/)
            await assert.rejects(() => miner.pauseMining(), /boom/)
            await assert.rejects(() => miner.resumeMining(), /boom/)
        } finally {
            stub.restore()
        }
    })
})
