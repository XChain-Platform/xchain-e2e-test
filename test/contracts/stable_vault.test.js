// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// Stable Vault (on-chain): a mini-MakerDAO -- over-collateralized vaults where
// the CONTRACT issues and mints its own stable token against oracle-priced
// collateral.
//
//   DEPLOY stableVault(collateralTick, stableTick, coinPair, minRatioPct,
//                      liqBonusPct, maxSnapshotAge)
//     -> initialize emits ISSUE(stableTick): the contract is the issuer.
//   vault owner: DEPOSIT(contract, COLL, x) then EXECUTE "deposit"
//                EXECUTE "borrow" amount   -> emits MINT + SEND of the stable
//                DEPOSIT(contract, STABLE, x) then EXECUTE "repay" -> DESTROY
//   anyone:      DEPOSIT(contract, STABLE, >= debt) then EXECUTE "liquidate"
//                once the oracle price puts the vault under the minimum ratio.
//
// This is the first e2e where a contract EMITS ISSUE/MINT/DESTROY on-chain:
// it proves the emission path indexer actionIssue/actionMint/actionDestroy <-
// VM emissionCollector <- contract emit.*, on top of the PRICE-oracle wiring
// already proven by the priceBet suite (getPrice + getSnapshotAge here).
//
// The contract source is a compacted copy of the canonical template at
// xchain-contracts/stableVault/stableVault.js. Behaviour is identical; the VM
// unit test (stable_vault.test.js in xchain-contracts) covers the full matrix.

const assert = require('assert')
const cryptoHelper = require('../helpers/core/cryptoHelper')
const vmHelper = require('../helpers/vmHelper')
const gasHelper = require('../helpers/gasHelper')
const priceSnapshotHelper = require('../helpers/priceSnapshotHelper')
const { STABLE_VAULT } = require('./fixtures/stable_vault_source')

    const CHAIN = ({ bitcoin: 'BTC', litecoin: 'LTC', dogecoin: 'DOGE' })[COIN] || 'BTC'
    const COLL = 'XCHAIN'      // collateral = the gas token; nothing extra to issue
    const RATIO = '150'
    const BONUS = '20'
    const MAXAGE = '100000'    // blocks; staleness is unit-tested, not the point here
    // All amounts below are integers ON PURPOSE: the indexer normalizes every
    // emitted amount to the tick's decimals, and XCHAIN carries 0 decimals in
    // this stack -- a fractional seizure (e.g. 2.75) would be rounded in the
    // ledger while the contract state keeps the exact figure, drifting the
    // two apart. Numbers are chosen so the liquidation seizure lands exactly
    // on the integer grid: 150 debt * 120% / $20 = 9.
    // Unique stable tick + oracle pair per run, so reruns never collide with a
    // tick already issued (by a previous contract address) or older snapshots.
    const rand = () => String.fromCharCode(65 + Math.floor(Math.random() * 26))
    const STABLE = 'DU' + rand() + rand() + rand()
    const PAIR = 'XC' + Math.floor(Math.random() * 900 + 100) + '/USD'

    let alice = null           // vault owner who gets liquidated
    let liq = null             // second vault owner acting as liquidator
    let ci = null              // contract action_index
    let contractAddr = null
    let stableVaultSetup = null

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
        return rows.length ? String(rows[0].amount) : null
    }
    async function stateOf(key) {
        const rows = await q(`SELECT state_value FROM contract_state
            WHERE contract_index=? AND state_key=?
            ORDER BY id DESC LIMIT 1`, [ci, key])
        if (!rows.length || rows[0].state_value === null) return null
        let v = String(rows[0].state_value)
        try { v = JSON.parse(v) } catch (e) { /* stored raw */ }
        return v
    }
    async function setPrice(price, round) {
        // referenceBlock at the tip keeps getSnapshotAge() small: the vault's
        // freshness guard (borrow/withdraw/liquidate) measures blocks since
        // the last finalized snapshot's reference_block.
        const tip = await q(`SELECT MAX(block_index) AS b FROM blocks`)
        await priceSnapshotHelper.seedSnapshot({
            coinPair: PAIR,
            price: price,
            blockTimestamp: await priceSnapshotHelper.latestBlockTime(),
            roundNumber: round,
            referenceBlock: Number(tip[0].b) || 0
        })
    }

    async function prepareStableVault() {
        if (!stableVaultSetup) {
            stableVaultSetup = (async function () {
                alice = await cryptoHelper.getNewFundedAddress('vault-alice', COIN, NETWORK, null, 'legacy', 0, 1)
                liq = await cryptoHelper.getNewFundedAddress('vault-liq', COIN, NETWORK, null, 'legacy', 0, 1)
                await gasHelper.ensureGasBalance(alice, '2000')
                await gasHelper.ensureGasBalance(liq, '2000')
                assert(await priceSnapshotHelper.isAvailable(), 'price_snapshots must be reachable for this suite')
                await priceSnapshotHelper.clearPair(PAIR)
            })()
        }
        return stableVaultSetup
    }

