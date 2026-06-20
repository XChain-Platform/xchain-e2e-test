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

// Integration tests for dispenser helper → DB assertion pipeline.

const assert = require('assert')
const sinon = require('sinon')
const bitcoin = require('bitcoinjs-lib')
const { ECPairFactory } = require('ecpair')
const ecc = require('tiny-secp256k1')
const ECPair = ECPairFactory(ecc)

const dispenserHelper = require('../../../test/helpers/dispenserHelper')
const transactionHelper = require('../../../test/transactionHelper')
const dbRows = require('../fixtures/dbRows')

describe('Dispenser Helper → DB Assertion Pipeline', function () {

    let savedGlobals
    let addressInfo
    let createTxStub

    before(function () {
        const keyPair = ECPair.makeRandom({ network: bitcoin.networks.regtest })
        const { address } = bitcoin.payments.p2pkh({
            pubkey: keyPair.publicKey,
            network: bitcoin.networks.regtest
        })
        addressInfo = { address, privateKey: keyPair.privateKey, publicKey: keyPair.publicKey }
    })

    beforeEach(function () {
        savedGlobals = {
            NETWORK_OBJECT: global.NETWORK_OBJECT,
            indexerDatabase: global.indexerDatabase,
        }
        global.NETWORK_OBJECT = { ...bitcoin.networks.regtest, dustThreshold: 546 }
        createTxStub = sinon.stub(transactionHelper, 'createAndSendTransaction').resolves('txhash_disp')
    })

    afterEach(function () {
        Object.assign(global, savedGlobals)
        sinon.restore()
    })

    describe('Scenario 3.3.3: Dispenser V0 complex parameter mapping', function () {

        it('maps all parameters correctly to message and DB filter', async function () {
            let waitForDispenserArgs = null

            global.indexerDatabase = {
                waitForDispenser: async function (obj) {
                    waitForDispenserArgs = obj
                    return dbRows.dispenserRow()
                }
            }

            const result = await dispenserHelper.sendDispenserV0(
                addressInfo,
                'BTC',           // giveCoin
                'MYTOKEN',       // giveTick
                '10',            // giveAmount
                '100',           // giveEscrow
                '',              // getCoin
                'OTHERTOKEN',    // getTick
                '5',             // getAmount
                'getAddr123',    // getAddress
                'USD',           // fiatCode
                '1.50',          // fiatAmount
                null,            // oracleAddress → ""
                '999999',        // expiration
                'allowAddr1',    // allowList
                'blockAddr1',    // blockList
                'test dispenser' // memo
            )

            // Verify message construction: pipe-delimited order incl. the
            // GIVE_OWNERSHIP (empty = 0) and ORACLE_ADDRESS slots:
            // VERSION|GIVE_COIN|GIVE_TICK|GIVE_AMOUNT|GIVE_OWNERSHIP|GIVE_ESCROW|GET_COIN|GET_TICK|GET_AMOUNT|GET_ADDRESS|FIAT_CODE|FIAT_AMOUNT|ORACLE_ADDRESS|EXPIRATION|ALLOW_LIST|BLOCK_LIST|MEMO
            const message = createTxStub.firstCall.args[1]
            assert(message.startsWith('DISPENSER|0|BTC|MYTOKEN|10||100||OTHERTOKEN|5|getAddr123|USD|1.50||999999|allowAddr1|blockAddr1|test dispenser'))

            assert(waitForDispenserArgs, 'waitForDispenser should have been called')
            assert.strictEqual(waitForDispenserArgs.source, addressInfo.address)
            assert.strictEqual(waitForDispenserArgs.txHash, 'txhash_disp')
            assert.strictEqual(waitForDispenserArgs.giveCoin, 'BTC')
            assert.strictEqual(waitForDispenserArgs.giveTick, 'MYTOKEN')
            assert.strictEqual(waitForDispenserArgs.giveAmount, '10')
            assert.strictEqual(waitForDispenserArgs.giveEscrow, '100')
            assert.strictEqual(waitForDispenserArgs.getCoin, '')
            assert.strictEqual(waitForDispenserArgs.getTick, 'OTHERTOKEN')
            assert.strictEqual(waitForDispenserArgs.getAmount, '5')
            assert.strictEqual(waitForDispenserArgs.getAddress, 'getAddr123')
            assert.strictEqual(waitForDispenserArgs.fiatCode, 'USD')
            assert.strictEqual(waitForDispenserArgs.fiatAmount, '1.50')
            assert.strictEqual(waitForDispenserArgs.expiration, '999999')
            assert.strictEqual(waitForDispenserArgs.allowList, 'allowAddr1')
            assert.strictEqual(waitForDispenserArgs.blockList, 'blockAddr1')
            assert.strictEqual(waitForDispenserArgs.memo, 'test dispenser')
            assert.strictEqual(waitForDispenserArgs.status, 'valid')

            assert.strictEqual(result.txHash, 'txhash_disp')
            assert(result.dispenser, 'dispenser row should be present')
        })

        it('coerces null optional params to empty string in message', async function () {
            global.indexerDatabase = {
                waitForDispenser: async () => dbRows.dispenserRow()
            }

            await dispenserHelper.sendDispenserV0(
                addressInfo,
                null,      // giveCoin → ""
                null,      // giveTick → ""
                '10',      // giveAmount
                '100',     // giveEscrow
                null,      // getCoin → ""
                null,      // getTick → ""
                '5',       // getAmount
                'addr',    // getAddress
                null,      // fiatCode → ""
                null,      // fiatAmount → ""
                null,      // oracleAddress → ""
                null,      // expiration → ""
                null,      // allowList → ""
                null,      // blockList → ""
                'memo'     // memo
            )

            const message = createTxStub.firstCall.args[1]
            assert.strictEqual(message, 'DISPENSER|0|||10||100|||5|addr|||||||memo')
        })
    })
})
