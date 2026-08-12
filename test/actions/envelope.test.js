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
// TAPROOT ENVELOPE + PAYLOAD COMPRESSION
//
// The envelope was proven end to end during the build (BTC and LTC regtest,
// testnet4, mainnet arming) by one-off scripts run during development. Those
// scripts prove a moment; this file is the standing regression, so a later change to the
// encoder, the decoder's recognition rules or the explorer's serve path cannot
// quietly un-prove it.
//
// Each scenario names the spec section it holds down, because the interesting
// assertions here are not "it worked" but "it worked the specced way": the pair
// is joined, the grammar is the frozen one, the source is the commit funder and
// not the one-time P2TR address, and the bytes on chain are smaller than the
// bytes the user handed us.

const assert = require('assert')
const cryptoHelper = require('../cryptoHelper')
const transactionHelper = require('../transactionHelper')
const envelopeHelper = require('../helpers/envelopeHelper')

// Compressible, and big enough that the legacy lane would need a fan of chunk
// outputs to carry it (476 data bytes per P2WSH chunk).
const TEXT_BODY = Buffer.from(
    ('XChain Taproot envelope regression. One tapscript reveal carries the whole payload, ' +
     'and the payload is stored deflate-compressed. ').repeat(60)
)

// Incompressible by construction: a deterministic keystream, so the run is
// reproducible while deflate can find nothing to remove. Larger than one 520-byte
// script element so the envelope has to chunk its pushes.
function incompressibleBody(bytes){
    const crypto = require('crypto')
    const out = []
    let block = Buffer.from('envelope-incompressible-seed')
    while (out.reduce((n, b) => n + b.length, 0) < bytes){
        block = crypto.createHash('sha256').update(block).digest()
        out.push(block)
    }
    return Buffer.concat(out).subarray(0, bytes)
}

