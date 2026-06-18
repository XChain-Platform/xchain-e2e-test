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

/**
 * Issuance-fee exemption for VM-emitted ISSUE (constructor path).
 *
 * A contract whose CONSTRUCTOR calls xchain.emit.issue() runs while the freshly
 * derived contract address holds zero XCHAIN. If the issuance fee were charged
 * against that emitted ISSUE, the fee validation fails with "insufficient funds
 * (FEE)", the constructor reverts, and the whole DEPLOY rolls back: no contract
 * row, no token row. The deployer already paid DEPLOY gas (base + per-byte +
 * per-emission gas), so emitted ISSUEs are fee-exempt by design.
 *
 * The exemption is a consensus rule, gated by its own ISSUANCE_FEE_EMISSION_EXEMPT
 * activation (block 0 / version 2.0.0, the VM action cohort) so the fee behaviour
 * switches over deterministically at a fixed block rather than implicitly the moment
 * a node upgrades. Without the exemption, a constructor that emits an ISSUE forks the
 * ledger between node versions (revert + rollback vs. success + token row); this guard
 * proves the exempt path: the constructor must succeed with no contract funding.
 *
 * This is the constructor analogue of vmExtended.test.js section D, which pre-funds
 * the contract and emits from an EXECUTE (that path can mask the fee charge; the
 * constructor path cannot (a brand-new address cannot be pre-funded).
 */
describe('Issuance fee: VM-emitted ISSUE from a constructor is fee-exempt', function () {

    // Coin symbol used in the contract derived address: C:<CHAIN>:<action_index>
    const CHAIN = ({ bitcoin: 'BTC', litecoin: 'LTC', dogecoin: 'DOGE' })[COIN] || 'BTC'

    let deployer = null

    async function q(sql, params) {
        const conn = await indexerDatabase.getConnection()
        try { return await conn.query(sql, params) }
        finally { await conn.release() }
    }
    async function tickExists(tick) {
        const rows = await q(`SELECT id FROM index_tickers WHERE tick=? LIMIT 1`, [tick])
        return rows.length > 0
    }
    async function balanceOf(address, tick) {
        const rows = await q(
            `SELECT b.amount FROM balances b
             JOIN index_addresses ia ON ia.id=b.address_id
             JOIN index_tickers it ON it.id=b.tick_id
             WHERE ia.address=? AND it.tick=?`, [address, tick])
        return rows.length ? String(rows[0].amount) : null
    }
    function randTick(prefix) {
        let s = prefix
        for (let i = 0; i < 5; i++) s += String.fromCharCode(65 + Math.floor(Math.random() * 26))
        return s
    }

    before(async function () {
        // The deployer funds DEPLOY gas (which covers the per-emission gas for the
        // constructor's emit.issue). The CONTRACT is deliberately never funded; the
        // whole point is that the emitted ISSUE must not need a contract balance.
        deployer = await cryptoHelper.getNewFundedAddress('issfee-exempt-deployer', COIN, NETWORK, null, 'legacy', 0, 1)
        await gasHelper.ensureGasBalance(deployer, '500')
    })

    it('constructor emit.issue succeeds against a zero-balance contract (no issuance fee charged)', async function () {
        const tick = randTick('CIE')

        // Constructor (the deploy-time `initialize` method) emits an ISSUE to the
        // contract's own derived address. The tick is embedded in the source so the
        // deploy is self-contained and does not depend on constructor-param plumbing.
        const CTOR_MINTER = `
            module.exports = {
                initialize: function() {
                    xchain.emit.issue({
                        tick: '${tick}', maxSupply: '1000', maxMint: '1000',
                        decimals: '0', mintSupply: '1000', description: 'ctor-minted'
                    });
                }
            };
        `

        // sendDeployV0 waits for a status='valid' contract row. On a pre-exemption
        // (or un-gated) indexer the constructor reverts on the issuance fee and no
        // valid contract row is ever written, so this call fails the regression.
        const dep = await vmHelper.sendDeployV0(deployer, CTOR_MINTER, 300000)
        assert(dep.contract, 'a contract row should exist for the constructor-emit deploy')
        assert.strictEqual(dep.contract.status, 'valid',
            `DEPLOY must succeed; a charged issuance fee would revert the constructor (status: ${dep.contract.status})`)

        const ci = dep.contract.action_index
        const contractAddr = `C:${CHAIN}:${ci}`

        // The emitted token must exist (the constructor's ISSUE was processed, not rolled back).
        assert(await tickExists(tick), `emitted token ${tick} should exist after a successful constructor deploy`)

        // The contract holds the full minted supply at its derived address, and it
        // never held XCHAIN, proving no issuance fee was deducted from it.
        const bal = await balanceOf(contractAddr, tick)
        assert.strictEqual(bal, '1000',
            `contract address ${contractAddr} should hold the constructor-minted supply (got ${bal})`)
        assert.strictEqual(await balanceOf(contractAddr, 'XCHAIN'), null,
            'contract was never funded with XCHAIN, confirming the emitted ISSUE paid no issuance fee')
    })
})
