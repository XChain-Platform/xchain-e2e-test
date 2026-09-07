// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// Three chained MINTs from ONE address must be three DISTINCT
// transactions and three balance increments.
//
// The defect this pins against was measured live on BTC testnet4, 2026-08-27.
// Three MINTs fired about a second apart from one validator address: the first
// built and broadcast, and the second was handed the SAME input again by the
// utxo-tracker, which had not yet seen the spend. The encoder reserved outpoints
// only for sets it fetched from the tracker itself, and the SDK fetches the
// funding set and passes it as `utxos`, so the mainstream wallet path reserved
// nothing. It rebuilt a byte-identical transaction with the same txid, the
// caller journalled that as a second success, and the third ran dry.
//
// So the assertion is not "three MINTs succeeded". It is that the three txids
// are DISTINCT and the balance moved three times. A duplicate build passes a
// naive success count and fails both of those.

const assert = require('assert')
const bitcoin = require('bitcoinjs-lib')
const cryptoHelper = require('../cryptoHelper')
const mintHelper = require('../helpers/mintHelper')

const GAS_TICK = "XCHAIN"
const MINT_AMOUNT = 100
const CHAIN_LENGTH = 3

describe('MINT chaining', () => {
    it('three chained MINTs from one address are three distinct txids and three balance increments', async () => {
        // seedGas=false: the gas seed is itself a MINT, and it would put a
        // credit on the address before the chain under test starts. Starting at
        // zero makes each increment below attributable to one of these three.
        // XCHAIN is an open mint on the test networks, so a zero-gas address can
        // still mint it.
        const sender = await cryptoHelper.getNewFundedAddress(
            'XC1796.CHAIN', COIN, NETWORK, null, 'legacy', 0, 1, false
        )

        const opening = await indexerDatabase.getBalance({ address: sender.address, tick: GAS_TICK })
        assert.strictEqual(opening, "0", 'the drill needs a zero opening balance to attribute each increment')

        const txids = []
        const balances = [BigInt(opening)]

        for (let i = 1; i <= CHAIN_LENGTH; i++){
            // No settle delay between iterations. sendMintV0 waits for the MINT
            // row AND the credit row, so each send starts from a view that has
            // the previous spend in it - which is exactly the chained-send shape,
            // and the one the encoder has to keep distinct.
            const result = await mintHelper.sendMintV0(sender, GAS_TICK, MINT_AMOUNT, sender.address, 'mint chain ' + i)
            assert(result.mint, 'MINT ' + i + ' should exist in the DB')
            assert(result.credit, 'MINT ' + i + ' credit should exist in the DB')

            txids.push(result.txHash)

            const settled = await indexerDatabase.getBalance({ address: sender.address, tick: GAS_TICK })
            assert(settled != null, 'balance read after MINT ' + i + ' failed')
            balances.push(BigInt(settled))
        }

        // Three DISTINCT txids. A Set, not a pairwise compare, so a three-way
        // repeat cannot slip through on an off-by-one.
        assert.strictEqual(new Set(txids).size, CHAIN_LENGTH,
            'the three chained MINTs must be three distinct transactions, got: ' + txids.join(', '))

        // Three increments, all positive and all equal. The expected size is the
        // FIRST increment, not MINT_AMOUNT: the ledger stores base units and the
        // wire amount is a display amount, so hard-coding the wire figure here
        // would pin the ticker's decimals rather than the chaining behaviour.
        // A duplicate broadcast leaves one of these flat even when the txid it
        // reported looked fine, which is the shape being pinned.
        const deltas = []
        for (let i = 1; i <= CHAIN_LENGTH; i++) deltas.push(balances[i] - balances[i - 1])
        assert(deltas[0] > 0n, 'the first MINT must move the balance, moved ' + deltas[0])
        for (let i = 0; i < CHAIN_LENGTH; i++){
            assert.strictEqual(deltas[i], deltas[0],
                'MINT ' + (i + 1) + ' must move the balance by the same ' + deltas[0] +
                ' the first one did, moved ' + deltas[i] + ' (deltas: ' + deltas.join(', ') + ')')
        }
    })

    // The case above chains on CONFIRMED state, which is what the platform's own
    // driver does, and on that path even a broken encoder looks fine. This one
    // reproduces the window the defect actually lived in: the caller re-supplies
    // the tracker's view before the tracker has retired the spent input, which is
    // what every rapid chained send does.
    //
    // The contract is NOT "the second build succeeds". It is that two build calls
    // never hand back the SAME transaction as two separate successes. Refusing the
    // second is a correct outcome; returning a duplicate txid is not, because the
    // caller journals it as a second MINT that never happened.
    it('a rapid re-send over a stale view is never handed back as a second identical transaction', async () => {
        const sender = await cryptoHelper.getNewFundedAddress(
            'XC1796.RAPID', COIN, NETWORK, null, 'legacy', 0, 1, false
        )

        // One snapshot, read once and reused: this IS the stale view. Re-reading
        // per attempt would sometimes get a fresh one and make the test flaky
        // about the very window it exists to cover.
        const trackerView = await utxoTrackerConnector.getUtxosFromAddress(sender.address)
        const staleView = (trackerView && trackerView.utxos) || []
        assert(staleView.length > 0,
            'the funded address must have at least one UTXO in the tracker view')

        const action = 'MINT|0|' + GAS_TICK + '|' + MINT_AMOUNT + '|' + sender.address + '|mint rapid'
        const builtTxids = []
        const refusals = []

        for (let i = 1; i <= CHAIN_LENGTH; i++){
            let result = null
            try {
                result = await encoderConnector.createTx(
                    staleView, sender.address, null, action, null, null, false, null,
                    sender.address, null, null, null, true
                )
            } catch (err){
                // A refusal is a pass for this contract: the caller was told the
                // input is spoken for instead of being handed a repeat.
                refusals.push(err.message)
                continue
            }
            const psbt = bitcoin.Psbt.fromHex(result.psbt, { network: NETWORK_OBJECT })
            builtTxids.push(
                bitcoin.Transaction.fromBuffer(psbt.data.globalMap.unsignedTx.toBuffer()).getId()
            )
        }

        assert(builtTxids.length > 0 || refusals.length > 0, 'the drill built nothing and refused nothing')
        assert.strictEqual(new Set(builtTxids).size, builtTxids.length,
            'the encoder handed back the SAME transaction twice as two separate builds: ' +
            builtTxids.join(', ') + (refusals.length ? ' | refusals: ' + refusals.join(' ; ') : ''))
    })
})
