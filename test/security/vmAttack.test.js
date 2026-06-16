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
const cryptoHelper = require('../cryptoHelper')
const vmHelper = require('../helpers/vmHelper')
const gasHelper = require('../helpers/gasHelper')
const transactionHelper = require('../transactionHelper')

/**
 * VM Attack — deploys & executes hostile contracts on-chain and proves the
 * indexer CONTAINS them: each malicious EXECUTE is recorded as a failed
 * execution (no escape, no emissions), and block processing keeps advancing
 * (a halted indexer would stop producing rows and time these out). This is the
 * end-to-end complement to the direct-VM adversarial harness.
 */
describe('VM Attack — hostile contracts on-chain', function () {

    // Classic sandbox-escape attempt via the Function constructor chain.
    const ESCAPE = `module.exports = function(){
        return [].constructor.constructor('return process.env')();
    };`

    // Burns past the gas ceiling.
    const LOOP = `module.exports = { run: function(){ var x=0; while(true){ x++; } } };`

    // Blows the call stack.
    const RECURSE = `module.exports = { run: function(){ function f(n){ return f(n+1); } return f(0); } };`

    // Tries to emit more actions than the per-execution cap.
    const EMIT_BOMB = `module.exports = { run: function(){
        for (var i = 0; i < 60; i++) { xchain.emit.send({ tick: 'AAA', quantity: '1', destination: 'x' }); }
    } };`

    // Bulk-allocation bomb. Historically (Finding A) this made V8 abort() the host
    // process; F3 allocation metering now charges the fill by size, so it hits the
    // gas ceiling (out_of_gas) BEFORE V8 services it — fast, deterministic, and it
    // never even reaches the out-of-process executor's host-abort containment (which
    // remains the load-bearing defense for paths F3 can't wrap). Either way the
    // hostile contract is contained: a non-valid execution, no emissions, block advances.
    const MEMORY_BOMB = `module.exports = { run: function(){ var a = new Array(100000000).fill('x'); return a.length; } };`

    // The SAME bulk allocation, but in the contract's constructor (initialize).
    // Exercises the DEPLOY status path: a failed constructor deletes the contract
    // row, but its execution row persists, and the consensus-hashed status must
    // intern as a normalized token (F1) — NOT the raw VM error string. Under F3 the
    // constructor fill is gas-bounded; the consensus token is the collapsed
    // 'out_of_resource' (with the raw out_of_gas detail kept in error_message).
    const CONSTRUCTOR_BOMB = `module.exports = { initialize: function(){ var a = new Array(100000000).fill('x'); return a.length; } };`

    let deployer = null

    async function q(sql, params) {
        const conn = await indexerDatabase.getConnection()
        try { return await conn.query(sql, params) }
        finally { await conn.release() }
    }
    async function tip() {
        const rows = await q('SELECT MAX(block_index) AS t FROM blocks', [])
        return rows.length ? Number(rows[0].t) : 0
    }
    async function rawExecute(addr, ci, method) {
        return await transactionHelper.createAndSendTransaction(addr, `EXECUTE|0|${ci}|${method}`)
    }
    async function waitForAnyExecution(ci, caller, method, timeMax = 90000) {
        const end = Date.now() + timeMax
        while (Date.now() < end) {
            const row = await indexerDatabase.checkExecution({ contractIndex: ci, caller, methodName: method })
            if (row) return row
            await new Promise(r => setTimeout(r, 1000))
        }
        return null
    }

    before(async function () {
        deployer = await cryptoHelper.getNewFundedAddress('vmatk-deployer', COIN, NETWORK, null, 'legacy', 0, 1)
        await gasHelper.ensureGasBalance(deployer, '500')
    })

    it('a sandbox-escape attempt fails and indexes cleanly', async function () {
        const dep = await vmHelper.sendDeployV0(deployer, ESCAPE, 200000)
        const ci = dep.contract.action_index
        await rawExecute(deployer, ci, 'default')
        const row = await waitForAnyExecution(ci, deployer.address, 'default')
        assert(row, 'escape execution should be recorded (indexer processed the block)')
        assert.notStrictEqual(row.status, 'valid', 'sandbox escape must not succeed')
        assert.strictEqual(Number(row.emitted_count), 0)
    })

    it('an infinite loop is killed by the gas meter', async function () {
        const dep = await vmHelper.sendDeployV0(deployer, LOOP, 200000)
        const ci = dep.contract.action_index
        await rawExecute(deployer, ci, 'run')
        const row = await waitForAnyExecution(ci, deployer.address, 'run')
        assert(row, 'loop execution should be recorded')
        // The consensus status collapses the whole resource-exhaustion family
        // (out_of_gas / timeout / out_of_memory / out_of_stack) to one
        // host-independent token — which ceiling fires (gas vs the wall-clock
        // net) is a host-timing race that must not change the hashed status_id.
        // The gas-specific detail survives (un-hashed) in error_message.
        assert.strictEqual(row.status, 'out_of_resource', `expected out_of_resource (got: ${row.status})`)
        assert.match(String(row.error_message || ''), /out_of_gas:/,
            `gas meter (not the wall-clock net) should have bound the loop (error_message: ${row.error_message})`)
    })

    it('deep recursion fails without crashing the indexer', async function () {
        const dep = await vmHelper.sendDeployV0(deployer, RECURSE, 200000)
        const ci = dep.contract.action_index
        await rawExecute(deployer, ci, 'run')
        const row = await waitForAnyExecution(ci, deployer.address, 'run')
        assert(row, 'recursion execution should be recorded')
        assert.notStrictEqual(row.status, 'valid', 'stack overflow must fail the execution')
    })

    it('an over-cap emission storm commits nothing', async function () {
        const dep = await vmHelper.sendDeployV0(deployer, EMIT_BOMB, 200000)
        const ci = dep.contract.action_index
        await rawExecute(deployer, ci, 'run')
        const row = await waitForAnyExecution(ci, deployer.address, 'run')
        assert(row, 'emission-bomb execution should be recorded')
        assert.notStrictEqual(row.status, 'valid', 'over-cap emissions must fail')
        assert.strictEqual(Number(row.emitted_count), 0, 'no emissions should be committed')
        const em = await q('SELECT id FROM contract_emissions WHERE execution_index=?', [row.action_index])
        assert.strictEqual(em.length, 0)
    })

    it('a bulk-allocation bomb is gas-bounded and contained without crashing the indexer', async function () {
        const dep = await vmHelper.sendDeployV0(deployer, MEMORY_BOMB, 200000)
        const ci = dep.contract.action_index
        await rawExecute(deployer, ci, 'run')
        const row = await waitForAnyExecution(ci, deployer.address, 'run')
        // If the indexer crashed (old in-process VM), no row is ever written and this
        // times out → the row appearing at all is the containment proof.
        assert(row, 'bulk-allocation execution should be recorded (indexer survived)')
        // F3 charges the fill by size → gas-bounded before V8 allocates. The
        // consensus status is the collapsed resource-exhaustion token; the raw
        // out_of_gas detail (proving F3 metering, not a timeout/abort) is in error_message.
        assert.strictEqual(row.status, 'out_of_resource', `expected out_of_resource (got: ${row.status})`)
        assert.match(String(row.error_message || ''), /out_of_gas:/,
            `F3 size metering should bind the fill with gas, not the wall-clock net (error_message: ${row.error_message})`)
        assert.strictEqual(Number(row.emitted_count), 0, 'no emissions on a contained failure')
    })

    it('a bulk-allocation bomb in the constructor interns as out_of_resource and the indexer survives', async function () {
        const before = await tip()
        // Fresh address so its only 'constructor' execution is this one (every DEPLOY
        // records a method='constructor' execution row; a separate address keeps the
        // lookup unambiguous without needing the deleted contract's action_index).
        const ctorDeployer = await cryptoHelper.getNewFundedAddress('vmatk-ctor', COIN, NETWORK, null, 'legacy', 0, 1)
        await gasHelper.ensureGasBalance(ctorDeployer, '500')
        // sendDeployV0 waits for a VALID contract row, which never appears here (a
        // failed constructor deletes the contract). Broadcast the DEPLOY directly with
        // a constructor param (required to run the constructor) and poll the execution.
        // Inline CODE_ENCODING is base64 (DEPLOY_BASE64_CODE active from genesis on regtest);
        // hex would be rejected at decode, so the constructor — the thing under test — never runs.
        const codeB64 = Buffer.from(CONSTRUCTOR_BOMB, 'utf8').toString('base64')
        await transactionHelper.createAndSendTransaction(ctorDeployer, `DEPLOY|0|${codeB64}|200000|1`, null, [], 'P2SH')
        let row = null
        const end = Date.now() + 90000
        while (Date.now() < end) {
            row = await indexerDatabase.checkExecution({ caller: ctorDeployer.address, methodName: 'constructor' }).catch(() => null)
            if (row) break
            await new Promise(r => setTimeout(r, 1000))
        }
        assert(row, 'constructor execution should be recorded (indexer survived the constructor failure)')
        // Under F3 the constructor fill is gas-bounded; deploy.js must record the
        // normalized, host-independent resource-exhaustion token (not the raw
        // 'invalid: constructor failed: ...' string, and not a distinct out_of_gas
        // token that would fork against a slow validator's wall-clock timeout).
        assert.strictEqual(row.status, 'out_of_resource',
            `constructor failure must intern as the normalized token (got: ${row.status})`)
        assert.match(String(row.error_message || ''), /out_of_gas:/,
            `the gas-bounded detail should survive in error_message (got: ${row.error_message})`)
        assert.strictEqual(Number(row.emitted_count), 0, 'no emissions on a contained constructor failure')
        const after = await tip()
        assert(after >= before, `block tip should keep advancing (before=${before} after=${after})`)
    })

    it('the indexer is still alive and processing after the attacks', async function () {
        const before = await tip()
        // A normal deploy must still succeed — proves block processing did not halt.
        const dep = await vmHelper.sendDeployV0(deployer, `module.exports = function(){ return 'ok'; };`, 200000)
        assert(dep.contract, 'a normal contract should still deploy after the attacks')
        assert.strictEqual(dep.contract.status, 'valid')
        const after = await tip()
        assert(after >= before, `block tip should keep advancing (before=${before} after=${after})`)
    })
})
