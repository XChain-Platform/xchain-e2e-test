// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

/*
 * Live LTC/DOGE rail. The indexer process and this Mocha process must both have
 * XC_EXECUTE_NATIVE_METERED_GAS_REGTEST_ACTIVATION=0. From the repository root:
 *
 * XC_EXECUTE_NATIVE_METERED_GAS_REGTEST_ACTIVATION=0 \
 * node ./node_modules/.bin/mocha \
 * --timeout 0 --exit --require ./test/initial_check.test.js \
 * test/actions/native_execute_metered_gas.test.js
 *
 * Setting the variable only on this command is not enough. The already-running
 * indexer reads the height gate from its own process environment.
 */

'use strict'

const assert = require('assert')
const cryptoHelper = require('../helpers/core/cryptoHelper')
const transactionHelper = require('../helpers/core/transactionHelper')
const vmHelper = require('../helpers/vmHelper')
const nativeFeeHelper = require('../helpers/nativeFeeHelper')
const addressHelper = require('../helpers/addressHelper')
const {
    FIXTURE_ID_FLOOR,
    FIXTURE_INSERT_SQL,
    FIXTURE_DELETE_SQL
} = require('../helpers/priceSnapshotHelper')

const ARMING_ENV = 'XC_EXECUTE_NATIVE_METERED_GAS_REGTEST_ACTIVATION'
const EXECUTE_BASE_GAS = 1000
const EXECUTE_GAS_CEILING = 1000000
const XCHAIN_USD_ROUND = 999500080
const COIN_USD_ROUND = 999500081

// At XCHAIN/USD=2 and native/USD=20, VM_EXECUTE_BASE costs exactly 100,000
// sats. That is DOGE's output floor as well as a convenient observable base fee.
const XCHAIN_USD = '2.00000000'
const NATIVE_USD = '20.00000000'

// The two heavy entry points are intentionally separate so a status-agnostic
// lookup cannot confuse the quoted-fee run with the base-fee run.
const METERED_CONTRACT = `
module.exports = {
    meta: {
        name: 'Native Metered Gas Probe',
        description: 'Provides cheap and deterministic gas-heavy execute methods.',
        version: '1.0.0'
    },
    ping: function () {
        return 'ok';
    },
    heavyQuoted: function () {
        var n = parseInt(xchain.getInputParam(0), 10);
        var x = 0;
        for (var i = 0; i < n; i++) x = (x + i) % 1000003;
        xchain.state.set('heavyQuoted', String(x));
        return String(x);
    },
    heavyBase: function () {
        var n = parseInt(xchain.getInputParam(0), 10);
        var x = 0;
        for (var i = 0; i < n; i++) x = (x + i) % 1000003;
        xchain.state.set('heavyBase', String(x));
        return String(x);
    }
};`

const HEAVY_ITERATIONS = '50000'

let caller = null
let contractIndex = null
let feeDestination = null
let baseFeeSats = null
let quotedHeavyFee = null

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
}

async function clearSuitePrices() {
    await q(FIXTURE_DELETE_SQL, [XCHAIN_USD_ROUND, 'XCHAIN/USD'])
    await q(FIXTURE_DELETE_SQL, [COIN_USD_ROUND, COIN_CODE + '/USD'])
}

function executeWire(method, params) {
    return ['EXECUTE', '0', contractIndex, method].concat(params || []).join('|')
}

