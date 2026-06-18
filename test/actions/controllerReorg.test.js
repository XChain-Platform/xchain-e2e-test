/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * Controller Reorg (on-chain): proves the indexer rolls back a token
 * controller BINDING across a real chain reorg. controllerPolicy.test.js
 * exercises bind/enforce/royalty under normal (auto-mined) conditions, but the
 * `token_controllers` rollback path (a dataTable, block-scoped DELETE in
 * rollback.js) was never driven end-to-end on-chain for the policy layer.
 *
 * Mechanism (mirrors vmContractReorg): ISSUE + DEPLOY land in EARLIER surviving
 * blocks; the BIND (ISSUE v6) lands ALONE in block H and is proven to have teeth
 * (a SEND of the bound token is denied by the transfer guard). We then pause the
 * auto-miner, `invalidateblock(H)` to orphan the BIND, and mine an EMPTY
 * competing chain longer than H via `generateblock(addr, [])` (mempool ignored,
 * so the orphaned BIND tx is NOT re-included). The node reorgs; decoder + indexer
 * follow and rollback.js deletes the block-scoped token_controllers row. We
 * assert the binding event is gone (token reverts to uncontrolled), while the
 * ISSUE'd token and the guard contract (in earlier surviving blocks) remain.
 *
 * Requires the reorg primitives on BlockchainConnector (invalidateBlock /
 * getBlockHash / getBlockCount / generateBlock). Dogecoin Core 1.14.x lacks
 * `generateblock`, so this scenario skips on DOGE (a node capability gap; the
 * rollback path itself is chain-agnostic, operating on DB rows by block_index).
 ********************************************************************/

const assert            = require('assert')
const cryptoHelper      = require('../cryptoHelper')
const gasHelper         = require('../helpers/gasHelper')
const issueHelper       = require('../helpers/issueHelper')
const sendHelper        = require('../helpers/sendHelper')
const vmHelper          = require('../helpers/vmHelper')
const transactionHelper = require('../transactionHelper')

// Deny a SEND of the bound token to give the binding observable teeth pre-reorg.
const SEND_GATE = `module.exports = { guard: function(){
    var at = xchain.getInputParam(0);
    if (at === 'SEND') { xchain.revert('send blocked'); }
    return {};
}};`

async function q(sql, params) {
    const conn = await indexerDatabase.getConnection()
    try { return await conn.query(sql, params) }
    finally { await conn.release() }
}
async function balanceOf(address, tick) {
    const rows = await q(`SELECT b.amount FROM balances b
        JOIN index_addresses ia ON ia.id=b.address_id
        JOIN index_tickers it ON it.id=b.tick_id
        WHERE ia.address=? AND it.tick=?`, [address, tick])
    return rows.length ? String(rows[0].amount) : '0'
}
async function tokenControllerEvents(tick) {
    return await q(`SELECT tc.action_index, tc.action_class, tc.contract_index, tc.is_unbind, tc.block_index
                    FROM token_controllers tc
                    JOIN index_tickers it ON it.id=tc.tick_id
                    WHERE it.tick=? ORDER BY tc.action_index`, [tick])
}
async function blockOfAction(actionIndex) {
    const rows = await q(`SELECT t.block_index AS b FROM actions a
        JOIN transactions t ON t.tx_index=a.tx_index WHERE a.action_index=?`, [actionIndex])
    return rows.length ? Number(rows[0].b) : null
}
async function tickExists(tick) {
    const rows = await q(`SELECT 1 FROM index_tickers WHERE tick=?`, [tick])
    return rows.length > 0
}
async function contractExists(ci) {
    const rows = await q(`SELECT 1 FROM contracts WHERE action_index=?`, [ci])
    return rows.length > 0
}
function randTick(p) { let s = p; for (let i = 0; i < 6; i++) s += String.fromCharCode(65 + Math.floor(Math.random() * 26)); return s }
const j = (x) => JSON.stringify(x, (k, v) => typeof v === 'bigint' ? Number(v) : v)
async function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }
async function mine(n) { try { await regtestMinerConnector.generateBlocks(n) } catch (e) {} }
function issueBindWire(tick, ctrl, cls, cooldown, unbind) {
    return `ISSUE|6|${tick}|${ctrl}|${cls}|${cooldown}|${unbind}|creorg`
}
async function waitTokenController(tick, predicate, timeMax = 20000) {
    const end = Date.now() + timeMax
    let ev = []
    while (Date.now() < end) {
        ev = await tokenControllerEvents(tick)
        if (ev.some(predicate)) return ev
        await sleep(1000)
    }
    return ev
}

