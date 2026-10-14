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

// The 'all' class fallback and override, and the uncontrolled regression. Part of controller_policy.test.js.

const assert = require('assert')
const cryptoHelper = require('../../helpers/core/cryptoHelper')
const issueHelper = require('../../helpers/issueHelper')
const sendHelper = require('../../helpers/sendHelper')
const vmHelper = require('../../helpers/vmHelper')
const { waitForTxIndexed } = require('../../helpers/indexerWait')
const {
    balanceOf, randTick, mine, submitRaw, issueBindWire, waitValidOrder, expectOrderRejected, waitTokenController, ALL_DENY_GATE, ALLOW_GATE, newOwner,
} = require('./support/shared')

describe('Controller Policy Layer: bindings, enforcement, royalty split + permissions manifest (Phases A-E)', function () {
    this.timeout(0)
    let owner

    before(async function () {
        owner = await newOwner()
    })

    it("8. 'all' class: one binding gates multiple classes; a specific binding overrides it for that class only", async function () {
        const tick = randTick('CVL')
        await issueHelper.sendIssueV0(owner, tick, '100000', '100000', '0', "cverify all", '100000')

        // Bind a deny-everything guard to the catch-all 'all' class.
        const depAll = await vmHelper.sendDeployV0(owner, ALL_DENY_GATE, 250000)
        await submitRaw(owner, issueBindWire(tick, depAll.contract.action_index, 'all', 0, 0))
        await mine(1)
        const ev = await waitTokenController(tick, e => e.action_class === 'all' && Number(e.is_unbind) === 0)
        assert(ev.some(e => e.action_class === 'all' && Number(e.is_unbind) === 0), "'all' bind row present")
        console.log("   bound 'all' -> deny-everything guard")

        // FALLBACK across classes: a SEND (transfer) is blocked by the 'all' guard...
        const fred = await cryptoHelper.getNewFundedAddress('cv-fred', COIN, NETWORK, null, 'legacy', 0, 1)
        let before = await balanceOf(fred.address, tick)
        const allBlockedSendTx = await submitRaw(owner, `SEND|0|${tick}|10|${fred.address}|all-blocked-send`)
        // The indexer's verdict on THIS send, not a fixed interval.
        await mine(1); await waitForTxIndexed(allBlockedSendTx, { timeoutMs: 120000, intervalMs: 250 })
        assert.strictEqual(await balanceOf(fred.address, tick), before, "SEND falls back to the 'all' guard and is DENIED")
        console.log("   SEND denied via 'all' fallback (transfer class); OK")

        // ...and an ORDER (trade) is ALSO blocked by the same single 'all' binding.
        const allBlockedOrderTx = await submitRaw(owner, `ORDER|0|${COIN_CODE}|${tick}|50||${COIN_CODE}|XCHAIN|50||${owner.address}||||all-blocked-order`)
        await mine(1)
        assert(await expectOrderRejected(owner.address, tick, allBlockedOrderTx), "ORDER falls back to the 'all' guard and is DENIED")
        console.log("   ORDER denied via 'all' fallback (trade class); one binding gates both; OK")

        // OVERRIDE: bind a permissive controller to the specific 'transfer' class on top of 'all'.
        // (Binding a specific class while 'all' is bound must be ALLOWED; it is the override.)
        const depAllow = await vmHelper.sendDeployV0(owner, ALLOW_GATE, 250000)
        await submitRaw(owner, issueBindWire(tick, depAllow.contract.action_index, 'transfer', 0, 0))
        await mine(1)
        await waitTokenController(tick, e => e.action_class === 'transfer' && Number(e.is_unbind) === 0)
        console.log("   bound specific 'transfer' -> allow guard (override on top of 'all')")

        // SEND now resolves to the specific transfer controller (most-specific wins) -> ALLOWED.
        before = await balanceOf(fred.address, tick)
        const sres = await sendHelper.sendSendV0(owner, tick, '10', fred.address, 'override-send')
        assert(sres.send, 'SEND now routes to the specific transfer controller (most-specific wins) and is ALLOWED')
        assert.strictEqual(Number(await balanceOf(fred.address, tick)) - Number(before), 10, 'recipient credited under the override')
        console.log("   SEND allowed under specific 'transfer' override; OK")

        // The override is class-scoped: ORDER (trade) still has no specific binding, so it STILL
        // falls back to the 'all' deny guard.
        const stillBlockedOrderTx = await submitRaw(owner, `ORDER|0|${COIN_CODE}|${tick}|50||${COIN_CODE}|XCHAIN|50||${owner.address}||||still-blocked-order`)
        await mine(1)
        assert(await expectOrderRejected(owner.address, tick, stillBlockedOrderTx), "ORDER still falls back to 'all' (override is class-scoped)")
        console.log("   ORDER still denied via 'all'; override is class-scoped; OK")
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
        await mine(1)
        const ord = await waitValidOrder(owner.address, tick, 22500)
        assert(ord && ord.status === 'valid', 'uncontrolled ORDER accepted')
        assert(ord.payout_legs === null, 'uncontrolled ORDER has NULL payout_legs')
        console.log('   uncontrolled token unchanged (payout_legs NULL); OK')
    })
})
