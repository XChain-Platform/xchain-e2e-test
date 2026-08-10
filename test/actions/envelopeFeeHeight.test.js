/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available:
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * TAPROOT ENVELOPE FEE LIFECYCLE ( §3.5)
 * spec: claude/specs/resolved/taproot-envelope-and-payload-compression.md
 *
 * §3.5 makes two claims about money that no other envelope test can reach:
 *
 *   "Native fee-destination outputs ride the COMMIT transaction, mirroring the
 *    funding transaction's role in the chunk lanes; the decoder's funding-fee
 *    resolver extends to the commit."
 *   "Fee sufficiency is evaluated against the requirement in force at the
 *    REVEAL's block height, using the outputs recorded on the commit."
 *
 * Every other envelope test carries a FILE, and FILE is exactly the action that
 * cannot exercise this: it has no protocol fee of any kind (§5.6), so its fee
 * verdict is trivially satisfied and would pass with the resolver removed. This
 * file carries a fee-bearing ISSUE instead, from an address holding NO gas, so
 * the only way the action can be valid is for the indexer to have found a fee
 * output that is not on the transaction it is grading. It is on the commit,
 * seven blocks back.
 *
 * The negative is what stops the positive being vacuous: the same ISSUE with a
 * commit carrying no fee output must be REJECTED. Together they say the fee check
 * is live on this lane and reaches exactly where §3.5 says it reaches.
 *
 * The one-off that first proved this (claude/bin/xc990-s4-e2e.js --scenarios
 * feeheight) read the decoder's own transaction_outputs table on a throwaway
 * venue. This asserts the same rule one layer out, through the indexer's verdict
 * and its fees row, which is where a regression would actually hurt.
 *
 * BTC and LTC only: DOGE has no segwit, so there is no envelope to fund.
 ********************************************************************/

const assert = require('assert')
const cryptoHelper = require('../cryptoHelper')
const nativeFeeHelper = require('../helpers/nativeFeeHelper')
const envelopeHelper = require('../helpers/envelopeHelper')
const priceSnapshotHelper = require('../helpers/priceSnapshotHelper')
const { NO_PRICE_SEED } = require('../helpers/xchainPriceConstants')

// The synthetic round that carries the mid-flight requirement change. Registered
// in SEED_SENTINEL_ROUNDS so clearSeedSentinels can retract it: a seeded round
// outranks every derived one, so an unretractable seed shadows a real hub forever.
const FEE_SPIKE_ROUND = 999400002

// A coin worth a hundredth of what it was worth when the commit was funded. The
// protocol fee is USD-pegged, so the same action now costs a hundred times more
// coin, and the fee output the commit already paid no longer covers it. Chosen to
// move the requirement for a 1-XCHAIN ISSUE from ~1,900 sats to ~190,000, either
// side of the 50,000-sat output the commit carries.
const CHEAP_COIN_USD = '1000.00000000'

// Blocks between the commit and the reveal. Well past any confirmation the
// indexer might coincidentally still have in hand, which is the point: the fee
// outputs have to be resolved from a transaction that is old news by then.
const GAP_BLOCKS = 6

let FEE_DEST = null

async function q(sql, params){
    const conn = await indexerDatabase.getConnection()
    try { return await conn.query(sql, params) }
    finally { await conn.release() }
}
async function sleep(ms){ return new Promise(r => setTimeout(r, ms)) }

// The action row for a transaction, whatever its verdict. waitForIssue only
// resolves for a status you already predicted, and half of this file is about
// reading a verdict rather than confirming a guess. The verdict lives on the
// per-action table (`actions` itself carries no status), so it comes from
// `issues` here, resolved through the status lookup the suite's own reader uses.
async function actionRowsFor(txHash){
    return await q(
        `SELECT a.action_index, a.block_index, ist.status AS status
           FROM actions a
           JOIN transactions t         ON t.tx_index = a.tx_index
           JOIN index_transactions it  ON it.id = t.tx_hash_id
           LEFT JOIN issues i          ON i.action_index = a.action_index
           LEFT JOIN index_statuses ist ON ist.id = i.status_id
          WHERE it.hash = ?
          ORDER BY a.action_index ASC`, [txHash])
}

