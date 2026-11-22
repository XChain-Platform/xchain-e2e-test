// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.
//
// Shared constants, chain readers and wire builders for the BATCH_COST_WEIGHTING
// acceptance suite. See ../batch_cost_weighting.test.js for the scenario overview.

const assert = require('assert')

// Fee lane, resolved once by initLane().
const lane = { feeDest: null, nativeFee: null }

async function initLane() {
    lane.nativeFee = require('../../../helpers/nativeFeeHelper')
    const mode = await lane.nativeFee.discoverFeeMode()
    lane.feeDest = mode.destination || null
    console.log('lane: COIN=' + COIN_CODE + ' feeDestination=' + (lane.feeDest ? 'resolved' : 'none') +
        ' budget=' + WEIGHT_BUDGET + ' vmWeight=' + VM_WEIGHT + ' fanOutWeight=' + FANOUT_WEIGHT)
}

const WEIGHT_BUDGET  = 250
const VM_WEIGHT      = 30   // DEPLOY, EXECUTE, XEXEC
const FANOUT_WEIGHT  = 25   // AIRDROP, DIVIDEND

// Sub-command counts either side of each class's budget boundary.
const VM_AT_BUDGET       = Math.floor(WEIGHT_BUDGET / VM_WEIGHT)          // 8  -> 240
const VM_OVER_BUDGET     = VM_AT_BUDGET + 1                               // 9  -> 270
const FANOUT_AT_BUDGET   = Math.floor(WEIGHT_BUDGET / FANOUT_WEIGHT)      // 10 -> 250
const FANOUT_OVER_BUDGET = FANOUT_AT_BUDGET + 1                           // 11 -> 275

// Gas schedule (xchain-indexer/src/coins/<COIN>.js GAS_SCHEDULE x GAS_PRICE), used only
// to size the at-budget ISSUE batch's one fee output.
const XCHAIN_PER_ISSUE       = 1.0
const XCHAIN_PER_CHILD_ISSUE = 0.5

const CONTRACT = `
    module.exports = {
        meta: { name: 'Batch Cost Counter', description: 'Counter contract used to weigh the gas cost of a batched execution.', version: '1.0.0' },
        initialize: function() {
            xchain.state.set('count', '0');
        },
        bump: function() {
            let count = parseInt(xchain.state.get('count') || '0');
            xchain.state.set('count', String(count + 1));
            return String(count + 1);
        }
    };
`

async function q(sql, args){
    const conn = await indexerDatabase.getConnection()
    try { return await conn.query(sql, args) } finally { await conn.release() }
}

// Every action row the indexer wrote for one transaction. A batch refused by the budget
// must produce exactly ONE (the BATCH itself), which is how "no sub-command executed" is
// proven rather than inferred from the absence of per-action rows.
async function actionsForTx(txHash){
    return q(`SELECT a.action_index, a.block_index, ia.action AS action
                FROM actions a
                JOIN transactions t          ON t.tx_index = a.tx_index
                JOIN index_transactions it   ON it.id = t.tx_hash_id
                LEFT JOIN index_actions ia   ON ia.id = a.action_id
               WHERE it.hash = ?
               ORDER BY a.action_index ASC`, [txHash])
}

async function issueStatusesForTx(txHash){
    return q(`SELECT i.action_index, itk.tick AS tick, ist.status AS status
                FROM issues i
                JOIN actions a               ON a.action_index = i.action_index
                JOIN transactions t          ON t.tx_index = a.tx_index
                JOIN index_transactions it   ON it.id = t.tx_hash_id
                LEFT JOIN index_tickers itk  ON itk.id = i.tick_id
                LEFT JOIN index_statuses ist ON ist.id = i.status_id
               WHERE it.hash = ?
               ORDER BY i.action_index ASC`, [txHash])
}

async function executionStatusesForTx(txHash){
    return q(`SELECT ce.action_index, ce.contract_index, ce.method_name, ce.gas_used,
                     ist.status AS status
                FROM contract_executions ce
                JOIN actions a               ON a.action_index = ce.action_index
                JOIN transactions t          ON t.tx_index = a.tx_index
                JOIN index_transactions it   ON it.id = t.tx_hash_id
                LEFT JOIN index_statuses ist ON ist.id = ce.status_id
               WHERE it.hash = ?
               ORDER BY ce.action_index ASC`, [txHash])
}

async function airdropStatusesForTx(txHash){
    return q(`SELECT ad.action_index, ad.amount, ist.status AS status
                FROM airdrops ad
                JOIN actions a               ON a.action_index = ad.action_index
                JOIN transactions t          ON t.tx_index = a.tx_index
                JOIN index_transactions it   ON it.id = t.tx_hash_id
                LEFT JOIN index_statuses ist ON ist.id = ad.status_id
               WHERE it.hash = ?
               ORDER BY ad.action_index ASC`, [txHash])
}

