// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

'use strict'

const assert = require('assert')
const cryptoHelper = require('../helpers/core/cryptoHelper')
const transactionHelper = require('../helpers/core/transactionHelper')
const vmHelper = require('../helpers/vmHelper')
const nativeFeeHelper = require('../helpers/nativeFeeHelper')
const gasHelper = require('../helpers/gasHelper')
const { NO_PRICE_SEED } = require('../helpers/xchainPriceConstants')
const {
    FIXTURE_ID_FLOOR,
    FIXTURE_INSERT_SQL,
    FIXTURE_DELETE_SQL
} = require('../helpers/priceSnapshotHelper')

const XCHAIN_USD_ROUND = 999500082
const COIN_USD_ROUND = 999500083
const XCHAIN_USD = '2.00000000'
const NATIVE_USD = '20.00000000'

const FEE_CONTRACT = `
module.exports = {
    meta: {
        name: 'Execute Fee Record Probe',
        description: 'Provides a deterministic paid execution.',
        version: '1.0.0'
    },
    ping: function () {
        return 'ok';
    }
};`

let caller = null
let contractIndex = null
let feeDestination = null
let pricesSeeded = false

async function q(sql, args) {
    const conn = await indexerDatabase.getConnection()
    try { return await conn.query(sql, args) }
    finally { await conn.release() }
}

async function seedPrice(round, pair, price, tip, timestamp) {
    await q(FIXTURE_DELETE_SQL, [round, pair])
    await q(FIXTURE_INSERT_SQL,
        [FIXTURE_ID_FLOOR, round, pair, price, tip, timestamp])
}

async function seedDustSafePrices() {
    const rows = await q('SELECT block_index, block_time FROM blocks ORDER BY block_index DESC LIMIT 1')
    assert(rows.length, 'the indexer must have a block before prices can be seeded')
    const tip = Number(rows[0].block_index)
    const chainNow = Math.max(Number(rows[0].block_time), Math.floor(Date.now() / 1000))
    await seedPrice(XCHAIN_USD_ROUND, 'XCHAIN/USD', XCHAIN_USD, tip, chainNow - 60)
    await seedPrice(COIN_USD_ROUND, COIN_CODE + '/USD', NATIVE_USD, tip, chainNow - 60)
    pricesSeeded = true
}

async function clearSuitePrices() {
    if (!pricesSeeded) return
    await q(FIXTURE_DELETE_SQL, [XCHAIN_USD_ROUND, 'XCHAIN/USD'])
    await q(FIXTURE_DELETE_SQL, [COIN_USD_ROUND, COIN_CODE + '/USD'])
}

function executeWire() {
    return ['EXECUTE', '0', contractIndex, 'ping'].join('|')
}

async function quoteNativeExecute(wire) {
    const fields = wire.split('|')
    const quote = await indexerConnector.call('feequote', {
        action: fields.shift(),
        params: fields,
        source: caller.address
    })
    assert(quote && !quote.error, 'EXECUTE feequote must succeed: ' + JSON.stringify(quote))
    assert(Number.isSafeInteger(Number(quote.requiredFeeSats)) && Number(quote.requiredFeeSats) > 0,
        'EXECUTE feequote must return positive integer requiredFeeSats')
    assert.strictEqual(quote.feeDestination, feeDestination,
        'EXECUTE feequote must use the configured fee destination')
    return quote
}

async function sendWithNativeFee(wire, feeSats) {
    return transactionHelper.createAndSendTransaction(
        caller, wire, null, [{ address: feeDestination, value: feeSats }],
        null, null, true)
}

async function waitForExecutionTx(txHash, timeMax = 90000) {
    const end = Date.now() + timeMax
    while (Date.now() < end) {
        const rows = await q(
            `SELECT ce.*, ist.status AS status
               FROM contract_executions ce
               JOIN actions a               ON a.action_index = ce.action_index
               JOIN transactions t          ON t.tx_index = a.tx_index
               JOIN index_transactions itx  ON itx.id = t.tx_hash_id
               LEFT JOIN index_statuses ist ON ist.id = ce.status_id
              WHERE itx.hash = ? LIMIT 1`, [txHash])
        if (rows.length) return rows[0]
        await new Promise(resolve => setTimeout(resolve, 1000))
    }
    return null
}

async function executionFeeRow(actionIndex) {
    const rows = await q(
        `SELECT ce.action_index, ce.gas_used, ce.fee_payment_mode,
                f.action_index AS fee_action_index, f.amount, f.gas_cost,
                f.gas_price, f.xchain_amount, f.payment_mode,
                f.native_coin, f.native_coin_amount, f.oracle_round
           FROM contract_executions ce
           LEFT JOIN fees f ON f.action_index = ce.action_index
          WHERE ce.action_index = ? LIMIT 1`, [actionIndex])
    return rows.length ? rows[0] : null
}

