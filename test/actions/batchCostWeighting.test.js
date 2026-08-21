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
// BATCH_COST_WEIGHTING acceptance suite (spec acceptance tests A2-A5).
//
// The flag replaces the flat per-BATCH command cap with a budget over per-action COST
// WEIGHTS. Every case here is a PAIR - one batch AT the budget that lands, one over it
// that is refused - because a single rejection cannot distinguish "the budget stopped
// it" from "this batch shape never works on this stack".
//
// The weights under test are the landed table in xchain-indexer/src/actions/batch.js:
// budget 250, default weight 1, AIRDROP/DIVIDEND 25, DEPLOY/EXECUTE/XEXEC 30, and the
// per-action cap DEPLOY = 1 that survives BESIDE the weight.
//
// A4 and A5 also carry a CONTROL: the same command COUNT built from ordinary SENDs,
// which must land. Without it a rejection at 9 EXECUTEs or 11 AIRDROPs is equally
// explained by the count cap, and the count cap is not what is being tested.
//
// Fee lane: on a native-fee chain the whole batch draws one fee pool, so the at-budget
// ISSUE case attaches an output covering all 250 sub-commands rather than the helper's
// flat per-transaction fee. Every other case fits inside the flat fee.

const assert = require('assert')
const cryptoHelper = require('../cryptoHelper')
const listHelper = require('../helpers/listHelper')
const issueHelper = require('../helpers/issueHelper')
const batchHelper = require('../helpers/batchHelper')
const gasHelper = require('../helpers/gasHelper')
const vmHelper = require('../helpers/vmHelper')
const nativeFeeHelper = require('../helpers/nativeFeeHelper')
const envelopeHelper = require('../helpers/envelopeHelper')

const WEIGHT_BUDGET  = 250
const VM_WEIGHT      = 30   // DEPLOY, EXECUTE, XEXEC
const FANOUT_WEIGHT  = 25   // AIRDROP, DIVIDEND

// Sub-command counts either side of each class's budget boundary.
const VM_AT_BUDGET       = Math.floor(WEIGHT_BUDGET / VM_WEIGHT)          // 8  -> 240
const VM_OVER_BUDGET     = VM_AT_BUDGET + 1                               // 9  -> 270
const FANOUT_AT_BUDGET   = Math.floor(WEIGHT_BUDGET / FANOUT_WEIGHT)      // 10 -> 250
const FANOUT_OVER_BUDGET = FANOUT_AT_BUDGET + 1                           // 11 -> 275

// Gas schedule (xchain-indexer/src/coins/<COIN>.js GAS_SCHEDULE x GAS_PRICE), used only
// to size the at-budget ISSUE batch's one fee output.
const XCHAIN_PER_ISSUE       = 1.0
const XCHAIN_PER_CHILD_ISSUE = 0.5

const CONTRACT = `
    module.exports = {
        initialize: function() {
            xchain.state.set('count', '0');
        },
        bump: function() {
            let count = parseInt(xchain.state.get('count') || '0');
            xchain.state.set('count', String(count + 1));
            return String(count + 1);
        }
    };
`

let FEE_DEST = null

async function q(sql, args){
    const conn = await indexerDatabase.getConnection()
    try { return await conn.query(sql, args) } finally { await conn.release() }
}

// Every action row the indexer wrote for one transaction. A batch refused by the budget
// must produce exactly ONE (the BATCH itself), which is how "no sub-command executed" is
// proven rather than inferred from the absence of per-action rows.
async function actionsForTx(txHash){
    return q(`SELECT a.action_index, a.block_index, ia.action AS action
                FROM actions a
                JOIN transactions t          ON t.tx_index = a.tx_index
                JOIN index_transactions it   ON it.id = t.tx_hash_id
                LEFT JOIN index_actions ia   ON ia.id = a.action_id
               WHERE it.hash = ?
               ORDER BY a.action_index ASC`, [txHash])
}

