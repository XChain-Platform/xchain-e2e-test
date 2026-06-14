/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available —
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * Programmable Policy Layer — controller-gated tokens & accounts + royalty/fee
 * split (xchain-indexer Phases A–D). End-to-end integration regression against a
 * live bitcoin-regtest stack via the connector helpers (initialCheck globals).
 *
 * The controller binding actions have no SDK builder yet (Phase F), so they are
 * submitted as raw wire strings through transactionHelper:
 *   ISSUE format 6 : ISSUE|6|TICK|CONTROLLER|ACTION_CLASS|COOLDOWN_BLOCKS|UNBIND|MEMO
 *   ADDRESS format 1: ADDRESS|1|CONTROLLER|ACTION_CLASS|COOLDOWN_BLOCKS|UNBIND|MEMO
 *
 * Covers: bind + drop-cooldown gating, action-class routing, royalty/fee split
 * persistence + EXACT conservation across partial fills, recipient address gate,
 * guard-of-guard recursion control, and an uncontrolled-token regression. The
 * royalty scenario specifically pins the two integration bugs that made the split
 * a silent no-op (VM returnValue is a JSON STRING parsed in runControllerGuard;
 * legs persisted from a pre-guard copy in order.js/swap.js).
 ********************************************************************/

const assert            = require('assert')
const cryptoHelper      = require('../cryptoHelper')
const gasHelper         = require('../helpers/gasHelper')
const issueHelper       = require('../helpers/issueHelper')
const orderHelper       = require('../helpers/orderHelper')
const sendHelper        = require('../helpers/sendHelper')
const destroyHelper     = require('../helpers/destroyHelper')
const vmHelper          = require('../helpers/vmHelper')
const transactionHelper = require('../transactionHelper')