describe('TAPROOT ENVELOPE', () => {
    // BTC and LTC have Taproot; DOGE has no segwit at all, so the envelope is
    // unavailable there by network definition rather than by policy (§3.6).
    before(function(){ if (!envelopeHelper.envelopeSupported()) this.skip() })

    describe('a compressed FILE in one commit/reveal pair', () => {
        let addr = null
        let sent = null
        let onChain = null

        // Published once; the assertions below all read that one publication, so a
        // failure names the property that broke rather than re-running the chain work.
        before(async function(){
            // The commit's inputs must be segwit (§3.5), which is why this is the
            // only action test in the suite that does not fund a legacy address.
            addr = await cryptoHelper.getNewFundedAddress("ENVELOPE.FILE", COIN, NETWORK, null, "segwit", 0, 1)

            // The suite mines one second after a transaction arrives, which would make
            // the same-block assertion below a one-second race rather than a test. Widen
            // the window for this pair only: both halves are broadcast back to back, so
            // thirty seconds is a margin, not a wait.
            await regtestMinerConnector.setMiningTime(30000, 30000)
            try {
                sent = await envelopeHelper.sendFileViaEnvelope(addr, {
                    name: "envelope-test.txt",
                    type: "text/plain",
                    title: "Envelope FILE",
                    memo: "carried by one tapscript reveal",
                    rawData: TEXT_BODY,
                    compress: true
                })
            } finally {
                await regtestMinerConnector.setMiningTime(1000, 1000)   // back to the suite's cadence
            }
        })

        it('publishes and indexes the action', () => {
            assert(sent.file, "the envelope-carried FILE should be indexed")
            assert.strictEqual(sent.capture.encoding, "TAPROOT",
                "the encoder should have built the envelope, not fallen back to a chunk lane")
        })

        it('attributes the action to the commit funder, not the one-time commit address (§3.4)', () => {
            // The reveal's ins[0] is the commit output: a payload-dependent P2TR
            // address nothing else references. Attributing to it would break
            // ownership, GATE_MIN_AMOUNT holdings and fee attribution on every
            // envelope action ever published.
            assert.strictEqual(sent.file.source, addr["address"])
            assert.notStrictEqual(sent.file.source, sent.capture.envelope.commitAddress)
        })

        it('identifies the action by the REVEAL transaction (§3.1)', async () => {
            assert.strictEqual(sent.txHash, sent.capture.revealTxHash)
            assert.notStrictEqual(sent.capture.revealTxHash, sent.capture.fundingTxHash)

            const reveal = await nodeConnector.getTransaction(sent.capture.revealTxHash)
            assert(reveal && reveal.blockhash, "the reveal should be confirmed")
            assert.strictEqual(reveal.vin[0].txid, sent.capture.fundingTxHash,
                "reveal input 0 must be the commit outpoint (§3.5)")
        })

        it('confirms commit and reveal in the SAME block (§3.7)', async () => {
            // The decoder must not assume a confirmation gap. Both halves are
            // broadcast back to back, so the venue miner sweeps them together; a
            // failure here means the decoder was only ever exercised on split pairs.
            const commit = await nodeConnector.getTransaction(sent.capture.fundingTxHash)
            const reveal = await nodeConnector.getTransaction(sent.capture.revealTxHash)
            assert.strictEqual(commit.blockhash, reveal.blockhash,
                "the pair should share a block; a split pair means this scenario stopped covering §3.7")
        })

        it('carries the frozen §3.2 grammar in the witness', async () => {
            onChain = await envelopeHelper.readEnvelopeFromChain(sent.capture.revealTxHash)

            assert.strictEqual(onChain.witnessLength, 3,
                "witness should be [signature, envelope script, control block]")
            assert.strictEqual(onChain.controlBlockLength, 33,
                "single-leaf tree: 33-byte control block, no merkle path")
            assert(onChain.grammarOk,
                "OP_FALSE OP_IF <XCHN> <0x00> ... OP_ENDIF")
            assert(onChain.terminated, "the envelope should be OP_ENDIF-terminated")
        })

        it('stores the payload deflated and inflates byte-exactly (§5.1, §5.2)', () => {
            assert.strictEqual(envelopeHelper.compressionFieldOf(onChain.actionString), "1",
                "COMPRESSION=1 should ride the action string in its eleventh field")
            assert.strictEqual(sent.capture.compression.compressed, true)
            assert(sent.capture.compression.storedLength < sent.capture.compression.rawLength,
                "the encoder keeps the compressed form only when it is smaller")

            const inflated = envelopeHelper.inflate(onChain.storedPayload)
            assert.strictEqual(envelopeHelper.sha256(inflated), envelopeHelper.sha256(TEXT_BODY),
                "the bytes on chain must inflate to the original, byte for byte")
            console.log("        " + onChain.storedPayload.length + " B on chain -> " +
                        TEXT_BODY.length + " B original (" +
                        (TEXT_BODY.length / onChain.storedPayload.length).toFixed(2) + "x)")
        })

        it('stays under the §4 payload ceiling and standardness weight', () => {
            assert(onChain.storedPayload.length < 390000,
                "payload must be under ENVELOPE_MAX_PAYLOAD")
            assert(onChain.weight < 400000,
                "the reveal must be under MAX_STANDARD_TX_WEIGHT or no node will relay it")
        })

        it('prefunds the reveal accurately from the commit (§3.5, §9.5)', () => {
            // The reveal's only input is the commit output, so the fee it actually paid
            // is exactly what the commit prefunded minus what the reveal emitted. That
            // number is the estimator's quote graded against the chain: quote too low
            // and the reveal is unrelayable with its fee already committed to a one-time
            // output, which is the failure §3.5's prefunding rule exists to prevent.
            const outputTotal = onChain.tx.outs.reduce((n, o) => n + o.value, 0)
            const actualFee = sent.capture.envelope.commitValue - outputTotal
            const quoted = sent.capture.envelope.revealFee

            assert(actualFee > 0, 'the reveal must pay a fee')
            assert(sent.capture.envelope.commitValue >= quoted,
                'the commit output must cover the quoted reveal fee')
            assert(Math.abs(actualFee - quoted) <= Math.max(10, quoted * 0.02),
                'quoted ' + quoted + ' sat vs actual ' + actualFee + ' sat: the estimator is pricing the reveal it actually built')
            console.log("        reveal fee quoted " + quoted + " sat, paid " + actualFee + " sat")
        })

        it('is served by the explorer as the ORIGINAL bytes (§5.5)', async () => {
            const served = await envelopeHelper.waitForServedFile(sent.file.action_index)

            assert.strictEqual(served.status, 200)
            assert.strictEqual(envelopeHelper.sha256(served.body), envelopeHelper.sha256(TEXT_BODY),
                "the explorer inflates transparently; the client sees the file it uploaded")
            assert.strictEqual(served.headers['x-xchain-compression'], 'deflate-raw')
            assert.strictEqual(Number(served.headers['x-xchain-stored-length']), onChain.storedPayload.length,
                "the stored-length header should report the real on-chain footprint")
            assert.strictEqual(served.headers['x-xchain-stored-form'], undefined,
                "no fail-closed fallback should have been taken on a valid stream")
        })
    })

    describe('an incompressible payload rides raw and chunks its pushes (§5.2, §3.2)', () => {
        it('keeps the raw form and splits the payload across 520-byte elements', async () => {
            const body = incompressibleBody(2000)
            const addr = await cryptoHelper.getNewFundedAddress("ENVELOPE.RAW", COIN, NETWORK, null, "segwit", 0, 1)

            const sent = await envelopeHelper.sendFileViaEnvelope(addr, {
                name: "envelope-incompressible.bin",
                type: "application/octet-stream",
                title: "Envelope raw payload",
                memo: "already-random bytes gain nothing from deflate",
                rawData: body,
                compress: true      // asked for, and correctly declined
            })

            assert(sent.file, "the raw-payload FILE should be indexed")
            assert.strictEqual(sent.capture.compression.compressed, false,
                "deflate cannot shrink random bytes, so the encoder must emit raw (keep-if-smaller)")
            assert(sent.capture.compression.reason,
                "the encoder should say WHY the bytes were not compressed")

            const onChain = await envelopeHelper.readEnvelopeFromChain(sent.capture.revealTxHash)
            assert.strictEqual(envelopeHelper.compressionFieldOf(onChain.actionString), "",
                "an uncompressed FILE carries no COMPRESSION field at all (stripped when empty)")
            assert(onChain.pushCount >= 2,
                "a 2,000-byte payload must span more than one 520-byte script element")
            assert.strictEqual(envelopeHelper.sha256(onChain.storedPayload), envelopeHelper.sha256(body),
                "the concatenated pushes must reassemble the payload exactly")

            const served = await envelopeHelper.waitForServedFile(sent.file.action_index)
            assert.strictEqual(served.status, 200)
            assert.strictEqual(envelopeHelper.sha256(served.body), envelopeHelper.sha256(body))
            assert.strictEqual(served.headers['x-xchain-compression'], undefined,
                "nothing to declare: the payload was never deflated")
        })
    })

    describe('parity with the shipped P2WSH chunk lane (§9.2)', () => {
        it('serves identical bytes for a smaller on-chain footprint', async () => {
            const addr = await cryptoHelper.getNewFundedAddress("ENVELOPE.PARITY", COIN, NETWORK, null, "segwit", 0, 2)

            const viaEnvelope = await envelopeHelper.sendFileViaEnvelope(addr, {
                name: "envelope-parity-envelope.txt",
                type: "text/plain",
                title: "Envelope parity via envelope",
                memo: "one reveal",
                rawData: TEXT_BODY,
                compress: true
            })

            // The same bytes down the lane the platform shipped before this work:
            // uncompressed, fanned across P2WSH chunk outputs.
            const parityCapture = {}
            const parityAction = "FILE|0|envelope-parity-p2wsh.txt|text/plain|Envelope parity via P2WSH|chunk lane"
            const parityTxHash = await transactionHelper.createAndSendTransaction(
                addr,
                parityAction,
                TEXT_BODY.toString('binary'),
                [],
                "P2WSH",
                null,
                false,
                { compress: false, capture: parityCapture }
            )
            const parityRow = await indexerDatabase.waitForFile({
                txHash: parityTxHash,
                source: addr["address"],
                name: "envelope-parity-p2wsh.txt",
                title: "Envelope parity via P2WSH",
                status: "valid"
            }, 180000)
            assert(parityRow, "the P2WSH-carried FILE should be indexed")

            const envelopeServed = await envelopeHelper.waitForServedFile(viaEnvelope.file.action_index)
            const parityServed = await envelopeHelper.waitForServedFile(parityRow.action_index)
            assert.strictEqual(envelopeHelper.sha256(envelopeServed.body), envelopeHelper.sha256(TEXT_BODY))
            assert.strictEqual(envelopeHelper.sha256(parityServed.body), envelopeHelper.sha256(envelopeServed.body),
                "both lanes must reproduce the same file, byte for byte")

            // §1's whole claim, measured rather than asserted from prose. Compared as
            // weight per ORIGINAL byte, which is what a user pays for: the envelope
            // wins on carrier efficiency and again on carrying fewer bytes at all.
            const envelopeWu = viaEnvelope.capture.revealWeight / TEXT_BODY.length
            const parityWu = parityCapture.revealWeight / TEXT_BODY.length
            console.log("        envelope " + envelopeWu.toFixed(3) + " WU/byte vs P2WSH " +
                        parityWu.toFixed(3) + " WU/byte")
            assert(envelopeWu < parityWu,
                "the envelope should cost less per payload byte than the chunk lane")
        })
    })
})