// Generous by design. This drill deliberately spends BLOCKS, and an indexer that
// takes tens of seconds per block on a state-heavy venue is slow rather than
// broken; a short budget here would turn venue speed into a false red.
async function waitForActionRow(txHash, timeoutMs = 600000){
    const deadline = Date.now() + timeoutMs
    let rows = []
    while (Date.now() < deadline){
        rows = await actionRowsFor(txHash)
        if (rows.length) return rows
        await sleep(2000)
    }
    return rows
}

async function feeRowFor(txHash){
    const rows = await q(
        `SELECT f.payment_mode, f.native_coin, f.native_coin_amount, f.oracle_round
           FROM fees f
           JOIN actions a              ON a.action_index = f.action_index
           JOIN transactions t         ON t.tx_index = a.tx_index
           JOIN index_transactions it  ON it.id = t.tx_hash_id
          WHERE it.hash = ? LIMIT 1`, [txHash])
    return rows && rows[0] ? rows[0] : null
}

function issueAction(tick){
    return 'ISSUE|0|' + tick + '|1000|1000|0| envelope fee lifecycle|1000||||||||||||||||||'
}

function freshTick(prefix, address){
    return (prefix + address.substring(address.length - 8)).toUpperCase().slice(0, 12)
}

// Publish a pre-built pair with a deliberate gap between the halves, and return
// the reveal's height. Mining is not paused: nothing here depends on which block
// a half lands in, only on the distance between them.
async function publishSplit(pair){
    await nodeConnector.broadcastTx(pair.commitHex)
    await regtestMinerConnector.generateBlocks(1)
    const commitHeight = await nodeConnector.getBlockCount()

    await regtestMinerConnector.generateBlocks(GAP_BLOCKS)

    await nodeConnector.broadcastTx(pair.revealHex)
    await regtestMinerConnector.generateBlocks(1)
    const revealHeight = await nodeConnector.getBlockCount()

    assert(revealHeight - commitHeight >= GAP_BLOCKS,
        'the reveal must land well after the commit (' + commitHeight + ' -> ' + revealHeight + ')')
    // Deliberately NOT gated on indexer-tip == node-tip: the venue miner keeps
    // mining underneath, so on a busy stack that equality can stay false forever
    // while the indexer is perfectly healthy. Both cases here assert the PRESENCE
    // of an action row (a rejected action still gets one), so waiting for the row
    // itself is the readiness check, and it is a tighter one: the row cannot exist
    // until the reveal's block is indexed.
    return { commitHeight, revealHeight }
}

