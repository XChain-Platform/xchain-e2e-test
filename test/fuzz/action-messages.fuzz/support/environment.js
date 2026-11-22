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

const assert = require('assert')
const sinon = require('sinon')
const fc = require('fast-check')

const gen = require('../../helpers/fuzz_generators')

require('../../../integration/fixtures/mockMariadb')

global.wallets = {}
global.COIN = 'bitcoin'
global.NETWORK = 'regtest'
global.NETWORK_OBJECT = { dustThreshold: 546 }
global.COIN_CODE = 'BTC'

global.nodeConnector = {
    waitForTx: async () => true,
    broadcastTx: async () => 'txhash-stub',
    getFeePerKilobyte: async () => 0.001,
    getTransactionHex: async () => 'deadbeef',
    getNetworkInfo: async () => ({ version: 1 })
}
global.utxoTrackerConnector = {
    waitForUtxos: async () => true,
    getUtxosFromAddress: async () => ({ utxos: [] })
}
global.encoderConnector = {
    createTx: async () => ({ psbt: 'dead', encoding: 'OP_RETURN' }),
    ping: async () => true
}
global.regtestMinerConnector = {
    sendFunds: async () => 'txid-stub',
    ping: async () => true,
    setMiningTime: async () => true,
    setDefaultMiningTime: async () => true
}
global.indexerConnector = { ping: async () => true }

const mockDbResults = {
    issue: { tick: 'TOKF', status: 'valid' },
    send: { tick: 'TOKF', source: 'addr', status: 'valid' },
    credit: { tick: 'TOKF', amount: 100 },
    debit: { tick: 'TOKF', amount: 100 },
    mint: { tick: 'TOKF', status: 'valid' },
    broadcast: { message: 'msg', status: 'valid' },
    dispenser: { status: 'valid' },
    dispense: { status: 'valid' },
    dispenserStatus: { status: 'open' },
    destroy: { status: 'valid' },
    message: { status: 'valid' },
    file: { status: 'valid' },
    sleep: { status: 'valid' },
    sweep: { status: 'valid' },
    dividend: { status: 'valid' },
    callback: { status: 'valid' },
    order: { status: 'valid' },
    orderMatch: { status: 'valid' },
    swap: { status: 'valid' },
    swapMatch: { status: 'valid' },
    batch: { status: 'valid' },
    link: { status: 'valid' },
    list: { status: 'valid' },
    airdrop: { status: 'valid' },
    addressOption: { status: 'valid' },
    coinpay: { status: 'valid' },
    coinpayObligation: { status: 'valid' },
    stake: { status: 'valid' },
    unstake: { status: 'valid' },
}

global.indexerDatabase = {}
for (const [name, row] of Object.entries(mockDbResults)) {
    const capName = name.charAt(0).toUpperCase() + name.slice(1)
    global.indexerDatabase[`waitFor${capName}`] = async () => row
    global.indexerDatabase[`check${capName}`] = async () => row
}
global.indexerDatabase.ping = async () => true

const transactionHelper = require('../../../helpers/core/transactionHelper')

module.exports = { assert, sinon, fc, gen, transactionHelper }
