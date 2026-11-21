/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 *********************************************************************/

'use strict'

async function mineWithConnector(connector, blocks = 1) {
    const result = await connector.generateBlocks(blocks)
    const actual = result && result.count
    if (actual !== blocks) {
        throw new Error('mine(' + blocks + '): regtest miner reported ' + String(actual) +
            ' blocks, expected ' + blocks)
    }
    return result
}

async function mine(blocks = 1) {
    return mineWithConnector(global.regtestMinerConnector, blocks)
}

module.exports = { mine, mineWithConnector }
