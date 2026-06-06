// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available —
// contact legal@dankest.llc.

const assert = require('assert')
const cryptoHelper = require('../cryptoHelper')
const vmHelper = require('../helpers/vmHelper')
const issueHelper = require('../helpers/issueHelper')
const gasHelper = require('../helpers/gasHelper')
const orderHelper = require('../helpers/orderHelper')

/**
 * VM Emissions — proves that contract-emitted actions of several types flow through
 * the real action handlers and land on-chain, including multiple emissions in a
 * single execution. Verified against the indexer DB (balances, supply,
 * contract_emissions, and the emitted action's own table row).
 */
describe('VM Emissions — emitted action variety', function () {

    const CHAIN = ({ bitcoin: 'BTC', litecoin: 'LTC', dogecoin: 'DOGE' })[COIN] || 'BTC'

    // Sends two different amounts to two recipients in one execution.
    const MULTI_SEND = `module.exports = { payout: function(){
        var t = xchain.getInputParam(0);
        xchain.emit.send({ tick: t, quantity: '10', destination: xchain.getInputParam(1) });
        xchain.emit.send({ tick: t, quantity: '20', destination: xchain.getInputParam(2) });
    } };`

    const DESTROYER = `module.exports = { burn: function(){
        xchain.emit.destroy({ tick: xchain.getInputParam(0), quantity: '30' });
    } };`

    const CASTER = `module.exports = { announce: function(){
        xchain.emit.broadcast({ message: 'hello-from-contract', value: '' });
    } };`

    // Token-for-token order: give the test tick (a ${CHAIN}-network token) for XCHAIN.
    // GIVE_COIN must be a supported network. GET_ADDRESS must be an explicit real address —
    // a contract's synthetic C:${CHAIN}:N address fails the isCryptoAddress format check, so
    // it cannot default GET_ADDRESS to itself.
    const ORDERER = `module.exports = { mkorder: function(){
        xchain.emit.order({ giveCoin: '${CHAIN}', giveTick: xchain.getInputParam(0), giveAmount: '40',
            getCoin: '${CHAIN}', getTick: 'XCHAIN', getAmount: '5',
            getAddress: xchain.getInputParam(1) });
    } };`

    // Token-for-token order with NO explicit GET_ADDRESS — it defaults to the contract's
    // own derived address (C:${CHAIN}:N). Proves a contract can be the GET_ADDRESS recipient
    // of its own same-chain token ORDER: proceeds settle on the XChain ledger to the
    // contract's balance. Before this was allowed, the default-to-SOURCE produced the
    // contract's synthetic address, which failed isCryptoAddress and aborted the execution.
    const SELF_ORDERER = `module.exports = { mkselforder: function(){
        xchain.emit.order({ giveCoin: '${CHAIN}', giveTick: xchain.getInputParam(0), giveAmount: '40',
            getCoin: '${CHAIN}', getTick: 'XCHAIN', getAmount: '5' });
    } };`

    // Self-addressed token order with a caller-supplied EXPIRATION (input param 1), so the
    // test can make it expire and assert the escrow refunds to the contract.
    const EXPIRING_ORDERER = `module.exports = { mkexporder: function(){
        xchain.emit.order({ giveCoin: '${CHAIN}', giveTick: xchain.getInputParam(0), giveAmount: '40',
            getCoin: '${CHAIN}', getTick: 'XCHAIN', getAmount: '5',
            expiration: xchain.getInputParam(1) });
    } };`

    // Self-addressed order whose GET side is NATIVE coin (getTick empty). A contract cannot
    // receive native coin at its synthetic address, so this emission must be rejected and the
    // whole execution must roll back (the GIVE side must NOT be escrowed). Proves the
    // intended half of the GET_ADDRESS rule: contract addresses are allowed for token
    // proceeds only, never native coin.
    const NATIVE_ORDERER = `module.exports = { mknativeorder: function(){
        xchain.emit.order({ giveCoin: '${CHAIN}', giveTick: xchain.getInputParam(0), giveAmount: '40',
            getCoin: '${CHAIN}', getTick: '', getAmount: '1' });
    } };`

    // Native-coin dispenser: dispense 10 of the test tick per trigger for 1 ${CHAIN}.
    // GET_ADDRESS must be a fresh real address (anti-replay: no prior on-chain activity).
    const DISPENSERR = `module.exports = { mkdisp: function(){
        xchain.emit.dispenser({ giveCoin: '${CHAIN}', giveTick: xchain.getInputParam(0), giveAmount: '10',
            giveEscrow: '100', getCoin: '${CHAIN}', getTick: '', getAmount: '1',
            getAddress: xchain.getInputParam(1) });
    } };`

    // Coin-scoped message to a real address. Exercises the MESSAGE emission's leading
    // COIN field: without it the DESTINATION would land in the COIN slot and the handler
    // would reject it as 'invalid: COIN (value)', aborting the whole execution.
    const MESSENGER = `module.exports = { ping: function(){
        xchain.emit.message({ coin: '${CHAIN}', destination: xchain.getInputParam(0) });
    } };`

    // Public (non-gated) file. A contract can only emit a public FILE — gated files
    // require SOURCE to be the GATE_TICKER issuer, which a contract address is not — so
    // this covers the emit.file -> FILE handler -> files-row plumbing.
    const FILER = `module.exports = { publish: function(){
        xchain.emit.file({ name: 'contract-note.txt', type: 'text/plain', title: 'Note', memo: 'from contract' });
    } };`

    let deployer = null

    async function q(sql, params) {
        const conn = await indexerDatabase.getConnection()
        try { return await conn.query(sql, params) }
        finally { await conn.release() }
    }
    async function emissionsFor(executionIndex) {
        return await q(`SELECT emitted_action, action_index FROM contract_emissions
                        WHERE execution_index=? ORDER BY position`, [executionIndex])
    }
    async function balanceOf(address, tick) {
        const rows = await q(`SELECT b.amount FROM balances b
            JOIN index_addresses ia ON ia.id=b.address_id
            JOIN index_tickers it ON it.id=b.tick_id
            WHERE ia.address=? AND it.tick=?`, [address, tick])
        return rows.length ? String(rows[0].amount) : null
    }
    async function tokenSupply(tick) {
        const rows = await q(`SELECT t.supply FROM tokens t JOIN index_tickers it ON it.id=t.tick_id WHERE it.tick=?`, [tick])
        return rows.length ? String(rows[0].supply) : null
    }
    async function rowCount(table, actionIndex) {
        const rows = await q(`SELECT COUNT(*) AS c FROM ${table} WHERE action_index=?`, [actionIndex])
        return Number(rows[0].c)
    }
    async function orderGetAddress(actionIndex) {
        const rows = await q(`SELECT ia.address AS addr FROM orders o
            JOIN index_addresses ia ON ia.id=o.get_address_id WHERE o.action_index=?`, [actionIndex])
        return rows.length ? rows[0].addr : null
    }
    async function pollBalance(address, tick, want, timeMax = 30000) {
        const end = Date.now() + timeMax
        let v = null
        while (Date.now() < end) {
            v = await balanceOf(address, tick)
            if (v === want) return v
            await new Promise(r => setTimeout(r, 1000))
        }
        return v
    }
    async function fundedContract(code, tick, depositAmt) {
        // Issue tick to deployer, deploy the contract, deposit `tick` into it.
        await issueHelper.sendIssueV0(deployer, tick, '1000', '1000', '0', 'vm emit', '1000')
        const dep = await vmHelper.sendDeployV0(deployer, code, 250000)
        const ci = dep.contract.action_index
        await vmHelper.sendDepositV0(deployer, ci, tick, depositAmt)
        return ci
    }
    function randTick(p) { let s = p; for (let i = 0; i < 5; i++) s += String.fromCharCode(65 + Math.floor(Math.random() * 26)); return s }

    before(async function () {
        deployer = await cryptoHelper.getNewFundedAddress('vmemit-deployer', COIN, NETWORK, null, 'legacy', 0, 1)
        await gasHelper.ensureGasBalance(deployer, '500')
    })

    it('emits two SENDs in one execution; both land in order', async function () {
        const tick = randTick('VES')
        const ci = await fundedContract(MULTI_SEND, tick, '100')
        const contractAddr = `C:${CHAIN}:${ci}`
        const a = await cryptoHelper.getNewFundedAddress('vmemit-a', COIN, NETWORK, null, 'legacy', 0, 1)
        const b = await cryptoHelper.getNewFundedAddress('vmemit-b', COIN, NETWORK, null, 'legacy', 0, 1)

        const ex = await vmHelper.sendExecuteV0(deployer, ci, 'payout', [tick, a.address, b.address])
        assert.strictEqual(ex.execution.status, 'valid')
        assert.strictEqual(Number(ex.execution.emitted_count), 2, 'two emissions expected')

        const em = await emissionsFor(ex.execution.action_index)
        assert.deepStrictEqual(em.map(e => e.emitted_action), ['SEND', 'SEND'])
        assert.strictEqual(await balanceOf(a.address, tick), '10')
        assert.strictEqual(await balanceOf(b.address, tick), '20')
        assert.strictEqual(await balanceOf(contractAddr, tick), '70', 'contract debited 30 total')
    })

    it('emits DESTROY; contract balance and token supply drop', async function () {
        const tick = randTick('VED')
        const ci = await fundedContract(DESTROYER, tick, '100')
        const contractAddr = `C:${CHAIN}:${ci}`
        const supplyBefore = await tokenSupply(tick)

        const ex = await vmHelper.sendExecuteV0(deployer, ci, 'burn', [tick])
        assert.strictEqual(ex.execution.status, 'valid')
        const em = await emissionsFor(ex.execution.action_index)
        assert.strictEqual(em[0].emitted_action, 'DESTROY')
        assert.strictEqual(await balanceOf(contractAddr, tick), '70', 'contract burned 30')
        assert.strictEqual(await tokenSupply(tick), String(Number(supplyBefore) - 30), 'supply dropped by 30')
    })

    it('emits BROADCAST; a broadcast row is created from the contract', async function () {
        const dep = await vmHelper.sendDeployV0(deployer, CASTER, 200000)
        const ci = dep.contract.action_index
        const ex = await vmHelper.sendExecuteV0(deployer, ci, 'announce', [])
        assert.strictEqual(ex.execution.status, 'valid')
        const em = await emissionsFor(ex.execution.action_index)
        assert.strictEqual(em[0].emitted_action, 'BROADCAST')
        assert.strictEqual(await rowCount('broadcasts', em[0].action_index), 1, 'broadcast row should exist')
    })

    it('emits ORDER; an order row is created from the contract', async function () {
        const tick = randTick('VEO')
        const ci = await fundedContract(ORDERER, tick, '100')
        const recv = await cryptoHelper.getNewAddress('vmemit-ord-recv', COIN, NETWORK, null, 'legacy', 0)
        const ex = await vmHelper.sendExecuteV0(deployer, ci, 'mkorder', [tick, recv.address])
        assert(ex.execution, 'execution row should exist (ORDER emission must succeed)')
        assert.strictEqual(ex.execution.status, 'valid')
        const em = await emissionsFor(ex.execution.action_index)
        assert.strictEqual(em[0].emitted_action, 'ORDER')
        assert.strictEqual(await rowCount('orders', em[0].action_index), 1, 'order row should exist')
    })

    it('emits a self-addressed token ORDER; GET_ADDRESS defaults to the contract itself', async function () {
        const tick = randTick('VES')
        const ci = await fundedContract(SELF_ORDERER, tick, '100')
        const contractAddr = `C:${CHAIN}:${ci}`

        const ex = await vmHelper.sendExecuteV0(deployer, ci, 'mkselforder', [tick])
        assert(ex.execution, 'execution row should exist (self-addressed ORDER must succeed)')
        assert.strictEqual(ex.execution.status, 'valid', 'a contract may receive its own token ORDER proceeds')
        const em = await emissionsFor(ex.execution.action_index)
        assert.strictEqual(em[0].emitted_action, 'ORDER')
        assert.strictEqual(await rowCount('orders', em[0].action_index), 1, 'order row should exist')
        // The recipient must be the contract's own derived address...
        assert.strictEqual(await orderGetAddress(em[0].action_index), contractAddr,
            'GET_ADDRESS should default to the contract address')
        // ...and the GIVE side (40) must be escrowed out of the contract's balance (100 -> 60).
        assert.strictEqual(await balanceOf(contractAddr, tick), '60', 'contract GIVE_AMOUNT should be escrowed')
    })

    it('rejects a self-addressed ORDER whose GET side is native coin', async function () {
        const tick = randTick('VEN')
        const ci = await fundedContract(NATIVE_ORDERER, tick, '100')
        const contractAddr = `C:${CHAIN}:${ci}`

        // Status-agnostic helper — the emission is rejected and the execution reverts.
        const ex = await vmHelper.sendExecuteV0Invalid(deployer, ci, 'mknativeorder', [tick])
        const row = ex.execution
        assert(row, 'an execution row should be recorded')
        assert.notStrictEqual(row.status, 'valid', 'a contract cannot receive native coin via its own ORDER')
        assert.strictEqual(Number(row.emitted_count), 0, 'no emissions should be committed')
        // The whole execution rolled back — the GIVE side must NOT have been escrowed.
        assert.strictEqual(await balanceOf(contractAddr, tick), '100', 'contract balance must be unchanged')
    })

    it("a contract's self-addressed token ORDER gets matched; proceeds credit the contract (option A payoff)", async function () {
        const tick = randTick('VEM')
        const ci = await fundedContract(SELF_ORDERER, tick, '100')
        const contractAddr = `C:${CHAIN}:${ci}`

        // Contract emits: GIVE 40 `tick`, GET 5 XCHAIN, GET_ADDRESS defaults to itself.
        const ex = await vmHelper.sendExecuteV0(deployer, ci, 'mkselforder', [tick])
        assert.strictEqual(ex.execution.status, 'valid')
        const em = await emissionsFor(ex.execution.action_index)
        const contractOrderIndex = Number(em[0].action_index)

        // Counterparty posts the exact counter-order: GIVE 5 XCHAIN, GET 40 `tick`.
        const buyer = await cryptoHelper.getNewFundedAddress('vmemit-buyer', COIN, NETWORK, null, 'legacy', 0, 1)
        await gasHelper.ensureGasBalance(buyer, '100') // buyer needs XCHAIN to give
        const expiration = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 90
        const counter = await orderHelper.sendOrderV0(
            buyer, CHAIN, 'XCHAIN', 5, CHAIN, tick, 40,
            buyer.address, expiration, null, null, 'buying contract tick'
        )
        assert(counter.order, 'counter-order row should exist')

        const match = await indexerDatabase.waitForOrderMatch({
            giveActionIndex: contractOrderIndex,
            getActionIndex: Number(counter.order.action_index),
            status: 'valid'
        }, 30000)
        assert(match, 'order match should exist (contract order matched the counter-order)')

        // Payoff: the contract's own balance is credited with the GET proceeds on-ledger.
        assert.strictEqual(await pollBalance(contractAddr, 'XCHAIN', '5', 30000), '5',
            'contract should receive 5 XCHAIN proceeds into its own balance')
        // ...and its escrowed GIVE (40 tick) was released to the buyer.
        assert.strictEqual(await balanceOf(contractAddr, tick), '60', 'contract GIVE released (100 deposited - 40 given)')
        assert.strictEqual(await balanceOf(buyer.address, tick), '40', 'buyer received the contract tick')
    })

    it("a contract's self-addressed token ORDER refunds the escrow to the contract on expiry", async function () {
        const tick = randTick('VEX')
        const ci = await fundedContract(EXPIRING_ORDERER, tick, '100')
        const contractAddr = `C:${CHAIN}:${ci}`
        // Far enough ahead to survive creation (EXECUTE confirms in ~20s), soon enough to expire.
        const expiration = Math.floor(Date.now() / 1000) + 45

        const ex = await vmHelper.sendExecuteV0(deployer, ci, 'mkexporder', [tick, String(expiration)])
        assert.strictEqual(ex.execution.status, 'valid', 'self-addressed expiring order must be created')
        // GIVE (40) escrowed out of the contract on creation: 100 -> 60.
        assert.strictEqual(await balanceOf(contractAddr, tick), '60', 'GIVE escrowed on order creation')

        // Drive blocks forward until block_time passes EXPIRATION and the per-block expiry sweep
        // (XChainIndexer processExpirations) fires. Batch-mine + poll — robust whether regtest
        // block_time tracks wall-clock or advances ~1s/block (median-time-past).
        let refunded = null
        const deadline = Date.now() + 150000
        while (Date.now() < deadline) {
            await regtestMinerConnector.generateBlocks(5)
            refunded = await balanceOf(contractAddr, tick)
            if (refunded === '100') break
            await new Promise(r => setTimeout(r, 2000))
        }
        // order_expire.js credits the refunded GIVE back to the order SOURCE (the contract): 60 -> 100.
        assert.strictEqual(refunded, '100', 'escrow refunded to the contract on order expiry')
    })

    it('emits DISPENSER; a dispenser row is created from the contract', async function () {
        const tick = randTick('VEP')
        const ci = await fundedContract(DISPENSERR, tick, '100')
        // Fresh (unfunded) address — required as the dispenser GET_ADDRESS.
        const fresh = await cryptoHelper.getNewAddress('vmemit-disp-recv', COIN, NETWORK, null, 'legacy', 0)
        const ex = await vmHelper.sendExecuteV0(deployer, ci, 'mkdisp', [tick, fresh.address])
        assert(ex.execution, 'execution row should exist (DISPENSER emission must succeed)')
        assert.strictEqual(ex.execution.status, 'valid')
        const em = await emissionsFor(ex.execution.action_index)
        assert.strictEqual(em[0].emitted_action, 'DISPENSER')
        assert.strictEqual(await rowCount('dispensers', em[0].action_index), 1, 'dispenser row should exist')
    })

    it('emits MESSAGE; a message row is created from the contract', async function () {
        const dep = await vmHelper.sendDeployV0(deployer, MESSENGER, 200000)
        const ci = dep.contract.action_index
        const recv = await cryptoHelper.getNewAddress('vmemit-msg-recv', COIN, NETWORK, null, 'legacy', 0)
        const ex = await vmHelper.sendExecuteV0(deployer, ci, 'ping', [recv.address])
        assert(ex.execution, 'execution row should exist (MESSAGE emission must succeed)')
        assert.strictEqual(ex.execution.status, 'valid')
        const em = await emissionsFor(ex.execution.action_index)
        assert.strictEqual(em[0].emitted_action, 'MESSAGE')
        assert.strictEqual(await rowCount('messages', em[0].action_index), 1, 'message row should exist')
    })

    it('emits FILE; a file row is created from the contract', async function () {
        const dep = await vmHelper.sendDeployV0(deployer, FILER, 200000)
        const ci = dep.contract.action_index
        const ex = await vmHelper.sendExecuteV0(deployer, ci, 'publish', [])
        assert(ex.execution, 'execution row should exist (FILE emission must succeed)')
        assert.strictEqual(ex.execution.status, 'valid')
        const em = await emissionsFor(ex.execution.action_index)
        assert.strictEqual(em[0].emitted_action, 'FILE')
        assert.strictEqual(await rowCount('files', em[0].action_index), 1, 'file row should exist')
    })
})
