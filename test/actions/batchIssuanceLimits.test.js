// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.
//
// XC-1454 / BATCH_ISSUANCE_LIMITS acceptance suite (spec acceptance tests A1-A6).
//
// Chain evidence for a consensus change, so every case here asserts the STATUS STRING
// the indexer wrote for a real transaction, not a shape or a count alone. The unit
// suites already pin the strings against synthetic input; the job of this file is to
// prove the same verdicts come out of a live indexer reading a real block.
//
// Which case runs where, and why. The lane question is NOT "does this stack have
// native fees" - a BTC regtest stack can have a FEE_DESTINATION configured and still
// accept an XCHAIN-balance deduction, because detectFeePaymentMode's gas fallback is
// keyed on the COIN, not on whether fees are enabled. So:
//   A6           needs GAS metering, which means sending the batch with NO output to
//                FEE_DESTINATION. That fallback exists on BTC (or on a stack with no
//                fee destination at all) and nowhere else, so it skips on LTC/DOGE.
//   A1           runs on both: in gas mode it reads the per-command schedule straight
//                off the ledger, and in native mode the same 51 commands draw on ONE
//                fee pool, which is the scale check on R5.
//   A2/A3        never reach a fee check (the batch dies in the limit scan, or the
//                ISSUE dies on its TICK), so they run on every lane.
//   A4/A5(fee)   need a resolvable FEE_DESTINATION so an exact-size fee output can be
//                attached. Runs wherever one exists.
//   A5(COINPAY)  runs everywhere; its batch suppresses the fee output so the only
//                transaction-level value in play is the payment itself.
//
// Fee sizing: the whole point of A4/A5 is an output carrying EXACTLY one command's
// worth of fee, and one child ISSUE's worth at the suite's standard fixture prices is
// 1000 satoshis - fine against BTC's 546 dust threshold, under LTC's 5460 and far
// under DOGE's 100000. So prepareFeeFixture() leaves the shared pair alone where it
// already sizes above dust and re-prices {COIN}/USD downward only where it does not,
// which scales every expected fee up by the same factor. XCHAIN/USD is never a free
// parameter (the seed guard pins it), and the shared fixture is restored afterwards.

const assert = require('assert')
const cryptoHelper = require('../cryptoHelper')
const issueHelper = require('../helpers/issueHelper')
const mintHelper = require('../helpers/mintHelper')
const orderHelper = require('../helpers/orderHelper')
const batchHelper = require('../helpers/batchHelper')
const nativeFeeHelper = require('../helpers/nativeFeeHelper')
const priceSnapshotHelper = require('../helpers/priceSnapshotHelper')
const { BOOTSTRAP_XCHAIN_USD, NO_PRICE_SEED } = require('../helpers/xchainPriceConstants')

const GAS_TICK = 'XCHAIN'

// Gas schedule (xchain-indexer/src/coins/<COIN>.js GAS_SCHEDULE x GAS_PRICE).
const XCHAIN_PER_ISSUE          = 1.0   // ISSUE          100000 gas
const XCHAIN_PER_CHILD_ISSUE    = 0.5   // ISSUE_SUBTOKEN  50000 gas
const ORDER_GAS_PER_DAY         = 550   // EXPIRATION_PER_DAY
const ORDER_FREE_DAYS           = 90    // UNIFIED_EXPIRATION_FEE_FREE_DAYS

// Fallback native-fee fixture for A4/A5, used ONLY when the suite's standard pair
// would size one command's worth of fee below the chain's dust threshold (which is
// the LTC/DOGE case; see the header). {COIN}/USD is the free parameter, XCHAIN/USD is
// not (the seed guard pins it to the shared bootstrap constant).
const FEE_CASE_COIN_USD     = '1000.00000000'
const FEE_CASE_ROUND_XCHAIN = 997710001
const FEE_CASE_ROUND_COIN   = 997710002

// Per-chain dust threshold in satoshis (xchain-indexer/src/coins/<COIN>.js net).
const DUST_SATS = { BTC: 546, LTC: 5460, DOGE: 100000 }

let FEE_DEST      = null    // resolvable FEE_DESTINATION, or null on a pure gas stack
let GAS_MODE      = false   // this chain can pay an issuance fee from an XCHAIN balance
let SATS_PER_XCHAIN = 0     // set per fee case by prepareFeeFixture()

async function q(sql, args){
    const conn = await indexerDatabase.getConnection()
    try { return await conn.query(sql, args) } finally { await conn.release() }
}

// Every action row the indexer wrote for one transaction. An over-limit BATCH must
// produce exactly ONE (the BATCH itself); this is how "no sub-command executed" is
// proven rather than inferred from the absence of issue rows.
async function actionsForTx(txHash){
    return q(`SELECT a.action_index, ia.action AS action
                FROM actions a
                JOIN transactions t          ON t.tx_index = a.tx_index
                JOIN index_transactions it   ON it.id = t.tx_hash_id
                LEFT JOIN index_actions ia   ON ia.id = a.action_id
               WHERE it.hash = ?
               ORDER BY a.action_index ASC`, [txHash])
}

async function issuesForTx(txHash){
    return q(`SELECT i.action_index, itk.tick AS tick, ist.status AS status
                FROM issues i
                JOIN actions a               ON a.action_index = i.action_index
                JOIN transactions t          ON t.tx_index = a.tx_index
                JOIN index_transactions it   ON it.id = t.tx_hash_id
                LEFT JOIN index_tickers itk  ON itk.id = i.tick_id
                LEFT JOIN index_statuses ist ON ist.id = i.status_id
               WHERE it.hash = ?
               ORDER BY i.action_index ASC`, [txHash])
}

