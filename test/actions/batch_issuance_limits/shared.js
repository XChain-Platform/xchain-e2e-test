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

const assert = require('assert')

const GAS_TICK = 'XCHAIN'

// Gas schedule (xchain-indexer/src/coins/<COIN>.js GAS_SCHEDULE x GAS_PRICE).
const XCHAIN_PER_ISSUE          = 1.0   // ISSUE          100000 gas
const XCHAIN_PER_CHILD_ISSUE    = 0.5   // ISSUE_SUBTOKEN  50000 gas
const ORDER_GAS_PER_DAY         = 550   // EXPIRATION_PER_DAY
const ORDER_FREE_DAYS           = 90    // UNIFIED_EXPIRATION_FEE_FREE_DAYS

// Mutable lane state, shared by reference across the registration modules.
const state = {
    FEE_DEST: null,            // resolvable FEE_DESTINATION, or null on a pure gas stack
    GAS_MODE: false,           // this chain can pay an issuance fee from an XCHAIN balance
    SATS_PER_XCHAIN: 0,        // set per fee case by prepareFeeFixture()
    FEE_CASE_REPRICED: false   // the FEE_CASE rows are live; restoreFeeFixture() must delete them
}

async function q(sql, args){
    const conn = await indexerDatabase.getConnection()
    try { return await conn.query(sql, args) } finally { await conn.release() }
}

// Every action row the indexer wrote for one transaction. An over-limit BATCH must
// produce exactly ONE (the BATCH itself); this is how "no sub-command executed" is
// proven rather than inferred from the absence of issue rows.
async function actionsForTx(txHash){
    return q(`SELECT a.action_index, ia.action AS action
                FROM actions a
                JOIN transactions t          ON t.tx_index = a.tx_index
                JOIN index_transactions it   ON it.id = t.tx_hash_id
                LEFT JOIN index_actions ia   ON ia.id = a.action_id
               WHERE it.hash = ?
               ORDER BY a.action_index ASC`, [txHash])
}

async function issuesForTx(txHash){
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

async function ordersForTx(txHash){
    return q(`SELECT o.action_index, ist.status AS status
                FROM orders o
                JOIN actions a               ON a.action_index = o.action_index
                JOIN transactions t          ON t.tx_index = a.tx_index
                JOIN index_transactions it   ON it.id = t.tx_hash_id
                LEFT JOIN index_statuses ist ON ist.id = o.status_id
               WHERE it.hash = ?
               ORDER BY o.action_index ASC`, [txHash])
}

async function debitsForTx(txHash, tick){
    return q(`SELECT d.action_index, d.amount
                FROM debits d
                JOIN actions a             ON a.action_index = d.action_index
                JOIN transactions t        ON t.tx_index = a.tx_index
                JOIN index_transactions it ON it.id = t.tx_hash_id
                JOIN index_tickers itk     ON itk.id = d.tick_id
               WHERE it.hash = ? AND itk.tick = ?
               ORDER BY d.action_index ASC`, [txHash, tick])
}

async function tokenRow(tick){
    const rows = await q(`SELECT itk.tick AS tick, ia.address AS owner, tk.supply, tk.escrow_action_index
                            FROM tokens tk
                            JOIN index_tickers itk    ON itk.id = tk.tick_id
                            LEFT JOIN index_addresses ia ON ia.id = tk.owner_id
                           WHERE itk.tick = ?`, [tick])
    return rows.length ? rows[0] : null
}

// Gas expectations are the gas schedule EXACTLY. LEDGER_AMOUNT_PRECISION is armed on
// regtest, so the ledger stores amounts exactly and rounds once at balance projection
// rather than quantizing each row to the gas tick's decimals.

async function feesForTx(txHash){
    return q(`SELECT f.action_index, f.gas_cost, f.amount, f.payment_mode
                FROM fees f
                JOIN actions a             ON a.action_index = f.action_index
                JOIN transactions t        ON t.tx_index = a.tx_index
                JOIN index_transactions it ON it.id = t.tx_hash_id
               WHERE it.hash = ?
               ORDER BY f.action_index ASC`, [txHash])
}

async function tickerId(tick){
    const rows = await q("SELECT id FROM index_tickers WHERE tick = ? LIMIT 1", [tick])
    return rows.length ? Number(rows[0].id) : null
}

async function balanceOf(address, tick){
    const rows = await q(`SELECT b.amount FROM balances b
                            JOIN index_addresses ia ON ia.id = b.address_id
                            JOIN index_tickers itk  ON itk.id = b.tick_id
                           WHERE ia.address = ? AND itk.tick = ?`, [address, tick])
    return rows.length ? String(rows[0].amount) : '0'
}

async function chainTipTime(){
    const rows = await q("SELECT block_time FROM blocks ORDER BY block_index DESC LIMIT 1")
    return rows.length ? Number(rows[0].block_time) : Math.floor(Date.now() / 1000)
}

// Poll until the indexer has written every action row of a batch transaction, so a
// count assertion cannot race a half-processed block. Returns the rows.
async function waitForActionCount(txHash, expected, timeoutMs = 180000){
    const deadline = Date.now() + timeoutMs
    let rows = []
    for (;;){
        rows = await actionsForTx(txHash)
        if (rows.length >= expected || Date.now() > deadline) return rows
        await new Promise(r => setTimeout(r, 2000))
    }
}

async function waitForIssueCount(txHash, expected, timeoutMs = 180000){
    const deadline = Date.now() + timeoutMs
    let rows = []
    for (;;){
        rows = await issuesForTx(txHash)
        if (rows.length >= expected || Date.now() > deadline) return rows
        await new Promise(r => setTimeout(r, 2000))
    }
}

function issueCmd(tick, maxSupply, maxMint, mintSupply, description){
    // ISSUE v0: VERSION|TICK|MAX_SUPPLY|MAX_MINT|DECIMALS|DESCRIPTION|MINT_SUPPLY|...
    // Trailing optional fields are omitted to keep a 51-command batch inside the
    // legacy data lane's MAX_ACTION_DATA_LENGTH.
    return "ISSUE|0|"+tick+"|"+maxSupply+"|"+maxMint+"|0|"+description+"|"+mintSupply
}

// An ISSUE sent with NO fee output, so its issuance fee is metered against the
// source's XCHAIN balance. issueHelper cannot express this: it goes through
// transactionHelper's default path, which injects a fee output wherever the stack has
// a FEE_DESTINATION, and a natively-paid ISSUE debits no gas at all. A6's arithmetic
// is a gas balance, so its setup ISSUE has to take this path.
async function sendGasPaidIssue(addressInfo, tick, description){
    const transactionHelper = require('../../helpers/core/transactionHelper')
    const txHash = await transactionHelper.createAndSendTransaction(
        addressInfo, issueCmd(tick, 100000, 100000, 10, description), null, [], null, null, true)
    const row = await indexerDatabase.waitForIssue({
        source: addressInfo["address"], tick: tick, txHash: txHash, status: 'valid'
    }, 120000)
    assert(row, "gas-paid ISSUE " + tick + " should be valid")
    return { txHash, issue: row }
}

module.exports = {
    GAS_TICK, XCHAIN_PER_ISSUE, XCHAIN_PER_CHILD_ISSUE, ORDER_GAS_PER_DAY, ORDER_FREE_DAYS,
    state, q, actionsForTx, issuesForTx, ordersForTx, debitsForTx, tokenRow, feesForTx,
    tickerId, balanceOf, chainTipTime, waitForActionCount, waitForIssueCount, issueCmd,
    sendGasPaidIssue
}