async function quoteExecute(wire) {
    const fields = wire.split('|')
    const quote = await indexerConnector.call('feequote', {
        action: fields.shift(),
        params: fields,
        source: caller.address
    })
    assert(!quote.error, 'EXECUTE feequote must not error: ' + JSON.stringify(quote))
    assert.strictEqual(quote.valid, true,
        'the dry-run-backed EXECUTE quote must validate the call')
    assert.strictEqual(quote.validated, true,
        'the activated EXECUTE quote must be backed by a dry run')
    assert.notStrictEqual(quote.staticQuote, true,
        'the activated EXECUTE quote must not use the pre-activation static base quote')
    assert.strictEqual(quote.feeDestination, feeDestination,
        'the quote must name the configured native fee destination')
    assert(Number.isSafeInteger(Number(quote.gasCost)) && Number(quote.gasCost) >= EXECUTE_BASE_GAS,
        'the quote must return a safe integer gas budget at or above the base')
    assert(Number.isSafeInteger(Number(quote.estimatedGasCost)) && Number(quote.estimatedGasCost) > 0,
        'the quote must disclose the dry-run gas estimate')
    assert(Number(quote.gasSafetyMarginPercent) > 0,
        'the quote must disclose a positive gas safety margin')
    const expectedBudget = Math.min(EXECUTE_GAS_CEILING, Math.max(EXECUTE_BASE_GAS,
        Math.ceil(Number(quote.estimatedGasCost) *
            (100 + Number(quote.gasSafetyMarginPercent)) / 100)))
    assert.strictEqual(Number(quote.gasCost), expectedBudget,
        'the quoted gas budget must be the estimate plus its margin, within protocol bounds')
    assert(Number.isSafeInteger(Number(quote.requiredFeeSats)) && Number(quote.requiredFeeSats) > 0,
        'the quote must return a positive integer requiredFeeSats')
    return quote
}

async function sendWithNativeFee(wire, feeSats) {
    return transactionHelper.createAndSendTransaction(
        caller,
        wire,
        null,
        [{ address: feeDestination, value: feeSats }],
        null,
        null,
        true
    )
}

async function waitForExecutionTx(txHash, timeMax = 90000) {
    const end = Date.now() + timeMax
    while (Date.now() < end) {
        const rows = await q(
            `SELECT e.*, ia.address AS caller, ist.status AS status
               FROM contract_executions e
               JOIN actions a              ON a.action_index = e.action_index
               JOIN transactions t         ON t.tx_index = a.tx_index
               JOIN index_transactions itx ON itx.id = t.tx_hash_id
               JOIN index_addresses ia     ON ia.id = e.caller_id
               LEFT JOIN index_statuses ist ON ist.id = e.status_id
              WHERE itx.hash = ? LIMIT 1`, [txHash])
        if (rows.length) return rows[0]
        await new Promise(resolve => setTimeout(resolve, 1000))
    }
    return null
}

// EXECUTE writes no `fees` row: its native fee is the output the confirmed transaction
// pays to the fee destination, and nothing can hand a confirmed output back. So the
// kept fee is proved on the transaction itself.
async function assertNativeFeeKept(txHash, paidSats) {
    const raw = await nodeConnector['_rpc']('getrawtransaction', [txHash, true])
    const out = addressHelper.findVoutPayingAddress(raw, feeDestination)
    assert(out, 'the EXECUTE transaction must pay the native fee destination')
    assert.strictEqual(Math.round(Number(out.value) * 1e8), paidSats,
        'the native fee output must equal the amount that was paid')
}

async function setUp(suite) {
    if (COIN_CODE === 'BTC') {
        console.log('Skipping native EXECUTE metered gas: BTC has no mandatory native-fee lane')
        suite.skip()
        return
    }

    const armedAt = process.env[ARMING_ENV]
    if (armedAt === undefined || armedAt === '') {
        console.log('Skipping native EXECUTE metered gas: ' + ARMING_ENV +
            ' is absent from the test process and must also be set on the indexer process')
        suite.skip()
        return
    }
    assert.match(armedAt, /^\d+$/, ARMING_ENV + ' must be a non-negative block height')
    assert(['LTC', 'DOGE'].includes(COIN_CODE),
        'native EXECUTE metering is a live LTC/DOGE rail, got ' + COIN_CODE)
    const tipRows = await q('SELECT MAX(block_index) AS height FROM blocks')
    assert(tipRows.length && Number(tipRows[0].height) >= Number(armedAt),
        ARMING_ENV + '=' + armedAt + ' is not active at the current indexer tip')

    const mode = await nativeFeeHelper.discoverFeeMode()
    assert(mode.enabled, COIN_CODE + ' must have native fees enabled')
    assert(mode.destination, COIN_CODE + ' must expose a native fee destination')
    feeDestination = mode.destination

    caller = await cryptoHelper.getNewFundedAddress(
        'native-execute-metered-gas', COIN, NETWORK, null, 'legacy', 0, 4)
    const deployed = await vmHelper.sendDeployV0(caller, METERED_CONTRACT, 300000)
    contractIndex = deployed.contract.action_index

    await seedDustSafePrices()

    const cheapQuote = await quoteExecute(executeWire('ping', []))
    assert.strictEqual(Number(cheapQuote.gasCost), EXECUTE_BASE_GAS,
        'the cheap call must quote only VM_EXECUTE_BASE')
    baseFeeSats = Number(cheapQuote.requiredFeeSats)
    assert.strictEqual(baseFeeSats, nativeFeeHelper.FLAT_FEE_SATS,
        'the dust-safe price fixture must make the base fee exactly 100,000 sats')

    quotedHeavyFee = await quoteExecute(executeWire('heavyQuoted', [HEAVY_ITERATIONS]))
    assert(Number(quotedHeavyFee.gasCost) > EXECUTE_BASE_GAS,
        'the heavy call quote must include metered gas above the base')
    assert(Number(quotedHeavyFee.requiredFeeSats) > baseFeeSats,
        'the heavy call quote must cost more than the base fee')
}

