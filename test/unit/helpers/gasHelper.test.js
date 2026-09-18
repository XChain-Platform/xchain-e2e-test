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
// The hub's own relay-margin table, resolved the way loadSdk resolves the SDK so
// the numbers asserted below are the hub's, not a copy typed into this file.
function loadRelayMargin() {
    for (const c of ['xchain-hub/src/lib/relay_margin', '../../../xchain-hub/src/lib/relay_margin.js', '../../../../xchain-hub/src/lib/relay_margin.js']) {
        try { return c.startsWith('.') ? require(path.resolve(__dirname, c)) : require(c) } catch (e) { /* next */ }
    }
    throw new Error('gasHelper.test: cannot resolve xchain-hub/src/lib/relay_margin beside this checkout')
}
const relay = loadRelayMargin()

// A regtest miner that records every heartbeat setting in order, and can be told
// to refuse the disable so the restore path is exercised, not just the happy one.
function fakeMiner(name, opts = {}) {
    return {
        name,
        intervals: [],
        interval: 0,
        async setIdleMineInterval(ms) {
            if (ms === 0 && opts.failRestore) throw new Error(name + ' refused the restore')
            this.intervals.push(ms)
            this.interval = ms
            return 'ok'
        },
    }
}

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
        let destDb, btcDb, btcMiner, destMiner, savedDestMiner

        beforeEach(() => {
            // This block drives the real mintHelper.sendMintV0/issueHelper.sendIssueV0
            // wire composition, so undo the blanket mintHelper stub from the outer
            // beforeEach for the duration of these tests.
            mintStub.restore()

            global.COIN = 'dogecoin'
            global.COIN_CODE = 'DOGE'
            global.NETWORK = 'regtest'

            // The two miners the idle heartbeat drives: the BTC rail's (on the
            // rail's captured globals) and the destination's standing one (the
            // process global, which the real withRail swaps out and back).
            btcMiner  = fakeMiner('btc')
            destMiner = fakeMiner('dest')
            savedDestMiner = global.regtestMinerConnector
            global.regtestMinerConnector = destMiner

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
                    indexerDatabase: btcDb, regtestMinerConnector: btcMiner,
                },
                env: { COIN: 'bitcoin', NETWORK: 'regtest', INDEXER_DB_NAME: 'x', INDEXER_DB_USER: 'x', INDEXER_DB_PASS: 'x' },
            })
        })

        afterEach(() => {
            if (savedDestMiner === undefined) delete global.regtestMinerConnector
            else global.regtestMinerConnector = savedDestMiner
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

        // The two-stack nightly legs sat on this twice (runs 35122297316 and
        // 35124072478): neither regtest miner mines without a transaction in its
        // mempool, so with nothing in flight BTC never buried the lock to the hub's
        // depth and the destination's protocol clock (median-time-past) never
        // reached the row's effective_time, a full relay margin ahead. The
        // heartbeat has to be on for BOTH chains for the whole gas-in, and off
        // again on every exit, because every later case counts blocks.
        describe('idle heartbeat and the credit budget', () => {
            it('runs the lock and the credit wait with the heartbeat on the BTC rail miner and the destination miner, then turns both off', async () => {
                let intervalsAtWait
                destDb.waitForCredit.callsFake(async () => {
                    intervalsAtWait = [btcMiner.interval, destMiner.interval]
                    return { id: 500 }
                })
                await helper.bridgeGasIn({ address: 'DDest5' }, '10')
                assert.deepStrictEqual(intervalsAtWait, [helper.IDLE_MINE_INTERVAL_MS, helper.IDLE_MINE_INTERVAL_MS],
                    'both heartbeats are still on while the credit is awaited, not just through the lock')
                assert.deepStrictEqual(btcMiner.intervals, [helper.IDLE_MINE_INTERVAL_MS, 0])
                assert.deepStrictEqual(destMiner.intervals, [helper.IDLE_MINE_INTERVAL_MS, 0])
            })

            it('budgets the credit wait at the destination relay margin plus slack, never the old 120 s', async () => {
                await helper.bridgeGasIn({ address: 'DDest6' }, '10')
                const waitCall = destDb.waitForCredit.firstCall
                assert.deepStrictEqual(waitCall.args[0], { address: 'DDest6', tick: 'XCHAIN', amount: '10' })
                assert.strictEqual(waitCall.args[1], helper.bridgeCreditWaitMs('DOGE'))
                assert.ok(waitCall.args[1] > relay.relayMarginFloorS('DOGE') * 1000)
            })

            it('budgets LTC at its own longer margin', async () => {
                global.COIN = 'litecoin'
                global.COIN_CODE = 'LTC'
                await helper.bridgeGasIn({ address: 'LDest7' }, '10')
                assert.strictEqual(destDb.waitForCredit.firstCall.args[1], helper.bridgeCreditWaitMs('LTC'))
                assert.ok(helper.bridgeCreditWaitMs('LTC') > helper.bridgeCreditWaitMs('DOGE'))
            })

            it('turns both heartbeats off when the credit never lands', async () => {
                destDb.waitForCredit.resolves(null)
                await assert.rejects(() => helper.bridgeGasIn({ address: 'DDest8' }, '10'), /never landed/)
                assert.strictEqual(btcMiner.interval, 0)
                assert.strictEqual(destMiner.interval, 0)
            })

            it('turns both heartbeats off when the BTC lock never debits', async () => {
                btcDb.waitForDebit.resolves(null)
                await assert.rejects(() => helper.bridgeGasIn({ address: 'DDest9' }, '10'), /never debited/)
                assert.strictEqual(btcMiner.interval, 0)
                assert.strictEqual(destMiner.interval, 0)
            })
        })
    })

    describe('bridgeCreditWaitMs', () => {
        it('is the destination relay margin plus the slack, read from the hub table, so it always exceeds the margin', () => {
            for (const coin of ['LTC', 'DOGE', 'BTC']) {
                const wait = helper.bridgeCreditWaitMs(coin)
                assert.strictEqual(wait, relay.relayMarginFloorS(coin) * 1000 + helper.BRIDGE_CREDIT_SLACK_MS, coin)
                assert.ok(wait > relay.relayMarginFloorS(coin) * 1000, coin + ': the wait must exceed the margin')
            }
        })

        it('lands on the margins the hub stamps, LTC 600 s and DOGE 240 s, plus 180 s slack', () => {
            assert.strictEqual(helper.bridgeCreditWaitMs('LTC'), 780000)
            assert.strictEqual(helper.bridgeCreditWaitMs('DOGE'), 420000)
        })
    })

    describe('withIdleMining', () => {
        it('turns the heartbeat on for every miner before fn runs, and off on every one after it resolves', async () => {
            const a = fakeMiner('btc'), b = fakeMiner('dest')
            let seenDuring
            const result = await helper.withIdleMining([a, b], async () => {
                seenDuring = [a.interval, b.interval]
                return 'credit-row'
            })
            assert.strictEqual(result, 'credit-row')
            assert.deepStrictEqual(seenDuring, [helper.IDLE_MINE_INTERVAL_MS, helper.IDLE_MINE_INTERVAL_MS])
            assert.deepStrictEqual(a.intervals, [helper.IDLE_MINE_INTERVAL_MS, 0])
            assert.deepStrictEqual(b.intervals, [helper.IDLE_MINE_INTERVAL_MS, 0])
        })

        it('turns the heartbeat off on every miner when fn throws, and rethrows fn\'s own error', async () => {
            const a = fakeMiner('btc'), b = fakeMiner('dest')
            await assert.rejects(
                helper.withIdleMining([a, b], async () => { throw new Error('credit never landed') }),
                /credit never landed/
            )
            assert.strictEqual(a.interval, 0)
            assert.strictEqual(b.interval, 0)
        })

        it('restores the other miner when one refuses the restore, and surfaces that refusal after a success', async () => {
            const a = fakeMiner('btc', { failRestore: true }), b = fakeMiner('dest')
            await assert.rejects(helper.withIdleMining([a, b], async () => 'ok'), /btc refused the restore/)
            assert.strictEqual(b.interval, 0, 'the second miner is still restored')
        })

        it('never lets a restore failure mask fn\'s own failure', async () => {
            const a = fakeMiner('btc', { failRestore: true }), b = fakeMiner('dest')
            await assert.rejects(
                helper.withIdleMining([a, b], async () => { throw new Error('the real failure') }),
                /the real failure/
            )
            assert.strictEqual(b.interval, 0)
        })

        it('honours an explicit interval', async () => {
            const a = fakeMiner('btc')
            await helper.withIdleMining([a], async () => {}, 5000)
            assert.deepStrictEqual(a.intervals, [5000, 0])
        })
    })
})