describe('Controller Reorg: a token binding rolls back across an on-chain reorg', function () {
    this.timeout(0)
    let owner

    before(async function () {
        // generateblock(addr, []) (empty competing chain) is required and absent on
        // Dogecoin Core 1.14.x → 404 "method not found". rollback.js is chain-agnostic
        // (DB rows by block_index), proven structurally here on BTC/LTC; skip DOGE.
        if (global.COIN_CODE === 'DOGE') this.skip()
        owner = await cryptoHelper.getNewFundedAddress('creorg-owner', COIN, NETWORK, null, 'legacy', 0, 1)
        await gasHelper.ensureGasBalance(owner, '3000')
    })

    it('orphaning the BIND block rolls back token_controllers while ISSUE + DEPLOY survive', async function () {
        const tick = randTick('CRR')

        // ISSUE + DEPLOY in EARLIER blocks, then bury them so the BIND is cleanly isolatable.
        await issueHelper.sendIssueV0(owner, tick, '100000', '100000', '0', 'ctl-reorg', '100000')
        const dep = await vmHelper.sendDeployV0(owner, SEND_GATE, 250000)
        const ctrl = dep.contract.action_index
        const deployBlock = await blockOfAction(ctrl)
        await mine(2)

        // BIND transfer -> SEND_GATE, alone in block H.
        await transactionHelper.createAndSendTransaction(owner, issueBindWire(tick, ctrl, 'transfer', 0, 0))
        await mine(1)
        let ev = await waitTokenController(tick, e => Number(e.is_unbind) === 0)
        assert(ev.length === 1 && Number(ev[0].is_unbind) === 0, 'bind row present pre-reorg')
        const bindActionIndex = ev[0].action_index
        const bindBlock = await blockOfAction(bindActionIndex)
        assert(bindBlock && deployBlock && bindBlock > deployBlock,
            `BIND must be in a later block than DEPLOY (deploy=${deployBlock} bind=${bindBlock}) to isolate the rollback`)
        console.log('   bound transfer->guard', ctrl, 'at block', bindBlock, '(deploy', deployBlock + ')')

        // The binding has teeth: a SEND of the bound token is DENIED pre-reorg.
        const bob = await cryptoHelper.getNewFundedAddress('creorg-bob', COIN, NETWORK, null, 'legacy', 0, 1)
        const bobBefore = await balanceOf(bob.address, tick)
        await transactionHelper.createAndSendTransaction(owner, `SEND|0|${tick}|10|${bob.address}|pre-reorg`)
        await mine(1); await sleep(3000)
        assert.strictEqual(await balanceOf(bob.address, tick), bobBefore, 'SEND denied by the active binding pre-reorg')
        console.log('   SEND denied by active transfer binding (binding has teeth)')

        // ── Reorg out the BIND block ──
        await regtestMinerConnector.setMiningTime(3600000, 3600000)
        try {
            const tipBefore = await nodeConnector.getBlockCount()
            const bindHash = await nodeConnector.getBlockHash(bindBlock)
            const miner = (await cryptoHelper.getNewAddress('creorg-miner', COIN, NETWORK, null, 'legacy', 0)).address

            await nodeConnector.invalidateBlock(bindHash)
            assert.strictEqual(await nodeConnector.getBlockCount(), bindBlock - 1,
                'node rolled back to the block before the BIND')

            // Empty competing chain longer than the original tip; the orphaned BIND
            // (and the orphaned denied-SEND above it) are NOT re-included.
            const need = tipBefore - (bindBlock - 1) + 2
            for (let i = 0; i < need; i++) await nodeConnector.generateBlock(miner, [])
            assert(await nodeConnector.getBlockCount() > tipBefore, 'competing chain overtakes the original')

            // Wait for node -> decoder -> indexer + rollback.js to delete the block-scoped row.
            let rolled = null
            const deadline = Date.now() + 120000
            while (Date.now() < deadline) {
                rolled = await tokenControllerEvents(tick)
                if (rolled.length === 0) break
                await sleep(2000)
            }
            console.log('   token_controllers after reorg:', j(rolled))
            assert.strictEqual(rolled.length, 0, 'token_controllers BIND row rolled back (token reverts to uncontrolled)')

            // ISSUE + DEPLOY were in earlier surviving blocks, so they must remain.
            assert.strictEqual(await tickExists(tick), true, 'the ISSUE\'d token (earlier block) survives')
            assert.strictEqual(await contractExists(ctrl), true, 'the guard contract (earlier block) survives')
            console.log('   ISSUE + DEPLOY survived; only the BIND rolled back (isolation OK)')
        } finally {
            await regtestMinerConnector.setDefaultMiningTime()
        }
    })
})
