const assert = require('assert')
const cryptoHelper = require('../cryptoHelper')
const issueHelper = require('../helpers/issueHelper')
const sendHelper = require('../helpers/sendHelper')
const mintHelper = require('../helpers/mintHelper')

// GAS token. Issuing a new token charges an ISSUANCE_FEE payable in GAS (XCHAIN);
// on testnet/regtest XCHAIN is an open faucet (anyone MINTs it — no owner check,
// no fee), so a fresh issuer grabs gas via a MINT before it can ISSUE.
const GAS_TICK = 'XCHAIN'

/**
 * Money-path reorg convergence (on-chain) — proves the decoder + indexer roll back
 * LEDGER state (credits/debits → balances, token supply) across a real chain reorg.
 *
 * vmContractReorg.test.js covers contract_state rollback; the integration suite covers
 * individual action rollback with mocked chains — but no test drives a real reorg that
 * orphans a *money movement* and asserts the balances and supply converge back exactly.
 * That is the highest-stakes rollback path (a wrong balance after a reorg is lost or
 * minted money) and the 18-decimal supply HALT lived precisely here.
 *
 * Mechanism (mirrors vmContractReorg): ISSUE a token in an early surviving block, SEND
 * part of it in block H, pause the auto-miner, `invalidateblock(H)` to orphan the SEND,
 * then mine an EMPTY competing chain longer than H via `generateBlock(addr, [])` so the
 * orphaned SEND tx is NOT re-included. The node reorgs onto the empty chain; the decoder
 * records the reorg and the indexer's rollback.js deletes the orphaned credit/debit and
 * recomputes balances. We assert the sender is made whole, the recipient credit is gone,
 * and the token supply is unchanged (conserved).
 */
describe('Money Reorg — SEND rolls back, balances + supply converge across an on-chain reorg', function () {

    async function q(sql, params) {
        const conn = await indexerDatabase.getConnection()
        try { return await conn.query(sql, params) }
        finally { await conn.release() }
    }
    async function balanceOf(address, tick) {
        const rows = await q(`SELECT b.amount FROM balances b
            JOIN index_addresses ia ON ia.id=b.address_id
            JOIN index_tickers   it ON it.id=b.tick_id
            WHERE ia.address=? AND it.tick=?`, [address, tick])
        return rows.length ? String(rows[0].amount) : null
    }
    async function supplyOf(tick) {
        const rows = await q(`SELECT t.supply FROM tokens t
            JOIN index_tickers it ON it.id=t.tick_id WHERE it.tick=?`, [tick])
        return rows.length ? String(rows[0].supply) : null
    }
    async function blockOfAction(actionIndex) {
        const rows = await q(`SELECT t.block_index AS b FROM actions a
            JOIN transactions t ON t.tx_index=a.tx_index WHERE a.action_index=?`, [actionIndex])
        return rows.length ? Number(rows[0].b) : null
    }

    it('orphaning the SEND block restores the sender, drops the recipient credit, conserves supply', async function () {
        const sender = await cryptoHelper.getNewFundedAddress('moneyreorg-sender', COIN, NETWORK, null, 'legacy', 0, 1)
        const dest   = await cryptoHelper.getNewAddress('moneyreorg-dest', COIN, NETWORK, null, 'legacy', 0)
        const tick   = 'MRG' + sender['address'].substring(sender['address'].length - 8)

        // Grab GAS first — the sender needs an XCHAIN balance to pay the ISSUANCE_FEE.
        // XCHAIN is an open faucet on testnet/regtest: anyone MINTs it (no owner check, no fee).
        await mintHelper.sendMintV0(sender, GAS_TICK, 10)

        // ISSUE in an early block: mintSupply credited to the sender.
        const MINT = 100
        await issueHelper.sendIssueV0(sender, tick, MINT, MINT, 0, 'money-reorg test token', MINT)
        const issueSupply = await supplyOf(tick)
        assert.strictEqual(await balanceOf(sender['address'], tick), String(MINT), 'sender holds full mint pre-send')

        // SEND part of it to dest — lands in a later block H.
        const AMOUNT = 40
        const result = await sendHelper.sendSendV0(sender, tick, AMOUNT, dest['address'], 'money-reorg SEND')
        assert(result.send && result.credit && result.debit, 'SEND must be indexed pre-reorg')
        assert.strictEqual(await balanceOf(sender['address'], tick), String(MINT - AMOUNT), 'sender debited pre-reorg')
        assert.strictEqual(await balanceOf(dest['address'], tick), String(AMOUNT), 'dest credited pre-reorg')

        // The ISSUE was confirmed+indexed before the SEND was broadcast (helpers wait for
        // confirmation), so it is necessarily in an earlier, surviving block — orphaning the
        // SEND block leaves the token (and its supply) intact.
        const sendBlock = await blockOfAction(result.send.action_index)
        assert(sendBlock, 'SEND block height resolved')

        // Pause the auto-miner so it cannot re-mine the orphaned SEND from the mempool.
        await regtestMinerConnector.setMiningTime(3600000, 3600000)
        try {
            const tipBefore = await nodeConnector.getBlockCount()
            const sendHash  = await nodeConnector.getBlockHash(sendBlock)
            const miner     = (await cryptoHelper.getNewAddress('moneyreorg-miner', COIN, NETWORK, null, 'legacy', 0)).address

            // Orphan the SEND block (and everything above it).
            await nodeConnector.invalidateBlock(sendHash)
            assert.strictEqual(await nodeConnector.getBlockCount(), sendBlock - 1, 'node rolled back to block before the SEND')

            // Empty competing chain that overtakes the original tip — the mempool SEND is excluded.
            const need = tipBefore - (sendBlock - 1) + 2
            for (let i = 0; i < need; i++) await nodeConnector.generateBlock(miner, [])
            assert(await nodeConnector.getBlockCount() > tipBefore, 'competing chain must be longer than the original')

            // Wait for node → decoder → indexer to propagate and rollback.js to run.
            let restored = null
            const deadline = Date.now() + 120000
            while (Date.now() < deadline) {
                restored = await balanceOf(sender['address'], tick)
                if (restored === String(MINT)) break
                await new Promise(r => setTimeout(r, 2000))
            }

            // Conservation: sender made whole, recipient credit erased, supply unchanged.
            assert.strictEqual(restored, String(MINT), 'sender balance must be fully restored after the SEND is orphaned')
            const destAfter = await balanceOf(dest['address'], tick)
            assert(destAfter === null || destAfter === '0', `dest credit must be rolled back (got ${destAfter})`)
            assert.strictEqual(await supplyOf(tick), issueSupply, 'token supply must be conserved across the reorg')
        } finally {
            // Restore normal auto-mining so the stack is healthy for later suites.
            await regtestMinerConnector.setDefaultMiningTime()
        }
    })
})