// From indexer develop 4b672ff7f every paid EXECUTE writes a fees row, so a missing row
// is a failure, never a skip.
function requireFeeRow(row) {
    assert(row, 'the EXECUTE must have a contract_executions row')
    assert(row.fee_action_index !== null && row.fee_action_index !== undefined,
        'a paid EXECUTE must write a fees row')
    return row
}

function decimalToUnits(value) {
    const match = String(value).match(/^(\d+)(?:\.(\d{0,8}))?$/)
    assert(match, 'expected a non-negative decimal with at most 8 places, got ' + value)
    return BigInt(match[1]) * 100000000n + BigInt((match[2] || '').padEnd(8, '0'))
}

function feeFor(gasCost, gasPrice) {
    const priceUnits = decimalToUnits(gasPrice)
    const feeUnits = BigInt(String(gasCost)) * priceUnits
    const whole = feeUnits / 100000000n
    const fraction = String(feeUnits % 100000000n).padStart(8, '0').replace(/0+$/, '')
    return fraction ? String(whole) + '.' + fraction : String(whole)
}

async function setUp() {
    caller = await cryptoHelper.getNewFundedAddress(
        'execute-fee-record', COIN, NETWORK, null, 'legacy', 0, 3)
    if (COIN_CODE === 'BTC') await gasHelper.ensureGasBalance(caller, '100')
    else {
        if (!['LTC', 'DOGE'].includes(COIN_CODE))
            throw new Error('execute fee record suite does not support chain ' + COIN_CODE)
        if (!NO_PRICE_SEED) await seedDustSafePrices()
        const mode = await nativeFeeHelper.discoverFeeMode()
        assert(mode.enabled, COIN_CODE + ' must have native fees enabled')
        assert(mode.destination, COIN_CODE + ' must expose a native fee destination')
        feeDestination = mode.destination
    }
    const deployed = await vmHelper.sendDeployV0(caller, FEE_CONTRACT, 200000)
    contractIndex = deployed.contract.action_index
}

describe('EXECUTE fee records (live stack)', function () {
    this.timeout(300000)

    before(setUp)
    after(clearSuitePrices)

    it('records the native output and payment mode on LTC or DOGE', async function () {
        if (COIN_CODE === 'BTC') this.skip()

        // stake-teardown-ok: this is an EXECUTE wire, never a STAKE broadcast
        const wire = executeWire()
        const quote = await quoteNativeExecute(wire)
        const paidSats = Number(quote.requiredFeeSats)
        const txHash = await sendWithNativeFee(wire, paidSats)
        const execution = await waitForExecutionTx(txHash)
        assert(execution, 'the native-paid EXECUTE must record an execution')
        assert.strictEqual(execution.status, 'valid')

        const row = await executionFeeRow(execution.action_index)
        requireFeeRow(row)
        assert.strictEqual(Number(row.payment_mode), 1)
        assert.strictEqual(Number(row.fee_payment_mode), 1)
        assert.strictEqual(row.native_coin, COIN_CODE)
        assert.strictEqual(decimalToUnits(row.native_coin_amount), BigInt(paidSats))
        assert(row.oracle_round !== null && row.oracle_round !== undefined,
            'the native fee row must record its oracle round')
        if (pricesSeeded) assert.strictEqual(Number(row.oracle_round), COIN_USD_ROUND)
    })

    it('records the billed metered fee and payment mode on the GAS-balance lane', async function () {
        if (COIN_CODE !== 'BTC') this.skip()

        // A stack with BTC native fees on (the nightly CI stack) would get a native fee
        // output injected by the send helper and pay in mode 1. BTC falls back to the GAS
        // balance only when no output pays the fee destination, so send without one.
        // stake-teardown-ok: this is an EXECUTE wire, never a STAKE broadcast
        const txHash = await transactionHelper.createAndSendTransaction(
            caller, executeWire(), null, [], null, null, true)
        const execution = await waitForExecutionTx(txHash)
        assert(execution, 'the ledger-paid EXECUTE must record an execution')
        assert.strictEqual(execution.status, 'valid')

        const row = await executionFeeRow(execution.action_index)
        requireFeeRow(row)
        assert.strictEqual(Number(row.payment_mode), 2)
        assert.strictEqual(Number(row.fee_payment_mode), 2)
        assert.strictEqual(Number(row.gas_cost), Number(row.gas_used))
        assert.strictEqual(String(row.amount), feeFor(row.gas_cost, row.gas_price))
        assert.strictEqual(String(row.xchain_amount), String(row.amount))
    })
})
