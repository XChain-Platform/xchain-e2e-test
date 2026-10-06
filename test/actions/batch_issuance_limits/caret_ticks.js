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
const cryptoHelper = require('../../helpers/core/cryptoHelper')
const issueHelper = require('../../helpers/issueHelper')
const batchHelper = require('../../helpers/batchHelper')
const { q, actionsForTx, tokenRow, tickerId, issueCmd } = require('./shared')

module.exports = function registerCaretTickCases(){

    // ─── A3 ────────────────────────────────────────────────────────────────────
    describe('A3: caret TICKs', function () {

        it('rejects a lone ISSUE whose caret TICK contains a dot', async function () {
            const addr    = await cryptoHelper.getNewFundedAddress("BIL.A3A", COIN, NETWORK, null, "legacy", 0, 1)
            const address = addr["address"]
            const owned   = "BILA3" + address.substring(address.length - 8)

            await issueHelper.sendIssueV0(addr, owned, 1000, 1000, 0, "caret parent", 10)
            const id = await tickerId(owned)
            assert(id, "the owned tick should have an index_tickers id")

            // ^<id>.<n> resolves its parent to a tick this address owns, so every guard
            // ahead of the caret rule passes and the caret-dot rejection is what fires.
            const caretTick = "^" + id + ".5"
            const txHash = await require('../../helpers/core/transactionHelper').createAndSendTransaction(
                addr, issueCmd(caretTick, 100, 100, 1, "caretdot"))
            const row = await indexerDatabase.waitForIssue({
                source: address, txHash: txHash, status: 'invalid: TICK (caret dot)'
            }, 120000)
            assert(row, "ISSUE ^" + id + ".5 must be invalid: TICK (caret dot)")
            console.log("A3a txHash=" + txHash + " tick=" + caretTick + " status=" + row.status)
        })

        it('counts caret entries against the top-level ISSUE limit rather than exempting them', async function () {
            const addr    = await cryptoHelper.getNewFundedAddress("BIL.A3B", COIN, NETWORK, null, "legacy", 0, 1)
            const address = addr["address"]
            const owned   = "BILA3C" + address.substring(address.length - 8)

            await issueHelper.sendIssueV0(addr, owned, 1000, 1000, 0, "caret parent 2", 10)
            const id = await tickerId(owned)
            assert(id, "the owned tick should have an index_tickers id")

            // Both TICKs contain a dot. A dotted-TICK exemption that did not special-case
            // the caret would classify BOTH as children and let the batch through.
            const result = await batchHelper.sendBatch(addr, [
                issueCmd("^" + id + ".1", 100, 100, 1, "c1"),
                issueCmd("^" + id + ".2", 100, 100, 1, "c2")
            ], { status: 'invalid: ISSUE (limit)' })
            assert(result.batch, "two caret ISSUEs must trip the top-level ISSUE limit")
            assert.strictEqual(result.batch.status, 'invalid: ISSUE (limit)')
            const actions = await actionsForTx(result.txHash)
            assert.strictEqual(actions.length, 1, "no sub-command may execute")
            console.log("A3b txHash=" + result.txHash + " status=" + result.batch.status)
        })

        // A dotted TICK whose parent was never issued rejects the ISSUE at "parent
        // unknown"; the PARENT name is never interned since nothing stores it, only
        // TICK and CALLBACK_TICK reach an index_tickers id through createIssue.
        //
        // The child name IS interned though: db.js's createIssue calls createTicker to
        // store the rejected row, which is how EVERY action type records a rejected
        // attempt. Its ticker row is inert - no token row, no supply, no balance.
        it('interns no PARENT name for an ISSUE rejected at parent-unknown', async function () {
            const addr    = await cryptoHelper.getNewFundedAddress("BIL.A3C", COIN, NETWORK, null, "legacy", 0, 1)
            const address = addr["address"]
            const parent  = "BILA3E" + address.substring(address.length - 8)
            const child   = parent + ".1"

            // Neither name may exist yet, or the test would assert on someone else's row.
            assert.strictEqual(await tickerId(parent), null, "the parent name must be unseen at the start")
            assert.strictEqual(await tickerId(child),  null, "the child name must be unseen at the start")

            const txHash = await require('../../helpers/core/transactionHelper').createAndSendTransaction(
                addr, issueCmd(child, 100, 100, 1, "orphan"))
            const row = await indexerDatabase.waitForIssue({
                source: address, txHash: txHash, status: 'invalid: TICK (parent unknown)'
            }, 120000)
            assert(row, "ISSUE " + child + " must be invalid: TICK (parent unknown)")

            assert.strictEqual(await tickerId(parent), null,
                "the unknown parent name must NOT be interned: the lookup that reads it is resolve-only")
            const childId = await tickerId(child)
            assert(childId, "the attempted TICK is interned by the storage layer, as every rejected action's is")
            assert.strictEqual(await tokenRow(child), null, "but no token row may exist for a rejected ISSUE")
            console.log("A3c txHash=" + txHash + " tick=" + child + " status=" + row.status +
                " parentInterned=false childTickerId=" + childId + " childToken=none")
        })

        // The consequence the two cases above exist to prevent, asserted over the whole
        // venue rather than one transaction: a NULL tick_id is what a non-interned name
        // writes, so no row that COUNTS may ever carry one. Rejected issuances are the
        // deliberate exception - they are stored with their verdict and no ticker, which
        // is the shape the fix produces.
        it('leaves no valid issuance and no ledger row carrying a NULL tick_id', async function () {
            const validNullIssues = await q(
                `SELECT COUNT(*) AS n FROM issues i
                   JOIN index_statuses s ON s.id = i.status_id
                  WHERE i.tick_id IS NULL AND s.status = 'valid'`)
            assert.strictEqual(Number(validNullIssues[0].n), 0,
                "a valid issuance with a NULL ticker id is the NULL-tick defect landing")

            for (const table of ['credits', 'debits', 'balances', 'tokens']){
                const rows = await q('SELECT COUNT(*) AS n FROM `' + table + '` WHERE tick_id IS NULL')
                assert.strictEqual(Number(rows[0].n), 0,
                    table + " may not carry a NULL tick_id row: it is unattributable balance")
            }

            // createTicker hands any ^-led name to getTickerId and never inserts one, so a
            // caret string appearing here would mean the resolve-only path had regressed.
            const caretNames = await q("SELECT COUNT(*) AS n FROM index_tickers WHERE tick LIKE '%^%'")
            assert.strictEqual(Number(caretNames[0].n), 0, "no caret-form name may be interned as a ticker")
        })
    })
}