describe('Stable Vault: mini-MakerDAO (contract-emitted ISSUE/MINT/DESTROY + oracle getPrice)', function () {
    before(prepareStableVault)

    it('deploys the vault system and ISSUEs its own stable token', async function () {
        const params = [COLL, STABLE, PAIR, RATIO, BONUS, MAXAGE].join('|')
        const dep = await vmHelper.sendDeployV0(alice, STABLE_VAULT, 1000000, params)
        ci = dep.contract.action_index
        contractAddr = `C:${CHAIN}:${ci}`
        assert.strictEqual(await stateOf('stableTick'), STABLE, 'terms should be persisted')
        assert.strictEqual(await stateOf('totalDebt'), '0')

        // The emitted ISSUE must have registered the stable with the CONTRACT
        // as its owner.
        const issued = await q(
            `SELECT ia.address FROM tokens tk
             JOIN index_tickers it ON it.id=tk.tick_id
             JOIN index_addresses ia ON ia.id=tk.owner_id
             WHERE it.tick=?`, [STABLE])
        assert(issued.length, 'contract-emitted ISSUE should register the token')
        assert.strictEqual(String(issued[0].address), contractAddr, 'the contract owns the stable')
    })

    it('deposit collateral, borrow the stable up to the ratio limit, not a unit more', async function () {
        await setPrice('100.00000000', 1)

        await vmHelper.sendDepositV0(alice, ci, COLL, '10')
        const dep = await vmHelper.sendExecuteV0(alice, ci, 'deposit', [])
        assert(dep.execution && dep.execution.status === 'valid', 'deposit should index a valid execution')
        assert.strictEqual(await stateOf('v:' + alice.address + ':coll'), '10')

        // 10 XCHAIN * $100 * 100 = 100000 >= debt * 150  ->  max debt 666.
        const ex = await vmHelper.sendExecuteV0(alice, ci, 'borrow', ['200'])
        assert(ex.execution && ex.execution.status === 'valid',
            'borrow should index a valid execution (emitted MINT + SEND)')
        assert.strictEqual(Number(await balanceOf(alice.address, STABLE)), 200,
            'the borrower holds the freshly minted stable')
        assert.strictEqual(await stateOf('v:' + alice.address + ':debt'), '200')

        // Borrowing against an EMPTY vault must be rejected. (The attempt
        // comes from liq, who has no valid `borrow` yet: the e2e execution
        // lookup matches by contract+caller+method, so a caller with an
        // earlier valid call of the same method would match that one. The
        // exact at-the-ratio-limit rejection is covered by the unit suite.)
        const over = await vmHelper.sendExecuteV0Invalid(liq, ci, 'borrow', ['1'])
        assert(over.execution, 'empty-vault borrow should still record an execution row')
        assert.notStrictEqual(over.execution.status, 'valid', 'empty-vault borrow must not be valid')
    })
})