describe('PAYLOAD COMPRESSION WITHOUT THE ENVELOPE (Part B)', () => {
    // DOGE cannot take the envelope (no segwit), and compression is the half of
    // this work it CAN receive; §1 calls that out explicitly. The negative half of
    // the same story, that the encoder refuses to build an envelope there rather
    // than building one nothing would ever recognize, is asserted alongside it.
    before(function(){ if (global.COIN_CODE !== 'DOGE') this.skip() })

    it('refuses TAPROOT on a chain without segwit (§3.6)', async () => {
        const addr = await cryptoHelper.getNewFundedAddress("ENVELOPE.DOGE", COIN, NETWORK, null, "legacy", 0, 1)
        let threw = null
        try {
            await encoderConnector.createTx(
                [], addr["address"], [], "FILE|0|nope.txt|text/plain|no envelope here|refused",
                "hello", null, false, "TAPROOT", addr["address"], null, null,
                Buffer.from(addr["publicKey"]).toString('hex'), false, null
            )
        } catch (err){ threw = err }

        assert(threw, "the encoder must refuse to build an envelope on DOGE")
        assert(/segwit|not supported on this network|not recognized on this network/i.test(threw.message),
            "the refusal should name the network capability, not fail obscurely: " + threw.message)
    })

    it('still compresses the payload on the lane DOGE does have (§1 Part B)', async () => {
        const addr = await cryptoHelper.getNewFundedAddress("COMPRESSION.DOGE", COIN, NETWORK, null, "legacy", 0, 1)
        const body = Buffer.from(('Compression is the half of this work that every chain receives. ').repeat(30))

        const capture = {}
        const action = "FILE|0|envelope-doge-compressed.txt|text/plain|Compression on DOGE|no envelope needed"
        const txHash = await transactionHelper.createAndSendTransaction(
            addr, action, body.toString('binary'), [], null, null, false,
            { compress: true, capture }
        )

        assert.notStrictEqual(capture.encoding, "TAPROOT", "DOGE must never select the envelope")
        assert.strictEqual(capture.compression.compressed, true)
        assert(capture.compression.storedLength < capture.compression.rawLength)

        const row = await indexerDatabase.waitForFile({
            txHash: txHash,
            source: addr["address"],
            name: "envelope-doge-compressed.txt",
            title: "Compression on DOGE",
            status: "valid"
        }, 180000)
        assert(row, "the compressed FILE should be indexed on DOGE")

        const served = await envelopeHelper.waitForServedFile(row.action_index)
        assert.strictEqual(served.status, 200)
        assert.strictEqual(envelopeHelper.sha256(served.body), envelopeHelper.sha256(body),
            "the explorer inflates a compressed DOGE payload the same way it does a BTC one")
        assert.strictEqual(served.headers['x-xchain-compression'], 'deflate-raw')
    })
})
