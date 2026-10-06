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
const batchHelper = require('../../helpers/batchHelper')
const { actionsForTx, issuesForTx, tokenRow, issueCmd } = require('./shared')

module.exports = function registerCommandCapCases(){

    // ─── A2 ────────────────────────────────────────────────────────────────────
    context('A2: the top-level ISSUE limit and the global command cap', function () {

        it('rejects two undotted ISSUEs as ONE record: invalid: ISSUE (limit)', async function () {
            const addr    = await cryptoHelper.getNewFundedAddress("BIL.A2A", COIN, NETWORK, null, "legacy", 0, 1)
            const address = addr["address"]
            const t1 = "BILA2A" + address.substring(address.length - 8)
            const t2 = "BILA2B" + address.substring(address.length - 8)

            const result = await batchHelper.sendBatch(addr, [
                issueCmd(t1, 1000, 1000, 10, "one"),
                issueCmd(t2, 1000, 1000, 10, "two")
            ], { status: 'invalid: ISSUE (limit)' })
            assert(result.batch, "two undotted ISSUEs must whole-batch reject with the ISSUE limit")
            assert.strictEqual(result.batch.status, 'invalid: ISSUE (limit)')

            const actions = await actionsForTx(result.txHash)
            assert.strictEqual(actions.length, 1,
                "an over-limit BATCH is ONE record; no sub-command may execute (got " +
                JSON.stringify(actions.map(a => a.action)) + ")")
            assert.strictEqual(actions[0].action, 'BATCH')
            assert.strictEqual((await issuesForTx(result.txHash)).length, 0, "no ISSUE row")
            assert.strictEqual(await tokenRow(t1), null, "neither tick may be created")
            assert.strictEqual(await tokenRow(t2), null, "neither tick may be created")
            console.log("A2a txHash=" + result.txHash + " status=" + result.batch.status)
        })

        it('accepts exactly 250 commands and rejects 251 with invalid: COMMAND (limit)', async function () {
            const addr = await cryptoHelper.getNewFundedAddress("BIL.A2B", COIN, NETWORK, null, "legacy", 0, 1)

            // Counting is the raw ';'-split list after the BATCH|<v>| strip, EMPTY
            // elements included. 250 empty commands is therefore AT the cap and must
            // fail on the activation scan instead; 251 trips the cap. Nothing but the
            // counting rule separates these two transactions.
            const at   = new Array(250).fill("")
            const over = new Array(251).fill("")

            const atCap = await batchHelper.sendBatch(addr, at, { status: 'invalid: ACTION (unknown)' })
            assert(atCap.batch,
                "250 commands must NOT trip the cap (it should die on the unknown empty ACTION)")
            assert.strictEqual(atCap.batch.status, 'invalid: ACTION (unknown)')
            console.log("A2b at-cap txHash=" + atCap.txHash + " status=" + atCap.batch.status)

            const overCap = await batchHelper.sendBatch(addr, over, { status: 'invalid: COMMAND (limit)' })
            assert(overCap.batch, "251 commands must trip the global cap")
            assert.strictEqual(overCap.batch.status, 'invalid: COMMAND (limit)')
            const actions = await actionsForTx(overCap.txHash)
            assert.strictEqual(actions.length, 1, "an over-cap BATCH is ONE record")
            console.log("A2b over-cap txHash=" + overCap.txHash + " status=" + overCap.batch.status)
        })

        it('reports the CAP, not the ISSUE limit, when a batch breaks both', async function () {
            const addr    = await cryptoHelper.getNewFundedAddress("BIL.A2C", COIN, NETWORK, null, "legacy", 0, 1)
            const address = addr["address"]
            const t1 = "BILA2C" + address.substring(address.length - 8)
            const t2 = "BILA2D" + address.substring(address.length - 8)

            // 251 commands AND two undotted ISSUEs. The cap is checked first, so this
            // pins error precedence on chain.
            const commands = [ issueCmd(t1, 1000, 1000, 10, "one"), issueCmd(t2, 1000, 1000, 10, "two") ]
            while (commands.length < 251) commands.push("")

            const result = await batchHelper.sendBatch(addr, commands, { status: 'invalid: COMMAND (limit)' })
            assert(result.batch,
                "an over-cap batch that ALSO breaks the ISSUE limit must report the cap")
            assert.strictEqual(result.batch.status, 'invalid: COMMAND (limit)',
                "precedence: the cap wins over invalid: ISSUE (limit)")
            const actions = await actionsForTx(result.txHash)
            assert.strictEqual(actions.length, 1, "no sub-command may execute")
            assert.strictEqual(await tokenRow(t1), null)
            assert.strictEqual(await tokenRow(t2), null)
            console.log("A2c txHash=" + result.txHash + " status=" + result.batch.status)
        })
    })
}