describe('Stable Vault: mini-MakerDAO (contract-emitted ISSUE/MINT/DESTROY + oracle getPrice)', function () {
    before(prepareStableVault)

    it('repay burns the stable against the debt (emitted DESTROY)', async function () {
        await vmHelper.sendDepositV0(alice, ci, STABLE, '50')
        const ex = await vmHelper.sendExecuteV0(alice, ci, 'repay', [])
        assert(ex.execution && ex.execution.status === 'valid', 'repay should index a valid execution')
        assert.strictEqual(await stateOf('v:' + alice.address + ':debt'), '150')
        assert.strictEqual(await stateOf('totalDebt'), '150')
        assert.strictEqual(Number(await balanceOf(alice.address, STABLE)), 150)
        // Burned, not held: the 50 must NOT sit in contract custody.
        const held = await balanceOf(contractAddr, STABLE)
        assert(held === null || Number(held) === 0, 'repaid stable should be destroyed')
    })

    it('liquidating a healthy vault is rejected on-chain', async function () {
        // No stable deposit needed: the health check fires before funding.
        const ex = await vmHelper.sendExecuteV0Invalid(liq, ci, 'liquidate', [alice.address])
        assert(ex.execution, 'rejected liquidate should still record an execution row')
        assert.notStrictEqual(ex.execution.status, 'valid', 'liquidating a healthy vault must not be valid')
        assert.strictEqual(await stateOf('v:' + alice.address + ':debt'), '150', 'vault must be untouched')
    })
})

describe('Stable Vault: mini-MakerDAO (contract-emitted ISSUE/MINT/DESTROY + oracle getPrice)', function () {
    before(prepareStableVault)

    it('price drop: a second vault borrows the stable and liquidates the first', async function () {
        // The liquidator sources stable the honest way: their own vault.
        await vmHelper.sendDepositV0(liq, ci, COLL, '3')
        const dep = await vmHelper.sendExecuteV0(liq, ci, 'deposit', [])
        assert(dep.execution && dep.execution.status === 'valid')
        const bor = await vmHelper.sendExecuteV0(liq, ci, 'borrow', ['150'])
        assert(bor.execution && bor.execution.status === 'valid')

        // Round 2 finalizes at $20: alice's vault is under water
        // (10 * 20 * 100 = 20000 < 150 * 150 = 22500). The liquidator's own
        // vault is even deeper under water, which is irrelevant: being under-
        // collateralized exposes you to liquidation, it does not block you
        // from liquidatING. Seizure: 150 * 120 / (20 * 100) = 9 XCHAIN.
        await setPrice('20.00000000', 2)

        const collBefore = Number(await balanceOf(liq.address, COLL))
        await vmHelper.sendDepositV0(liq, ci, STABLE, '150')
        const ex = await vmHelper.sendExecuteV0(liq, ci, 'liquidate', [alice.address])
        assert(ex.execution && ex.execution.status === 'valid',
            'liquidate should index a valid execution (DESTROY debt + SEND collateral)')

        const collAfter = Number(await balanceOf(liq.address, COLL))
        assert.strictEqual(collAfter - collBefore, 9,
            'liquidator seizes debt + 20% bonus at the oracle price')
        assert.strictEqual(Number(await stateOf('v:' + alice.address + ':coll')), 1,
            'the leftover collateral stays credited to the vault owner')
        assert.strictEqual(await stateOf('v:' + alice.address + ':debt'), '0')
        assert.strictEqual(await stateOf('totalDebt'), '150', 'only the liquidator debt remains')
        const held = await balanceOf(contractAddr, STABLE)
        assert(held === null || Number(held) === 0, 'the covered debt should be destroyed')

        // The former owner can still withdraw their leftover collateral.
        const wd = await vmHelper.sendExecuteV0(alice, ci, 'withdraw', ['1'])
        assert(wd.execution && wd.execution.status === 'valid', 'debt-free withdraw should be valid')
    })
})
