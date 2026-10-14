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
 ********************************************************************/

// Shared helpers and guard contract sources for the Controller Policy Layer
// scenarios. See controller_policy.test.js for the scenario overview.

const assert = require('assert')
const cryptoHelper = require('../../../helpers/core/cryptoHelper')
const gasHelper = require('../../../helpers/gasHelper')
const issueHelper = require('../../../helpers/issueHelper')
const orderHelper = require('../../../helpers/orderHelper')
const sendHelper = require('../../../helpers/sendHelper')
const destroyHelper = require('../../../helpers/destroyHelper')
const vmHelper = require('../../../helpers/vmHelper')
const transactionHelper = require('../../../helpers/core/transactionHelper')
const { waitForTxIndexed } = require('../../../helpers/indexerWait')

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
async function tip() {
    const rows = await q(`SELECT MAX(block_index) AS h FROM blocks`, [])
    return Number(rows[0].h)
}
async function contractPermissionsRow(contractIndex) {
    const rows = await q(`SELECT permissions, max_take_bps FROM contract_permissions WHERE contract_index=? LIMIT 1`, [contractIndex])
    return rows.length ? rows[0] : null
}
async function tokenControllerEvents(tick) {
    return await q(`SELECT tc.action_index, tc.action_class, tc.contract_index, tc.is_unbind,
                           tc.cooldown_blocks, tc.cooldown_end_block, tc.block_index
                    FROM token_controllers tc
                    JOIN index_tickers it ON it.id=tc.tick_id
                    WHERE it.tick=? ORDER BY tc.action_index`, [tick])
}
async function addressControllerEvents(address) {
    return await q(`SELECT ac.action_index, ac.action_class, ac.contract_index, ac.is_unbind,
                           ac.cooldown_blocks, ac.cooldown_end_block, ac.block_index
                    FROM address_controllers ac
                    JOIN index_addresses ia ON ia.id=ac.address_id
                    WHERE ia.address=? ORDER BY ac.action_index`, [address])
}
function randTick(p) { let s = p; for (let i = 0; i < 6; i++) s += String.fromCharCode(65 + Math.floor(Math.random() * 26)); return s }
// BigInt-safe JSON (mariadb returns BigInt for BIGINT columns).
const j = (x) => JSON.stringify(x, (k, v) => typeof v === 'bigint' ? Number(v) : v)
async function mine(n) { try { await regtestMinerConnector.generateBlocks(n) } catch (e) {} }
async function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

// Submit a raw wire string; returns the broadcast txHash.
async function submitRaw(addr, wire) {
    return await transactionHelper.createAndSendTransaction(addr, wire)
}

// Build ISSUE format-6 binding (UNBIND=0 binds, =1 unbinds).
function issueBindWire(tick, controllerIdx, actionClass, cooldown, unbind) {
    return `ISSUE|6|${tick}|${controllerIdx}|${actionClass}|${cooldown}|${unbind}|cverify`
}
function addressBindWire(controllerIdx, actionClass, cooldown, unbind) {
    return `ADDRESS|1|${controllerIdx}|${actionClass}|${cooldown}|${unbind}|cverify`
}

// Valid order via the proven e2e helper (resolves source through the action's
// transaction + status through index_statuses). Returns the row (incl.
// payout_legs) or null on timeout.
async function waitValidOrder(source, giveTick, timeMax = 25000) {
    return await indexerDatabase.waitForOrder({ source, giveTick, status: 'valid' }, timeMax)
}
// Confirm an order WAS rejected: wait for the indexer's verdict on the ORDER's own
// tx (an actions row lands for every parsed action, valid or not), then assert no
// valid order exists. Bound = one indexer barrier cycle (60s timeout plus retry).
async function expectOrderRejected(source, giveTick, txHash, waitMs = 120000) {
    await waitForTxIndexed(txHash, { timeoutMs: waitMs, intervalMs: 250 })
    const valid = await indexerDatabase.checkOrder({ source, giveTick, status: 'valid' })
    return !valid
}
// Poll a token-controller event matching predicate (indexing lags submitRaw).
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
async function waitAddressController(address, predicate, timeMax = 20000) {
    const end = Date.now() + timeMax
    let ev = []
    while (Date.now() < end) {
        ev = await addressControllerEvents(address)
        if (ev.some(predicate)) return ev
        await sleep(1000)
    }
    return ev
}

// guard params (positional, via getInputParam): 0 actionType, 1 from, 2 to,
// 3 tick, 4 amount, 5 price, 6 proceedsTick. Deny = xchain.revert(). Allow =
// return (optionally { payoutLegs }).
const TRADE_GATE = `module.exports = { meta: { name: 'Trade Gate', description: 'Controller guard that denies order and swap creation.', version: '1.0.0' }, guard: function(){
    var at = xchain.getInputParam(0);
    if (at === 'ORDER_CREATE' || at === 'SWAP_CREATE') { xchain.revert('trade blocked'); }
    return {};
}};`

