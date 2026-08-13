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
// XC-1454 review finding F12: "ORDER escrows the parent, then child ISSUEs" in ONE batch.
//
// WHY THIS SHAPE AND NOT ANOTHER. Every other read on the child-issuance path is
// scoped as-of the acting ACTION_INDEX (getTokenInfo takes `a1.action_index < ?`,
// balances take a block+action bound), so a sub-command deep in a batch sees exactly
// the state its predecessors left and a replay reconstructs the same view. The ONE
// exception is issue.js's ownership-escrow guard: it calls
// indexerDb.isOwnershipEscrowed(parent), which reads `tokens.escrow_action_index`
// with NO action-index bound at all (xchain-indexer/src/db.js getTokenEscrow). Before
// XC-1454 that hardly mattered, because a batch could carry at most one ISSUE and
// therefore could not both open the escrow and issue a child in one transaction.
// R1's dotted-TICK exemption makes that transaction composable, so the unscoped read
// becomes reachable mid-batch and is exactly where a live run and a replay could
// disagree.
//
// What this suite proves on chain:
//   1. the verdict itself: an ORDER escrowing the parent invalidates the child ISSUEs
//      that follow it IN THE SAME BATCH, with the same status string a separate
//      transaction would have produced;
//   2. that the verdict is decided at the sub-command's POSITION, not for the batch as
//      a whole (a child ahead of the ORDER is valid, one behind it is not), which is
//      the property a sequential replay reproduces and an unscoped read evaluated
//      once per transaction would not;
//   3. that the stored verdict is durable: releasing the escrow afterwards does not
//      rewrite the rows the batch wrote, so a later reader of the ledger sees what the
//      block decided;
//   4. that the same shape re-run at a later height produces byte-identical statuses.
//
// Read together, those four are the replay-stability witness available without
// re-indexing the chain: the outcome is a pure function of the batch and of the escrow
// state at each sub-command's position, both of which a from-genesis replay
// reconstructs in the same order.

const assert = require('assert')
const cryptoHelper = require('../cryptoHelper')
const issueHelper = require('../helpers/issueHelper')
const orderHelper = require('../helpers/orderHelper')
const batchHelper = require('../helpers/batchHelper')

const ESCROWED_CHILD = 'invalid: TICK (parent ownership escrowed)'

// Carried between cases at module scope rather than on mocha's `this`, which is a
// fresh context object per test and shares nothing with the next one.
const caseState = {}