describe('Native EXECUTE metered gas (live stack)', function () {
    this.timeout(300000)

    before(async function () { await setUp(this) })
    after(async function () {
        if (contractIndex !== null) await clearSuitePrices()
    })

    it('accepts a heavy call paid at its exact quote and bills within the paid gas budget', async function () {
        // stake-teardown-ok: an EXECUTE contract call wire, never a STAKE
        const wire = executeWire('heavyQuoted', [HEAVY_ITERATIONS])
        const paidSats = Number(quotedHeavyFee.requiredFeeSats)
        const txHash = await sendWithNativeFee(wire, paidSats)
        const row = await waitForExecutionTx(txHash)

        assert(row, 'the exactly quoted heavy EXECUTE must record an execution')
        assert.strictEqual(row.status, 'valid', 'the exactly quoted heavy EXECUTE must be valid')
        assert(Number(row.gas_used) > EXECUTE_BASE_GAS,
            'the heavy call must actually consume more than the base gas')
        assert(Number(row.gas_used) <= Number(row.gas_limit),
            'recorded billed gas must stay within the gas bought by the native output')
        assert(Number(row.gas_limit) >= Number(quotedHeavyFee.gasCost),
            'the paid ceiling must cover the quote gas estimate and its margin')
        await assertNativeFeeKept(txHash, paidSats)
    })

    it('fails a heavy call paid only at the base fee as out-of-gas and keeps the fee', async function () {
        const txHash = await sendWithNativeFee(
            executeWire('heavyBase', [HEAVY_ITERATIONS]), baseFeeSats)
        const row = await waitForExecutionTx(txHash)

        assert(row, 'the underfunded heavy EXECUTE must record an execution')
        assert.strictEqual(row.status, 'out_of_resource',
            'the underfunded heavy EXECUTE must use the consensus resource status')
        assert.match(String(row.error_message || ''), /out_of_gas:/,
            'the failure detail must identify the paid gas ceiling')
        assert(Number(row.gas_limit) >= EXECUTE_BASE_GAS,
            'a base-fee output must buy at least the base gas budget')
        assert(Number(row.gas_limit) < Number(quotedHeavyFee.gasCost),
            'a base-fee output must not buy the quoted heavy-call budget')
        assert.strictEqual(Number(row.gas_used), Number(row.gas_limit),
            'an out-of-gas call must bill the full paid gas budget')
        await assertNativeFeeKept(txHash, baseFeeSats)
    })

    it('accepts a cheap call paid at the base fee', async function () {
        const txHash = await sendWithNativeFee(executeWire('ping', []), baseFeeSats)
        const row = await waitForExecutionTx(txHash)

        assert(row, 'the base-paid cheap EXECUTE must record an execution')
        assert.strictEqual(row.status, 'valid', 'the base-paid cheap EXECUTE must be valid')
        assert(Number(row.gas_used) <= EXECUTE_BASE_GAS,
            'the cheap call must fit within the base gas budget')
        await assertNativeFeeKept(txHash, baseFeeSats)
    })
})
