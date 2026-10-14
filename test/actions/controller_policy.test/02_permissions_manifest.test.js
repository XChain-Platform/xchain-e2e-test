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

// Phase E permissions manifest: persisted maxTakeBps, emission allowlist, per-contract cap. Part of controller_policy.test.js.

const assert = require('assert')
const cryptoHelper = require('../../helpers/core/cryptoHelper')
const issueHelper = require('../../helpers/issueHelper')
const vmHelper = require('../../helpers/vmHelper')
const { waitForTxIndexed } = require('../../helpers/indexerWait')
const {
    balanceOf, contractPermissionsRow, randTick, mine, sleep, submitRaw, issueBindWire, waitValidOrder, expectOrderRejected, waitTokenController, royaltyGateManifest, MANIFEST_FORBIDS_SEND, newOwner,
} = require('./support/shared')

describe('Controller Policy Layer: bindings, enforcement, royalty split + permissions manifest (Phases A-E)', function () {
    this.timeout(0)
    let owner

    before(async function () {
        owner = await newOwner()
    })

    it('E1. manifest persisted at deploy: declared maxTakeBps stored in contract_permissions', async function () {
        const creator = await cryptoHelper.getNewFundedAddress('cv-e1c', COIN, NETWORK, null, 'legacy', 0, 1)
        const market  = await cryptoHelper.getNewFundedAddress('cv-e1m', COIN, NETWORK, null, 'legacy', 0, 1)
        const dep = await vmHelper.sendDeployV0(owner, royaltyGateManifest(creator.address, market.address, 300), 250000)
        const ci  = dep.contract.action_index
        // Poll: DEPLOY indexing lags the submit (submitRaw/deploy return on confirm).
        let row = null
        const end = Date.now() + 20000
        while (Date.now() < end) { row = await contractPermissionsRow(ci); if (row) break; await sleep(1000) }
        assert(row !== null, 'contract_permissions row persisted at deploy')
        assert.strictEqual(Number(row.max_take_bps), 300, 'declared maxTakeBps stored')
        assert(row.permissions === null, 'no permissions array declared -> NULL (unrestricted)')
        console.log('   E1 contract_permissions =', row)
    })

    it('E2. emission allowlist: a guard emitting a non-permitted action is denied (all paths)', async function () {
        const tick = randTick('CVE')
        await issueHelper.sendIssueV0(owner, tick, '100000', '100000', '0', 'cverify E2', '100000')
        // Guard emits SEND but its manifest permits only ISSUE.
        const dep = await vmHelper.sendDeployV0(owner, MANIFEST_FORBIDS_SEND, 250000)
        const ctrl = dep.contract.action_index
        // Fund the contract so its guard's SEND emission WOULD succeed if the allowlist permitted
        // it. Otherwise the emission fails on insufficient balance regardless of the manifest,
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
        // the allowlist -> throws -> guard DENIES -> the original SEND is blocked (recipient gets none).
        const manifestBlockedTx = await submitRaw(owner, `SEND|0|${tick}|10|${recip.address}|manifest-blocked`)
        // Wait for the send to be judged; the recipient's balance is only evidence
        // of a denial after that. Bound = one indexer barrier cycle (60s plus retry).
        await waitForTxIndexed(manifestBlockedTx, { timeoutMs: 120000, intervalMs: 250 })
        const after = await balanceOf(recip.address, tick)
        assert.strictEqual(after, before, 'SEND blocked by the allowlist (contract IS funded, so the block is the manifest, not balance)')
        console.log('   E2 manifest-forbidden emission denied the funded contract; OK')
    })

    it('E3. tighter maxTakeBps denies an over-cap legs guard; a looser one allows the same legs', async function () {
        const creator = await cryptoHelper.getNewFundedAddress('cv-e3c', COIN, NETWORK, null, 'legacy', 0, 1)
        const market  = await cryptoHelper.getNewFundedAddress('cv-e3m', COIN, NETWORK, null, 'legacy', 0, 1)

        // (a) maxTakeBps 300 < Σlegs 350 -> DENIED.
        const tickA = randTick('CVF')
        await issueHelper.sendIssueV0(owner, tickA, '100000', '100000', '0', 'cverify E3a', '100000')
        const depA = await vmHelper.sendDeployV0(owner, royaltyGateManifest(creator.address, market.address, 300), 250000)
        await submitRaw(owner, issueBindWire(tickA, depA.contract.action_index, 'trade', 0, 0))
        await waitTokenController(tickA, e => e.action_class === 'trade' && e.is_unbind === 0)
        await mine(1)
        const overcapTx = await submitRaw(owner, `ORDER|0|${COIN_CODE}|${tickA}|1000||${COIN_CODE}|XCHAIN|1000||${owner.address}||||e3-overcap`)
        assert(await expectOrderRejected(owner.address, tickA, overcapTx), 'over-cap legs: ORDER rejected by tighter per-contract maxTakeBps')
        console.log('   E3a over-cap legs denied by tighter per-contract maxTakeBps; OK')

        // (b) maxTakeBps 600 > Σlegs 350 -> ALLOWED, legs persisted.
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
        console.log('   E3b legs within the looser cap settled; OK')
    })
})
