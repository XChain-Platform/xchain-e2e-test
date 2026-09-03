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
const crypto = require('crypto')
const cryptoHelper = require('../cryptoHelper')
const stakeHelper = require('../helpers/stakeHelper')
const stakeTeardown = require('../helpers/stakeTeardown')
const vmHelper = require('../helpers/vmHelper')
const gasHelper = require('../helpers/gasHelper')

/**
 * VM Contract SLASH: proves the fund-movement of a contract slashing one of its own stakers.
 * `contractStaking.test.js` deploys a stakeable contract with a ready `doSlash` method but never
 * invokes it; this exercises the full SLASH emission path end-to-end:
 *   contract emits SLASH → indexer _processSlashEmission → staker's stake deducted (LIFO) →
 *   slashed tokens credited to the contract's slash_destination (BURN) → slash_events row.
 *
 * Verified against the indexer DB: contract_stakes (remaining), slash_events, and the
 * burn-address balance. (contract_executions has no return_value, so we assert via DB state.)
 */
describe('VM Contract SLASH: a contract slashes its own staker', function () {

    // Ed25519 pubkey as a 64-hex string (same pattern as contractStaking.test.js / staking.test.js).
    function newSigningPubkey(){
        let { publicKey } = crypto.generateKeyPairSync('ed25519')
        return publicKey.export({ format: 'der', type: 'spki' }).subarray(12).toString('hex')
    }

    // Stakeable contract exposing a single slash primitive: slash(pubkey, amount) of XCHAIN.
    const SLASHER = `
        module.exports = {
            doSlash: function() {
                xchain.contract.slash(xchain.getInputParam(0), 'XCHAIN', xchain.getInputParam(1))
                return 'ok'
            }
        };
    `

    let contractIndex = null
    let staker = null
    let pubkey = null

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
    // Net active stake for (contract, pubkey, tick): the SUM the gateway's getStake reads.
    async function activeStake(ci, pk, tick) {
        const rows = await q(`SELECT COALESCE(SUM(CAST(cs.amount AS DECIMAL(30,8))),0) AS amt
            FROM contract_stakes cs
            JOIN index_pubkeys pk ON pk.id=cs.signing_pubkey_id
            JOIN index_tickers it ON it.id=cs.tick_id
            JOIN index_statuses s ON s.id=cs.status_id
            WHERE cs.target_contract_index=? AND pk.pubkey=? AND it.tick=? AND s.status='valid'`,
            [Number(ci), pk, tick])
        return rows.length ? Number(rows[0].amt) : 0
    }
    // Latest slash_events row for (contract, pubkey) → { amount, dest address }.
    async function latestSlashEvent(ci, pk) {
        const rows = await q(`SELECT se.amount AS amount, ia.address AS dest
            FROM slash_events se
            JOIN index_pubkeys pk ON pk.id=se.signing_pubkey_id
            JOIN index_addresses ia ON ia.id=se.destination_id
            WHERE se.target_contract_index=? AND pk.pubkey=?
            ORDER BY se.id DESC LIMIT 1`, [Number(ci), pk])
        return rows.length ? { amount: String(rows[0].amount), dest: rows[0].dest } : null
    }
    // Poll until the newest slash_events row reaches `expected` amount (or deadline). sendExecuteV0
    // resolves once the EXECUTE row is 'valid', but the emitted SLASH's slash_events row can land a
    // beat later through a separate pool connection; on the slower DOGE cadence the immediate read
    // saw the *previous* slash (50 vs the capped 150). Returns the last-seen row either way so a
    // genuine mismatch still surfaces in the caller's assertion.
    async function waitForLatestSlash(ci, pk, expected, ms = 30000) {
        const deadline = Date.now() + ms
        let ev = null
        while (Date.now() < deadline) {
            ev = await latestSlashEvent(ci, pk)
            if (ev && ev.amount === String(expected)) return ev
            await new Promise(r => setTimeout(r, 1000))
        }
        return ev
    }
    // The contract's configured slash destination address (BURN sentinel resolved at DEPLOY time).
    async function slashDestAddress(ci) {
        const rows = await q(`SELECT ia.address AS address FROM contracts c
            JOIN index_addresses ia ON ia.id=c.slash_destination_id
            WHERE c.action_index=?`, [Number(ci)])
        return rows.length ? rows[0].address : null
    }
    async function emissionAction(executionIndex) {
        const rows = await q(`SELECT emitted_action FROM contract_emissions
            WHERE execution_index=? ORDER BY position`, [executionIndex])
        return rows.map(r => r.emitted_action)
    }
    // One address's escrow row for an action. A contract stake LOCKS its tokens in the
    // staker's escrow, so a slash that redirects them must RELEASE that lock in the same
    // action - a negative row keyed to the staker. Without it the credit below is a mint
    // and the burned stake stays locked in the staker's escrow for good.
    async function escrowRow(actionIndex, address, tick) {
        const rows = await q(`SELECT e.amount FROM escrows e
            JOIN index_addresses ia ON ia.id=e.address_id
            JOIN index_tickers it ON it.id=e.tick_id
            WHERE e.action_index=? AND ia.address=? AND it.tick=?`,
            [Number(actionIndex), address, tick])
        return rows.length ? Number(rows[0].amount) : null
    }
    // Signed ledger rows for one action: credits positive, debits negative, escrows as
    // written. Their sum is that action's effect on total supply.
    async function ledgerFor(actionIndex, tick) {
        const one = async (table) => {
            const rows = await q(`SELECT COALESCE(SUM(CAST(l.amount AS DECIMAL(30,8))),0) AS amt
                FROM ${table} l JOIN index_tickers it ON it.id=l.tick_id
                WHERE l.action_index=? AND it.tick=?`, [Number(actionIndex), tick])
            return Number(rows[0].amt)
        }
        const credits = await one('credits'), debits = await one('debits'), escrows = await one('escrows')
        return { credits, debits, escrows, net: credits - debits + escrows }
    }
    // The ledger shape every slash below must have: the escrow release equals the amount
    // slashed, and once the EXECUTE's own gas burn is netted out the slash moves supply by
    // ZERO - a contract slash redirects the whole bond to its destination, so it has no
    // un-redirected remainder to destroy. Any drift here is a mint or a stranded lock.
    async function assertSlashIsARedirect(executionIndex, slashed) {
        const released = await escrowRow(executionIndex, staker['address'], 'XCHAIN')
        assert.notStrictEqual(released, null,
            'the slash wrote no escrow row for the staker: the slashed stake is stranded in escrow ' +
            'and the destination credit is a pure mint')
        assert.strictEqual(released, -slashed,
            'the escrow release must equal the amount slashed exactly')
        const led = await ledgerFor(executionIndex, 'XCHAIN')
        // The slash handler pushes no debits of its own, so anything debited on this
        // action is the EXECUTE's gas: a genuine burn, but not part of the slash.
        assert.strictEqual(led.net + led.debits, 0,
            'the slash changed total supply; it redirects a locked stake, so it must not ' +
            '(credits ' + led.credits + ', escrows ' + led.escrows + ', gas ' + led.debits + ')')
    }

    before(async function () {
        const deployer = await cryptoHelper.getNewFundedAddress('slash-deployer', COIN, NETWORK, null, 'legacy', 0, 1)
        await gasHelper.ensureGasBalance(deployer, '500')
        // DEPLOY v1: stakeable, cooldown 50 blocks, slash destination BURN.
        const deploy = await vmHelper.sendDeployV1(deployer, SLASHER, 300000, '', 50, 'BURN')
        assert(deploy.contract && deploy.contract.status === 'valid', 'stakeable contract must deploy clean')
        contractIndex = deploy.contract.action_index

        staker = await cryptoHelper.getNewFundedAddress('slash-staker', COIN, NETWORK, null, 'legacy', 0, 1)
        await gasHelper.ensureGasBalance(staker, '600') // 200 to stake + gas headroom
        pubkey = newSigningPubkey()

        const st = await stakeHelper.sendStakeV3(staker, '200.00000000', pubkey, contractIndex, 'XCHAIN')
        assert(st.stake && st.stake.status === 'valid', 'STAKE v3 of 200 XCHAIN must be valid')
    })

    // A stake this suite slashed to zero owes the venue no UNSTAKE: there is nothing left
    // to hand back, and the sweep's doomed broadcast costs the run a minute and prints a
    // FAILED line that reads like a defect. Settle the fixture ledger only when the chain
    // agrees the stake is empty, so a suite that stopped early still gets swept normally.
    after(async function () {
        if (contractIndex === null || pubkey === null) return
        if (await activeStake(contractIndex, pubkey, 'XCHAIN') === 0)
            stakeTeardown.noteUnstake({ signingPubkey: pubkey, contractIndex, tick: 'XCHAIN' })
    })

    it('records a 200 XCHAIN stake before any slash', async function () {
        assert.strictEqual(await activeStake(contractIndex, pubkey, 'XCHAIN'), 200,
            'active stake should be 200 before slashing')
    })

    it('slashes 50: stake drops to 150, 50 credited to the burn destination, slash_events written', async function () {
        // BURN is a global, shared destination that accumulates across every slash on the stack,
        // so assert a +50 delta rather than an absolute balance (the DB is not pristine).
        const burnAddr = await slashDestAddress(contractIndex)
        const burnBefore = Number(await balanceOf(burnAddr, 'XCHAIN')) || 0

        const ex = await vmHelper.sendExecuteV0(staker, contractIndex, 'doSlash', [pubkey, '50'])
        assert.strictEqual(ex.execution.status, 'valid', 'doSlash execution must be valid')
        assert.deepStrictEqual(await emissionAction(ex.execution.action_index), ['SLASH'],
            'one SLASH emission should be recorded')

        const ev = await waitForLatestSlash(contractIndex, pubkey, 50)
        assert(ev, 'a slash_events row should exist')
        assert.strictEqual(Number(ev.amount), 50, 'slash_events.amount should be 50')

        // Remaining active stake: 200 -> 150.
        assert.strictEqual(await activeStake(contractIndex, pubkey, 'XCHAIN'), 150,
            'stake should be reduced to 150 after slashing 50')
        // The slashed 50 XCHAIN was credited to the contract's slash destination (BURN address).
        assert.strictEqual(Number(await balanceOf(ev.dest, 'XCHAIN')), burnBefore + 50,
            'burn destination should be credited exactly the slashed 50 XCHAIN')

        await assertSlashIsARedirect(ex.execution.action_index, 50)
    })

    it('over-slash is capped at the available stake (slash 300 of 150 → 150, stake → 0)', async function () {
        // Burn dest currently holds 50 from the previous slash; capping should add exactly 150 more.
        const ev0 = await latestSlashEvent(contractIndex, pubkey)
        const destBefore = Number(await balanceOf(ev0.dest, 'XCHAIN')) // 50

        const ex = await vmHelper.sendExecuteV0(staker, contractIndex, 'doSlash', [pubkey, '300'])
        assert.strictEqual(ex.execution.status, 'valid', 'over-slash execution still succeeds (capped, not rejected)')

        const ev = await waitForLatestSlash(contractIndex, pubkey, 150)
        assert.strictEqual(Number(ev.amount), 150, 'slash_events.amount should be capped at the remaining 150')
        assert.strictEqual(await activeStake(contractIndex, pubkey, 'XCHAIN'), 0, 'stake should be fully drained to 0')
        assert.strictEqual(Number(await balanceOf(ev.dest, 'XCHAIN')), destBefore + 150,
            'burn destination should receive exactly the capped 150 more')

        // The cap changes how much is taken, not the shape: the release still equals what
        // was actually slashed, not what the contract asked for.
        await assertSlashIsARedirect(ex.execution.action_index, 150)
    })
})