async function ordersForTx(txHash){
    return q(`SELECT o.action_index, ist.status AS status
                FROM orders o
                JOIN actions a               ON a.action_index = o.action_index
                JOIN transactions t          ON t.tx_index = a.tx_index
                JOIN index_transactions it   ON it.id = t.tx_hash_id
                LEFT JOIN index_statuses ist ON ist.id = o.status_id
               WHERE it.hash = ?
               ORDER BY o.action_index ASC`, [txHash])
}

async function debitsForTx(txHash, tick){
    return q(`SELECT d.action_index, d.amount
                FROM debits d
                JOIN actions a             ON a.action_index = d.action_index
                JOIN transactions t        ON t.tx_index = a.tx_index
                JOIN index_transactions it ON it.id = t.tx_hash_id
                JOIN index_tickers itk     ON itk.id = d.tick_id
               WHERE it.hash = ? AND itk.tick = ?
               ORDER BY d.action_index ASC`, [txHash, tick])
}

async function tokenRow(tick){
    const rows = await q(`SELECT itk.tick AS tick, ia.address AS owner, tk.supply, tk.escrow_action_index
                            FROM tokens tk
                            JOIN index_tickers itk    ON itk.id = tk.tick_id
                            LEFT JOIN index_addresses ia ON ia.id = tk.owner_id
                           WHERE itk.tick = ?`, [tick])
    return rows.length ? rows[0] : null
}

// The GAS tick's decimal precision, and the rounding db.createLedgerChangeRecord
// applies to every ledger row with it (`bcadd(amount, 0, decimals)`).
//
// This is load-bearing, not incidental. The regtest GAS token is issued with ZERO
// decimals (test/initialCheck.test.js bootstraps XCHAIN that way), so ISSUE_SUBTOKEN's
// 0.5-XCHAIN fee is RECORDED as 0.5 in the `fees` table and DEBITED as 1 in `debits`.
// Balances derive from credits - debits, and each sub-command re-reads its balance
// as-of its own action index, so the rounded figure is what actually meters a batch of
// children. Expectations here are therefore computed from the venue's own precision
// rather than from the gas schedule alone.
async function tokenDecimals(tick){
    const rows = await q(`SELECT tk.decimals FROM tokens tk
                            JOIN index_tickers itk ON itk.id = tk.tick_id
                           WHERE itk.tick = ?`, [tick])
    return rows.length ? Number(rows[0].decimals) : 8
}

function ledgerRound(amount, decimals){
    const factor = Math.pow(10, decimals)
    return Math.round(amount * factor) / factor
}

async function feesForTx(txHash){
    return q(`SELECT f.action_index, f.gas_cost, f.amount, f.payment_mode
                FROM fees f
                JOIN actions a             ON a.action_index = f.action_index
                JOIN transactions t        ON t.tx_index = a.tx_index
                JOIN index_transactions it ON it.id = t.tx_hash_id
               WHERE it.hash = ?
               ORDER BY f.action_index ASC`, [txHash])
}

async function tickerId(tick){
    const rows = await q("SELECT id FROM index_tickers WHERE tick = ? LIMIT 1", [tick])
    return rows.length ? Number(rows[0].id) : null
}

async function balanceOf(address, tick){
    const rows = await q(`SELECT b.amount FROM balances b
                            JOIN index_addresses ia ON ia.id = b.address_id
                            JOIN index_tickers itk  ON itk.id = b.tick_id
                           WHERE ia.address = ? AND itk.tick = ?`, [address, tick])
    return rows.length ? String(rows[0].amount) : '0'
}

async function chainTipTime(){
    const rows = await q("SELECT block_time FROM blocks ORDER BY block_index DESC LIMIT 1")
    return rows.length ? Number(rows[0].block_time) : Math.floor(Date.now() / 1000)
}

// Poll until the indexer has written every action row of a batch transaction, so a
// count assertion cannot race a half-processed block. Returns the rows.
async function waitForActionCount(txHash, expected, timeoutMs = 180000){
    const deadline = Date.now() + timeoutMs
    let rows = []
    for (;;){
        rows = await actionsForTx(txHash)
        if (rows.length >= expected || Date.now() > deadline) return rows
        await new Promise(r => setTimeout(r, 2000))
    }
}

async function waitForIssueCount(txHash, expected, timeoutMs = 180000){
    const deadline = Date.now() + timeoutMs
    let rows = []
    for (;;){
        rows = await issuesForTx(txHash)
        if (rows.length >= expected || Date.now() > deadline) return rows
        await new Promise(r => setTimeout(r, 2000))
    }
}

function issueCmd(tick, maxSupply, maxMint, mintSupply, description){
    // ISSUE v0: VERSION|TICK|MAX_SUPPLY|MAX_MINT|DECIMALS|DESCRIPTION|MINT_SUPPLY|...
    // Trailing optional fields are omitted to keep a 51-command batch inside the
    // legacy data lane's MAX_ACTION_DATA_LENGTH.
    return "ISSUE|0|"+tick+"|"+maxSupply+"|"+maxMint+"|0|"+description+"|"+mintSupply
}

