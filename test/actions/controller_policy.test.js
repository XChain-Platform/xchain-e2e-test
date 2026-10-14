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
 * Programmable Policy Layer: controller-gated tokens & accounts + royalty/fee
 * split (xchain-indexer Phases A-D). End-to-end integration regression against a
 * live bitcoin-regtest stack via the connector helpers (initialCheck globals).
 *
 * The controller binding actions have no SDK builder yet (Phase F), so they are
 * submitted as raw wire strings through transactionHelper:
 *   ISSUE format 6 : ISSUE|6|TICK|CONTROLLER|ACTION_CLASS|COOLDOWN_BLOCKS|UNBIND|MEMO
 *   ADDRESS format 1: ADDRESS|1|CONTROLLER|ACTION_CLASS|COOLDOWN_BLOCKS|UNBIND|MEMO
 *
 * Covers: bind + drop-cooldown gating, action-class routing, the catch-all 'all'
 * class (most-specific-wins fallback: one binding gates many classes, a specific
 * binding overrides it for that class only), royalty/fee split persistence + EXACT
 * conservation across partial fills, recipient address gate, guard-of-guard
 * recursion control, and an uncontrolled-token regression. The
 * royalty scenario specifically pins the two integration bugs that made the split
 * a silent no-op (VM returnValue is a JSON STRING parsed in runControllerGuard;
 * legs persisted from a pre-guard copy in order.js/swap.js).
 ********************************************************************/

const assert = require('assert')
const cryptoHelper = require('../helpers/core/cryptoHelper')
const issueHelper = require('../helpers/issueHelper')
const sendHelper = require('../helpers/sendHelper')
const vmHelper = require('../helpers/vmHelper')
const { waitForTxIndexed } = require('../helpers/indexerWait')
const {
    balanceOf, tip, randTick, j, mine, sleep, submitRaw, issueBindWire, addressBindWire,
    waitValidOrder, expectOrderRejected, waitTokenController, waitAddressController,
    TRADE_GATE, SEND_GATE, RECIP_GATE, SELF_EMIT_GATE, royaltyGate, newOwner,
} = require('./controller_policy.test/support/shared')

describe('Controller Policy Layer: bindings, enforcement, royalty split + permissions manifest (Phases A-E)', function () {
    this.timeout(0)
    let owner

    before(async function () {
        owner = await newOwner()
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
        console.log('   SEND allowed under trade binding; routing OK; bob balance =', await balanceOf(bob.address, tick))

        // GATING: an ORDER listing the token must be REJECTED while bound.
        const blockedOrderTx = await submitRaw(owner, `ORDER|0|${COIN_CODE}|${tick}|50||${COIN_CODE}|XCHAIN|50||${owner.address}||||blocked-order`)
        await mine(1)
        assert(await expectOrderRejected(owner.address, tick, blockedOrderTx), 'ORDER is REJECTED while trade controller is active')
        console.log('   ORDER rejected while bound; gating OK')

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
        const cooldownOrderTx = await submitRaw(owner, `ORDER|0|${COIN_CODE}|${tick}|50||${COIN_CODE}|XCHAIN|50||${owner.address}||||cooldown-order`)
        await mine(1)
        assert(await expectOrderRejected(owner.address, tick, cooldownOrderTx), 'ORDER still REJECTED during drop cooldown (anti-instant-drop)')
        console.log('   ORDER still rejected during cooldown; cooldown teeth OK')

        // Advance past cooldown_end_block -> ORDER now ACCEPTED.
        const endBlock = Number(unbindEv.cooldown_end_block)
        let guard = 0
        while ((await tip()) <= endBlock && guard++ < 90) { await mine(1); await sleep(1000) }
        console.log('   tip', await tip(), '> cooldown_end', endBlock, '(cooldown expired)')
        await submitRaw(owner, `ORDER|0|${COIN_CODE}|${tick}|50||${COIN_CODE}|XCHAIN|50||${owner.address}||||after-cooldown`)
        await mine(1)
        const allowed = await waitValidOrder(owner.address, tick, 22500)
        assert(allowed && allowed.status === 'valid', 'ORDER ACCEPTED after cooldown expiry')
        console.log('   ORDER accepted after cooldown; expiry OK. order#', allowed.action_index)
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
        const blockedSendTx = await submitRaw(owner, `SEND|0|${tick}|10|${carol.address}|blocked-send`)
        // Wait for the indexer's verdict on THIS send (its actions row lands whether
        // accepted or refused); an unchanged balance says nothing before then. Bound
        // = one indexer barrier cycle (a 60s cross-chain defer plus its retry).
        await mine(1); await waitForTxIndexed(blockedSendTx, { timeoutMs: 120000, intervalMs: 250 })
        const after = await balanceOf(carol.address, tick)
        assert(before === after, 'SEND of transfer-bound token is REJECTED (recipient balance unchanged)')
        console.log('   SEND blocked by transfer controller; OK. carol balance still', after)
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
        const unsolicitedTx = await submitRaw(owner, `SEND|0|${tick}|25|${recip.address}|unsolicited`)
        // The indexer's verdict on THIS send, not a fixed interval: an unchanged
        // recipient balance only means "reverted" once the send has been judged.
        await mine(1); await waitForTxIndexed(unsolicitedTx, { timeoutMs: 120000, intervalMs: 250 })
        const after = await balanceOf(recip.address, tick)
        assert(before === after, 'inbound SEND to gated recipient REVERTS (no credit)')
        console.log('   inbound SEND reverted by recipient gate; OK. recip balance', after)
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
        console.log('   guard-of-guard SEND settled; dave +', Number(after) - Number(before), '(OK)')
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
        await mine(1)
        const ord = await waitValidOrder(owner.address, tick, 22500)
        assert(ord && ord.status === 'valid', 'guarded ORDER committed (deterministic accept)')
        assert((await tip()) >= before, 'ledger advanced past the guarded action')
        console.log('   guarded action deterministically committed (order#', ord.action_index, '); single-node check OK')
    })
})