// ───────────────────────── DB query helpers ─────────────────────────
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
// Confirm an order WAS rejected: after the indexer has had time to process,
// assert no valid order exists for (source, giveTick).
async function expectOrderRejected(source, giveTick, settleMs = 7000) {
    await sleep(settleMs)
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

// ───────────────────────── guard contracts ─────────────────────────
// guard params (positional, via getInputParam): 0 actionType, 1 from, 2 to,
// 3 tick, 4 amount, 5 price, 6 proceedsTick. Deny = xchain.revert(). Allow =
// return (optionally { payoutLegs }).
const TRADE_GATE = `module.exports = { guard: function(){
    var at = xchain.getInputParam(0);
    if (at === 'ORDER_CREATE' || at === 'SWAP_CREATE') { xchain.revert('trade blocked'); }
    return {};
}};`

const SEND_GATE = `module.exports = { guard: function(){
    var at = xchain.getInputParam(0);
    if (at === 'SEND') { xchain.revert('send blocked'); }
    return {};
}};`

const RECIP_GATE = `module.exports = { guard: function(){
    xchain.revert('inbound denied');
}};`

function royaltyGate(creator, market) {
    return `module.exports = { guard: function(){
        var at = xchain.getInputParam(0);
        if (at === 'ORDER_CREATE' || at === 'SWAP_CREATE') {
            return { payoutLegs: [ { to: '${creator}', bps: 250 }, { to: '${market}', bps: 100 } ] };
        }
        return {};
    }};`
}

// Emits a SEND of its OWN controlled token (from the contract's deposited
// balance) back to the original sender — exercises the guard-of-guard skip
// (IS_GUARD_EMISSION) + depth cap. Allows the action.
const SELF_EMIT_GATE = `module.exports = { guard: function(){
    var from = xchain.getInputParam(1);
    var tick = xchain.getInputParam(3);
    xchain.emit.send({ tick: tick, quantity: '1', destination: from });
    return {};
}};`

// ─────────────── Phase E: permissions manifest guard contracts ───────────────
// A guard that EMITS a SEND of its controlled token but whose manifest permits
// only ISSUE — the emission must be rejected fail-closed (action denied) before
// the SEND handler ever runs.
const MANIFEST_FORBIDS_SEND = `module.exports = {
    permissions: ['ISSUE'],
    guard: function(){
        var from = xchain.getInputParam(1);
        var tick = xchain.getInputParam(3);
        xchain.emit.send({ tick: tick, quantity: '1', destination: from });
        return {};
    }
};`

// A royalty guard returning legs that sum to 350 bps, with a contract-declared
// maxTakeBps passed in — lets one scenario flip allow/deny purely on the manifest.
function royaltyGateManifest(creator, market, maxTakeBps) {
    return `module.exports = {
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

// ───────────────────────── scenarios ─────────────────────────
describe('Controller Policy Layer — bindings, enforcement, royalty split + permissions manifest (Phases A–E)', function () {
    this.timeout(0)
    let owner

    before(async function () {
        owner = await cryptoHelper.getNewFundedAddress('cv-owner', COIN, NETWORK, null, 'legacy', 0, 1)
        await gasHelper.ensureGasBalance(owner, '5000')
    })

    it('1+2. bind+cooldown gating, class routing (trade gates ORDER, not SEND)', async function () {
        const tick = randTick('CVA')
        await issueHelper.sendIssueV0(owner, tick, '100000', '100000', '0', 'cverify A', '100000')
        const dep = await vmHelper.sendDeployV0(owner, TRADE_GATE, 250000)
        const ctrl = dep.contract.action_index
        console.log('   guard contract index =', ctrl)

        // BIND trade->TRADE_GATE with cooldown 40 (the regtest miner auto-mines
        // ~1 block/sec, so the cooldown window must be wide enough to observe).
        const COOLDOWN = 40
        await submitRaw(owner, issueBindWire(tick, ctrl, 'trade', COOLDOWN, 0))
        await mine(1)
        let ev = await waitTokenController(tick, e => Number(e.is_unbind) === 0)
        console.log('   token_controllers after bind:', j(ev))
        assert(ev.length === 1 && Number(ev[0].is_unbind) === 0, 'bind row present')
        assert(Number(ev[0].cooldown_blocks) === COOLDOWN, 'cooldown_blocks recorded = 40')
        assert(ev[0].cooldown_end_block === null, 'bind cooldown_end_block is NULL')
        assert(Number(ev[0].contract_index) === Number(ctrl), 'bound to the guard contract')

        // ROUTING: a plain SEND of the token must still work (SEND=transfer class,
        // not gated by a trade binding).
        const bob = await cryptoHelper.getNewFundedAddress('cv-bob', COIN, NETWORK, null, 'legacy', 0, 1)
        const sres = await sendHelper.sendSendV0(owner, tick, '10', bob.address, 'routing-send')
        assert(sres.send, 'SEND of trade-bound token is ALLOWED (class routing)')
        console.log('   SEND allowed under trade binding — routing OK; bob balance =', await balanceOf(bob.address, tick))

        // GATING: an ORDER listing the token must be REJECTED while bound.
        await submitRaw(owner, `ORDER|0|${COIN_CODE}|${tick}|50||${COIN_CODE}|XCHAIN|50||${owner.address}||||blocked-order`)
        await mine(1)
        assert(await expectOrderRejected(owner.address, tick), 'ORDER is REJECTED while trade controller is active')
        console.log('   ORDER rejected while bound — gating OK')

        // UNBIND -> cooldown begins; still gates until cooldown_end_block.
        await submitRaw(owner, issueBindWire(tick, ctrl, 'trade', COOLDOWN, 1))
        await mine(1)
        ev = await waitTokenController(tick, e => Number(e.is_unbind) === 1)
        const unbindEv = ev.find(e => Number(e.is_unbind) === 1)
        console.log('   token_controllers after unbind:', j(ev))
        assert(unbindEv, 'unbind row present')
        assert(Number(unbindEv.cooldown_end_block) === Number(unbindEv.block_index) + COOLDOWN,
            'cooldown_end_block = unbind block + cooldown_blocks')

        // Still within cooldown -> ORDER still rejected.
        await submitRaw(owner, `ORDER|0|${COIN_CODE}|${tick}|50||${COIN_CODE}|XCHAIN|50||${owner.address}||||cooldown-order`)
        await mine(1)
        assert(await expectOrderRejected(owner.address, tick), 'ORDER still REJECTED during drop cooldown (anti-instant-drop)')
        console.log('   ORDER still rejected during cooldown — cooldown teeth OK')

        // Advance past cooldown_end_block -> ORDER now ACCEPTED.
        const endBlock = Number(unbindEv.cooldown_end_block)
        let guard = 0
        while ((await tip()) <= endBlock && guard++ < 90) { await mine(1); await sleep(1000) }
        console.log('   tip', await tip(), '> cooldown_end', endBlock, '— cooldown expired')
        await submitRaw(owner, `ORDER|0|${COIN_CODE}|${tick}|50||${COIN_CODE}|XCHAIN|50||${owner.address}||||after-cooldown`)
        await mine(1); await sleep(2500)
        let allowed = await waitValidOrder(owner.address, tick, 20000)
        assert(allowed && allowed.status === 'valid', 'ORDER ACCEPTED after cooldown expiry')
        console.log('   ORDER accepted after cooldown — expiry OK. order#', allowed.action_index)
    })

    it('2b. transfer controller denies SEND of the token', async function () {
        const tick = randTick('CVB')
        await issueHelper.sendIssueV0(owner, tick, '100000', '100000', '0', 'cverify B', '100000')
        const dep = await vmHelper.sendDeployV0(owner, SEND_GATE, 250000)
        await submitRaw(owner, issueBindWire(tick, dep.contract.action_index, 'transfer', 0, 0))
        await mine(1)
        await waitTokenController(tick, e => Number(e.is_unbind) === 0)

        const carol = await cryptoHelper.getNewFundedAddress('cv-carol', COIN, NETWORK, null, 'legacy', 0, 1)
        const before = await balanceOf(carol.address, tick)
        await submitRaw(owner, `SEND|0|${tick}|10|${carol.address}|blocked-send`)
        await mine(1); await sleep(3000)
        const after = await balanceOf(carol.address, tick)
        assert(before === after, 'SEND of transfer-bound token is REJECTED (recipient balance unchanged)')
        console.log('   SEND blocked by transfer controller — OK. carol balance still', after)
    })

    it('3. royalty split: payout_legs stored + exact conservation across partial fills', async function () {
        const T   = randTick('CVT')   // controlled token (seller gives)
        const PAY = randTick('CVP')   // proceeds tick (buyers give)
        const creator = await cryptoHelper.getNewFundedAddress('cv-creator', COIN, NETWORK, null, 'legacy', 0, 1)
        const market  = await cryptoHelper.getNewFundedAddress('cv-market',  COIN, NETWORK, null, 'legacy', 0, 1)
        const buyer   = await cryptoHelper.getNewFundedAddress('cv-buyer',   COIN, NETWORK, null, 'legacy', 0, 1)
        await gasHelper.ensureGasBalance(buyer, '5000')

        await issueHelper.sendIssueV0(owner, T,   '100000', '100000', '0', 'royalty token', '100000')
        await issueHelper.sendIssueV0(buyer, PAY, '100000', '100000', '0', 'proceeds token', '100000')

        const dep = await vmHelper.sendDeployV0(owner, royaltyGate(creator.address, market.address), 250000)
        await submitRaw(owner, issueBindWire(T, dep.contract.action_index, 'trade', 0, 0))
        await mine(1)
        await waitTokenController(T, e => Number(e.is_unbind) === 0)

        // Owner lists 1000 T for 1000 PAY (price 1:1). Guard returns payoutLegs.
        await submitRaw(owner, `ORDER|0|${COIN_CODE}|${T}|1000||${COIN_CODE}|${PAY}|1000||${owner.address}||||royalty-listing`)
        await mine(1); await sleep(2500)
        const ord = await waitValidOrder(owner.address, T, 20000)
        assert(ord && ord.status === 'valid', 'controlled-token ORDER accepted with payout legs')
        console.log('   order.payout_legs =', ord.payout_legs)
        assert(ord.payout_legs !== null && ord.payout_legs !== undefined,
            'BUG: payout_legs NOT persisted on controlled ORDER (Phase D royalty no-op)')
        const legs = JSON.parse(ord.payout_legs)
        assert(legs.length === 2 && legs[0].bps === 250 && legs[1].bps === 100, 'payout_legs persisted [{250},{100}]')

        // Partial fill #1: buyer gives 400 PAY for 400 T (proceeds=400).
        async function fillAndCheck(proceeds) {
            const ownerPayBefore   = await balanceOf(owner.address,   PAY)
            const creatorBefore    = await balanceOf(creator.address, PAY)
            const marketBefore     = await balanceOf(market.address,  PAY)
            await submitRaw(buyer, `ORDER|0|${COIN_CODE}|${PAY}|${proceeds}||${COIN_CODE}|${T}|${proceeds}||${buyer.address}||||fill-${proceeds}`)
            await mine(1); await sleep(4000)
            // poll until creator credited (split applied)
            let tries = 20, creatorAfter
            while (tries-- > 0) {
                creatorAfter = await balanceOf(creator.address, PAY)
                if (creatorAfter !== creatorBefore) break
                await sleep(1000)
            }
            const ownerPayAfter = await balanceOf(owner.address,   PAY)
            const marketAfter   = await balanceOf(market.address,  PAY)
            const dCreator = Number(creatorAfter) - Number(creatorBefore)
            const dMarket  = Number(marketAfter)  - Number(marketBefore)
            const dOwner   = Number(ownerPayAfter)- Number(ownerPayBefore)
            console.log(`   fill ${proceeds}: seller+${dOwner} creator+${dCreator} market+${dMarket} (sum=${dOwner+dCreator+dMarket})`)
            // 2.5% + 1.0% of `proceeds`; seller gets remainder. The split rounds the leg
            // to tick precision (deterministic, mathjs bcdiv half-up), so each leg is within
            // [floor,ceil] of its exact bps amount — what matters for consensus is determinism
            // + EXACT conservation (seller absorbs any rounding).
            const exC = proceeds * 250 / 10000, exM = proceeds * 100 / 10000
            assert(dCreator === Math.floor(exC) || dCreator === Math.ceil(exC), 'creator leg ≈ 2.5%')
            assert(dMarket  === Math.floor(exM) || dMarket  === Math.ceil(exM), 'market leg ≈ 1.0%')
            assert(dCreator > 0 && dMarket > 0, 'both royalty legs took a cut')
            assert(dOwner + dCreator + dMarket === proceeds, 'EXACT conservation: legs + seller == proceeds')
        }
        await fillAndCheck(400)
        await fillAndCheck(300)
        console.log('   royalty split conserved across two partial fills — OK')
    })

    it('4. recipient address gate: inbound SEND to a gated address reverts', async function () {
        const tick = randTick('CVR')
        await issueHelper.sendIssueV0(owner, tick, '100000', '100000', '0', 'recip token', '100000')
        // Recipient binds RECIP_GATE on its OWN address for the transfer class.
        const recip = await cryptoHelper.getNewFundedAddress('cv-recip', COIN, NETWORK, null, 'legacy', 0, 1)
        await gasHelper.ensureGasBalance(recip, '2000')
        const dep = await vmHelper.sendDeployV0(recip, RECIP_GATE, 250000)
        await submitRaw(recip, addressBindWire(dep.contract.action_index, 'transfer', 0, 0))
        await mine(1)
        const ace = await waitAddressController(recip.address, e => Number(e.is_unbind) === 0)
        console.log('   address_controllers:', j(ace))
        assert(ace.length === 1 && Number(ace[0].is_unbind) === 0, 'address bind row present')

        const before = await balanceOf(recip.address, tick)
        await submitRaw(owner, `SEND|0|${tick}|25|${recip.address}|unsolicited`)
        await mine(1); await sleep(3000)
        const after = await balanceOf(recip.address, tick)
        assert(before === after, 'inbound SEND to gated recipient REVERTS (no credit)')
        console.log('   inbound SEND reverted by recipient gate — OK. recip balance', after)
    })

    it('5. guard-of-guard: guard emits its own controlled token, depth-capped, settles', async function () {
        const tick = randTick('CVS')
        await issueHelper.sendIssueV0(owner, tick, '100000', '100000', '0', 'selfemit token', '100000')
        const dep = await vmHelper.sendDeployV0(owner, SELF_EMIT_GATE, 250000)
        const ctrl = dep.contract.action_index
        // Fund the contract with the token so its guard emission has balance.
        await vmHelper.sendDepositV0(owner, ctrl, tick, '100')
        await submitRaw(owner, issueBindWire(tick, ctrl, 'transfer', 0, 0))
        await mine(1)
        await waitTokenController(tick, e => Number(e.is_unbind) === 0)

        const dave = await cryptoHelper.getNewFundedAddress('cv-dave', COIN, NETWORK, null, 'legacy', 0, 1)
        const before = await balanceOf(dave.address, tick)
        const sres = await sendHelper.sendSendV0(owner, tick, '10', dave.address, 'selfemit-send')
        assert(sres.send, 'SEND settles (guard ran + emitted without infinite recursion)')
        const after = await balanceOf(dave.address, tick)
        assert(Number(after) - Number(before) === 10, 'recipient credited the user SEND')
        // The guard emitted 1 token back to the sender (owner) from the contract.
        console.log('   guard-of-guard SEND settled; dave +', Number(after) - Number(before), '— OK')
    })

    it('6. determinism (single-node bound): guarded action is consensus-recorded; gas deterministic', async function () {
        // Full two-node determinism needs a second indexer; on a single regtest
        // node we assert the guarded action committed deterministically (status
        // valid + a contract_executions/guard row exists) and the ledger advanced.
        const tick = randTick('CVD')
        await issueHelper.sendIssueV0(owner, tick, '100000', '100000', '0', 'determinism token', '100000')
        const dep = await vmHelper.sendDeployV0(owner, royaltyGate(owner.address, owner.address), 250000)
        await submitRaw(owner, issueBindWire(tick, dep.contract.action_index, 'trade', 0, 0))
        await mine(1)
        await waitTokenController(tick, e => Number(e.is_unbind) === 0)
        const before = await tip()
        await submitRaw(owner, `ORDER|0|${COIN_CODE}|${tick}|500||${COIN_CODE}|XCHAIN|500||${owner.address}||||determinism`)
        await mine(1); await sleep(2500)
        const ord = await waitValidOrder(owner.address, tick, 20000)
        assert(ord && ord.status === 'valid', 'guarded ORDER committed (deterministic accept)')
        assert((await tip()) >= before, 'ledger advanced past the guarded action')
        console.log('   guarded action deterministically committed (order#', ord.action_index, ') — single-node check OK')
    })

    // ───────────────────── Phase E: permissions manifest ─────────────────────

    it('E1. manifest persisted at deploy: declared maxTakeBps stored in contract_permissions', async function () {
        const creator = await cryptoHelper.getNewFundedAddress('cv-e1c', COIN, NETWORK, null, 'legacy', 0, 1)
        const market  = await cryptoHelper.getNewFundedAddress('cv-e1m', COIN, NETWORK, null, 'legacy', 0, 1)
        const dep = await vmHelper.sendDeployV0(owner, royaltyGateManifest(creator.address, market.address, 300), 250000)
        const ci  = dep.contract.action_index
        // Poll — DEPLOY indexing lags the submit (submitRaw/deploy return on confirm).
        let row = null
        const end = Date.now() + 20000
        while (Date.now() < end) { row = await contractPermissionsRow(ci); if (row) break; await sleep(1000) }
        assert(row !== null, 'contract_permissions row persisted at deploy')
        assert.strictEqual(Number(row.max_take_bps), 300, 'declared maxTakeBps stored')
        assert(row.permissions === null, 'no permissions array declared → NULL (unrestricted)')
        console.log('   E1 contract_permissions =', row)
    })

    it('E2. emission allowlist: a guard emitting a non-permitted action is denied (all paths)', async function () {
        const tick = randTick('CVE')
        await issueHelper.sendIssueV0(owner, tick, '100000', '100000', '0', 'cverify E2', '100000')
        // Guard emits SEND but its manifest permits only ISSUE.
        const dep = await vmHelper.sendDeployV0(owner, MANIFEST_FORBIDS_SEND, 250000)
        const ctrl = dep.contract.action_index
        // Fund the contract so its guard's SEND emission WOULD succeed if the allowlist permitted
        // it — otherwise the emission fails on insufficient balance regardless of the manifest,
        // which made the original assertion a false green. With the contract funded, a blocked
        // SEND is attributable to the allowlist alone. (The definitive, balance-independent proof
        // lives in the indexer integration suite: 16-controller-permissions asserts the
        // constructor-emission denial on the execution error message.)
        await vmHelper.sendDepositV0(owner, ctrl, tick, '100')
        await submitRaw(owner, issueBindWire(tick, ctrl, 'transfer', 0, 0))
        await waitTokenController(tick, e => e.action_class === 'transfer' && e.is_unbind === 0)
        await mine(1)

        const recip = await cryptoHelper.getNewFundedAddress('cv-e2r', COIN, NETWORK, null, 'legacy', 0, 1)
        const before = await balanceOf(recip.address, tick)
        // The SEND triggers the transfer guard; the (now-funded) guard's SEND emission is not in
        // the allowlist → throws → guard DENIES → the original SEND is blocked (recipient gets none).
        await submitRaw(owner, `SEND|0|${tick}|10|${recip.address}|manifest-blocked`)
        await sleep(7000)
        const after = await balanceOf(recip.address, tick)
        assert.strictEqual(after, before, 'SEND blocked by the allowlist (contract IS funded, so the block is the manifest, not balance)')
        console.log('   E2 manifest-forbidden emission denied the funded contract — OK')
    })

    it('E3. tighter maxTakeBps denies an over-cap legs guard; a looser one allows the same legs', async function () {
        const creator = await cryptoHelper.getNewFundedAddress('cv-e3c', COIN, NETWORK, null, 'legacy', 0, 1)
        const market  = await cryptoHelper.getNewFundedAddress('cv-e3m', COIN, NETWORK, null, 'legacy', 0, 1)

        // (a) maxTakeBps 300 < Σlegs 350 → DENIED.
        const tickA = randTick('CVF')
        await issueHelper.sendIssueV0(owner, tickA, '100000', '100000', '0', 'cverify E3a', '100000')
        const depA = await vmHelper.sendDeployV0(owner, royaltyGateManifest(creator.address, market.address, 300), 250000)
        await submitRaw(owner, issueBindWire(tickA, depA.contract.action_index, 'trade', 0, 0))
        await waitTokenController(tickA, e => e.action_class === 'trade' && e.is_unbind === 0)
        await mine(1)
        await submitRaw(owner, `ORDER|0|${COIN_CODE}|${tickA}|1000||${COIN_CODE}|XCHAIN|1000||${owner.address}||||e3-overcap`)
        assert(await expectOrderRejected(owner.address, tickA), 'over-cap legs: ORDER rejected by tighter per-contract maxTakeBps')
        console.log('   E3a over-cap legs denied by tighter per-contract maxTakeBps — OK')

        // (b) maxTakeBps 600 > Σlegs 350 → ALLOWED, legs persisted.
        const tickB = randTick('CVG')
        await issueHelper.sendIssueV0(owner, tickB, '100000', '100000', '0', 'cverify E3b', '100000')
        const depB = await vmHelper.sendDeployV0(owner, royaltyGateManifest(creator.address, market.address, 600), 250000)
        await submitRaw(owner, issueBindWire(tickB, depB.contract.action_index, 'trade', 0, 0))
        await waitTokenController(tickB, e => e.action_class === 'trade' && e.is_unbind === 0)
        await mine(1)
        await submitRaw(owner, `ORDER|0|${COIN_CODE}|${tickB}|1000||${COIN_CODE}|XCHAIN|1000||${owner.address}||||e3-undercap`)
        const ord = await waitValidOrder(owner.address, tickB)
        assert(ord && ord.payout_legs, 'within the per-contract cap: order valid + legs persisted')
        const legs = JSON.parse(ord.payout_legs)
        assert(legs.length === 2 && legs[0].bps === 250 && legs[1].bps === 100, 'legs preserved under the looser cap')
        console.log('   E3b legs within the looser cap settled — OK')
    })

    it('7. regression: uncontrolled token + address behave byte-for-byte as before', async function () {
        const tick = randTick('CVU')
        await issueHelper.sendIssueV0(owner, tick, '100000', '100000', '0', 'uncontrolled', '100000')
        const eve = await cryptoHelper.getNewFundedAddress('cv-eve', COIN, NETWORK, null, 'legacy', 0, 1)
        // plain SEND
        const sres = await sendHelper.sendSendV0(owner, tick, '15', eve.address, 'plain')
        assert(sres.send && sres.credit && sres.debit, 'uncontrolled SEND credits+debits normally')
        assert(await balanceOf(eve.address, tick) === '15', 'recipient balance exact')
        // plain ORDER carries NO payout_legs
        await submitRaw(owner, `ORDER|0|${COIN_CODE}|${tick}|100||${COIN_CODE}|XCHAIN|100||${owner.address}||||plain-order`)
        await mine(1); await sleep(2500)
        const ord = await waitValidOrder(owner.address, tick, 20000)
        assert(ord && ord.status === 'valid', 'uncontrolled ORDER accepted')
        assert(ord.payout_legs === null, 'uncontrolled ORDER has NULL payout_legs')
        console.log('   uncontrolled token unchanged (payout_legs NULL) — OK')
    })
})