// An ISSUE sent with NO fee output, so its issuance fee is metered against the
// source's XCHAIN balance. issueHelper cannot express this: it goes through
// transactionHelper's default path, which injects a fee output wherever the stack has
// a FEE_DESTINATION, and a natively-paid ISSUE debits no gas at all. A6's arithmetic
// is a gas balance, so its setup ISSUE has to take this path.
async function sendGasPaidIssue(addressInfo, tick, description){
    const transactionHelper = require('../transactionHelper')
    const txHash = await transactionHelper.createAndSendTransaction(
        addressInfo, issueCmd(tick, 100000, 100000, 10, description), null, [], null, null, true)
    const row = await indexerDatabase.waitForIssue({
        source: addressInfo["address"], tick: tick, txHash: txHash, status: 'valid'
    }, 120000)
    assert(row, "gas-paid ISSUE " + tick + " should be valid")
    return { txHash, issue: row }
}

// The price pair the indexer will actually value a fee against: highest round wins
// (db.getLatestPrice orders by round_number DESC), which is what every seed site in
// this repo relies on.
async function effectivePrices(){
    const rows = await q(`SELECT coin_pair, price, round_number, block_timestamp
                            FROM price_snapshots
                           WHERE coin_pair IN ('XCHAIN/USD', ?) AND status = 'finalized'
                           ORDER BY round_number DESC`, [COIN_CODE + '/USD'])
    const pick = pair => rows.find(r => r.coin_pair === pair)
    return { xchain: pick('XCHAIN/USD'), coin: pick(COIN_CODE + '/USD') }
}

// Size the native-fee arithmetic for one A4/A5 case, and re-price the pair ONLY if
// the standard fixture would make one command's worth of fee an unspendable dust
// output (LTC's threshold is 5460 satoshis, DOGE's 100000; one child ISSUE at the
// standard pair is 1000). Leaving the shared pair alone wherever it already works
// keeps the blast radius off other suites sharing the venue.
//
// seedGlobalPrices(true) first is not decoration: it resets nativeFeeHelper's own
// throttle, so the per-transaction refresh transactionHelper performs while building
// the batch is a no-op and cannot clearPair() this fixture out from under the case.
async function prepareFeeFixture(perCommandXchain){
    await nativeFeeHelper.seedGlobalPrices(true)
    let prices = await effectivePrices()
    assert(prices.xchain && prices.coin,
        'no finalized XCHAIN/USD + ' + COIN_CODE + '/USD snapshots to price a native fee against')
    let satsPerXchain = Math.round(Number(prices.xchain.price) / Number(prices.coin.price) * 1e8)
    const dust = DUST_SATS[COIN_CODE] || 546

    if (Math.round(perCommandXchain * satsPerXchain) < dust * 2){
        const chainTime = await chainTipTime()
        await priceSnapshotHelper.clearPair('XCHAIN/USD')
        await priceSnapshotHelper.clearPair(COIN_CODE + '/USD')
        await priceSnapshotHelper.seedSnapshot({
            coinPair: 'XCHAIN/USD', price: BOOTSTRAP_XCHAIN_USD,
            blockTimestamp: chainTime, roundNumber: FEE_CASE_ROUND_XCHAIN })
        await priceSnapshotHelper.seedSnapshot({
            coinPair: COIN_CODE + '/USD', price: FEE_CASE_COIN_USD,
            blockTimestamp: chainTime, roundNumber: FEE_CASE_ROUND_COIN })
        prices = await effectivePrices()
        satsPerXchain = Math.round(Number(prices.xchain.price) / Number(prices.coin.price) * 1e8)
        console.log('fee fixture RE-PRICED (one command would have been dust): ' +
            COIN_CODE + '/USD=' + FEE_CASE_COIN_USD + ' anchored at chain_time=' + chainTime)
    }

    SATS_PER_XCHAIN = satsPerXchain
    const perCommandSats = Math.round(perCommandXchain * satsPerXchain)
    assert(perCommandSats >= dust,
        'one command of fee is ' + perCommandSats + ' sats, under the ' + COIN_CODE +
        ' dust threshold of ' + dust + '; the exact-size output could not be relayed')
    console.log('fee fixture: XCHAIN/USD=' + prices.xchain.price + ' ' + COIN_CODE + '/USD=' +
        prices.coin.price + ' -> ' + satsPerXchain + ' sats per XCHAIN, ' +
        perCommandSats + ' sats per command')
    return perCommandSats
}

function feeOutput(sats){
    return [{ address: FEE_DEST, value: sats }]
}

// A rejected fee-pool draw reports itself either as an exhausted pool or as a short
// one, depending on whether the remainder is exactly zero or merely below the band.
// Both are the invariant under test; anything else is not.
const POOL_EXHAUSTED = /^invalid: (fee output has zero value|insufficient native coin fee)/

