'use strict'

/*********************************************************************
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 ********************************************************************/

const assert = require('assert')

async function envelopeRevealHeight(node, txid){
    const tx = await node.getTransaction(String(txid))
    assert(tx, 'the node has no transaction ' + txid)
    assert(tx.blockhash, 'transaction ' + txid + ' is not confirmed')

    const block = await node.getBlock(tx.blockhash)
    assert(block, 'the node has no confirming block ' + tx.blockhash + ' for transaction ' + txid)

    const height = Number(block.height)
    assert(Number.isSafeInteger(height) && height >= 0,
        'transaction ' + txid + ' has an invalid confirming block height: ' + String(block.height))
    return height
}

module.exports = envelopeRevealHeight