describe('Taproot Envelope fee lifecycle across a block gap ( §3.5)', function () {
    this.timeout(0)

    before(async function (){
        if (!envelopeHelper.envelopeSupported()) this.skip()   // no segwit, no envelope

        // The fee destination has to be the one the decoder and indexer were
        // configured with, so it is discovered rather than assumed.
        const mode = await nativeFeeHelper.discoverFeeMode()
        if (!mode.enabled) this.skip()                          // a gas-only venue cannot carry this
        assert(mode.destination, 'native fees enabled but no FEE_DESTINATION resolvable')
        FEE_DEST = mode.destination
    })

    it('pays a fee-bearing action from an output on the COMMIT, ' + GAP_BLOCKS + ' blocks before the reveal', async function () {
        // seedGas=false: with no XCHAIN balance there is no second way to pay. If
        // the indexer cannot see the commit's fee output, this ISSUE is invalid.
        const addr = await cryptoHelper.getNewFundedAddress('ENVELOPE.FEEHEIGHT', COIN, NETWORK, null, 'segwit', 0, 1, false)
        const tick = freshTick('EFH', addr['address'])

        const pair = await envelopeHelper.buildEnvelopePair(addr, {
            action: issueAction(tick),
            rawData: null,
            customOutputs: [{ address: FEE_DEST, value: nativeFeeHelper.FLAT_FEE_SATS }]
        })

        // The fee leg is on the commit and nowhere else. Asserted on the signed
        // transactions themselves, before either is broadcast, because this is the
        // structural claim the rest of the test depends on.
        const feeScript = require('bitcoinjs-lib').address.toOutputScript(FEE_DEST, NETWORK_OBJECT)
        const onCommit = pair.commitTx.outs.filter(o => o.script.equals(feeScript))
        const onReveal = pair.revealTx.outs.filter(o => o.script.equals(feeScript))
        assert.strictEqual(onCommit.length, 1, 'the native fee output must ride the COMMIT (§3.5)')
        assert.strictEqual(Number(onCommit[0].value), nativeFeeHelper.FLAT_FEE_SATS)
        assert.strictEqual(onReveal.length, 0,
            'the reveal must carry no fee output: if it did, this test would prove nothing about the commit')

        const { commitHeight, revealHeight } = await publishSplit(pair)
        console.log('   commit at', commitHeight, '- reveal at', revealHeight)

        const rows = await waitForActionRow(pair.revealTxid)
        assert.strictEqual(rows.length, 1, 'the envelope-carried ISSUE should index exactly once')
        assert.strictEqual(Number(rows[0].block_index), revealHeight,
            'the action belongs to the REVEAL block: that is the height its fee is graded at (§3.5)')
        assert.strictEqual(rows[0].status, 'valid',
            'the ISSUE must be VALID, which is only possible if the fee was resolved from the commit ' +
            GAP_BLOCKS + ' blocks back (status was "' + rows[0].status + '")')

        // The fee row is where the resolution is recorded, so it is the difference
        // between "valid for the right reason" and "valid by accident".
        const fee = await feeRowFor(pair.revealTxid)
        assert(fee, 'a fee row should exist for the envelope-carried action')
        assert.strictEqual(Number(fee.payment_mode), 1, 'the fee must be recorded as native-coin (payment_mode 1)')
        assert.strictEqual(fee.native_coin, COIN_CODE)
        assert(fee.native_coin_amount, 'the native amount taken from the commit output must be recorded')
        console.log('   fee row:', JSON.stringify(fee, (k, v) => typeof v === 'bigint' ? Number(v) : v))
    })

    it('rejects the same action when the commit carries no fee output', async function () {
        // Same shape, same gap, one thing removed. Without this the case above
        // could pass with the fee check skipped entirely on this lane.
        const addr = await cryptoHelper.getNewFundedAddress('ENVELOPE.FEEHEIGHT.NEG', COIN, NETWORK, null, 'segwit', 0, 1, false)
        const tick = freshTick('EFN', addr['address'])

        const pair = await envelopeHelper.buildEnvelopePair(addr, {
            action: issueAction(tick),
            rawData: null,
            customOutputs: []          // deliberately none, on either half
        })

        const feeScript = require('bitcoinjs-lib').address.toOutputScript(FEE_DEST, NETWORK_OBJECT)
        assert.strictEqual(pair.commitTx.outs.filter(o => o.script.equals(feeScript)).length, 0,
            'this case requires a commit with no fee output')

        const { revealHeight } = await publishSplit(pair)

        const rows = await waitForActionRow(pair.revealTxid)
        assert.strictEqual(rows.length, 1, 'the action should still be indexed, as invalid')
        assert.strictEqual(Number(rows[0].block_index), revealHeight)
        // The rejection differs by chain: a native-fee chain says the output is
        // required, a gas chain falls back to an XCHAIN balance this address does
        // not have. Either way the action must not be valid.
        assert(/^invalid/.test(rows[0].status),
            'an ISSUE whose commit funds no fee must be rejected, not indexed valid (status was "' + rows[0].status + '")')
        assert(/fee|funds/i.test(rows[0].status),
            'the rejection should name the fee, not fail for an unrelated reason: ' + rows[0].status)
        console.log('   correctly rejected:', rows[0].status)
    })

    it('grades the fee against the requirement in force at the REVEAL height, not the commit height', async function () {
        // §9.2's last regtest bullet, and the sharpest form of the §3.5 rule: the
        // fee outputs are recorded on the commit, but WHAT THEY MUST COVER is
        // decided at the reveal's block. The first case here already showed a
        // commit-funded fee accepted across a gap; this one moves the requirement
        // underneath a commit that is already confirmed and unchangeable.
        //
        // Skipped on a venue whose hub publishes prices: seeding there would shadow
        // every derived round rather than simulate anything.
        if (NO_PRICE_SEED) this.skip()

        const addr = await cryptoHelper.getNewFundedAddress('ENVELOPE.FEESPIKE', COIN, NETWORK, null, 'segwit', 0, 1, false)
        const tick = freshTick('EFS', addr['address'])

        // The very same fee output the accepted case used. Nothing about this pair
        // is different; only the world it reveals into is.
        const pair = await envelopeHelper.buildEnvelopePair(addr, {
            action: issueAction(tick),
            rawData: null,
            customOutputs: [{ address: FEE_DEST, value: nativeFeeHelper.FLAT_FEE_SATS }]
        })

        let commitHeight = null
        try {
            await nodeConnector.broadcastTx(pair.commitHex)
            await regtestMinerConnector.generateBlocks(1)
            commitHeight = await nodeConnector.getBlockCount()

            // ── the requirement moves, between the two halves ────────────────────
            // Seeded as an ADDITIONAL row at a higher round rather than a replacement:
            // getLatestPrice takes the highest round a block may see, so this is a new
            // quote arriving, which is what a real price move looks like.
            const chainTime = await priceSnapshotHelper.latestBlockTime()
            const anchor = Math.max(chainTime, Math.floor(Date.now() / 1000)) - 60
            await priceSnapshotHelper.seedSnapshot({
                coinPair: COIN_CODE + '/USD',
                price: CHEAP_COIN_USD,
                blockTimestamp: anchor,
                roundNumber: FEE_SPIKE_ROUND,
                referenceBlock: commitHeight
            })
            console.log('   requirement raised after the commit at', commitHeight,
                        '(' + COIN_CODE + '/USD ->', CHEAP_COIN_USD + ')')

            await regtestMinerConnector.generateBlocks(GAP_BLOCKS)
            await nodeConnector.broadcastTx(pair.revealHex)
            await regtestMinerConnector.generateBlocks(1)
            const revealHeight = await nodeConnector.getBlockCount()
            assert(revealHeight - commitHeight >= GAP_BLOCKS, 'the reveal must land well after the commit')

            const rows = await waitForActionRow(pair.revealTxid)
            assert.strictEqual(rows.length, 1, 'the action should be indexed, as invalid')
            assert.strictEqual(Number(rows[0].block_index), revealHeight)
            assert(/^invalid/.test(rows[0].status),
                'the fee was sufficient at the commit height and is not at the reveal height, so the ' +
                'action must be REJECTED; indexing it valid would mean the commit height decided it ' +
                '(status was "' + rows[0].status + '")')
            assert(/fee|funds/i.test(rows[0].status),
                'the rejection should name the fee: ' + rows[0].status)
            console.log('   correctly rejected at the reveal height:', rows[0].status)
        } finally {
            // Restore the venue's standing prices. Deliberately after the verdict is
            // read, never before: the indexer grades a block when it reaches it, so
            // restoring early would let the reveal be graded against the old, cheaper
            // requirement and the case would pass or fail on indexer speed.
            await nativeFeeHelper.seedGlobalPrices(true)
        }
    })
})