async function contractsForTx(txHash){
    return q(`SELECT c.action_index, ist.status AS status
                FROM contracts c
                JOIN actions a               ON a.action_index = c.action_index
                JOIN transactions t          ON t.tx_index = a.tx_index
                JOIN index_transactions it   ON it.id = t.tx_hash_id
                LEFT JOIN index_statuses ist ON ist.id = c.status_id
               WHERE it.hash = ?
               ORDER BY c.action_index ASC`, [txHash])
}

// Poll until the indexer has written every action row of a batch, so a count assertion
// cannot race a half-processed block.
async function waitForActionCount(txHash, expected, timeoutMs = 300000){
    const deadline = Date.now() + timeoutMs
    for (;;){
        const rows = await actionsForTx(txHash)
        if (rows.length >= expected || Date.now() > deadline) return rows
        await new Promise(r => setTimeout(r, 2000))
    }
}

// Satoshis one XCHAIN of nominal fee converts to, off the price pair the indexer will
// actually value the fee against (highest round wins, as every seed site here relies on).
async function satsPerXchain(){
    await lane.nativeFee.seedGlobalPrices(true)
    const rows = await q(`SELECT coin_pair, price, round_number
                            FROM price_snapshots
                           WHERE coin_pair IN ('XCHAIN/USD', ?) AND status = 'finalized'
                           ORDER BY round_number DESC`, [COIN_CODE + '/USD'])
    const pick = pair => rows.find(r => r.coin_pair === pair)
    const xchain = pick('XCHAIN/USD'), coin = pick(COIN_CODE + '/USD')
    assert(xchain && coin, 'no finalized XCHAIN/USD + ' + COIN_CODE + '/USD snapshots to price a fee against')
    return Math.round(Number(xchain.price) / Number(coin.price) * 1e8)
}

// ISSUE v0 with trailing optional fields omitted, so a 251-command batch stays as small
// as the wire allows.
function issueCmd(tick, maxSupply, maxMint, mintSupply, description){
    return "ISSUE|0|"+tick+"|"+maxSupply+"|"+maxMint+"|0|"+description+"|"+mintSupply
}

function sendCmd(tick, amount, destination){
    return "SEND|0|"+tick+"|"+amount+"|"+destination+"|w"
}

function executeCmd(contractIndex, method){
    return "EXECUTE|0|"+contractIndex+"|"+method
}

function airdropCmd(tick, amount, listActionIndex, memo){
    return "AIRDROP|0|"+tick+"|"+amount+"|"+listActionIndex+"|"+memo
}

function deployCmd(code, gasLimit){
    return "DEPLOY|0|"+Buffer.from(code, 'utf8').toString('base64')+"|"+gasLimit
}

// Batch send options that let the whole batch's nominal fee be covered at once. On a gas
// stack the helper injects nothing and the source's XCHAIN balance is metered instead.
function wholeBatchFee(sats){
    if (!lane.feeDest) return { skipNativeFeeInjection: true }
    return { skipNativeFeeInjection: true, customOutputs: [{ address: lane.feeDest, value: Math.ceil(sats) }] }
}

// The envelope lane, and the only lane the A2 pair can ride: 250 real ISSUE sub-commands
// compile to ~10 KB and the chunk lanes refuse anything over 8192 bytes. It needs a
// segwit source and the source's public key as the envelope internal key.
function envelopeLane(addressInfo){
    return {
        outputType: 'TAPROOT',
        compressedPubKey: Buffer.from(addressInfo["publicKey"]).toString('hex')
    }
}

// Chain evidence line. The batch row carries no height, so the block is read back off
// the BATCH action row, which is the same row the verdict assertions read.
async function log(label, result){
    const rows = await actionsForTx(result.txHash)
    const block = rows.length ? rows[0].block_index : '?'
    console.log(label + ' txHash=' + result.txHash + ' block=' + block +
        ' status=' + (result.batch ? result.batch.status : 'NO ROW'))
}

module.exports = {
    WEIGHT_BUDGET, VM_WEIGHT, FANOUT_WEIGHT, VM_AT_BUDGET, VM_OVER_BUDGET, FANOUT_AT_BUDGET, FANOUT_OVER_BUDGET, XCHAIN_PER_ISSUE, XCHAIN_PER_CHILD_ISSUE, CONTRACT, lane, initLane, q, actionsForTx, issueStatusesForTx, executionStatusesForTx, airdropStatusesForTx, contractsForTx, waitForActionCount, satsPerXchain, issueCmd, sendCmd, executeCmd, airdropCmd, deployCmd, wholeBatchFee, envelopeLane, log,
}