describe('BATCH issuance limits (BATCH_ISSUANCE_LIMITS)', function () {

    before(async function () {
        const mode = await nativeFeeHelper.discoverFeeMode()
        FEE_DEST = mode.destination || null
        // detectFeePaymentMode (xchain-indexer/src/utility.js): a transaction carrying
        // NO output to FEE_DESTINATION falls back to an XCHAIN-balance deduction only
        // on BTC, or on a stack with no fee destination configured at all. Everywhere
        // else that transaction is rejected outright. So this, not "does the stack
        // have native fees", is what decides whether the gas-metered cases can run:
        // a regtest BTC stack can have BOTH modes wired at once, and this suite's
        // first run assumed it could not.
        GAS_MODE = (COIN_CODE === 'BTC') || !FEE_DEST
        console.log('lane: COIN=' + COIN_CODE + ' gasModeAvailable=' + GAS_MODE +
            ' feeDestination=' + (FEE_DEST ? 'resolved' : 'none'))
    })

    // ─── A1 ────────────────────────────────────────────────────────────────────
    describe('A1: one parent plus 50 children in ONE transaction', function () {
        it('lands 51 valid actions, every child owned by the issuer', async function () {
            const addr    = await cryptoHelper.getNewFundedAddress("BIL.A1", COIN, NETWORK, null, "legacy", 0, 1)
            const address = addr["address"]
            const parent  = "BILA1" + address.substring(address.length - 8)

            const CHILDREN = 50
            const commands = [ issueCmd(parent, 1000000, 1000000, 1000, "p") ]
            for (let n = 1; n <= CHILDREN; n++)
                commands.push(issueCmd(parent + "." + n, 100, 100, 10, "c"))

            // Both lanes, because the two say different things. In GAS mode the batch
            // carries no fee output and the per-command schedule is directly readable
            // off the ledger. In NATIVE mode the same 51 commands draw on ONE fee pool,
            // so this is also the scale check on R5: 51 legitimate commands with the
            // fee covered must all stand. The output is deliberately generous (the
            // exact-coverage boundary is A4's job, and overpayment is never rejected);
            // what is under test here is that the pool does not starve a valid batch.
            const totalXchain = XCHAIN_PER_ISSUE + CHILDREN * XCHAIN_PER_CHILD_ISSUE
            let sendOpts = { status: 'valid', skipNativeFeeInjection: true }
            if (!GAS_MODE){
                const wholeBatchSats = await prepareFeeFixture(totalXchain)
                sendOpts = { status: 'valid', skipNativeFeeInjection: false,
                             customOutputs: feeOutput(Math.ceil(wholeBatchSats * 1.5)) }
            }

            const gasBefore = await balanceOf(address, GAS_TICK)
            const result = await batchHelper.sendBatch(addr, commands, sendOpts)
            assert(result.batch, "the 51-command BATCH should be valid")
            console.log("A1 txHash=" + result.txHash + " batch action_index=" + result.batch.action_index)

            // 51 sub-commands + the BATCH itself.
            const actions = await waitForActionCount(result.txHash, 52)
            assert.strictEqual(actions.length, 52,
                "expected 1 BATCH + 51 ISSUE action rows, got " + actions.length)

            const issues = await waitForIssueCount(result.txHash, 51)
            assert.strictEqual(issues.length, 51, "expected 51 issue rows, got " + issues.length)
            const invalid = issues.filter(r => r.status !== 'valid')
            assert.deepStrictEqual(invalid.map(r => r.tick + ' -> ' + r.status), [],
                "every sub-command in the batch must be valid")

            // Intra-batch parent visibility: the parent row is written under a LOWER
            // action index and each child had to see it to pass the parent checks.
            const parentAI = Number(issues[0].action_index)
            assert.strictEqual(issues[0].tick, parent, "the parent ISSUE is the first sub-command")
            for (const row of issues.slice(1))
                assert(Number(row.action_index) > parentAI,
                    "child " + row.tick + " must carry a higher action index than its parent")

            // Every child is queryable with the right owner and the credited supply.
            for (let n = 1; n <= CHILDREN; n++){
                const tick = parent + "." + n
                const tk = await tokenRow(tick)
                assert(tk, "child token " + tick + " should be queryable")
                assert.strictEqual(tk.owner, address, "child " + tick + " owner")
                assert.strictEqual(String(await balanceOf(address, tick)), '10',
                    "child " + tick + " mint supply credited")
            }

            // Per-child ISSUE_SUBTOKEN accounted: the fee schedule charged the parent
            // ISSUE and every child ISSUE_SUBTOKEN, which is the accounting the spec
            // asks this case to prove.
            const fees = await feesForTx(result.txHash)
            assert.strictEqual(fees.length, 51, "one fee record per sub-command")
            assert.strictEqual(Number(fees[0].gas_cost), 100000, "the parent pays ISSUE gas")
            for (const row of fees.slice(1))
                assert.strictEqual(Number(row.gas_cost), 50000,
                    "every child pays ISSUE_SUBTOKEN gas, got " + row.gas_cost)
            const expectedMode = GAS_MODE ? 2 : 1
            for (const row of fees)
                assert.strictEqual(Number(row.payment_mode), expectedMode,
                    "every sub-command should record payment_mode " + expectedMode)

            if (!GAS_MODE){
                console.log("A1: 51/51 valid on the native-fee lane, gas_cost 100000 + 50x50000, " +
                    "one fee pool covering " + totalXchain + " XCHAIN")
                return
            }

            // The ledger side, at the venue's own GAS precision (see tokenDecimals).
            const decimals   = await tokenDecimals(GAS_TICK)
            const perChild   = ledgerRound(XCHAIN_PER_CHILD_ISSUE, decimals)
            const expectedSpent = ledgerRound(XCHAIN_PER_ISSUE, decimals) + CHILDREN * perChild
            const debits = await debitsForTx(result.txHash, GAS_TICK)
            assert.strictEqual(debits.length, 51, "one gas debit per sub-command")
            const spent = debits.reduce((s, d) => s + Number(d.amount), 0)
            assert.strictEqual(spent, expectedSpent,
                "gas debited should be 1 ISSUE + 50 ISSUE_SUBTOKEN rounded to " + decimals +
                " decimals = " + expectedSpent + " XCHAIN")
            const gasAfter = await balanceOf(address, GAS_TICK)
            assert.strictEqual(Number(gasBefore) - Number(gasAfter), expectedSpent,
                "the source's XCHAIN balance moved by exactly the batch's gas")
            console.log("A1: 51/51 valid, gas_cost 100000 + 50x50000, " + expectedSpent +
                " XCHAIN debited across " + debits.length + " debits (GAS decimals=" +
                decimals + ", per-child debit " + perChild + ")")
        })
    })

    // ─── A2 ────────────────────────────────────────────────────────────────────
    describe('A2: the top-level ISSUE limit and the global command cap', function () {

        it('rejects two undotted ISSUEs as ONE record: invalid: ISSUE (limit)', async function () {
            const addr    = await cryptoHelper.getNewFundedAddress("BIL.A2A", COIN, NETWORK, null, "legacy", 0, 1)
            const address = addr["address"]
            const t1 = "BILA2A" + address.substring(address.length - 8)
            const t2 = "BILA2B" + address.substring(address.length - 8)

            const result = await batchHelper.sendBatch(addr, [
                issueCmd(t1, 1000, 1000, 10, "one"),
                issueCmd(t2, 1000, 1000, 10, "two")
            ], { status: 'invalid: ISSUE (limit)' })
            assert(result.batch, "two undotted ISSUEs must whole-batch reject with the ISSUE limit")
            assert.strictEqual(result.batch.status, 'invalid: ISSUE (limit)')

            const actions = await actionsForTx(result.txHash)
            assert.strictEqual(actions.length, 1,
                "an over-limit BATCH is ONE record; no sub-command may execute (got " +
                JSON.stringify(actions.map(a => a.action)) + ")")
            assert.strictEqual(actions[0].action, 'BATCH')
            assert.strictEqual((await issuesForTx(result.txHash)).length, 0, "no ISSUE row")
            assert.strictEqual(await tokenRow(t1), null, "neither tick may be created")
            assert.strictEqual(await tokenRow(t2), null, "neither tick may be created")
            console.log("A2a txHash=" + result.txHash + " status=" + result.batch.status)
        })

        it('accepts exactly 250 commands and rejects 251 with invalid: COMMAND (limit)', async function () {
            const addr = await cryptoHelper.getNewFundedAddress("BIL.A2B", COIN, NETWORK, null, "legacy", 0, 1)

            // Counting is the raw ';'-split list after the BATCH|<v>| strip, EMPTY
            // elements included. 250 empty commands is therefore AT the cap and must
            // fail on the activation scan instead; 251 trips the cap. Nothing but the
            // counting rule separates these two transactions.
            const at   = new Array(250).fill("")
            const over = new Array(251).fill("")

            const atCap = await batchHelper.sendBatch(addr, at, { status: 'invalid: ACTION (unknown)' })
            assert(atCap.batch,
                "250 commands must NOT trip the cap (it should die on the unknown empty ACTION)")
            assert.strictEqual(atCap.batch.status, 'invalid: ACTION (unknown)')
            console.log("A2b at-cap txHash=" + atCap.txHash + " status=" + atCap.batch.status)

            const overCap = await batchHelper.sendBatch(addr, over, { status: 'invalid: COMMAND (limit)' })
            assert(overCap.batch, "251 commands must trip the global cap")
            assert.strictEqual(overCap.batch.status, 'invalid: COMMAND (limit)')
            const actions = await actionsForTx(overCap.txHash)
            assert.strictEqual(actions.length, 1, "an over-cap BATCH is ONE record")
            console.log("A2b over-cap txHash=" + overCap.txHash + " status=" + overCap.batch.status)
        })

        it('reports the CAP, not the ISSUE limit, when a batch breaks both', async function () {
            const addr    = await cryptoHelper.getNewFundedAddress("BIL.A2C", COIN, NETWORK, null, "legacy", 0, 1)
            const address = addr["address"]
            const t1 = "BILA2C" + address.substring(address.length - 8)
            const t2 = "BILA2D" + address.substring(address.length - 8)

            // 251 commands AND two undotted ISSUEs. The cap is checked first, so this
            // pins error precedence on chain.
            const commands = [ issueCmd(t1, 1000, 1000, 10, "one"), issueCmd(t2, 1000, 1000, 10, "two") ]
            while (commands.length < 251) commands.push("")

            const result = await batchHelper.sendBatch(addr, commands, { status: 'invalid: COMMAND (limit)' })
            assert(result.batch,
                "an over-cap batch that ALSO breaks the ISSUE limit must report the cap")
            assert.strictEqual(result.batch.status, 'invalid: COMMAND (limit)',
                "precedence: the cap wins over invalid: ISSUE (limit)")
            const actions = await actionsForTx(result.txHash)
            assert.strictEqual(actions.length, 1, "no sub-command may execute")
            assert.strictEqual(await tokenRow(t1), null)
            assert.strictEqual(await tokenRow(t2), null)
            console.log("A2c txHash=" + result.txHash + " status=" + result.batch.status)
        })
    })

    // ─── A3 ────────────────────────────────────────────────────────────────────
    describe('A3: caret TICKs', function () {

        it('rejects a lone ISSUE whose caret TICK contains a dot', async function () {
            const addr    = await cryptoHelper.getNewFundedAddress("BIL.A3A", COIN, NETWORK, null, "legacy", 0, 1)
            const address = addr["address"]
            const owned   = "BILA3" + address.substring(address.length - 8)

            await issueHelper.sendIssueV0(addr, owned, 1000, 1000, 0, "caret parent", 10)
            const id = await tickerId(owned)
            assert(id, "the owned tick should have an index_tickers id")

            // ^<id>.<n> resolves its parent to a tick this address owns, so every guard
            // ahead of the caret rule passes and the caret-dot rejection is what fires.
            const caretTick = "^" + id + ".5"
            const txHash = await require('../transactionHelper').createAndSendTransaction(
                addr, issueCmd(caretTick, 100, 100, 1, "caretdot"))
            const row = await indexerDatabase.waitForIssue({
                source: address, txHash: txHash, status: 'invalid: TICK (caret dot)'
            }, 120000)
            assert(row, "ISSUE ^" + id + ".5 must be invalid: TICK (caret dot)")
            console.log("A3a txHash=" + txHash + " tick=" + caretTick + " status=" + row.status)
        })

        it('counts caret entries against the top-level ISSUE limit rather than exempting them', async function () {
            const addr    = await cryptoHelper.getNewFundedAddress("BIL.A3B", COIN, NETWORK, null, "legacy", 0, 1)
            const address = addr["address"]
            const owned   = "BILA3C" + address.substring(address.length - 8)

            await issueHelper.sendIssueV0(addr, owned, 1000, 1000, 0, "caret parent 2", 10)
            const id = await tickerId(owned)
            assert(id, "the owned tick should have an index_tickers id")

            // Both TICKs contain a dot. A dotted-TICK exemption that did not special-case
            // the caret would classify BOTH as children and let the batch through.
            const result = await batchHelper.sendBatch(addr, [
                issueCmd("^" + id + ".1", 100, 100, 1, "c1"),
                issueCmd("^" + id + ".2", 100, 100, 1, "c2")
            ], { status: 'invalid: ISSUE (limit)' })
            assert(result.batch, "two caret ISSUEs must trip the top-level ISSUE limit")
            assert.strictEqual(result.batch.status, 'invalid: ISSUE (limit)')
            const actions = await actionsForTx(result.txHash)
            assert.strictEqual(actions.length, 1, "no sub-command may execute")
            console.log("A3b txHash=" + result.txHash + " status=" + result.batch.status)
        })
    })

    // ─── A6 ────────────────────────────────────────────────────────────────────
    describe('A6: gas for exactly K children', function () {
        it('yields exactly K valid children and K debits from a batch of N', async function () {
            if (!GAS_MODE) this.skip()   // gas debits are only consulted in gas mode

            const N = 8
            const K = 6

            // The budget is sized in what the LEDGER actually debits per child, which
            // is the gas schedule rounded to the GAS tick's precision (see
            // tokenDecimals): every sub-command re-reads its balance from the DB
            // as-of its own action index, so the rounded figure is what meters this.
            const decimals  = await tokenDecimals(GAS_TICK)
            const perChild  = ledgerRound(XCHAIN_PER_CHILD_ISSUE, decimals)
            const perParent = ledgerRound(XCHAIN_PER_ISSUE, decimals)

            // seedGas=false so the balance is exactly what this test mints, not the
            // 100 XCHAIN the funding helper hands out by default.
            const addr    = await cryptoHelper.getNewFundedAddress("BIL.A6", COIN, NETWORK, null, "legacy", 0, 1, false)
            const address = addr["address"]
            const parent  = "BILA6" + address.substring(address.length - 8)

            const mintAmount = perParent + K * perChild
            await mintHelper.sendMintV0(addr, GAS_TICK, mintAmount, address, "")
            assert.strictEqual(Number(await balanceOf(address, GAS_TICK)), mintAmount,
                "the source must start with exactly " + mintAmount + " XCHAIN")

            // The parent ISSUE must also be gas-metered, so it is sent WITHOUT the
            // harness's automatic fee output rather than through issueHelper.
            await sendGasPaidIssue(addr, parent, "A6 parent")
            const afterParent = Number(await balanceOf(address, GAS_TICK))
            assert.strictEqual(afterParent, K * perChild,
                "after the parent ISSUE the source must hold gas for exactly " + K + " children")

            const commands = []
            for (let n = 1; n <= N; n++)
                commands.push(issueCmd(parent + ".g" + n, 100, 100, 1, "c"))

            const result = await batchHelper.sendBatch(addr, commands,
                { status: 'valid', skipNativeFeeInjection: true })
            assert(result.batch, "the batch itself is valid; the shortfall is per-command")

            const issues = await waitForIssueCount(result.txHash, N)
            assert.strictEqual(issues.length, N, "every child gets its own record")
            const valid   = issues.filter(r => r.status === 'valid')
            const invalid = issues.filter(r => r.status !== 'valid')
            assert.strictEqual(valid.length, K, "exactly K=" + K + " children may be valid")
            assert.strictEqual(invalid.length, N - K)
            for (const row of invalid)
                assert.strictEqual(row.status, 'invalid: insufficient funds (FEE)',
                    "a child beyond the gas budget fails on the fee, got " + row.status)

            const debits = await debitsForTx(result.txHash, GAS_TICK)
            assert.strictEqual(debits.length, K, "exactly K gas debits")
            const spent = debits.reduce((s, d) => s + Number(d.amount), 0)
            assert.strictEqual(spent, K * perChild, "K x ISSUE_SUBTOKEN debited")
            assert.strictEqual(Number(await balanceOf(address, GAS_TICK)), 0,
                "the gas budget is exhausted exactly, with no overdraft")

            // Earlier siblings stand: this is the non-atomicity the spec documents.
            console.log("A6 txHash=" + result.txHash + " valid=" + valid.length +
                " invalid=" + invalid.length + " debits=" + debits.length +
                " statuses=" + JSON.stringify(issues.map(r => r.status)))
        })
    })

    // ─── A4 ────────────────────────────────────────────────────────────────────
    describe('A4: batch-cumulative native-coin fee', function () {
        // Fixture-priced (the exact output size is computed FROM the seeded pair), so
        // this cannot run on a venue whose hub publishes XCHAIN/USD itself.
        const N = 3

        let addr = null, address = null, parent = null

        before(async function () {
            if (!FEE_DEST || NO_PRICE_SEED) return
            // Setup runs at whatever the shared fixture says, so the harness's own
            // injected fee output covers it; only the batches below are hand-sized.
            addr    = await cryptoHelper.getNewFundedAddress("BIL.A4", COIN, NETWORK, null, "legacy", 0, 1)
            address = addr["address"]
            parent  = "BILA4" + address.substring(address.length - 8)
            await issueHelper.sendIssueV0(addr, parent, 100000, 100000, 0, "A4 parent", 10)
        })

        after(async function () {
            if (!FEE_DEST || NO_PRICE_SEED) return
            // Put the shared fixture back for whatever runs next.
            await nativeFeeHelper.seedGlobalPrices(true)
        })

        it('yields at most ONE valid command when the fee covers exactly one', async function () {
            if (!FEE_DEST) this.skip()   // no native fee to pay
            if (NO_PRICE_SEED) this.skip()

            const perCommandSats = await prepareFeeFixture(XCHAIN_PER_CHILD_ISSUE)
            const commands = []
            for (let n = 1; n <= N; n++)
                commands.push(issueCmd(parent + ".a" + n, 100, 100, 1, "c"))

            const result = await batchHelper.sendBatch(addr, commands, {
                status: 'valid', customOutputs: feeOutput(perCommandSats) })
            assert(result.batch, "the BATCH is valid; the shortfall is per-command")

            const issues = await waitForIssueCount(result.txHash, N)
            console.log("A4 one-fee txHash=" + result.txHash + " feeOutput=" + perCommandSats +
                " sats statuses=" + JSON.stringify(issues.map(r => r.status)))
            assert.strictEqual(issues.length, N)
            assert.strictEqual(issues.filter(r => r.status === 'valid').length, 1,
                "one command's worth of native fee must cover exactly ONE command, not " + N)
            for (const row of issues.filter(r => r.status !== 'valid'))
                assert(POOL_EXHAUSTED.test(row.status),
                    "a command past the exhausted fee pool should say so, got " + row.status)
        })

        it('yields N valid commands when the fee covers N', async function () {
            if (!FEE_DEST) this.skip()
            if (NO_PRICE_SEED) this.skip()

            const perCommandSats = await prepareFeeFixture(XCHAIN_PER_CHILD_ISSUE)
            const commands = []
            for (let n = 1; n <= N; n++)
                commands.push(issueCmd(parent + ".b" + n, 100, 100, 1, "c"))

            const result = await batchHelper.sendBatch(addr, commands, {
                status: 'valid', customOutputs: feeOutput(perCommandSats * N) })
            assert(result.batch)

            const issues = await waitForIssueCount(result.txHash, N)
            console.log("A4 N-fee txHash=" + result.txHash + " feeOutput=" + (perCommandSats * N) +
                " sats statuses=" + JSON.stringify(issues.map(r => r.status)))
            assert.strictEqual(issues.length, N)
            assert.strictEqual(issues.filter(r => r.status === 'valid').length, N,
                "N commands' worth of native fee must cover all N")
        })
    })

    // ─── A5 (fee half) ─────────────────────────────────────────────────────────
    describe('A5: the same one-fee-for-N shape over a batch of ORDERs', function () {
        const N = 3
        const EXPIRE_DAYS     = 190
        const CHARGEABLE_DAYS = EXPIRE_DAYS - ORDER_FREE_DAYS
        const ORDER_XCHAIN    = CHARGEABLE_DAYS * ORDER_GAS_PER_DAY * 0.00001

        let addr = null, address = null, tick = null

        before(async function () {
            if (!FEE_DEST || NO_PRICE_SEED) return
            addr    = await cryptoHelper.getNewFundedAddress("BIL.A5", COIN, NETWORK, null, "legacy", 0, 1)
            address = addr["address"]
            tick    = "BILA5" + address.substring(address.length - 8)
            await issueHelper.sendIssueV0(addr, tick, 10000, 10000, 0, "A5 order token", 1000)
        })

        after(async function () {
            if (!FEE_DEST || NO_PRICE_SEED) return
            await nativeFeeHelper.seedGlobalPrices(true)
        })

        async function orderCommands(count, giveAmount){
            // EXPIRATION is anchored on the CHAIN clock, never the wall clock: the
            // indexer prices the duration against BLOCK_TIME, and a regtest chain can
            // sit many hours behind wall time, which would silently change the
            // chargeable-day count this case's fee arithmetic depends on.
            const exp = (await chainTipTime()) + EXPIRE_DAYS * 86400
            const cmds = []
            for (let n = 0; n < count; n++)
                cmds.push("ORDER|0|" + COIN_CODE + "|" + tick + "|" + giveAmount + "||" +
                          COIN_CODE + "||0.00100000||" + address + "|" + exp + "|||A5")
            return cmds
        }

        async function waitForOrders(txHash, expected){
            const deadline = Date.now() + 180000
            for (;;){
                const rows = await ordersForTx(txHash)
                if (rows.length >= expected || Date.now() > deadline) return rows
                await new Promise(r => setTimeout(r, 2000))
            }
        }

        it('yields at most ONE valid ORDER when the fee covers exactly one', async function () {
            if (!FEE_DEST) this.skip()
            if (NO_PRICE_SEED) this.skip()

            const perOrderSats = await prepareFeeFixture(ORDER_XCHAIN)
            const result = await batchHelper.sendBatch(addr, await orderCommands(N, 10), {
                status: 'valid', customOutputs: feeOutput(perOrderSats) })
            assert(result.batch)

            const orders = await waitForOrders(result.txHash, N)
            console.log("A5 one-fee txHash=" + result.txHash + " feeOutput=" + perOrderSats +
                " sats (" + ORDER_XCHAIN + " XCHAIN/order) statuses=" +
                JSON.stringify(orders.map(r => r.status)))
            assert.strictEqual(orders.length, N, "every ORDER gets its own record")
            assert.strictEqual(orders.filter(r => r.status === 'valid').length, 1,
                "one ORDER's worth of native fee must cover exactly ONE ORDER, not " + N)
            for (const row of orders.filter(r => r.status !== 'valid'))
                assert(POOL_EXHAUSTED.test(row.status),
                    "an ORDER past the exhausted fee pool should say so, got " + row.status)
        })

        it('yields N valid ORDERs when the fee covers N', async function () {
            if (!FEE_DEST) this.skip()
            if (NO_PRICE_SEED) this.skip()

            const perOrderSats = await prepareFeeFixture(ORDER_XCHAIN)
            const result = await batchHelper.sendBatch(addr, await orderCommands(N, 11), {
                status: 'valid', customOutputs: feeOutput(perOrderSats * N) })
            assert(result.batch)

            const orders = await waitForOrders(result.txHash, N)
            console.log("A5 N-fee txHash=" + result.txHash + " feeOutput=" + (perOrderSats * N) +
                " sats statuses=" + JSON.stringify(orders.map(r => r.status)))
            assert.strictEqual(orders.length, N)
            assert.strictEqual(orders.filter(r => r.status === 'valid').length, N,
                "N ORDERs' worth of native fee must cover all N")
        })
    })

    // ─── A5 (settlement half) ──────────────────────────────────────────────────
    describe('A5: one COINPAY payment settles ONE obligation, not N', function () {
        it('leaves the second obligation pending', async function () {
            // Runs on every lane: the fee output is suppressed on the batch below, so
            // the only transaction-level value in play is the payment itself.

            const seller = await cryptoHelper.getNewFundedAddress("BIL.A5CP.S", COIN, NETWORK, null, "legacy", 0, 2)
            const buyer  = await cryptoHelper.getNewFundedAddress("BIL.A5CP.B", COIN, NETWORK, null, "legacy", 0, 2)
            const sAddr  = seller["address"]
            const bAddr  = buyer["address"]
            const tick   = "BILCP" + sAddr.substring(sAddr.length - 8)

            await issueHelper.sendIssueV0(seller, tick, 1000, 1000, 0, "A5 coinpay token", 1000)

            // Two independent matches to the SAME payee, so one payment output could in
            // principle be judged twice.
            const exp = (await chainTipTime()) + 86400
            const obligations = []
            for (let leg = 0; leg < 2; leg++){
                const sellerOrder = await orderHelper.sendOrderV0(
                    seller, COIN_CODE, tick, "100", COIN_CODE, "", "0.00100000",
                    sAddr, exp, "", "", "A5 sell leg " + leg)
                assert(sellerOrder.order, "seller ORDER leg " + leg)
                const buyerOrder = await orderHelper.sendOrderV0(
                    buyer, COIN_CODE, "", "0.00100000", COIN_CODE, tick, "100",
                    bAddr, exp, "", "", "A5 buy leg " + leg)
                assert(buyerOrder.order, "buyer ORDER leg " + leg)

                const match = await indexerDatabase.waitForOrderMatch({
                    giveActionIndex: Number(sellerOrder.order["action_index"]),
                    getActionIndex:  Number(buyerOrder.order["action_index"]),
                    status: 'pending_coinpay'
                }, 60000)
                assert(match, "ORDER_MATCH leg " + leg + " should be pending_coinpay")
                obligations.push(Number(match.action_index))
            }

            // ONE payment output, sized for ONE obligation, against TWO COINPAY commands.
            const result = await batchHelper.sendBatch(buyer, [
                "COINPAY|0|" + obligations[0],
                "COINPAY|0|" + obligations[1]
            ], { status: 'valid', skipNativeFeeInjection: true,
                 customOutputs: [{ address: sAddr, value: 100000 }] })
            assert(result.batch, "the BATCH itself is valid")

            // Give the indexer room to settle whatever it is going to settle.
            await new Promise(r => setTimeout(r, 20000))

            const settled = []
            for (const ai of obligations){
                const row = await indexerDatabase.checkCoinpayObligation({ actionIndex: ai })
                settled.push(row ? row.coinpay_status : null)
            }
            console.log("A5 COINPAY txHash=" + result.txHash + " obligations=" +
                JSON.stringify(obligations) + " statuses=" + JSON.stringify(settled))

            const fulfilled = settled.filter(s => s === 'fulfilled').length
            assert(fulfilled <= 1,
                "one payment must never settle more than one obligation (settled " + fulfilled + ")")
            assert.notStrictEqual(settled[1], 'fulfilled',
                "the second obligation must not be settled by the first obligation's payment")
        })
    })
})
