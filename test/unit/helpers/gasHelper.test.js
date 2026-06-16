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

const sinon = require('sinon')
const assert = require('assert')
const transactionHelper = require('../../transactionHelper')
const mintHelper = require('../../helpers/mintHelper')
const helper = require('../../helpers/gasHelper')

const addressInfo = { address: 'addr1', privateKey: Buffer.alloc(32), publicKey: Buffer.alloc(33) }

describe('gasHelper', () => {
    let mintStub

    beforeEach(() => {
        // gasHelper delegates to mintHelper.sendMintV0, so stub that
        mintStub = sinon.stub(mintHelper, 'sendMintV0').resolves({
            txHash: 'abc123',
            mint: { id: 200 },
            credit: { id: 201 }
        })
        // Also stub createAndSendTransaction in case it leaks through
        sinon.stub(transactionHelper, 'createAndSendTransaction').resolves('abc123')
        global.indexerDatabase = {
            waitForMint: sinon.stub().resolves({ id: 200 }),
            waitForCredit: sinon.stub().resolves({ id: 201 }),
        }
    })

    afterEach(() => sinon.restore())

    describe('mintGas', () => {
        it('should delegate to mintHelper.sendMintV0 with XCHAIN tick', async () => {
            const result = await helper.mintGas(addressInfo, '1000')

            assert(mintStub.calledOnce)
            const [calledAddressInfo, tick, amount, destination, memo] = mintStub.firstCall.args
            assert.strictEqual(calledAddressInfo, addressInfo)
            assert.strictEqual(tick, 'XCHAIN')
            assert.strictEqual(amount, '1000')
            assert.strictEqual(destination, 'addr1')
            assert.strictEqual(memo, '')
        })

        it('should return the result from mintHelper.sendMintV0', async () => {
            const result = await helper.mintGas(addressInfo, '500')
            assert.strictEqual(result.txHash, 'abc123')
            assert.deepStrictEqual(result.mint, { id: 200 })
            assert.deepStrictEqual(result.credit, { id: 201 })
        })

        it('should use addressInfo.address as destination', async () => {
            const customAddressInfo = { address: 'myaddr99' }
            await helper.mintGas(customAddressInfo, '100')
            assert.strictEqual(mintStub.firstCall.args[3], 'myaddr99')
        })
    })
})
