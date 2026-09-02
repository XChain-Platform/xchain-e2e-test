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
// BATCH_ISSUANCE_LIMITS acceptance suite (spec acceptance tests A1-A6).
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
let FEE_CASE_REPRICED = false   // the FEE_CASE rows are live; restoreFeeFixture() must delete them

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

// Gas expectations are the gas schedule EXACTLY. LEDGER_AMOUNT_PRECISION is armed on
// regtest, so the ledger stores amounts exactly and rounds once at balance projection
// rather than quantizing each row to the gas tick's decimals.

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
        FEE_CASE_REPRICED = true
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

// Undo prepareFeeFixture's re-price for whatever runs next. seedGlobalPrices alone
// cannot do it: the FEE_CASE round numbers outrank every seed round, and
// getLatestPrice picks by round_number DESC, so until the FEE_CASE rows age past
// the staleness window they keep pricing every OTHER test's flat-fee actions
// against the re-priced pair's much larger expectation. Deleting the pairs first
// is what actually restores the shared fixture.
async function restoreFeeFixture(){
    if (FEE_CASE_REPRICED){
        await priceSnapshotHelper.clearPair('XCHAIN/USD')
        await priceSnapshotHelper.clearPair(COIN_CODE + '/USD')
        FEE_CASE_REPRICED = false
    }
    await nativeFeeHelper.seedGlobalPrices(true)
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
        after(async function () {
            // The native lane below re-prices the shared pair on dust-heavy chains;
            // A2/A3 run next and rely on the standard fixture.
            await restoreFeeFixture()
        })

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

            // The ledger side, charged exactly (see the gas-expectation note above).
            const perChild      = XCHAIN_PER_CHILD_ISSUE
            const expectedSpent = XCHAIN_PER_ISSUE + CHILDREN * perChild
            // Pinned so the expectation cannot silently track a change in the very fee
            // arithmetic this test exists to hold still.
            assert.strictEqual(expectedSpent, 26,
                "gas schedule moved: 1 ISSUE + 50x0.5 ISSUE_SUBTOKEN should be 26 XCHAIN")
            const debits = await debitsForTx(result.txHash, GAS_TICK)
            assert.strictEqual(debits.length, 51, "one gas debit per sub-command")
            const spent = debits.reduce((s, d) => s + Number(d.amount), 0)
            assert.strictEqual(spent, expectedSpent,
                "gas debited should be 1 ISSUE + 50 ISSUE_SUBTOKEN charged exactly = " +
                expectedSpent + " XCHAIN")
            const gasAfter = await balanceOf(address, GAS_TICK)
            assert.strictEqual(Number(gasBefore) - Number(gasAfter), expectedSpent,
                "the source's XCHAIN balance moved by exactly the batch's gas")
            console.log("A1: 51/51 valid, gas_cost 100000 + 50x50000, " + expectedSpent +
                " XCHAIN debited across " + debits.length + " debits (per-child debit " +
                perChild + ")")
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

        // A dotted TICK whose parent was never issued rejects the ISSUE at "parent
        // unknown"; the PARENT name is never interned since nothing stores it, only
        // TICK and CALLBACK_TICK reach an index_tickers id through createIssue.
        //
        // The child name IS interned though: db.js's createIssue calls createTicker to
        // store the rejected row, which is how EVERY action type records a rejected
        // attempt. Its ticker row is inert - no token row, no supply, no balance.
        it('interns no PARENT name for an ISSUE rejected at parent-unknown', async function () {
            const addr    = await cryptoHelper.getNewFundedAddress("BIL.A3C", COIN, NETWORK, null, "legacy", 0, 1)
            const address = addr["address"]
            const parent  = "BILA3E" + address.substring(address.length - 8)
            const child   = parent + ".1"

            // Neither name may exist yet, or the test would assert on someone else's row.
            assert.strictEqual(await tickerId(parent), null, "the parent name must be unseen at the start")
            assert.strictEqual(await tickerId(child),  null, "the child name must be unseen at the start")

            const txHash = await require('../transactionHelper').createAndSendTransaction(
                addr, issueCmd(child, 100, 100, 1, "orphan"))
            const row = await indexerDatabase.waitForIssue({
                source: address, txHash: txHash, status: 'invalid: TICK (parent unknown)'
            }, 120000)
            assert(row, "ISSUE " + child + " must be invalid: TICK (parent unknown)")

            assert.strictEqual(await tickerId(parent), null,
                "the unknown parent name must NOT be interned: the lookup that reads it is resolve-only")
            const childId = await tickerId(child)
            assert(childId, "the attempted TICK is interned by the storage layer, as every rejected action's is")
            assert.strictEqual(await tokenRow(child), null, "but no token row may exist for a rejected ISSUE")
            console.log("A3c txHash=" + txHash + " tick=" + child + " status=" + row.status +
                " parentInterned=false childTickerId=" + childId + " childToken=none")
        })

        // The consequence the two cases above exist to prevent, asserted over the whole
        // venue rather than one transaction: a NULL tick_id is what a non-interned name
        // writes, so no row that COUNTS may ever carry one. Rejected issuances are the
        // deliberate exception - they are stored with their verdict and no ticker, which
        // is the shape the fix produces.
        it('leaves no valid issuance and no ledger row carrying a NULL tick_id', async function () {
            const validNullIssues = await q(
                `SELECT COUNT(*) AS n FROM issues i
                   JOIN index_statuses s ON s.id = i.status_id
                  WHERE i.tick_id IS NULL AND s.status = 'valid'`)
            assert.strictEqual(Number(validNullIssues[0].n), 0,
                "a valid issuance with a NULL ticker id is the NULL-tick defect landing")

            for (const table of ['credits', 'debits', 'balances', 'tokens']){
                const rows = await q('SELECT COUNT(*) AS n FROM `' + table + '` WHERE tick_id IS NULL')
                assert.strictEqual(Number(rows[0].n), 0,
                    table + " may not carry a NULL tick_id row: it is unattributable balance")
            }

            // createTicker hands any ^-led name to getTickerId and never inserts one, so a
            // caret string appearing here would mean the resolve-only path had regressed.
            const caretNames = await q("SELECT COUNT(*) AS n FROM index_tickers WHERE tick LIKE '%^%'")
            assert.strictEqual(Number(caretNames[0].n), 0, "no caret-form name may be interned as a ticker")
        })
    })

    // ─── A6 ────────────────────────────────────────────────────────────────────
    describe('A6: gas for exactly K children', function () {
        it('yields exactly K valid children and K debits from a batch of N', async function () {
            if (!GAS_MODE) this.skip()   // gas debits are only consulted in gas mode

            const N = 8
            const K = 6

            // The budget is what the LEDGER debits per child, the gas schedule EXACTLY.
            // An over-sized budget silently buys extra children, so the K boundary this
            // test pins stops being a boundary.
            const perChild  = XCHAIN_PER_CHILD_ISSUE
            const perParent = XCHAIN_PER_ISSUE

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
            await restoreFeeFixture()
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
            await restoreFeeFixture()
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

            // The settlement this case is about IS an observable row: the first
            // obligation flipping to 'fulfilled'. Both COINPAY sub-commands are
            // judged in list order inside the SAME batch action, so once the first
            // obligation carries its verdict the second one's is written too and
            // the split below can be read. Waiting on the row rather than on 20s
            // also means a run where nothing settles fails on the assertion that
            // names the split instead of on how busy the venue was.
            // give-up-ok: a wait that times out changes nothing; the per-obligation
            // status read below is the assertion, and it reports what is really there.
            await indexerDatabase.waitForCoinpayObligation(
                { actionIndex: obligations[0], coinpayStatus: 'fulfilled' }, 60000)

            const settled = []
            for (const ai of obligations){
                const row = await indexerDatabase.checkCoinpayObligation({ actionIndex: ai })
                settled.push(row ? row.coinpay_status : null)
            }
            console.log("A5 COINPAY txHash=" + result.txHash + " obligations=" +
                JSON.stringify(obligations) + " statuses=" + JSON.stringify(settled))

            // EXACTLY one, not "at most one". The weaker bound is satisfied by a batch
            // that settles NOTHING, and that is precisely how this test passed before
            // the decoder learned to capture a batched sub-command's payment output:
            // COINPAY never saw a COIN_AMOUNT at all, so `0 <= 1` held with the ledger
            // taking no part in it. Asserting the exact split is what makes this
            // evidence that the CUMULATIVE ACCOUNTING enforces one-settles-one, rather
            // than evidence that the path is inert.
            const fulfilled = settled.filter(s => s === 'fulfilled').length
            assert.strictEqual(fulfilled, 1,
                "one payment must settle EXACTLY one obligation, not none and not both " +
                "(settled " + fulfilled + ", statuses " + JSON.stringify(settled) + ")")
            assert.strictEqual(settled[0], 'fulfilled',
                "the first sub-command draws the payment: sub-commands bill in list order")
            assert.notStrictEqual(settled[1], 'fulfilled',
                "the second obligation must not be settled by the first obligation's payment")
        })

        // The converse, and the reason the case above is not just the old structural
        // inertness wearing a tighter assertion: when the batch really does carry a
        // payment for each obligation, EVERY obligation settles. One test alone cannot
        // tell "the ledger stopped the second draw" from "no draw ever happens"; the
        // pair can.
        it('settles BOTH obligations when each payee has its own output', async function () {
            // Two DIFFERENT sellers, so each obligation resolves its own payment output
            // by payee address rather than competing for one pool.
            const sellerA = await cryptoHelper.getNewFundedAddress("BIL.A5CP2.SA", COIN, NETWORK, null, "legacy", 0, 2)
            const sellerB = await cryptoHelper.getNewFundedAddress("BIL.A5CP2.SB", COIN, NETWORK, null, "legacy", 0, 2)
            const buyer   = await cryptoHelper.getNewFundedAddress("BIL.A5CP2.B",  COIN, NETWORK, null, "legacy", 0, 2)
            const bAddr   = buyer["address"]

            const exp = (await chainTipTime()) + 86400
            const obligations = []
            const payees = []
            for (const seller of [sellerA, sellerB]){
                const sAddr = seller["address"]
                const tick  = "BILC2" + sAddr.substring(sAddr.length - 8)
                await issueHelper.sendIssueV0(seller, tick, 1000, 1000, 0, "A5 coinpay token", 1000)

                const sellerOrder = await orderHelper.sendOrderV0(
                    seller, COIN_CODE, tick, "100", COIN_CODE, "", "0.00100000",
                    sAddr, exp, "", "", "A5 two-payee sell")
                assert(sellerOrder.order, "seller ORDER for " + sAddr)
                const buyerOrder = await orderHelper.sendOrderV0(
                    buyer, COIN_CODE, "", "0.00100000", COIN_CODE, tick, "100",
                    bAddr, exp, "", "", "A5 two-payee buy")
                assert(buyerOrder.order, "buyer ORDER for " + sAddr)

                const match = await indexerDatabase.waitForOrderMatch({
                    giveActionIndex: Number(sellerOrder.order["action_index"]),
                    getActionIndex:  Number(buyerOrder.order["action_index"]),
                    status: 'pending_coinpay'
                }, 60000)
                assert(match, "ORDER_MATCH for " + sAddr + " should be pending_coinpay")
                obligations.push(Number(match.action_index))
                payees.push(sAddr)
            }

            // One output PER payee, each sized for that payee's single obligation.
            const result = await batchHelper.sendBatch(buyer, [
                "COINPAY|0|" + obligations[0],
                "COINPAY|0|" + obligations[1]
            ], { status: 'valid', skipNativeFeeInjection: true,
                 customOutputs: [{ address: payees[0], value: 100000 },
                                 { address: payees[1], value: 100000 }] })
            assert(result.batch, "the BATCH itself is valid")

            // Both obligations are expected to settle, so wait on each one reaching
            // 'fulfilled' instead of on a fixed window. The status read below is
            // unchanged, so a wait that gives up still reports what is really there.
            for (const ai of obligations){
                // give-up-ok: as above, the status read below is the assertion.
                await indexerDatabase.waitForCoinpayObligation(
                    { actionIndex: ai, coinpayStatus: 'fulfilled' }, 20000)
            }

            const settled = []
            for (const ai of obligations){
                const row = await indexerDatabase.checkCoinpayObligation({ actionIndex: ai })
                settled.push(row ? row.coinpay_status : null)
            }
            console.log("A5 COINPAY two-payee txHash=" + result.txHash + " obligations=" +
                JSON.stringify(obligations) + " statuses=" + JSON.stringify(settled))

            assert.deepStrictEqual(settled, ['fulfilled', 'fulfilled'],
                "each obligation draws its OWN payee's output, so both settle")
        })
    })

    // ─── A5 (DISPENSE half: spec frontier rows 18, 19, 20, 23 and 35) ──────────
    //
    // Two claims, both money-bearing, both previously proven only by unit tests.
    //
    //   ROW 23 - one payment funds ONE fill, with no batch anywhere in sight.
    //     findMatchingDispensers returns EVERY open dispenser sitting behind the paid
    //     address and the handler loops over all of them. Nothing decremented the
    //     payment between iterations, so each dispenser priced itself against the same
    //     untouched COIN_AMOUNT and bought a full multiplier off it. Anyone can open a
    //     second dispenser at an address they control, so that was a live double-spend
    //     on an ORDINARY transaction, and A5's "one payment settles one obligation,
    //     not N" had no chain evidence for the no-batch case. Closed on both trigger
    //     paths: a native-coin payment, and a token SEND routed through
    //     util.processDispenserSends.
    //
    //   ROW 35 - a dispenser created INSIDE a batch actually dispenses.
    //     The decoder's open-dispenser registry gated on the TOP-LEVEL action string,
    //     so `BATCH|0|DISPENSER|0|...` never entered the open set: payments to that
    //     address were never captured as dispenses and no DISPENSE could fire, while
    //     the indexer had registered the dispenser perfectly well. A decoder/indexer
    //     divergence, so this only means anything against a live pair of them.
    //
    // EVERY case below is a PAIR, for the same reason the COINPAY cases above are: a
    // single "exactly one fill happened" assertion cannot tell "the ledger stopped the
    // second draw" from "the second draw never happens at all", and this spec has
    // already been bitten by exactly that. So each fixture is paid twice, and the
    // second payment must reach the dispenser the first payment did NOT fund.
    //
    // FIXTURE SHAPE. Each dispenser escrows EXACTLY one fill (GIVE_ESCROW ==
    // GIVE_AMOUNT), which clamps its multiplier to 1 however large the payment is.
    // That is what makes attribution observable: a dispenser cannot absorb the whole
    // payment by dispensing more units, so the only thing that can stop a sibling
    // dispenser behind the same address is the value tally.
    //
    // LANE: every case runs everywhere. None attaches a hand-sized fee output and none
    // needs a FEE_DESTINATION, because a DISPENSER create carrying no EXPIRATION sits
    // inside the free window and is charged nothing, so the only transaction-level
    // value in play is the payment itself.
    //
    // BELOW THE FLAG is deliberately absent here. BATCH_ISSUANCE_LIMITS is
    // GENESIS-ACTIVE on regtest, so there is no below-flag block on this chain to send
    // a transaction into. The replay half - one payment still fills all N below the
    // flag, byte for byte - is pinned in
    // xchain-indexer/test/unit/dispenserValueAccounting.test.js, which drives the
    // handler with the gate forced off. That is the honest boundary: these are
    // at-flag witnesses only.
    describe('A5: one payment fills ONE dispenser (rows 19/20/23) and a batched create dispenses (row 35)', function () {

        const transactionHelper = require('../transactionHelper')
        const sendHelper        = require('../helpers/sendHelper')
        const dispenserHelper   = require('../helpers/dispenserHelper')

        // One fill's price in satoshis, per chain. Sized above each chain's dust
        // threshold so the triggering payment is relayable, and the amount paid is
        // EXACTLY this: the whole point is a payment that covers one fill, not two.
        const FILL_SATS = { BTC: 100000, LTC: 100000, DOGE: 10000000 }

        // Units of the GIVE token handed over per fill, and the escrow each dispenser
        // holds. Equal on purpose: one fill of capacity each.
        const GIVE_PER_FILL = 10
        // Fill price when the trigger is a token SEND rather than a coin payment.
        const PAY_PER_FILL  = 10

        const INSUFFICIENT = 'invalid: GET_AMOUNT (insufficient funds)'

        function fillSats(){ return FILL_SATS[COIN_CODE] || 100000 }
        function fillCoin(){ return (fillSats() / 1e8).toFixed(8) }

        // Every dispense row the indexer wrote for one triggering transaction, in the
        // order the handler produced them (findMatchingDispensers orders by
        // d1.action_index, so the OLDEST dispenser behind the address draws first).
        //
        // The join runs through `actions` because a multi-dispenser trigger writes
        // several action rows against ONE transaction: the first dispense reuses the
        // trigger's own action index and each later one gets a fresh index.
        async function dispensesForTx(txHash){
            return q(`SELECT d.action_index, d.dispenser_action_index, d.give_amount,
                             d.get_amount, itk.tick AS give_tick, ist.status AS status
                        FROM dispenses d
                        JOIN actions a               ON a.action_index = d.action_index
                        JOIN transactions t          ON t.tx_index = a.tx_index
                        JOIN index_transactions it   ON it.id = t.tx_hash_id
                        LEFT JOIN index_tickers itk  ON itk.id = d.give_tick_id
                        LEFT JOIN index_statuses ist ON ist.id = d.status_id
                       WHERE it.hash = ?
                       ORDER BY d.action_index ASC`, [txHash])
        }

        // The dispensers a transaction created, oldest action index first.
        async function dispensersForTx(txHash){
            return q(`SELECT dp.action_index, dp.give_amount, dp.give_escrow, dp.get_amount,
                             itk.tick AS give_tick, ist.status AS status
                        FROM dispensers dp
                        JOIN actions a               ON a.action_index = dp.action_index
                        JOIN transactions t          ON t.tx_index = a.tx_index
                        JOIN index_transactions it   ON it.id = t.tx_hash_id
                        LEFT JOIN index_tickers itk  ON itk.id = dp.give_tick_id
                        LEFT JOIN index_statuses ist ON ist.id = dp.status_id
                       WHERE it.hash = ?
                       ORDER BY dp.action_index ASC`, [txHash])
        }

        // Numeric balance, because every assertion below is an exact DELTA and the
        // shared balanceOf() returns the raw column string.
        async function tokenBalance(address, tick){
            return Number(await balanceOf(address, tick))
        }

        async function waitForDispenses(txHash, expected, timeoutMs = 180000){
            const deadline = Date.now() + timeoutMs
            for (;;){
                const rows = await dispensesForTx(txHash)
                if (rows.length >= expected || Date.now() > deadline) break
                await new Promise(r => setTimeout(r, 2000))
            }
            // Settle, then re-read. Every case asserts an EXACT row count, and
            // returning the instant the count is MET would turn "the indexer wrote one
            // row too many" into a passing race rather than a failure.
            await new Promise(r => setTimeout(r, 8000))
            return dispensesForTx(txHash)
        }

        async function waitForBalance(address, tick, expected, timeoutMs = 120000){
            const deadline = Date.now() + timeoutMs
            for (;;){
                const value = await tokenBalance(address, tick)
                if (value >= expected || Date.now() > deadline) return value
                await new Promise(r => setTimeout(r, 2000))
            }
        }

        // DISPENSER v0 as a BATCH sub-command. dispenserHelper builds and SENDS its own
        // transaction, so it cannot express a create that lives inside a batch. Built
        // from a field LIST rather than concatenated pipes on purpose: the message has
        // sixteen fields, six of them empty and adjacent, and a miscounted separator
        // produces a create that parses into different columns rather than one that
        // fails loudly.
        function dispenserCmd(giveTick, giveAmount, giveEscrow, getAmount, getAddress, memo){
            return [
                'DISPENSER', '0',
                COIN_CODE,      // GIVE_COIN
                giveTick,       // GIVE_TICK
                giveAmount,     // GIVE_AMOUNT
                '',             // GIVE_OWNERSHIP
                giveEscrow,     // GIVE_ESCROW
                COIN_CODE,      // GET_COIN
                '',             // GET_TICK (native-coin priced)
                getAmount,      // GET_AMOUNT
                getAddress,     // GET_ADDRESS
                '',             // FIAT_CODE
                '',             // FIAT_AMOUNT
                '',             // ORACLE_ADDRESS
                '',             // EXPIRATION (free window, so the create is charged nothing)
                '',             // ALLOW_LIST
                '',             // BLOCK_LIST
                memo || ''
            ].join('|')
        }

        function statuses(rows){ return rows.map(r => r.status) }

        // ─── Row 23, native-coin trigger ───────────────────────────────────────
        describe('row 23: one coin payment behind THREE dispensers at one address', function () {

            let host = null, hostAddress = null, buyer = null, buyerAddress = null
            let tick = null
            const dispenserIndexes = []

            before(async function () {
                host  = await cryptoHelper.getNewFundedAddress("BIL.D23N.H", COIN, NETWORK, null, "legacy", 0, 2)
                buyer = await cryptoHelper.getNewFundedAddress("BIL.D23N.B", COIN, NETWORK, null, "legacy", 0, 2)
                hostAddress  = host["address"]
                buyerAddress = buyer["address"]
                tick = "BILDN" + hostAddress.substring(hostAddress.length - 8)

                await issueHelper.sendIssueV0(host, tick, 1000, 1000, 0, "row 23 native trigger", 1000)

                // Three dispensers, all at the SAME GET_ADDRESS, each holding exactly
                // one fill of escrow. No EXPIRATION: inside the free window, so the
                // creates are charged nothing and no fee output is hand-sized here.
                for (let n = 0; n < 3; n++){
                    const created = await dispenserHelper.sendDispenserV0(
                        host, COIN_CODE, tick, GIVE_PER_FILL, GIVE_PER_FILL,
                        COIN_CODE, null, fillCoin(), hostAddress,
                        null, null, null, null, null, null, 'row 23 dispenser ' + n)
                    assert(created.dispenser, "dispenser " + n + " should be open")
                    dispenserIndexes.push(Number(created.dispenser["action_index"]))
                }
                console.log("row 23 native: host=" + hostAddress + " tick=" + tick +
                    " dispensers=" + JSON.stringify(dispenserIndexes) +
                    " fill=" + fillSats() + " sats")
            })

            it('fills exactly ONE dispenser, and moves exactly one fill of balance', async function () {
                const before = await tokenBalance(buyerAddress, tick)

                const txHash = await transactionHelper.createSimpleTransaction(
                    buyer, hostAddress, fillSats())

                const rows  = await waitForDispenses(txHash, 3)
                const after = await waitForBalance(buyerAddress, tick, before + GIVE_PER_FILL)
                console.log("row 23 native ONE-FILL txHash=" + txHash +
                    " statuses=" + JSON.stringify(statuses(rows)) +
                    " giveAmounts=" + JSON.stringify(rows.map(r => r.give_amount)) +
                    " getAmounts=" + JSON.stringify(rows.map(r => r.get_amount)) +
                    " buyerBalance=" + before + "->" + after)

                // Every matched dispenser gets its own record, so "one settled" is
                // proven by the SPLIT rather than by the absence of rows.
                assert.strictEqual(rows.length, 3,
                    "all three dispensers behind the paid address are evaluated")

                // EXACTLY one, not "at most one": a path that settles NOTHING satisfies
                // the weaker bound, and that is the failure mode this case exists to
                // rule out. The companion case below is the other half of the argument.
                const valid = rows.filter(r => r.status === 'valid')
                assert.strictEqual(valid.length, 1,
                    "one payment must buy exactly ONE fill, not three (statuses " +
                    JSON.stringify(statuses(rows)) + ")")

                // Which one settles is deterministic across nodes: the match query
                // orders by the dispenser's action index.
                assert.strictEqual(Number(valid[0].dispenser_action_index), dispenserIndexes[0],
                    "the lowest dispenser action index draws the payment")

                for (const row of rows.filter(r => r.status !== 'valid'))
                    assert.strictEqual(row.status, INSUFFICIENT,
                        "a dispenser past the drained payment reports an empty pool")

                // The money, not just the bookkeeping.
                assert.strictEqual(after, before + GIVE_PER_FILL,
                    "exactly one fill of " + tick + " moved to the buyer")
                assert.strictEqual(Number(valid[0].give_amount), GIVE_PER_FILL)

                // Row 18: the row records what this dispense was CHARGED. At a payment
                // of exactly one fill the two figures coincide, so the discriminating
                // check is in the companion case, whose payment is larger than a fill.
                assert.strictEqual(Number(valid[0].get_amount), Number(fillCoin()),
                    "the settled row records the fill price it was charged")
            })

            it('fills the REMAINING two when a later payment carries two fills', async function () {
                // The same fixture, paid again. The first dispenser is exhausted and
                // closed, so this payment meets dispensers 2 and 3 - and if the case
                // above had passed merely because nothing ever settles, nothing would
                // settle here either.
                //
                // TWO fills' worth against two dispensers that serve one fill each:
                // both settle, and each draws ONE fill's price out of the pool rather
                // than the whole payment. That is the row 18 record correction too.
                const before = await tokenBalance(buyerAddress, tick)

                const txHash = await transactionHelper.createSimpleTransaction(
                    buyer, hostAddress, fillSats() * 2)

                const rows  = await waitForDispenses(txHash, 2)
                const after = await waitForBalance(buyerAddress, tick, before + GIVE_PER_FILL * 2)
                console.log("row 23 native TWO-FILL txHash=" + txHash +
                    " statuses=" + JSON.stringify(statuses(rows)) +
                    " getAmounts=" + JSON.stringify(rows.map(r => r.get_amount)) +
                    " buyerBalance=" + before + "->" + after)

                assert.strictEqual(rows.length, 2,
                    "the exhausted dispenser has closed; the other two remain open")
                assert.deepStrictEqual(statuses(rows), ['valid', 'valid'],
                    "two fills' worth must fund two fills")
                assert.deepStrictEqual(
                    rows.map(r => Number(r.dispenser_action_index)),
                    [dispenserIndexes[1], dispenserIndexes[2]],
                    "the two dispensers the first payment could not reach")
                assert.strictEqual(after, before + GIVE_PER_FILL * 2,
                    "two fills of " + tick + " moved to the buyer")

                // Each row carries ONE fill's price, never the two-fill payment: the
                // record and the amount drained from the pool are one number.
                for (const row of rows)
                    assert.strictEqual(Number(row.get_amount), Number(fillCoin()),
                        "each dispense records the fill it bought, not the whole payment")
            })
        })

        // ─── Row 23 / row 20, token-SEND trigger ───────────────────────────────
        //
        // The same double-spend lived on the SEND path: util.processDispenserSends
        // builds its own data object per SEND and hands it to the same handler, so
        // several dispensers priced in the sent token all drew on one SEND's amount.
        describe('row 23: one token SEND behind THREE dispensers at one address', function () {

            let host = null, hostAddress = null, buyer = null, buyerAddress = null
            let giveTick = null, payTick = null
            const dispenserIndexes = []

            before(async function () {
                host  = await cryptoHelper.getNewFundedAddress("BIL.D23S.H", COIN, NETWORK, null, "legacy", 0, 2)
                buyer = await cryptoHelper.getNewFundedAddress("BIL.D23S.B", COIN, NETWORK, null, "legacy", 0, 2)
                hostAddress  = host["address"]
                buyerAddress = buyer["address"]
                giveTick = "BILDG" + hostAddress.substring(hostAddress.length - 8)
                payTick  = "BILDP" + hostAddress.substring(hostAddress.length - 8)

                await issueHelper.sendIssueV0(host, giveTick, 1000, 1000, 0, "row 23 send give", 1000)
                await issueHelper.sendIssueV0(host, payTick,  1000, 1000, 0, "row 23 send pay",  1000)
                // The buyer needs the payment token before it can trigger anything.
                await sendHelper.sendSendV0(host, payTick, PAY_PER_FILL * 4, buyerAddress, "row 23 fund buyer")

                for (let n = 0; n < 3; n++){
                    const created = await dispenserHelper.sendDispenserV0(
                        host, COIN_CODE, giveTick, GIVE_PER_FILL, GIVE_PER_FILL,
                        COIN_CODE, payTick, PAY_PER_FILL, hostAddress,
                        null, null, null, null, null, null, 'row 23 send dispenser ' + n)
                    assert(created.dispenser, "token-priced dispenser " + n + " should be open")
                    dispenserIndexes.push(Number(created.dispenser["action_index"]))
                }
                console.log("row 23 send: host=" + hostAddress + " give=" + giveTick +
                    " pay=" + payTick + " dispensers=" + JSON.stringify(dispenserIndexes))
            })

            it('fills exactly ONE dispenser from one SEND carrying one fill', async function () {
                const before = await tokenBalance(buyerAddress, giveTick)

                const sent = await sendHelper.sendSendV0(
                    buyer, payTick, PAY_PER_FILL, hostAddress, "row 23 one fill")
                assert(sent.send, "the triggering SEND itself is valid")

                const rows  = await waitForDispenses(sent.txHash, 3)
                const after = await waitForBalance(buyerAddress, giveTick, before + GIVE_PER_FILL)
                console.log("row 23 send ONE-FILL txHash=" + sent.txHash +
                    " statuses=" + JSON.stringify(statuses(rows)) +
                    " getAmounts=" + JSON.stringify(rows.map(r => r.get_amount)) +
                    " buyerBalance=" + before + "->" + after)

                assert.strictEqual(rows.length, 3,
                    "all three token-priced dispensers behind the address are evaluated")
                const valid = rows.filter(r => r.status === 'valid')
                assert.strictEqual(valid.length, 1,
                    "one SEND must buy exactly ONE fill, not three (statuses " +
                    JSON.stringify(statuses(rows)) + ")")
                assert.strictEqual(Number(valid[0].dispenser_action_index), dispenserIndexes[0])
                for (const row of rows.filter(r => r.status !== 'valid'))
                    assert.strictEqual(row.status, INSUFFICIENT)
                assert.strictEqual(after, before + GIVE_PER_FILL,
                    "exactly one fill of " + giveTick + " moved to the buyer")
            })

            it('fills the REMAINING two when a later SEND carries two fills', async function () {
                const before = await tokenBalance(buyerAddress, giveTick)

                const sent = await sendHelper.sendSendV0(
                    buyer, payTick, PAY_PER_FILL * 2, hostAddress, "row 23 two fills")
                assert(sent.send, "the triggering SEND itself is valid")

                const rows  = await waitForDispenses(sent.txHash, 2)
                const after = await waitForBalance(buyerAddress, giveTick, before + GIVE_PER_FILL * 2)
                console.log("row 23 send TWO-FILL txHash=" + sent.txHash +
                    " statuses=" + JSON.stringify(statuses(rows)) +
                    " getAmounts=" + JSON.stringify(rows.map(r => r.get_amount)) +
                    " buyerBalance=" + before + "->" + after)

                assert.strictEqual(rows.length, 2)
                assert.deepStrictEqual(statuses(rows), ['valid', 'valid'],
                    "two fills' worth of the payment token must fund two fills")
                assert.deepStrictEqual(
                    rows.map(r => Number(r.dispenser_action_index)),
                    [dispenserIndexes[1], dispenserIndexes[2]])
                assert.strictEqual(after, before + GIVE_PER_FILL * 2)
                for (const row of rows)
                    assert.strictEqual(Number(row.get_amount), PAY_PER_FILL,
                        "each dispense records the fill it bought, not the whole SEND")
            })
        })

        // ─── Row 35 ────────────────────────────────────────────────────────────
        //
        // TWO creates in ONE batch, not one: the decoder collapses a batch's creates to
        // a single registration per operating address because its dispensers table is
        // keyed on (tx_index, address_id), and that collapse is itself part of the fix
        // (a second create used to collide on the primary key and be read as stored).
        // Two creates therefore exercise the registry AND give the pair evidence - the
        // second payment must reach the dispenser the first one did not fund.
        describe('row 35: a dispenser created inside a BATCH dispenses on a live chain', function () {

            let host = null, hostAddress = null, buyer = null, buyerAddress = null
            let tick = null, batchTxHash = null
            let dispenserIndexes = []

            before(async function () {
                host  = await cryptoHelper.getNewFundedAddress("BIL.D35.H", COIN, NETWORK, null, "legacy", 0, 2)
                buyer = await cryptoHelper.getNewFundedAddress("BIL.D35.B", COIN, NETWORK, null, "legacy", 0, 2)
                hostAddress  = host["address"]
                buyerAddress = buyer["address"]
                tick = "BILD5" + hostAddress.substring(hostAddress.length - 8)

                await issueHelper.sendIssueV0(host, tick, 1000, 1000, 0, "row 35 batch dispensers", 1000)

                const commands = [0, 1].map(n => dispenserCmd(
                    tick, GIVE_PER_FILL, GIVE_PER_FILL, fillCoin(), hostAddress,
                    'row 35 batched dispenser ' + n))

                const result = await batchHelper.sendBatch(host, commands, { status: 'valid' })
                assert(result.batch, "the BATCH itself is valid")
                batchTxHash = result.txHash

                // The indexer half: both creates land as open dispensers. This was never
                // the defect - it is the DECODER that did not see them - so it is a
                // precondition here rather than the witness.
                const created = await dispensersForTx(batchTxHash)
                assert.strictEqual(created.length, 2,
                    "a batch's two DISPENSER sub-commands each create a dispenser")
                for (const row of created)
                    assert.strictEqual(row.status, 'valid')
                dispenserIndexes = created.map(r => Number(r.action_index))
                console.log("row 35 batch txHash=" + batchTxHash + " host=" + hostAddress +
                    " tick=" + tick + " dispensers=" + JSON.stringify(dispenserIndexes))
            })

            it('captures a payment to the batch-created dispenser and dispenses', async function () {
                const before = await tokenBalance(buyerAddress, tick)

                const txHash = await transactionHelper.createSimpleTransaction(
                    buyer, hostAddress, fillSats())

                const rows  = await waitForDispenses(txHash, 2)
                const after = await waitForBalance(buyerAddress, tick, before + GIVE_PER_FILL)
                console.log("row 35 ONE-FILL txHash=" + txHash +
                    " statuses=" + JSON.stringify(statuses(rows)) +
                    " getAmounts=" + JSON.stringify(rows.map(r => r.get_amount)) +
                    " buyerBalance=" + before + "->" + after)

                // The witness itself: rows exist at all. Before the registry learned to
                // read a batch's sub-commands this payment was not classified as a
                // dispense trigger, so there was nothing here to have a status.
                assert.strictEqual(rows.length, 2,
                    "both batch-created dispensers are evaluated against the payment")
                const valid = rows.filter(r => r.status === 'valid')
                assert.strictEqual(valid.length, 1,
                    "one payment buys exactly ONE fill from the batch-created pair (statuses " +
                    JSON.stringify(statuses(rows)) + ")")
                assert.strictEqual(Number(valid[0].dispenser_action_index), dispenserIndexes[0])
                assert.strictEqual(rows.filter(r => r.status !== 'valid')[0].status, INSUFFICIENT)

                // Balances actually move, which is the part a registry-only assertion
                // could never prove.
                assert.strictEqual(after, before + GIVE_PER_FILL,
                    "one fill of " + tick + " moved out of the batch-created dispenser")
                assert.strictEqual(Number(valid[0].give_amount), GIVE_PER_FILL)
            })

            it('dispenses from the SECOND batch-created dispenser on a second payment', async function () {
                // Pair evidence, and the second half of row 35: the sibling create is
                // not merely present, it is spendable. The first dispenser is exhausted
                // and closed, so this payment reaches the one the tally stopped.
                const before = await tokenBalance(buyerAddress, tick)

                const txHash = await transactionHelper.createSimpleTransaction(
                    buyer, hostAddress, fillSats())

                const rows  = await waitForDispenses(txHash, 1)
                const after = await waitForBalance(buyerAddress, tick, before + GIVE_PER_FILL)
                console.log("row 35 SECOND-FILL txHash=" + txHash +
                    " statuses=" + JSON.stringify(statuses(rows)) +
                    " buyerBalance=" + before + "->" + after)

                assert.strictEqual(rows.length, 1,
                    "the exhausted dispenser has closed, leaving the sibling")
                assert.deepStrictEqual(statuses(rows), ['valid'])
                assert.strictEqual(Number(rows[0].dispenser_action_index), dispenserIndexes[1],
                    "the SECOND create in the batch dispenses too")
                assert.strictEqual(after, before + GIVE_PER_FILL)
            })
        })
    })
})
