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
const cryptoHelper = require('../../cryptoHelper')
const mintHelper = require('../../helpers/mintHelper')
const issueHelper = require('../../helpers/issueHelper')
const chainRail = require('../../helpers/chainRail')
const helper = require('../../helpers/gasHelper')
const path = require('path')

// The SDK the way the harness's tools resolve it: a staged CI checkout carries no
// node_modules link for the sibling, so a bare require('xchain-sdk') is not enough.
function loadSdk() {
    for (const c of ['xchain-sdk', '../../../xchain-sdk', '../../../../xchain-sdk']) {
        try { return c.startsWith('.') ? require(path.resolve(__dirname, c)) : require(c) } catch (e) { /* next */ }
    }
    throw new Error('gasHelper.test: cannot resolve xchain-sdk beside this checkout')
}
const { decoder, XChainSDK } = loadSdk()

const addressInfo = { address: 'addr1', privateKey: Buffer.alloc(32), publicKey: Buffer.alloc(33) }

describe('gasHelper', () => {
    let mintStub

    beforeEach(() => {
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

    afterEach(() => {
        sinon.restore()
        delete global.COIN
        delete global.COIN_CODE
        delete global.NETWORK
    })

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

    // xchain-bridge.md section 4/9 (D62): a broadcast ISSUE of the GAS tick, and
    // the open MINT a local ISSUE bootstrap leaves behind, are refused
    // unconditionally off BTC. ensureGasBalance is the one place every one of
    // gasHelper's ~190 callers goes through for "give me some gas", so it is the
    // seam that has to route by chain without any caller changing.
    describe('ensureGasBalance', () => {
        it('routes to the local open-mint faucet on BTC', async () => {
            global.COIN_CODE = 'BTC'
            await helper.ensureGasBalance(addressInfo, '1000')
            assert(mintStub.calledOnce)
            assert.strictEqual(mintStub.firstCall.args[1], 'XCHAIN')
            assert.strictEqual(mintStub.firstCall.args[2], '1000')
        })

        it('routes to bridgeGasIn on every other chain', async () => {
            global.COIN_CODE = 'DOGE'
            const bridgeStub = sinon.stub(helper, 'bridgeGasIn').resolves({ bridged: true })
            const result = await helper.ensureGasBalance(addressInfo, '500')
            assert(bridgeStub.calledOnceWith(addressInfo, '500'))
            assert(mintStub.notCalled)
            assert.deepStrictEqual(result, { bridged: true })
        })
    })

    // Driven against the REAL mintHelper/issueHelper wire builders and the real
    // chainRail global-swap mechanism (chainRail.createRail is stubbed, since it
    // discovers credentials from a live hub; chainRail.withRail/enterRail/exitRail
    // run for real). Only the network edges (transactionHelper.createAndSendTransaction,
    // cryptoHelper.getNewFundedAddress, and the two indexerDatabase instances) are
    // stubbed, so the wire strings asserted below are gasHelper's actual output,
    // not a re-typed copy, and are decoded through the landed xchain-sdk decoder
    // rather than a hand-rolled parser.
    describe('bridgeGasIn', () => {
        let sendTxStub, getAddrStub, createRailStub
        let destDb, btcDb

        beforeEach(() => {
            // This block drives the real mintHelper.sendMintV0/issueHelper.sendIssueV0
            // wire composition, so undo the blanket mintHelper stub from the outer
            // beforeEach for the duration of these tests.
            mintStub.restore()

            global.COIN = 'dogecoin'
            global.COIN_CODE = 'DOGE'
            global.NETWORK = 'regtest'

            destDb = {
                checkIssue: sinon.stub().resolves(null),
                waitForCredit: sinon.stub().resolves({ id: 500 }),
            }
            btcDb = {
                checkIssue: sinon.stub().resolves({ id: 99 }),
                waitForIssue: sinon.stub().resolves({ id: 1 }),
                waitForMint: sinon.stub().resolves({ id: 2 }),
                waitForCredit: sinon.stub().resolves({ id: 3 }),
                waitForDebit: sinon.stub().resolves({ id: 4 }),
            }
            global.indexerDatabase = destDb

            let addrN = 0
            getAddrStub = sinon.stub(cryptoHelper, 'getNewFundedAddress').callsFake(async () => {
                addrN += 1
                return { address: 'btcIssuer' + addrN, privateKey: Buffer.alloc(32), publicKey: Buffer.alloc(33) }
            })

            sendTxStub = transactionHelper.createAndSendTransaction // already sinon-stubbed by the outer beforeEach
            sendTxStub.resolves('txhash-' + Math.random())

            createRailStub = sinon.stub(chainRail, 'createRail').resolves({
                coin: 'bitcoin', network: 'regtest', code: 'BTC',
                globals: {
                    COIN: 'bitcoin', NETWORK: 'regtest', NETWORK_OBJECT: null, COIN_CODE: 'BTC',
                    nodeConnector: null, utxoTrackerConnector: null, encoderConnector: null,
                    decoderConnector: null, indexerConnector: null, explorerConnector: null,
                    indexerDatabase: btcDb, regtestMinerConnector: null,
                },
                env: { COIN: 'bitcoin', NETWORK: 'regtest', INDEXER_DB_NAME: 'x', INDEXER_DB_USER: 'x', INDEXER_DB_PASS: 'x' },
            })
        })

        it('mints on BTC and locks the amount to the destination with a real XBRIDGE v0 wire string, byte-equal to the SDK builder and round-tripping through the decoder', async () => {
            const destAddressInfo = { address: 'DDestAddressXXXXXXXXXXXXXXXXXXXXXX' }

            const result = await helper.bridgeGasIn(destAddressInfo, '500')

            assert(createRailStub.calledOnceWith('bitcoin', 'regtest'))
            // GAS token already exists on BTC (btcDb.checkIssue resolves truthy):
            // only a funded LOCK address is needed, no fresh ISSUE.
            assert.strictEqual(getAddrStub.callCount, 1)
            assert.strictEqual(getAddrStub.firstCall.args[0], 'GAS.LOCK')
            assert.strictEqual(getAddrStub.firstCall.args[1], 'bitcoin')

            // Two broadcasts on the BTC rail: the open MINT, then the lock.
            assert.strictEqual(sendTxStub.callCount, 2)
            const mintMessage = sendTxStub.firstCall.args[1]
            const lockMessage = sendTxStub.secondCall.args[1]

            assert.strictEqual(mintMessage, 'MINT|0|XCHAIN|500|btcIssuer1|')
            assert.strictEqual(lockMessage, 'XBRIDGE|0|DOGE|DDestAddressXXXXXXXXXXXXXXXXXXXXXX|500|')

            // Decode the ACTUAL broadcast bytes through the landed xchain-sdk decoder.
            const parsedMint = decoder.parse(mintMessage)
            const parsedLock = decoder.parse(lockMessage)
            assert.strictEqual(parsedMint.ok, true)
            assert.deepStrictEqual(parsedMint.params, {
                TICK: 'XCHAIN', AMOUNT: '500', DESTINATION: 'btcIssuer1', MEMO: ''
            })
            assert.strictEqual(parsedLock.ok, true)
            assert.strictEqual(parsedLock.action, 'XBRIDGE')
            assert.strictEqual(parsedLock.version, 0)
            assert.deepStrictEqual(parsedLock.params, {
                DEST_COIN: 'DOGE', DEST_ADDRESS: 'DDestAddressXXXXXXXXXXXXXXXXXXXXXX', AMOUNT: '500', MEMO: ''
            })

            // Cross-check against the SDK's OWN XBRIDGE builder (XChainSDK.xbridge(),
            // landed d120fcd/81bf831) for the identical lock: same fields, whether
            // the caller composed the string by hand or through the SDK.
            const sdk = new XChainSDK({ network: 'bitcoin-regtest' })
            const sdkLock = await sdk.xbridge({
                version: 0, destCoin: 'DOGE', destAddress: destAddressInfo.address, amount: '500', memo: ''
            })
            assert.strictEqual(sdkLock.actionString, 'XBRIDGE|0|DOGE|DDestAddressXXXXXXXXXXXXXXXXXXXXXX|500')
            assert.deepStrictEqual(parsedLock.params, decoder.parse(sdkLock.actionString).params)

            // The rail is torn down: globals are back on the destination chain.
            assert.strictEqual(global.COIN_CODE, 'DOGE')
            assert.strictEqual(global.indexerDatabase, destDb)
            assert.deepStrictEqual(result, { id: 500 })
        })

        it('ISSUEs the GAS tick on BTC first when it does not exist there yet, with the real 24-field wire string', async () => {
            btcDb.checkIssue.resolves(null)

            await helper.bridgeGasIn({ address: 'DDest2' }, '30')

            assert.strictEqual(getAddrStub.firstCall.args[0], 'GAS.TOKEN')
            // ISSUE, then MINT, then the lock.
            assert.strictEqual(sendTxStub.callCount, 3)
            const issueMessage = sendTxStub.getCall(0).args[1]

            const parsed = decoder.parse(issueMessage)
            assert.strictEqual(parsed.ok, true)
            assert.strictEqual(parsed.action, 'ISSUE')
            assert.strictEqual(parsed.version, 0)
            assert.strictEqual(parsed.params.TICK, 'XCHAIN')
            assert.strictEqual(parsed.params.MAX_SUPPLY, '100000000')
            assert.strictEqual(parsed.params.MAX_MINT, '100000')
            assert.strictEqual(parsed.params.DECIMALS, '0')
            assert.strictEqual(parsed.params.DESCRIPTION, 'XChain GAS Token')
            assert.strictEqual(parsed.params.MINT_SUPPLY, '0')
        })

        it('throws when the BTC lock never debits (a refused/lost lock must not be swallowed)', async () => {
            btcDb.waitForDebit.resolves(null)
            await assert.rejects(
                () => helper.bridgeGasIn({ address: 'DDest3' }, '10'),
                /never debited the BTC source/
            )
        })

        it('throws when the destination credit never lands (the mirror/mint side, still unproven live)', async () => {
            destDb.waitForCredit.resolves(null)
            await assert.rejects(
                () => helper.bridgeGasIn({ address: 'DDest4' }, '10'),
                /never landed/
            )
        })
    })
})