async function q(sql, args){
    const conn = await indexerDatabase.getConnection()
    try { return await conn.query(sql, args) } finally { await conn.release() }
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

async function tokenRow(tick){
    const rows = await q(`SELECT itk.tick AS tick, ia.address AS owner, tk.escrow_action_index
                            FROM tokens tk
                            JOIN index_tickers itk       ON itk.id = tk.tick_id
                            LEFT JOIN index_addresses ia ON ia.id = tk.owner_id
                           WHERE itk.tick = ?`, [tick])
    return rows.length ? rows[0] : null
}

async function chainTipTime(){
    const rows = await q("SELECT block_time FROM blocks ORDER BY block_index DESC LIMIT 1")
    return rows.length ? Number(rows[0].block_time) : Math.floor(Date.now() / 1000)
}

async function waitForRows(fn, txHash, expected, timeoutMs = 180000){
    const deadline = Date.now() + timeoutMs
    for (;;){
        const rows = await fn(txHash)
        if (rows.length >= expected || Date.now() > deadline) return rows
        await new Promise(r => setTimeout(r, 2000))
    }
}

function issueCmd(tick, description){
    return "ISSUE|0|" + tick + "|1000|1000|0|" + description + "|10"
}

// ORDER v0 listing the GIVE tick's OWNERSHIP (GIVE_AMOUNT empty, GIVE_OWNERSHIP=1),
// which is what sets tokens.escrow_action_index (order.js setTokenEscrow).
function ownershipOrderCmd(giveTick, getTick, getAddress, expiration){
    return "ORDER|0|" + COIN_CODE + "|" + giveTick + "||1|" + COIN_CODE + "|" + getTick +
           "|5||" + getAddress + "|" + expiration + "|||F12"
}

describe('BATCH: ORDER escrows the parent, then child ISSUEs (F12)', function () {

    // Shared issuer: one funded address, one settlement tick, several parents. Each
    // case gets its own parent so the escrow state of one cannot leak into another.
    let addr = null, address = null, settle = null

    before(async function () {
        addr    = await cryptoHelper.getNewFundedAddress("F12", COIN, NETWORK, null, "legacy", 0, 2)
        address = addr["address"]
        settle  = "F12S" + address.substring(address.length - 8)
        await issueHelper.sendIssueV0(addr, settle, 1000, 1000, 0, "F12 settlement tick", 100)
    })

    async function newParent(suffix){
        const tick = "F12P" + suffix + address.substring(address.length - 8)
        await issueHelper.sendIssueV0(addr, tick, 100000, 100000, 0, "F12 parent " + suffix, 10)
        const tk = await tokenRow(tick)
        assert(tk, "parent " + tick + " should exist")
        assert.strictEqual(tk.escrow_action_index, null, "a fresh parent is not escrowed")
        return tick
    }

    it('invalidates children that follow the escrowing ORDER in the same batch', async function () {
        const parent = await newParent("A")
        const exp    = (await chainTipTime()) + 30 * 86400

        const result = await batchHelper.sendBatch(addr, [
            ownershipOrderCmd(parent, settle, address, exp),
            issueCmd(parent + ".1", "c1"),
            issueCmd(parent + ".2", "c2")
        ], { status: 'valid' })
        assert(result.batch, "the BATCH itself is valid; the rejection is per-child")

        const orders = await waitForRows(ordersForTx, result.txHash, 1)
        assert.strictEqual(orders.length, 1, "the ORDER sub-command lands its own record")
        assert.strictEqual(orders[0].status, 'valid', "the ownership listing is valid")

        const issues = await waitForRows(issuesForTx, result.txHash, 2)
        console.log("F12 case A txHash=" + result.txHash +
            " order_action_index=" + orders[0].action_index +
            " child statuses=" + JSON.stringify(issues.map(r => r.tick + ' -> ' + r.status)))
        assert.strictEqual(issues.length, 2, "both children get their own record")
        for (const row of issues)
            assert.strictEqual(row.status, ESCROWED_CHILD,
                "a child issued behind the escrowing ORDER must be rejected, got " + row.status)

        // The escrow the ORDER opened is the one the children read.
        const tk = await tokenRow(parent)
        assert.strictEqual(Number(tk.escrow_action_index), Number(orders[0].action_index),
            "the parent's escrow points at the ORDER sub-command that opened it")
        // No token row for either child.
        assert.strictEqual(await tokenRow(parent + ".1"), null)
        assert.strictEqual(await tokenRow(parent + ".2"), null)

        caseState.caseA = { txHash: result.txHash, parent: parent,
                            orderActionIndex: Number(orders[0].action_index),
                            statuses: issues.map(r => r.status) }
    })

    it('decides per sub-command POSITION: a child AHEAD of the ORDER is valid', async function () {
        const parent = await newParent("B")
        const exp    = (await chainTipTime()) + 30 * 86400

        // The unscoped read is what makes this interesting: if the escrow were
        // evaluated once for the whole transaction (or read as "current" state at
        // some later time), BOTH children would share a verdict. They must not.
        const result = await batchHelper.sendBatch(addr, [
            issueCmd(parent + ".before", "ahead"),
            ownershipOrderCmd(parent, settle, address, exp),
            issueCmd(parent + ".after", "behind")
        ], { status: 'valid' })
        assert(result.batch)

        const issues = await waitForRows(issuesForTx, result.txHash, 2)
        console.log("F12 case B txHash=" + result.txHash + " statuses=" +
            JSON.stringify(issues.map(r => r.tick + ' -> ' + r.status)))
        assert.strictEqual(issues.length, 2)

        const before = issues.find(r => r.tick === parent + ".before")
        const after  = issues.find(r => r.tick === parent + ".after")
        assert(before && after, "both children should be recorded")
        assert(Number(before.action_index) < Number(after.action_index),
            "sub-command order must be preserved in the action index")
        assert.strictEqual(before.status, 'valid',
            "the child ahead of the escrowing ORDER must stand, got " + before.status)
        assert.strictEqual(after.status, ESCROWED_CHILD,
            "the child behind it must be rejected, got " + after.status)

        const tk = await tokenRow(parent + ".before")
        assert(tk, "the valid child is queryable")
        assert.strictEqual(tk.owner, address, "and owned by the issuer")
    })

    it('keeps the stored verdict after the escrow is released, and reopens issuance', async function () {
        const caseA = caseState.caseA
        assert(caseA, "case A must have run first")

        await orderHelper.sendOrderCancelV1(addr, caseA.orderActionIndex, "F12 release")
        const cancelled = await indexerDatabase.waitForOrder({
            source: address, giveTick: caseA.parent, orderStatus: 'cancelled'
        }, 60000)
        assert(cancelled, "the ownership listing should cancel")

        const tk = await tokenRow(caseA.parent)
        assert.strictEqual(tk.escrow_action_index, null, "cancelling clears the escrow gate")

        // The rows the batch wrote are history, not a view: releasing the escrow must
        // not rewrite them.
        const replayed = await issuesForTx(caseA.txHash)
        assert.deepStrictEqual(replayed.map(r => r.status), caseA.statuses,
            "the statuses the batch wrote must be unchanged after the escrow is released")

        // And a child issued now, with the gate clear, is valid: the rejection was the
        // escrow, nothing else about the batch shape.
        const after = await batchHelper.sendBatch(addr, [ issueCmd(caseA.parent + ".3", "post") ],
            { status: 'valid' })
        const issues = await waitForRows(issuesForTx, after.txHash, 1)
        console.log("F12 case C txHash=" + after.txHash + " statuses=" +
            JSON.stringify(issues.map(r => r.tick + ' -> ' + r.status)))
        assert.strictEqual(issues.length, 1)
        assert.strictEqual(issues[0].status, 'valid',
            "with the escrow released the same child shape is valid, got " + issues[0].status)
    })

    it('reproduces the identical verdict for the same shape at a later height', async function () {
        const caseA  = caseState.caseA
        const parent = await newParent("D")
        const exp    = (await chainTipTime()) + 30 * 86400

        const result = await batchHelper.sendBatch(addr, [
            ownershipOrderCmd(parent, settle, address, exp),
            issueCmd(parent + ".1", "c1"),
            issueCmd(parent + ".2", "c2")
        ], { status: 'valid' })
        assert(result.batch)

        const issues = await waitForRows(issuesForTx, result.txHash, 2)
        console.log("F12 case D txHash=" + result.txHash + " statuses=" +
            JSON.stringify(issues.map(r => r.tick + ' -> ' + r.status)))
        assert.deepStrictEqual(issues.map(r => r.status), caseA.statuses,
            "the same batch shape at a later height must produce the same status strings")
    })
})
