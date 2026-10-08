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
const envelopeRevealHeight = require('../../helpers/envelopeRevealHeight')

describe('envelopeRevealHeight', function () {
    it('reads the height from the transaction confirming block, not the node tip', async function () {
        const calls = []
        const node = {
            async getTransaction(txid){
                calls.push(['getTransaction', txid])
                return { txid, blockhash: 'confirming-block' }
            },
            async getBlock(hash){
                calls.push(['getBlock', hash])
                return { hash, height: 412 }
            },
            async getBlockCount(){
                throw new Error('the node tip must not decide the transaction height')
            }
        }

        assert.strictEqual(await envelopeRevealHeight(node, 'reveal-txid'), 412)
        assert.deepStrictEqual(calls, [
            ['getTransaction', 'reveal-txid'],
            ['getBlock', 'confirming-block']
        ])
    })

    it('accepts a numeric height returned as a string', async function () {
        const node = {
            async getTransaction(){ return { blockhash: 'block-9' } },
            async getBlock(){ return { height: '9' } }
        }

        assert.strictEqual(await envelopeRevealHeight(node, 'commit-txid'), 9)
    })

    it('fails loud when the transaction is unknown or unconfirmed', async function () {
        await assert.rejects(
            envelopeRevealHeight({ getTransaction: async () => null }, 'missing'),
            /node has no transaction missing/)
        await assert.rejects(
            envelopeRevealHeight({ getTransaction: async () => ({ txid: 'pending' }) }, 'pending'),
            /transaction pending is not confirmed/)
    })

    it('fails loud when the confirming block or its height is unreadable', async function () {
        const transaction = async () => ({ blockhash: 'block-x' })
        await assert.rejects(
            envelopeRevealHeight({ getTransaction: transaction, getBlock: async () => null }, 'reveal'),
            /no confirming block block-x/)
        await assert.rejects(
            envelopeRevealHeight({ getTransaction: transaction, getBlock: async () => ({ height: 'unknown' }) }, 'reveal'),
            /invalid confirming block height: unknown/)
    })
})