const SEND_GATE = `module.exports = { meta: { name: 'Send Gate', description: 'Controller guard that denies SEND transfers.', version: '1.0.0' }, guard: function(){
    var at = xchain.getInputParam(0);
    if (at === 'SEND') { xchain.revert('send blocked'); }
    return {};
}};`

const RECIP_GATE = `module.exports = { meta: { name: 'Recipient Gate', description: 'Controller guard that denies every inbound transfer.', version: '1.0.0' }, guard: function(){
    xchain.revert('inbound denied');
}};`

// Denies EVERY action it gates. Used on the 'all' class to prove one binding
// gates multiple concrete classes (transfer + trade) via the fallback.
const ALL_DENY_GATE = `module.exports = { meta: { name: 'All Deny Gate', description: 'Controller guard that denies every action class it is bound to.', version: '1.0.0' }, guard: function(){
    xchain.revert('all-class denied');
}};`

// Allows whatever it gates. Used as a class-specific OVERRIDE on top of 'all'.
const ALLOW_GATE = `module.exports = { meta: { name: 'Allow Gate', description: 'Controller guard that allows every action class it is bound to.', version: '1.0.0' }, guard: function(){ return {}; }};`

function royaltyGate(creator, market) {
    return `module.exports = { meta: { name: 'Royalty Gate', description: 'Controller guard that attaches creator and market royalty legs to a trade.', version: '1.0.0' }, guard: function(){
        var at = xchain.getInputParam(0);
        if (at === 'ORDER_CREATE' || at === 'SWAP_CREATE') {
            return { payoutLegs: [ { to: '${creator}', bps: 250 }, { to: '${market}', bps: 100 } ] };
        }
        return {};
    }};`
}

// Emits a SEND of its OWN controlled token (from the contract's deposited
// balance) back to the original sender. Exercises the guard-of-guard skip
// (IS_GUARD_EMISSION) + depth cap. Allows the action.
const SELF_EMIT_GATE = `module.exports = { meta: { name: 'Self Emit Gate', description: 'Controller guard that emits a SEND of its own token back to the sender.', version: '1.0.0' }, guard: function(){
    var from = xchain.getInputParam(1);
    var tick = xchain.getInputParam(3);
    xchain.emit.send({ tick: tick, quantity: '1', destination: from });
    return {};
}};`

// Phase E: permissions manifest guard contracts
// A guard that EMITS a SEND of its controlled token but whose manifest permits
// only ISSUE. The emission must be rejected fail-closed (action denied) before
// the SEND handler ever runs.
const MANIFEST_FORBIDS_SEND = `module.exports = {
    meta: { name: 'Issue Only Gate', description: 'Controller guard whose manifest permits ISSUE only while it emits a SEND.', version: '1.0.0' },
    permissions: ['ISSUE'],
    guard: function(){
        var from = xchain.getInputParam(1);
        var tick = xchain.getInputParam(3);
        xchain.emit.send({ tick: tick, quantity: '1', destination: from });
        return {};
    }
};`

// A royalty guard returning legs that sum to 350 bps, with a contract-declared
// maxTakeBps passed in. Lets one scenario flip allow/deny purely on the manifest.
function royaltyGateManifest(creator, market, maxTakeBps) {
    return `module.exports = {
        meta: { name: 'Royalty Gate Capped', description: 'Royalty guard that declares its own maxTakeBps alongside its payout legs.', version: '1.0.0' },
        maxTakeBps: ${maxTakeBps},
        guard: function(){
            var at = xchain.getInputParam(0);
            if (at === 'ORDER_CREATE' || at === 'SWAP_CREATE') {
                return { payoutLegs: [ { to: '${creator}', bps: 250 }, { to: '${market}', bps: 100 } ] };
            }
            return {};
        }
    };`
}

// Fresh funded owner for one scenario group.
async function newOwner() {
    const owner = await cryptoHelper.getNewFundedAddress('cv-owner', COIN, NETWORK, null, 'legacy', 0, 1)
    await gasHelper.ensureGasBalance(owner, '5000')
    return owner
}

module.exports = {
    q, balanceOf, tip, contractPermissionsRow, tokenControllerEvents, addressControllerEvents, randTick, j, mine, sleep, submitRaw, issueBindWire, addressBindWire, waitValidOrder, expectOrderRejected, waitTokenController, waitAddressController, TRADE_GATE, SEND_GATE, RECIP_GATE, ALL_DENY_GATE, ALLOW_GATE, royaltyGate, SELF_EMIT_GATE, MANIFEST_FORBIDS_SEND, royaltyGateManifest, newOwner,
}
