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
// Taproot envelope + payload compression.
//
// Everything here reads the envelope back out of the bytes that were actually
// broadcast rather than out of what the encoder said it built: the grammar is
// frozen (§3.2) and the whole point of the freeze is that a third party can
// recognize the envelope from the witness alone.

const crypto = require('crypto')
const zlib = require('zlib')
const transactionHelper = require('../transactionHelper')
const requireRow = require('./requireRow')

const OP_0 = 0x00
const OP_IF = 0x63
const OP_ENDIF = 0x68

// Minimal script reader. bitcoinjs-lib's decompile would do, but it collapses
// small integer pushes to opcodes, and the envelope's format byte is exactly the
// push a strict grammar check has to see as DATA.
function decompile(script){
    const out = []
    let i = 0
    while (i < script.length){
        const op = script[i++]
        if (op === 0x00){ out.push({ op }); continue }
        if (op >= 0x01 && op <= 0x4b){ out.push({ data: script.subarray(i, i + op) }); i += op; continue }
        if (op === 0x4c){ const n = script[i]; i += 1; out.push({ data: script.subarray(i, i + n) }); i += n; continue }
        if (op === 0x4d){ const n = script.readUInt16LE(i); i += 2; out.push({ data: script.subarray(i, i + n) }); i += n; continue }
        if (op === 0x4e){ const n = script.readUInt32LE(i); i += 4; out.push({ data: script.subarray(i, i + n) }); i += n; continue }
        out.push({ op })
    }
    return out
}

