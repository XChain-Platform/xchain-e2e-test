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

const { q, balanceOf } = require('./shared')

// One fill's price in satoshis, per chain. Sized above each chain's dust
// threshold so the triggering payment is relayable, and the amount paid is
// EXACTLY this: the whole point is a payment that covers one fill, not two.
const FILL_SATS = { BTC: 100000, LTC: 100000, DOGE: 10000000 }

// Units of the GIVE token handed over per fill, and the escrow each dispenser
// holds. Equal on purpose: one fill of capacity each.
const GIVE_PER_FILL = 10
// Fill price when the trigger is a token SEND rather than a coin payment.
const PAY_PER_FILL  = 10

const INSUFFICIENT = 'invalid: GET_AMOUNT (insufficient funds)'

function fillSats(){ return FILL_SATS[COIN_CODE] || 100000 }
function fillCoin(){ return (fillSats() / 1e8).toFixed(8) }

// Every dispense row the indexer wrote for one triggering transaction, in the
// order the handler produced them (findMatchingDispensers orders by
// d1.action_index, so the OLDEST dispenser behind the address draws first).
//
// The join runs through `actions` because a multi-dispenser trigger writes
// several action rows against ONE transaction: the first dispense reuses the
// trigger's own action index and each later one gets a fresh index.
async function dispensesForTx(txHash){
    return q(`SELECT d.action_index, d.dispenser_action_index, d.give_amount,
                     d.get_amount, itk.tick AS give_tick, ist.status AS status
                FROM dispenses d
                JOIN actions a               ON a.action_index = d.action_index
                JOIN transactions t          ON t.tx_index = a.tx_index
                JOIN index_transactions it   ON it.id = t.tx_hash_id
                LEFT JOIN index_tickers itk  ON itk.id = d.give_tick_id
                LEFT JOIN index_statuses ist ON ist.id = d.status_id
               WHERE it.hash = ?
               ORDER BY d.action_index ASC`, [txHash])
}

// The dispensers a transaction created, oldest action index first.
async function dispensersForTx(txHash){
    return q(`SELECT dp.action_index, dp.give_amount, dp.give_escrow, dp.get_amount,
                     itk.tick AS give_tick, ist.status AS status
                FROM dispensers dp
                JOIN actions a               ON a.action_index = dp.action_index
                JOIN transactions t          ON t.tx_index = a.tx_index
                JOIN index_transactions it   ON it.id = t.tx_hash_id
                LEFT JOIN index_tickers itk  ON itk.id = dp.give_tick_id
                LEFT JOIN index_statuses ist ON ist.id = dp.status_id
               WHERE it.hash = ?
               ORDER BY dp.action_index ASC`, [txHash])
}

// Numeric balance, because every assertion below is an exact DELTA and the
// shared balanceOf() returns the raw column string.
async function tokenBalance(address, tick){
    return Number(await balanceOf(address, tick))
}

async function waitForDispenses(txHash, expected, timeoutMs = 180000){
    const deadline = Date.now() + timeoutMs
    for (;;){
        const rows = await dispensesForTx(txHash)
        if (rows.length >= expected || Date.now() > deadline) break
        await new Promise(r => setTimeout(r, 2000))
    }
    // Settle, then re-read. Every case asserts an EXACT row count, and
    // returning the instant the count is MET would turn "the indexer wrote one
    // row too many" into a passing race rather than a failure.
    await new Promise(r => setTimeout(r, 8000))
    return dispensesForTx(txHash)
}

async function waitForBalance(address, tick, expected, timeoutMs = 120000){
    const deadline = Date.now() + timeoutMs
    for (;;){
        const value = await tokenBalance(address, tick)
        if (value >= expected || Date.now() > deadline) return value
        await new Promise(r => setTimeout(r, 2000))
    }
}

// DISPENSER v0 as a BATCH sub-command. dispenserHelper builds and SENDS its own
// transaction, so it cannot express a create that lives inside a batch. Built
// from a field LIST rather than concatenated pipes on purpose: the message has
// sixteen fields, six of them empty and adjacent, and a miscounted separator
// produces a create that parses into different columns rather than one that
// fails loudly.
function dispenserCmd(giveTick, giveAmount, giveEscrow, getAmount, getAddress, memo){
    return [
        'DISPENSER', '0',
        COIN_CODE,      // GIVE_COIN
        giveTick,       // GIVE_TICK
        giveAmount,     // GIVE_AMOUNT
        '',             // GIVE_OWNERSHIP
        giveEscrow,     // GIVE_ESCROW
        COIN_CODE,      // GET_COIN
        '',             // GET_TICK (native-coin priced)
        getAmount,      // GET_AMOUNT
        getAddress,     // GET_ADDRESS
        '',             // FIAT_CODE
        '',             // FIAT_AMOUNT
        '',             // ORACLE_ADDRESS
        '',             // EXPIRATION (free window, so the create is charged nothing)
        '',             // ALLOW_LIST
        '',             // BLOCK_LIST
        memo || ''
    ].join('|')
}

function statuses(rows){ return rows.map(r => r.status) }

module.exports = {
    FILL_SATS, GIVE_PER_FILL, PAY_PER_FILL, INSUFFICIENT, fillSats, fillCoin, dispensesForTx,
    dispensersForTx, tokenBalance, waitForDispenses, waitForBalance, dispenserCmd, statuses
}
