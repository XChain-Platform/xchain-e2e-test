const assert = require('assert')
const crypto = require('crypto')
const cryptoHelper = require('../cryptoHelper')
const stakeHelper = require('../helpers/stakeHelper')
const vmHelper = require('../helpers/vmHelper')
const gasHelper = require('../helpers/gasHelper')

/**
 * VM Contract SLASH — proves the fund-movement of a contract slashing one of its own stakers.
 * `contractStaking.test.js` deploys a stakeable contract with a ready `doSlash` method but never
 * invokes it; this exercises the full SLASH emission path end-to-end:
 *   contract emits SLASH → indexer _processSlashEmission → staker's stake deducted (LIFO) →
 *   slashed tokens credited to the contract's slash_destination (BURN) → slash_events row.
 *
 * Verified against the indexer DB: contract_stakes (remaining), slash_events, and the
 * burn-address balance. (contract_executions has no return_value, so we assert via DB state.)
 */
describe('VM Contract SLASH — a contract slashes its own staker', function () {

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
    // Net active stake for (contract, pubkey, tick) — the SUM the gateway's getStake reads.
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

    before(async function () {
        const deployer = await cryptoHelper.getNewFundedAddress('slash-deployer', COIN, NETWORK, null, 'legacy', 0, 1)
        await gasHelper.ensureGasBalance(deployer, '500')
        // DEPLOY v1 — stakeable, cooldown 50 blocks, slash destination BURN.
        const deploy = await vmHelper.sendDeployV1(deployer, SLASHER, 300000, '', 50, 'BURN')
        assert(deploy.contract && deploy.contract.status === 'valid', 'stakeable contract must deploy clean')
        contractIndex = deploy.contract.action_index

        staker = await cryptoHelper.getNewFundedAddress('slash-staker', COIN, NETWORK, null, 'legacy', 0, 1)
        await gasHelper.ensureGasBalance(staker, '600') // 200 to stake + gas headroom
        pubkey = newSigningPubkey()

        const st = await stakeHelper.sendStakeV3(staker, '200.00000000', pubkey, contractIndex, 'XCHAIN')
        assert(st.stake && st.stake.status === 'valid', 'STAKE v3 of 200 XCHAIN must be valid')
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

        const ev = await latestSlashEvent(contractIndex, pubkey)
        assert(ev, 'a slash_events row should exist')
        assert.strictEqual(Number(ev.amount), 50, 'slash_events.amount should be 50')

        // Remaining active stake: 200 -> 150.
        assert.strictEqual(await activeStake(contractIndex, pubkey, 'XCHAIN'), 150,
            'stake should be reduced to 150 after slashing 50')
        // The slashed 50 XCHAIN was credited to the contract's slash destination (BURN address).
        assert.strictEqual(Number(await balanceOf(ev.dest, 'XCHAIN')), burnBefore + 50,
            'burn destination should be credited exactly the slashed 50 XCHAIN')
    })

    it('over-slash is capped at the available stake (slash 300 of 150 → 150, stake → 0)', async function () {
        // Burn dest currently holds 50 from the previous slash; capping should add exactly 150 more.
        const ev0 = await latestSlashEvent(contractIndex, pubkey)
        const destBefore = Number(await balanceOf(ev0.dest, 'XCHAIN')) // 50

        const ex = await vmHelper.sendExecuteV0(staker, contractIndex, 'doSlash', [pubkey, '300'])
        assert.strictEqual(ex.execution.status, 'valid', 'over-slash execution still succeeds (capped, not rejected)')

        const ev = await latestSlashEvent(contractIndex, pubkey)
        assert.strictEqual(Number(ev.amount), 150, 'slash_events.amount should be capped at the remaining 150')
        assert.strictEqual(await activeStake(contractIndex, pubkey, 'XCHAIN'), 0, 'stake should be fully drained to 0')
        assert.strictEqual(Number(await balanceOf(ev.dest, 'XCHAIN')), destBefore + 150,
            'burn destination should receive exactly the capped 150 more')
    })
})
