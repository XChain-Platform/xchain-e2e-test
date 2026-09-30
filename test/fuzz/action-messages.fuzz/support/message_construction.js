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

const { assert, sinon, fc, gen, transactionHelper } = require('./environment')

const FC_PARAMS = { numRuns: 200 }

function fuzzMessageConstruction(helperName, methodName, argsArb) {
    describe(`Fuzz: ${helperName}.${methodName} message construction`, function () {

        let capturedMessage = null
        let createAndSendStub

        beforeEach(function () {
            capturedMessage = null
            createAndSendStub = sinon.stub(transactionHelper, 'createAndSendTransaction')
                .callsFake(async (addressInfo, data) => {
                    capturedMessage = data
                    return 'txhash-fuzz'
                })
        })

        afterEach(function () {
            sinon.restore()
        })

        it(`survives ${FC_PARAMS.numRuns} fuzzed inputs without crashing`, async function () {
            const helper = require(`../../../helpers/${helperName}`)

            await fc.assert(fc.asyncProperty(argsArb, async (args) => {
                capturedMessage = null
                const fakeAddressInfo = { address: 'fuzz_addr', privateKey: Buffer.alloc(32), publicKey: Buffer.alloc(33) }

                try {
                    await helper[methodName](fakeAddressInfo, ...args)
                    assert(typeof capturedMessage === 'string',
                        `${helperName}.${methodName} should produce a string message, got: ${typeof capturedMessage}`)
                } catch (err) {
                    if (err instanceof TypeError && err.message.includes('Cannot convert a Symbol')) {
                        return
                    }
                    throw err
                }
            }), FC_PARAMS)
        })
    })
}

module.exports = { fc, f: gen.actionFieldArb, fuzzMessageConstruction }
