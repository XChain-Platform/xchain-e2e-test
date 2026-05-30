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
        assert.strictEqual(row.status, 'out_of_gas', `expected out_of_gas (got: ${row.status})`)
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
