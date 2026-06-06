// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available —
// contact legal@dankest.llc.

const assert = require('assert')
const cryptoHelper = require('../cryptoHelper')
const vmHelper = require('../helpers/vmHelper')
const issueHelper = require('../helpers/issueHelper')
const gasHelper = require('../helpers/gasHelper')
const orderHelper = require('../helpers/orderHelper')

/**
 * VM Contract Custody — proves that a contract's own emitted entities are attributed to the
 * CONTRACT (its derived `C:CHAIN:N` address), not to the EXECUTE caller who triggered them.
 *
 * Background: an action's SOURCE used to be re-derived from its transaction
 * (`transactions.source_id`). A VM emission rides the caller's EXECUTE tx and has no tx of its
 * own, so the derivation returned the EXECUTE caller — letting the caller masquerade as the
 * owner of the contract's tokens/orders/dispensers (a fund-custody + authorization bug). The
 * fix (`xchain-indexer@1ee6413`) persists the true source on `actions.source_id` at creation and
 * reads it everywhere. `vmEmissions.test.js` proves the ORDER-expiry refund leg directly; this
 * file proves the remaining shared-query surfaces:
 *   1. token ownership  — getTokenInfo(OWNER) / tokens.owner_id
 *   2. dispenser expiry — getDispenserInfo(SOURCE) refund target
 *   3. cancel auth      — getOrderInfo(SOURCE) ownership gate
 *
 * NOTE ON SWAP: the handover listed "swap expiry refund to the contract" as a sibling surface,
 * but the VM has NO `emit.swap` (see xchain-vm/src/gateway-emit.js) and execute.js has no SWAP
 * emission handler — a contract can never create or own a SWAP, so the source_id fix is a no-op
 * for swaps (a swap's source is always its on-chain signer). There is nothing to e2e-test there;
 * the swap leg is intentionally omitted.
 */