async function issueStatusesForTx(txHash){
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

async function executionStatusesForTx(txHash){
    return q(`SELECT ce.action_index, ce.contract_index, ce.method_name, ce.gas_used,
                     ist.status AS status
                FROM contract_executions ce
                JOIN actions a               ON a.action_index = ce.action_index
                JOIN transactions t          ON t.tx_index = a.tx_index
                JOIN index_transactions it   ON it.id = t.tx_hash_id
                LEFT JOIN index_statuses ist ON ist.id = ce.status_id
               WHERE it.hash = ?
               ORDER BY ce.action_index ASC`, [txHash])
}

async function airdropStatusesForTx(txHash){
    return q(`SELECT ad.action_index, ad.amount, ist.status AS status
                FROM airdrops ad
                JOIN actions a               ON a.action_index = ad.action_index
                JOIN transactions t          ON t.tx_index = a.tx_index
                JOIN index_transactions it   ON it.id = t.tx_hash_id
                LEFT JOIN index_statuses ist ON ist.id = ad.status_id
               WHERE it.hash = ?
               ORDER BY ad.action_index ASC`, [txHash])
}

async function contractsForTx(txHash){
    return q(`SELECT c.action_index, ist.status AS status
                FROM contracts c
                JOIN actions a               ON a.action_index = c.action_index
                JOIN transactions t          ON t.tx_index = a.tx_index
                JOIN index_transactions it   ON it.id = t.tx_hash_id
                LEFT JOIN index_statuses ist ON ist.id = c.status_id
               WHERE it.hash = ?
               ORDER BY c.action_index ASC`, [txHash])
}

// Poll until the indexer has written every action row of a batch, so a count assertion
// cannot race a half-processed block.
async function waitForActionCount(txHash, expected, timeoutMs = 300000){
    const deadline = Date.now() + timeoutMs
    for (;;){
        const rows = await actionsForTx(txHash)
        if (rows.length >= expected || Date.now() > deadline) return rows
        await new Promise(r => setTimeout(r, 2000))
    }
}

// Satoshis one XCHAIN of nominal fee converts to, off the price pair the indexer will
// actually value the fee against (highest round wins, as every seed site here relies on).
async function satsPerXchain(){
    await nativeFeeHelper.seedGlobalPrices(true)
    const rows = await q(`SELECT coin_pair, price, round_number
                            FROM price_snapshots
                           WHERE coin_pair IN ('XCHAIN/USD', ?) AND status = 'finalized'
                           ORDER BY round_number DESC`, [COIN_CODE + '/USD'])
    const pick = pair => rows.find(r => r.coin_pair === pair)
    const xchain = pick('XCHAIN/USD'), coin = pick(COIN_CODE + '/USD')
    assert(xchain && coin, 'no finalized XCHAIN/USD + ' + COIN_CODE + '/USD snapshots to price a fee against')
    return Math.round(Number(xchain.price) / Number(coin.price) * 1e8)
}

// ISSUE v0 with trailing optional fields omitted, so a 251-command batch stays as small
// as the wire allows.
function issueCmd(tick, maxSupply, maxMint, mintSupply, description){
    return "ISSUE|0|"+tick+"|"+maxSupply+"|"+maxMint+"|0|"+description+"|"+mintSupply
}

function sendCmd(tick, amount, destination){
    return "SEND|0|"+tick+"|"+amount+"|"+destination+"|w"
}

function executeCmd(contractIndex, method){
    return "EXECUTE|0|"+contractIndex+"|"+method
}

function airdropCmd(tick, amount, listActionIndex, memo){
    return "AIRDROP|0|"+tick+"|"+amount+"|"+listActionIndex+"|"+memo
}

function deployCmd(code, gasLimit){
    return "DEPLOY|0|"+Buffer.from(code, 'utf8').toString('base64')+"|"+gasLimit
}

// Batch send options that let the whole batch's nominal fee be covered at once. On a gas
// stack the helper injects nothing and the source's XCHAIN balance is metered instead.
function wholeBatchFee(sats){
    if (!FEE_DEST) return { skipNativeFeeInjection: true }
    return { skipNativeFeeInjection: true, customOutputs: [{ address: FEE_DEST, value: Math.ceil(sats) }] }
}

// The envelope lane, and the only lane the A2 pair can ride: 250 real ISSUE sub-commands
// compile to ~10 KB and the chunk lanes refuse anything over 8192 bytes. It needs a
// segwit source and the source's public key as the envelope internal key.
function envelopeLane(addressInfo){
    return {
        outputType: 'TAPROOT',
        compressedPubKey: Buffer.from(addressInfo["publicKey"]).toString('hex')
    }
}

// Chain evidence line. The batch row carries no height, so the block is read back off
// the BATCH action row, which is the same row the verdict assertions read.
async function log(label, result){
    const rows = await actionsForTx(result.txHash)
    const block = rows.length ? rows[0].block_index : '?'
    console.log(label + ' txHash=' + result.txHash + ' block=' + block +
        ' status=' + (result.batch ? result.batch.status : 'NO ROW'))
}

describe('BATCH cost weighting (BATCH_COST_WEIGHTING)', function () {

    before(async function () {
        const mode = await nativeFeeHelper.discoverFeeMode()
        FEE_DEST = mode.destination || null
        console.log('lane: COIN=' + COIN_CODE + ' feeDestination=' + (FEE_DEST ? 'resolved' : 'none') +
            ' budget=' + WEIGHT_BUDGET + ' vmWeight=' + VM_WEIGHT + ' fanOutWeight=' + FANOUT_WEIGHT)
    })

    describe('A2: ordinary sub-commands still weigh 1 each', function () {

        // Both cases fund a SEGWIT source, because the envelope commit's inputs must
        // all be segwit (§3.5). DOGE has no segwit at all, so p2wpkh cannot even be
        // encoded there (bech32 throws on the absent network prefix) and the pair is
        // unrunnable rather than failing. Same gate the envelope suites use.
        beforeEach(function () {
            if (!envelopeHelper.envelopeSupported()) this.skip()
        })

        it('lands one parent plus 249 dotted children (weight 250, at budget)', async function () {
            // Segwit-funded: the envelope commit's inputs must be segwit (§3.5).
            const addr    = await cryptoHelper.getNewFundedAddress("BCW.A2.AT", COIN, NETWORK, null, "segwit", 0, 1)
            const address = addr["address"]
            const parent  = "BCWA" + address.substring(address.length - 8)

            const CHILDREN = WEIGHT_BUDGET - 1
            const commands = [ issueCmd(parent, 1000000, 1000000, 1000, "p") ]
            for (let n = 1; n <= CHILDREN; n++)
                commands.push(issueCmd(parent + "." + n, 100, 100, 10, "c"))
            assert.strictEqual(commands.length, WEIGHT_BUDGET)

            // Overpayment is never rejected, and the exact-coverage boundary is not this
            // suite's subject: what is under test is that 250 weight-1 sub-commands are
            // admitted, so the fee must not be what decides the verdict.
            const nominal = XCHAIN_PER_ISSUE + CHILDREN * XCHAIN_PER_CHILD_ISSUE
            const sats    = FEE_DEST ? (await satsPerXchain()) * nominal * 1.5 : 0

            const result = await batchHelper.sendBatch(addr, commands,
                Object.assign({ status: 'valid', timeout: 300000 }, wholeBatchFee(sats), envelopeLane(addr)))
            assert(result.batch, 'a 250-command batch of weight-1 sub-commands must be valid')
            assert.strictEqual(result.batch.status, 'valid')
            await log('A2 at-budget', result)

            const actions = await waitForActionCount(result.txHash, WEIGHT_BUDGET + 1)
            assert.strictEqual(actions.length, WEIGHT_BUDGET + 1,
                'expected 1 BATCH + ' + WEIGHT_BUDGET + ' ISSUE action rows, got ' + actions.length)

            const issues = await issueStatusesForTx(result.txHash)
            assert.strictEqual(issues.length, WEIGHT_BUDGET, 'expected ' + WEIGHT_BUDGET + ' issue rows')
            assert.deepStrictEqual(
                issues.filter(r => r.status !== 'valid').map(r => r.tick + ' -> ' + r.status), [],
                'every issuance in an at-budget batch must land')
            console.log('A2 at-budget landed ' + issues.length + ' issuances in block ' + actions[0].block_index)
        })

        it('rejects one parent plus 250 children with invalid: COMMAND (limit)', async function () {
            const addr    = await cryptoHelper.getNewFundedAddress("BCW.A2.OVER", COIN, NETWORK, null, "segwit", 0, 1)
            const address = addr["address"]
            const parent  = "BCWB" + address.substring(address.length - 8)

            const commands = [ issueCmd(parent, 1000000, 1000000, 1000, "p") ]
            for (let n = 1; n <= WEIGHT_BUDGET; n++)
                commands.push(issueCmd(parent + "." + n, 100, 100, 10, "c"))
            assert.strictEqual(commands.length, WEIGHT_BUDGET + 1)

            const result = await batchHelper.sendBatch(addr, commands,
                Object.assign({ status: 'invalid: COMMAND (limit)', timeout: 300000 }, envelopeLane(addr)))
            assert(result.batch, '251 weight-1 sub-commands must exceed the budget')
            assert.strictEqual(result.batch.status, 'invalid: COMMAND (limit)')
            await log('A2 over-budget', result)

            const actions = await actionsForTx(result.txHash)
            assert.strictEqual(actions.length, 1,
                'an over-budget BATCH is ONE record; no sub-command may execute (got ' +
                JSON.stringify(actions.map(a => a.action)) + ')')
            assert.strictEqual(actions[0].action, 'BATCH')
            assert.strictEqual((await issueStatusesForTx(result.txHash)).length, 0, 'no issue row')
        })
    })

    describe('A3: the per-action DEPLOY cap survives beside the weight', function () {

        it('admits ONE DEPLOY (weight 30, far under budget)', async function () {
            const addr = await cryptoHelper.getNewFundedAddress("BCW.A3.ONE", COIN, NETWORK, null, "legacy", 0, 1)
            await gasHelper.ensureGasBalance(addr, '100')

            const result = await batchHelper.sendBatch(addr, [ deployCmd(CONTRACT, 200000) ],
                { status: 'valid', timeout: 180000 })
            assert(result.batch, 'a batch carrying one DEPLOY must be valid')
            assert.strictEqual(result.batch.status, 'valid')
            await log('A3 one-deploy', result)

            const actions = await waitForActionCount(result.txHash, 2)
            assert.strictEqual(actions.length, 2, 'expected 1 BATCH + 1 DEPLOY action row')
            assert(actions.some(a => a.action === 'DEPLOY'), 'the DEPLOY sub-command must have run')
        })

        it('rejects TWO DEPLOYs with invalid: DEPLOY (limit), not the budget', async function () {
            const addr = await cryptoHelper.getNewFundedAddress("BCW.A3.TWO", COIN, NETWORK, null, "legacy", 0, 1)
            await gasHelper.ensureGasBalance(addr, '100')

            // Two DEPLOYs weigh 60 and count 2, so neither the budget nor the count cap can
            // explain this rejection: only the per-action cap of 1 can.
            const result = await batchHelper.sendBatch(addr,
                [ deployCmd(CONTRACT, 200000), deployCmd(CONTRACT, 200000) ],
                { status: 'invalid: DEPLOY (limit)', timeout: 180000 })
            assert(result.batch, 'two DEPLOYs must whole-batch reject')
            assert.strictEqual(result.batch.status, 'invalid: DEPLOY (limit)',
                'the per-action cap string must be unchanged by the weight table')
            await log('A3 two-deploys', result)

            const actions = await actionsForTx(result.txHash)
            assert.strictEqual(actions.length, 1,
                'a capped BATCH is ONE record (got ' + JSON.stringify(actions.map(a => a.action)) + ')')
            assert.strictEqual(actions[0].action, 'BATCH')
            assert.strictEqual((await contractsForTx(result.txHash)).length, 0, 'no contract row')
        })
    })

    describe('A4: EXECUTE weighs ' + VM_WEIGHT, function () {

        let deployer = null
        let contractIndex = null

        before(async function () {
            deployer = await cryptoHelper.getNewFundedAddress("BCW.A4", COIN, NETWORK, null, "legacy", 0, 1)
            await gasHelper.ensureGasBalance(deployer, '500')
            const deploy = await vmHelper.sendDeployV0(deployer, CONTRACT, 200000, 'init')
            assert(deploy.contract, 'the A4 contract must deploy')
            contractIndex = deploy.contract.action_index
            console.log('A4 contract action_index=' + contractIndex + ' txHash=' + deploy.txHash)
        })

        it('accepts ' + VM_AT_BUDGET + ' EXECUTEs (weight ' + (VM_AT_BUDGET * VM_WEIGHT) + ')', async function () {
            const commands = []
            for (let n = 0; n < VM_AT_BUDGET; n++) commands.push(executeCmd(contractIndex, 'bump'))

            const result = await batchHelper.sendBatch(deployer, commands, { status: 'valid', timeout: 240000 })
            assert(result.batch, VM_AT_BUDGET + ' EXECUTEs must be inside the budget')
            assert.strictEqual(result.batch.status, 'valid')
            await log('A4 at-budget', result)

            const actions = await waitForActionCount(result.txHash, VM_AT_BUDGET + 1)
            assert.strictEqual(actions.length, VM_AT_BUDGET + 1,
                'expected 1 BATCH + ' + VM_AT_BUDGET + ' EXECUTE action rows, got ' + actions.length)

            const executions = await executionStatusesForTx(result.txHash)
            assert.strictEqual(executions.length, VM_AT_BUDGET,
                'expected ' + VM_AT_BUDGET + ' execution rows, got ' + executions.length)
            assert.deepStrictEqual(
                executions.filter(r => r.status !== 'valid').map(r => r.action_index + ' -> ' + r.status), [],
                'every EXECUTE in an at-budget batch must run')
            console.log('A4 at-budget ran ' + executions.length + ' executions in block ' + actions[0].block_index)
        })

        it('rejects ' + VM_OVER_BUDGET + ' EXECUTEs as ONE invalid record', async function () {
            const commands = []
            for (let n = 0; n < VM_OVER_BUDGET; n++) commands.push(executeCmd(contractIndex, 'bump'))

            const result = await batchHelper.sendBatch(deployer, commands,
                { status: 'invalid: COMMAND (limit)', timeout: 240000 })
            assert(result.batch, VM_OVER_BUDGET + ' EXECUTEs must exceed the budget')
            assert.strictEqual(result.batch.status, 'invalid: COMMAND (limit)')
            await log('A4 over-budget', result)

            const actions = await actionsForTx(result.txHash)
            assert.strictEqual(actions.length, 1,
                'the whole batch is ONE record, not ' + VM_OVER_BUDGET + ' rejected EXECUTEs (got ' +
                JSON.stringify(actions.map(a => a.action)) + ')')
            assert.strictEqual(actions[0].action, 'BATCH')
            assert.strictEqual((await executionStatusesForTx(result.txHash)).length, 0, 'no execution row')
        })

        it('control: ' + VM_OVER_BUDGET + ' ordinary sub-commands at the same count land', async function () {
            const addr    = await cryptoHelper.getNewFundedAddress("BCW.A4.CTL", COIN, NETWORK, null, "legacy", 0, 1)
            const address = addr["address"]
            const tick    = "BCWC" + address.substring(address.length - 8)
            const dest    = await cryptoHelper.getNewAddress("BCW.A4.CTL", COIN, NETWORK, null, "legacy", 1)

            await gasHelper.ensureGasBalance(addr, '100')
            await issueHelper.sendIssueV0(addr, tick, 1000, 1000, 0, "A4 control", 1000)

            const commands = []
            for (let n = 0; n < VM_OVER_BUDGET; n++) commands.push(sendCmd(tick, 1, dest["address"]))

            const result = await batchHelper.sendBatch(addr, commands, { status: 'valid', timeout: 180000 })
            assert(result.batch,
                VM_OVER_BUDGET + ' weight-1 sub-commands must land; only EXECUTE\'s weight refuses the batch above')
            assert.strictEqual(result.batch.status, 'valid')
            await log('A4 control', result)
        })
    })

    describe('A5: AIRDROP consumes its declared fan-out weight of ' + FANOUT_WEIGHT, function () {

        let dropper = null
        let tick = null
        let listActionIndex = null

        before(async function () {
            dropper = await cryptoHelper.getNewFundedAddress("BCW.A5", COIN, NETWORK, null, "legacy", 0, 1)
            const address = dropper["address"]
            tick = "BCWD" + address.substring(address.length - 8)

            await gasHelper.ensureGasBalance(dropper, '500')
            await issueHelper.sendIssueV0(dropper, tick, 100000, 100000, 0, "A5 fan-out token", 100000)

            const r1 = await cryptoHelper.getNewAddress("BCW.A5", COIN, NETWORK, null, "legacy", 1)
            const r2 = await cryptoHelper.getNewAddress("BCW.A5", COIN, NETWORK, null, "legacy", 2)
            const r3 = await cryptoHelper.getNewAddress("BCW.A5", COIN, NETWORK, null, "legacy", 3)
            const list = await listHelper.sendListV0(dropper, 2, [r1["address"], r2["address"], r3["address"]])
            assert(list.list, 'the A5 recipient list must exist')
            listActionIndex = Number(list.list["action_index"])
            console.log('A5 list action_index=' + listActionIndex + ' recipients=3')
        })

        it('accepts ' + FANOUT_AT_BUDGET + ' AIRDROPs (weight ' + (FANOUT_AT_BUDGET * FANOUT_WEIGHT) + ', exactly the budget)', async function () {
            const commands = []
            for (let n = 0; n < FANOUT_AT_BUDGET; n++)
                commands.push(airdropCmd(tick, 1, listActionIndex, "d" + n))

            const result = await batchHelper.sendBatch(dropper, commands, { status: 'valid', timeout: 240000 })
            assert(result.batch, FANOUT_AT_BUDGET + ' AIRDROPs weigh exactly the budget and must be admitted')
            assert.strictEqual(result.batch.status, 'valid')
            await log('A5 at-budget', result)

            const actions = await waitForActionCount(result.txHash, FANOUT_AT_BUDGET + 1)
            assert.strictEqual(actions.length, FANOUT_AT_BUDGET + 1,
                'expected 1 BATCH + ' + FANOUT_AT_BUDGET + ' AIRDROP action rows, got ' + actions.length)

            const airdrops = await airdropStatusesForTx(result.txHash)
            assert.strictEqual(airdrops.length, FANOUT_AT_BUDGET,
                'expected ' + FANOUT_AT_BUDGET + ' airdrop rows, got ' + airdrops.length)
            assert.deepStrictEqual(
                airdrops.filter(r => r.status !== 'valid').map(r => r.action_index + ' -> ' + r.status), [],
                'every AIRDROP in an at-budget batch must land')
            console.log('A5 at-budget landed ' + airdrops.length + ' airdrops in block ' + actions[0].block_index)
        })

        it('rejects ' + FANOUT_OVER_BUDGET + ' AIRDROPs as ONE invalid record', async function () {
            const commands = []
            for (let n = 0; n < FANOUT_OVER_BUDGET; n++)
                commands.push(airdropCmd(tick, 1, listActionIndex, "e" + n))

            const result = await batchHelper.sendBatch(dropper, commands,
                { status: 'invalid: COMMAND (limit)', timeout: 240000 })
            assert(result.batch, FANOUT_OVER_BUDGET + ' AIRDROPs exceed the budget on fan-out weight alone')
            assert.strictEqual(result.batch.status, 'invalid: COMMAND (limit)')
            await log('A5 over-budget', result)

            const actions = await actionsForTx(result.txHash)
            assert.strictEqual(actions.length, 1,
                'the whole batch is ONE record, not ' + FANOUT_OVER_BUDGET + ' rejected AIRDROPs (got ' +
                JSON.stringify(actions.map(a => a.action)) + ')')
            assert.strictEqual(actions[0].action, 'BATCH')
            assert.strictEqual((await airdropStatusesForTx(result.txHash)).length, 0, 'no airdrop row')
        })

        it('control: ' + FANOUT_OVER_BUDGET + ' ordinary sub-commands at the same count land', async function () {
            const dest = await cryptoHelper.getNewAddress("BCW.A5", COIN, NETWORK, null, "legacy", 4)

            const commands = []
            for (let n = 0; n < FANOUT_OVER_BUDGET; n++) commands.push(sendCmd(tick, 1, dest["address"]))

            const result = await batchHelper.sendBatch(dropper, commands, { status: 'valid', timeout: 180000 })
            assert(result.batch,
                FANOUT_OVER_BUDGET + ' weight-1 sub-commands must land; only AIRDROP\'s fan-out weight refuses the batch above')
            assert.strictEqual(result.batch.status, 'valid')
            await log('A5 control', result)
        })
    })
})