module.exports = {
    sha256(buf){ return crypto.createHash('sha256').update(buf).digest('hex') },

    // The explorer's coin path segment: R/T prefix by network, mirroring the SDK's
    // endpoint mapping (RBTC on bitcoin regtest, TLTC on litecoin testnet, ...).
    coinPrefix(){
        const code = global.COIN_CODE
        if (NETWORK === 'regtest') return 'R' + code
        if (NETWORK === 'testnet' || NETWORK === 'testnet4') return 'T' + code
        return code
    },

    // Does this venue recognize the envelope at all? BTC and LTC have Taproot;
    // DOGE has no segwit, so ENVELOPE_RECOGNITION_ACTIVATION is null there forever
    // and the encoder refuses to build one (§3.6).
    envelopeSupported(){
        return global.COIN_CODE === 'BTC' || global.COIN_CODE === 'LTC'
    },

    // Publish a FILE carried by a Taproot envelope. Returns the indexed row plus
    // the build metadata, so a caller can assert on HOW it was carried and not only
    // that it arrived.
    async sendFileViaEnvelope(addressInfo, { name, type, title, memo, rawData, compress = null }){
        const action = "FILE|0|"+name+"|"+type+"|"+title+"|"+memo
        const capture = {}

        // rawData crosses JSON-RPC as a BINARY (latin1) string: the encoder's
        // validator does Buffer.from(rawData, 'binary'). Handing it hex publishes the
        // hex TEXT as the payload, which is silently twice the size and inflates to
        // the wrong bytes.
        const payload = Buffer.isBuffer(rawData) ? rawData : Buffer.from(rawData)

        console.log("Creating and sending an envelope-carried FILE ("+payload.length+" bytes)...")
        const txHash = await transactionHelper.createAndSendTransaction(
            addressInfo,
            action,
            payload.toString('binary'),
            [],                                     // customOutputs
            "TAPROOT",                              // outputType - explicit; auto-selection is opt-in (§6)
            Buffer.from(addressInfo["publicKey"]).toString('hex'),  // becomes the envelope internal key (§3.1)
            false,                                  // native fee injection stays on: the fee outputs ride the COMMIT (§3.5)
            { compress, capture }
        )

        console.log("Waiting for the envelope-carried FILE in the database...")
        const row = requireRow(await indexerDatabase.waitForFile({
            txHash: txHash,
            source: addressInfo["address"],
            name: name,
            title: title,
            status: "valid"
        }, 180000), "sendFileViaEnvelope: the envelope-carried FILE " + name
            + " (tx " + txHash + ") at status=valid")

        return { txHash, file: row, capture, payload }
    },

    // Build and sign an envelope pair WITHOUT broadcasting either half. The normal
    // path (sendFileViaEnvelope) puts both on the wire back to back, which is the
    // fee-optimal thing to do and lands them in one block; a caller that needs the
    // halves SEPARATED in time (the §3.7 reorg drill, or proving that a confirmed
    // commit alone produces no action) has to hold them itself.
    // `action` overrides the FILE composition for callers driving a different action
    // through the envelope (the §3.5 fee-lifecycle drill carries a fee-bearing ISSUE,
    // which FILE can never be: FILE has no protocol fee at all). `customOutputs`
    // likewise overrides the discovered native fee output, including with [] for the
    // negative case where the commit deliberately carries none.
    async buildEnvelopePair(addressInfo, { name, type, title, memo, rawData, compress = null,
                                           action: actionOverride = null, customOutputs = null }){
        const bitcoin = require('bitcoinjs-lib')
        const action = actionOverride || ("FILE|0|"+name+"|"+type+"|"+title+"|"+memo)
        const payload = (rawData === null || rawData === undefined)
            ? null
            : (Buffer.isBuffer(rawData) ? rawData : Buffer.from(rawData))

        // The commit carries any native fee-destination outputs (§3.5), the same way
        // the funding transaction does in the chunk lanes, so the fee output has to be
        // discovered and passed here rather than left to the reveal.
        const nativeFeeHelper = require('./nativeFeeHelper')
        let outputs = customOutputs
        if (outputs === null){
            const feeOutput = await nativeFeeHelper.getNativeFeeOutput()
            outputs = feeOutput ? [feeOutput] : []
        }

        // No UTXO list is passed, so the encoder asks the tracker; on a busy stack the
        // tracker can still be behind the funding transaction that cryptoHelper just
        // waited for, and the encoder answers "no utxos found on the blockchain".
        // transactionHelper retries that class of transient at its own chokepoint;
        // this path calls the encoder directly, so it needs the same patience.
        let built = null
        let lastErr = null
        for (let attempt = 1; attempt <= 5; attempt++){
            try {
                await utxoTrackerConnector.quiesce({ timeoutMs: 20000, pollMs: 250, regtestMiner: regtestMinerConnector })
            } catch (e) { /* best effort */ }
            try {
                built = await encoderConnector.createTx(
                    [], addressInfo["address"], outputs, action, payload ? payload.toString('binary') : null,
                    null, false, "TAPROOT", addressInfo["address"], null, null,
                    Buffer.from(addressInfo["publicKey"]).toString('hex'), false, compress
                )
                break
            } catch (err){
                lastErr = err
                if (attempt === 5 || !/no utxos|missingorspent|missing inputs/i.test(err.message)) throw err
                await new Promise(r => setTimeout(r, 3000))
            }
        }
        if (!built) throw lastErr

        const transactionHelper = require('../transactionHelper')
        const commitPsbt = bitcoin.Psbt.fromHex(built["psbt"])
        const ecc = require('tiny-secp256k1')
        const { ECPairFactory } = require('ecpair')
        const keyToSign = ECPairFactory(ecc).fromPrivateKey(addressInfo["privateKey"], { NETWORK_OBJECT })
        for (let i = 0; i < commitPsbt.data.inputs.length; i++) commitPsbt.signInput(i, keyToSign)
        commitPsbt.finalizeAllInputs()
        commitPsbt.setMaximumFeeRate(100000)
        const commitTx = commitPsbt.extractTransaction()

        const revealTx = transactionHelper.signEnvelopeReveal(addressInfo, built["revealPsbt"], commitTx.getId())

        return {
            action,
            payload,
            commitTx, commitHex: commitTx.toHex(), commitTxid: commitTx.getId(),
            revealTx, revealHex: revealTx.toHex(), revealTxid: revealTx.getId(),
            envelope: built["envelope"] || null,
            compression: built["compression"] || null
        }
    },

    // Read the envelope back out of the confirmed reveal on chain and check it
    // against the frozen §3.2 grammar. Returns the payload pushes concatenated,
    // which is byte-identical to the compiled data stream every other lane carries.
    async readEnvelopeFromChain(revealTxHash){
        const hex = await nodeConnector.getTransactionHex(revealTxHash)
        const bitcoin = require('bitcoinjs-lib')
        const tx = bitcoin.Transaction.fromHex(hex)
        const witness = tx.ins[0].witness

        // Index from the END of the stack per BIP341 (control block last, script
        // second to last), never from a fixed offset: a fixed index misreads any
        // spend that carries an annex.
        const script = witness[witness.length - 2]
        const controlBlock = witness[witness.length - 1]
        const ops = decompile(script)

        const grammarOk = Boolean(
            ops[0] && ops[0].op === OP_0 &&
            ops[1] && ops[1].op === OP_IF &&
            ops[2] && ops[2].data && ops[2].data.toString('latin1') === 'XCHN' &&
            ops[3] && ops[3].data && ops[3].data.length === 1 && ops[3].data[0] === 0x00
        )

        const pushes = []
        let i = 4
        for (; i < ops.length && ops[i].op !== OP_ENDIF; i++){
            if (!ops[i].data) break
            pushes.push(ops[i].data)
        }
        const terminated = Boolean(ops[i] && ops[i].op === OP_ENDIF)
        const inner = decompile(Buffer.concat(pushes))

        return {
            tx,
            grammarOk,
            terminated,
            controlBlockLength: controlBlock ? controlBlock.length : 0,
            witnessLength: witness.length,
            weight: tx.weight(),
            actionString: inner[0] && inner[0].data ? inner[0].data.toString('latin1') : '',
            storedPayload: inner[1] && inner[1].data ? inner[1].data : Buffer.alloc(0),
            // Every push is 520 bytes except the last, so a payload that needed more
            // than one push proves the chunking path rather than the trivial case.
            pushCount: pushes.length
        }
    },

    // COMPRESSION is the eleventh field of FILE v0 and is stripped when empty, so
    // an uncompressed FILE has ten fields and a compressed one has eleven (§5.1).
    compressionFieldOf(actionString){
        const fields = actionString.split('|')
        return fields.length >= 11 ? fields[10] : ''
    },

    inflate(buf){ return zlib.inflateRawSync(buf) },

    // What the explorer serves for an action index, with the §5.5 headers.
    async servedFile(actionIndex){
        return await explorerConnector.getFileRaw(this.coinPrefix(), actionIndex)
    },

    // Poll the explorer for the file bytes. The indexer writes the `files` row before
    // the explorer's own view is warm on a busy stack, so a single GET right after
    // waitForFile can 404; that is a race in the test, not a defect in the serve path.
    async waitForServedFile(actionIndex, timeMax = 60000){
        const end = Date.now() + timeMax
        let last = null
        while (Date.now() < end){
            last = await this.servedFile(actionIndex)
            if (last.status === 200 && last.body.length) return last
            await new Promise(r => setTimeout(r, 2000))
        }
        return last
    }
}