describe('VM Contract Custody — emitted entities belong to the contract, not the caller', function () {

    const CHAIN = ({ bitcoin: 'BTC', litecoin: 'LTC', dogecoin: 'DOGE' })[COIN] || 'BTC'

    // Issues a brand-new token from inside the contract, then exposes a re-issue (description
    // edit). Both emissions carry the contract as SOURCE, so the contract — not the EXECUTE
    // caller — must become and remain the token OWNER.
    const ISSUER = `module.exports = {
        create: function(){
            xchain.emit.issue({ tick: xchain.getInputParam(0), maxSupply: '1000', maxMint: '1000',
                decimals: '0', description: 'v1-contract-owned', mintSupply: '500' });
        },
        reissue: function(){
            xchain.emit.issue({ tick: xchain.getInputParam(0), description: xchain.getInputParam(1) });
        }
    };`

    // Native-coin dispenser with an escrow AND a caller-supplied EXPIRATION (input param 2), so
    // the test can make it expire and assert the remaining escrow refunds to the CONTRACT.
    const EXPIRING_DISPENSER = `module.exports = { mkexpdisp: function(){
        xchain.emit.dispenser({ giveCoin: '${CHAIN}', giveTick: xchain.getInputParam(0), giveAmount: '10',
            giveEscrow: '100', getCoin: '${CHAIN}', getTick: '', getAmount: '1',
            getAddress: xchain.getInputParam(1), expiration: xchain.getInputParam(2) });
    } };`

    // Self-addressed token order: GIVE 40 `tick`, GET 5 XCHAIN, GET_ADDRESS defaults to the
    // contract itself. Escrows 40 out of the contract. Used to prove the EXECUTE caller cannot
    // cancel the contract's order (the order's SOURCE is the contract, not the caller).
    const SELF_ORDERER = `module.exports = { mkselforder: function(){
        xchain.emit.order({ giveCoin: '${CHAIN}', giveTick: xchain.getInputParam(0), giveAmount: '40',
            getCoin: '${CHAIN}', getTick: 'XCHAIN', getAmount: '5' });
    } };`

    let deployer = null

    async function q(sql, params) {
        const conn = await indexerDatabase.getConnection()
        try { return await conn.query(sql, params) }
        finally { await conn.release() }
    }
    async function emissionsFor(executionIndex) {
        return await q(`SELECT emitted_action, action_index FROM contract_emissions
                        WHERE execution_index=? ORDER BY position`, [executionIndex])
    }
    async function balanceOf(address, tick) {
        const rows = await q(`SELECT b.amount FROM balances b
            JOIN index_addresses ia ON ia.id=b.address_id
            JOIN index_tickers it ON it.id=b.tick_id
            WHERE ia.address=? AND it.tick=?`, [address, tick])
        return rows.length ? String(rows[0].amount) : null
    }
    // Current OWNER of a token, resolved through tokens.owner_id (set from the ISSUE's source_id).
    async function ownerOf(tick) {
        const rows = await q(`SELECT ia.address AS addr FROM tokens t
            JOIN index_tickers it ON it.id=t.tick_id
            JOIN index_addresses ia ON ia.id=t.owner_id
            WHERE it.tick=?`, [tick])
        return rows.length ? rows[0].addr : null
    }
    // Current (materialized) description of a token.
    async function descOf(tick) {
        const rows = await q(`SELECT t.description AS d FROM tokens t
            JOIN index_tickers it ON it.id=t.tick_id WHERE it.tick=?`, [tick])
        return rows.length ? rows[0].d : null
    }
    // Status of the most recent ISSUE recorded for (address, tick) — used to confirm a
    // non-owner's re-issue was REJECTED rather than merely not-yet-processed.
    async function latestIssueStatus(address, tick) {
        const rows = await q(`SELECT s.status AS st FROM issues i
            JOIN actions a ON a.action_index=i.action_index
            JOIN index_addresses ia ON ia.id=a.source_id
            JOIN index_tickers it ON it.id=i.tick_id
            JOIN index_statuses s ON s.id=i.status_id
            WHERE ia.address=? AND it.tick=?
            ORDER BY i.action_index DESC LIMIT 1`, [address, tick])
        return rows.length ? rows[0].st : null
    }
    async function rowCount(table, actionIndex) {
        const rows = await q(`SELECT COUNT(*) AS c FROM ${table} WHERE action_index=?`, [actionIndex])
        return Number(rows[0].c)
    }
    // Latest status of an order, via the order_statuses transition log.
    async function orderStatus(orderActionIndex) {
        const rows = await q(`SELECT s.status AS st FROM order_statuses os
            JOIN index_statuses s ON s.id=os.status_id
            WHERE os.order_action_index=?
            ORDER BY os.action_index DESC LIMIT 1`, [orderActionIndex])
        return rows.length ? rows[0].st : null
    }
    async function pollBalance(address, tick, want, timeMax = 30000) {
        const end = Date.now() + timeMax
        let v = null
        while (Date.now() < end) {
            v = await balanceOf(address, tick)
            if (v === want) return v
            await new Promise(r => setTimeout(r, 1000))
        }
        return v
    }
    // Broadcast a raw ISSUE from `addressInfo` for `tick` setting only `description`, status-agnostic.
    // (issueHelper.sendIssueV0 waits for a 'valid' row, which never appears for a rejected edit.)
    // FORMAT: VERSION|TICK|MAX_SUPPLY|MAX_MINT|DECIMALS|DESCRIPTION|MINT_SUPPLY|TRANSFER|TRANSFER_SUPPLY|
    //   LOCK_MAX_SUPPLY|LOCK_MAX_MINT|LOCK_DESCRIPTION|LOCK_SLEEP|LOCK_CALLBACK|CALLBACK_BLOCK|
    //   CALLBACK_TICK|CALLBACK_AMOUNT|ALLOW_LIST|BLOCK_LIST|MINT_ADDRESS_MAX|MINT_START_BLOCK|
    //   MINT_STOP_BLOCK|LOCK_MINT|LOCK_MINT_SUPPLY  (23 fields after VERSION, mirroring
    //   issueHelper.sendIssueV0's wire layout; all empty but DESCRIPTION)
    async function broadcastIssueDescription(addressInfo, tick, description) {
        const transactionHelper = require('../transactionHelper')
        const fields = new Array(23).fill('')
        fields[0] = tick          // TICK
        fields[4] = description    // DESCRIPTION (TICK, MAX_SUPPLY, MAX_MINT, DECIMALS, DESCRIPTION)
        const msg = 'ISSUE|0|' + fields.join('|')
        return await transactionHelper.createAndSendTransaction(addressInfo, msg)
    }
    function randTick(p) { let s = p; for (let i = 0; i < 5; i++) s += String.fromCharCode(65 + Math.floor(Math.random() * 26)); return s }

    before(async function () {
        deployer = await cryptoHelper.getNewFundedAddress('vmcust-deployer', COIN, NETWORK, null, 'legacy', 0, 1)
        await gasHelper.ensureGasBalance(deployer, '500')
    })

    it('a contract-issued token is OWNED by the contract, not the EXECUTE caller', async function () {
        const tick = randTick('VCO')
        const dep = await vmHelper.sendDeployV0(deployer, ISSUER, 300000)
        const ci = dep.contract.action_index
        const contractAddr = `C:${CHAIN}:${ci}`

        const ex = await vmHelper.sendExecuteV0(deployer, ci, 'create', [tick])
        assert.strictEqual(ex.execution.status, 'valid')
        const em = await emissionsFor(ex.execution.action_index)
        assert.strictEqual(em[0].emitted_action, 'ISSUE')

        // OWNER must be the contract's derived address — the heart of the source_id fix. Before it,
        // the ISSUE's source resolved to `deployer` (the EXECUTE caller) and the caller owned the token.
        assert.strictEqual(await ownerOf(tick), contractAddr,
            'token owner should be the contract, not the EXECUTE caller')
        assert.notStrictEqual(await ownerOf(tick), deployer.address,
            'the EXECUTE caller must NOT own the contract-issued token')
        // And the MINT_SUPPLY landed in the contract's balance, not the caller's.
        assert.strictEqual(await balanceOf(contractAddr, tick), '500', 'minted supply credited to the contract')
        assert.strictEqual(await balanceOf(deployer.address, tick), null, 'caller holds none of the token')
    })

    it('the EXECUTE caller CANNOT re-issue (edit) the contract-owned token', async function () {
        const tick = randTick('VCR')
        const dep = await vmHelper.sendDeployV0(deployer, ISSUER, 300000)
        const ci = dep.contract.action_index
        const contractAddr = `C:${CHAIN}:${ci}`

        const ex = await vmHelper.sendExecuteV0(deployer, ci, 'create', [tick])
        assert.strictEqual(ex.execution.status, 'valid')
        assert.strictEqual(await ownerOf(tick), contractAddr)

        // The caller (deployer) tries to edit the token's description directly. They are not the
        // owner (the contract is), so the ISSUE owner-gate must reject it.
        await broadcastIssueDescription(deployer, tick, 'hijacked-by-caller')

        // Drive blocks so the rejected edit is processed, then assert it left no mark.
        let st = null
        const deadline = Date.now() + 90000
        while (Date.now() < deadline) {
            await regtestMinerConnector.generateBlocks(2)
            st = await latestIssueStatus(deployer.address, tick)
            if (st) break
            await new Promise(r => setTimeout(r, 2000))
        }
        // The status column stores the full rejection reason; the owner-gate yields this exact text.
        assert(st && st.indexOf('issued by another address') !== -1,
            "the caller's re-issue must be rejected as 'issued by another address', got: " + st)
        assert.strictEqual(await descOf(tick), 'v1-contract-owned', 'description must be unchanged by the caller')
        assert.strictEqual(await ownerOf(tick), contractAddr, 'ownership must remain with the contract')
    })

    it('the CONTRACT itself CAN re-issue (edit) its own token', async function () {
        const tick = randTick('VCE')
        const dep = await vmHelper.sendDeployV0(deployer, ISSUER, 300000)
        const ci = dep.contract.action_index
        const contractAddr = `C:${CHAIN}:${ci}`

        let ex = await vmHelper.sendExecuteV0(deployer, ci, 'create', [tick])
        assert.strictEqual(ex.execution.status, 'valid')
        assert.strictEqual(await descOf(tick), 'v1-contract-owned')

        // The contract re-issues with a new description — its SOURCE matches the token OWNER, so
        // the edit is accepted. (Same wire action the caller was just rejected for.)
        ex = await vmHelper.sendExecuteV0(deployer, ci, 'reissue', [tick, 'v2-by-contract'])
        assert.strictEqual(ex.execution.status, 'valid', 'the owning contract may edit its own token')
        const em = await emissionsFor(ex.execution.action_index)
        assert.strictEqual(em[0].emitted_action, 'ISSUE')

        assert.strictEqual(await descOf(tick), 'v2-by-contract', 'owning contract successfully edited the description')
        assert.strictEqual(await ownerOf(tick), contractAddr, 'ownership stays with the contract after re-issue')
    })

    it("a contract's dispenser refunds its remaining escrow to the contract on expiry", async function () {
        const tick = randTick('VCD')
        // Issue tick to deployer, deploy, deposit exactly the escrow amount (100) into the contract.
        await issueHelper.sendIssueV0(deployer, tick, '1000', '1000', '0', 'vm cust disp', '1000')
        const dep = await vmHelper.sendDeployV0(deployer, EXPIRING_DISPENSER, 250000)
        const ci = dep.contract.action_index
        const contractAddr = `C:${CHAIN}:${ci}`
        await vmHelper.sendDepositV0(deployer, ci, tick, '100')
        assert.strictEqual(await balanceOf(contractAddr, tick), '100', 'contract funded with the escrow amount')

        // Fresh real address required as a native-coin dispenser's GET_ADDRESS (anti-replay).
        const fresh = await cryptoHelper.getNewAddress('vmcust-disp-recv', COIN, NETWORK, null, 'legacy', 0)
        const expiration = Math.floor(Date.now() / 1000) + 45

        const ex = await vmHelper.sendExecuteV0(deployer, ci, 'mkexpdisp', [tick, fresh.address, String(expiration)])
        assert.strictEqual(ex.execution.status, 'valid', 'expiring dispenser must be created')
        const em = await emissionsFor(ex.execution.action_index)
        assert.strictEqual(em[0].emitted_action, 'DISPENSER')
        // GIVE_ESCROW (100) escrowed out of the contract on creation: 100 -> 0. A zero spendable
        // balance is stored as no row (null), not a literal '0'.
        assert.strictEqual(await balanceOf(contractAddr, tick), null,
            'full escrow debited from the contract on creation (spendable balance now zero)')

        // Drive blocks until block_time passes EXPIRATION and the per-block expiry sweep fires.
        let refunded = null
        const deadline = Date.now() + 150000
        while (Date.now() < deadline) {
            await regtestMinerConnector.generateBlocks(5)
            refunded = await balanceOf(contractAddr, tick)
            if (refunded === '100') break
            await new Promise(r => setTimeout(r, 2000))
        }
        // dispenser_expire.js credits the remaining escrow back to the dispenser SOURCE (the
        // contract, via source_id): 0 -> 100. Pre-fix it would have refunded the EXECUTE caller.
        assert.strictEqual(refunded, '100', 'remaining escrow refunded to the contract on dispenser expiry')
        assert.strictEqual(await balanceOf(fresh.address, tick), null, 'the EXECUTE caller / recipient got no refund')
    })

    it('the EXECUTE caller CANNOT cancel the contract\'s own order', async function () {
        const tick = randTick('VCC')
        await issueHelper.sendIssueV0(deployer, tick, '1000', '1000', '0', 'vm cust cancel', '1000')
        const dep = await vmHelper.sendDeployV0(deployer, SELF_ORDERER, 250000)
        const ci = dep.contract.action_index
        const contractAddr = `C:${CHAIN}:${ci}`
        await vmHelper.sendDepositV0(deployer, ci, tick, '100')

        const ex = await vmHelper.sendExecuteV0(deployer, ci, 'mkselforder', [tick])
        assert.strictEqual(ex.execution.status, 'valid')
        const em = await emissionsFor(ex.execution.action_index)
        const orderIndex = Number(em[0].action_index)
        assert.strictEqual(await rowCount('orders', orderIndex), 1, 'order row should exist')
        // GIVE (40) escrowed out of the contract: 100 -> 60.
        assert.strictEqual(await balanceOf(contractAddr, tick), '60', 'GIVE escrowed on order creation')

        // The caller (deployer) tries to cancel the contract's order. The cancel owner-gate checks
        // the order's SOURCE (the contract) against the canceller (the deployer) — must be rejected.
        await orderHelper.sendOrderCancelV1(deployer, orderIndex, 'caller tries to cancel')
        // Give the indexer a couple of blocks to settle the rejection.
        await regtestMinerConnector.generateBlocks(2)
        await new Promise(r => setTimeout(r, 3000))

        // The order must still be open and the escrow still held — a wrongful cancel would have
        // refunded the 40 to the contract (60 -> 100). Staying at 60 proves the cancel was rejected.
        assert.strictEqual(await orderStatus(orderIndex), 'open', "the contract's order must remain open")
        assert.strictEqual(await balanceOf(contractAddr, tick), '60',
            'escrow must remain held — the non-owner caller cannot cancel the contract order')
    })
})
