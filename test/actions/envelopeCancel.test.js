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
 * ENVELOPE CANCEL FROM PERSISTED STATE ( §3.5)
 * spec: claude/specs/taproot-envelope-and-payload-compression.md
 *
 * The commit output is a P2TR whose tweak commits to the envelope leaf. Spending
 * it back out by the key path needs the internal key AND the tapleaf hash to
 * reconstruct that tweak; lose the leaf and the funds sit in an address the wallet
 * cannot re-derive. §3.5 therefore requires the wallet to persist
 * {commit outpoint, internal key derivation path, tapleaf hash} BEFORE the commit
 * is broadcast, and requires cancel to be reconstructible from that record ALONE,
 * surviving a crash between commit and reveal.
 *
 * This test holds that requirement structurally rather than by assertion: it keeps
 * ONLY the five record fields, throws the rest of the build away, and rebuilds the
 * cancel through the encoder SERVICE, which is a separate process that remembers
 * nothing about the commit. The only thing not reconstructed is the private key,
 * which a real wallet re-derives from its seed and the persisted path.
 *
 * The proof that the tweak was rebuilt correctly is the chain's, not ours: a
 * key-path spend under a wrong tweak is simply an invalid signature, so the node
 * accepting the transaction IS the assertion.
 *
 * DOGE-skipped: no segwit, so no envelope and no commit to cancel.
 ********************************************************************/

const assert = require('assert')
const bitcoin = require('bitcoinjs-lib')
const ecc = require('tiny-secp256k1')
const cryptoHelper = require('../cryptoHelper')
const envelopeHelper = require('../helpers/envelopeHelper')

bitcoin.initEccLib(ecc)

const BODY = Buffer.from('This payload is never revealed. The commit funding it is cancelled instead. '.repeat(20))

// BIP341: a key-path spend of an output whose tweak commits to a script tree signs
// under the tweaked key, and always under the even-Y representative of the internal
// key. This is the whole of what the recovery record has to make reconstructible.
function tweakPrivateKey(privateKey, merkleRoot){
    let d = Buffer.from(privateKey)
    const point = Buffer.from(ecc.pointFromScalar(d, true))
    if (point[0] === 3) d = Buffer.from(ecc.privateNegate(d))
    const xonly = point.subarray(1, 33)
    const tweak = bitcoin.crypto.taggedHash('TapTweak', Buffer.concat([xonly, merkleRoot]))
    const tweaked = ecc.privateAdd(d, tweak)
    if (!tweaked) throw new Error('tweak produced an invalid private key')
    return Buffer.from(tweaked)
}

async function q(sql, params) {
    const conn = await indexerDatabase.getConnection()
    try { return await conn.query(sql, params) }
    finally { await conn.release() }
}
async function fileCountByName(name) {
    const rows = await q(`SELECT COUNT(*) c FROM files WHERE name = ?`, [name])
    return Number(rows[0].c)
}
async function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

// An assertion that something was NOT indexed is worthless until the indexer has
// actually reached the blocks in question: a lagging indexer makes "no action here"
// true for the wrong reason, and the assertion passes vacuously. Under a full-suite
// run the indexer has been observed six blocks behind, so this is not hypothetical.
async function waitForIndexerToCatchUp(timeoutMs = 180000) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
        const rows = await q(`SELECT MAX(block_index) h FROM blocks`, [])
        if (Number(rows[0].h) >= await nodeConnector.getBlockCount()) return true
        await sleep(2000)
    }
    return false
}

describe('Envelope Cancel: recovering an unrevealed commit from persisted state alone ( §3.5)', function () {
    this.timeout(0)

    before(async function () {
        if (!envelopeHelper.envelopeSupported()) this.skip()
    })

    it('spends the commit back by the key path, and the reveal can no longer be broadcast', async function () {
        const fileName = 'xc990-cancelled-' + Date.now().toString().slice(-6) + '.txt'
        const addr = await cryptoHelper.getNewFundedAddress('envcancel', COIN, NETWORK, null, 'segwit', 0, 1)
        const recovery = (await cryptoHelper.getNewAddress('envcancel-recovery', COIN, NETWORK, null, 'legacy', 0)).address

        const pair = await envelopeHelper.buildEnvelopePair(addr, {
            name: fileName,
            type: 'text/plain',
            title: ' cancelled envelope',
            memo: 'the reveal never happens',
            rawData: BODY,
            compress: true
        })

        // §3.5's persistence contract, asserted as a contract: these five fields are
        // what the encoder hands back for the wallet to durably write BEFORE the
        // commit goes out, and they are all that survives into the recovery below.
        const record = {
            commitTxid: pair.envelope.commitTxid,
            commitVout: pair.envelope.commitVout,
            commitValue: pair.envelope.commitValue,
            internalPubkey: pair.envelope.internalPubkey,
            tapleafHash: pair.envelope.tapleafHash
        }
        for (const field of Object.keys(record)) {
            assert(record[field] !== undefined && record[field] !== null,
                'the recovery record must carry ' + field + '; without it the commit is unrecoverable')
        }
        const revealHex = pair.revealHex          // kept only to prove it is dead below

        // ── The commit is broadcast; the reveal never is. ──
        await nodeConnector.broadcastTx(pair.commitHex)
        await regtestMinerConnector.generateBlocks(1)
        const confirmedCommit = await nodeConnector.getTransaction(record.commitTxid)
        assert(confirmedCommit && confirmedCommit.blockhash, 'the commit confirmed')

        // ── Everything else about the build is now gone. Rebuild from the record. ──
        const cancel = await encoderConnector.createEnvelopeCancelTx({
            commitTxid: record.commitTxid,
            commitVout: record.commitVout,
            commitValue: record.commitValue,
            internalPubkey: record.internalPubkey,
            tapleafHash: record.tapleafHash,
            destination: recovery,
            feePerKb: 2000
        })

        const cancelPsbt = bitcoin.Psbt.fromHex(cancel.psbt, { network: NETWORK_OBJECT })
        const tweakedPriv = tweakPrivateKey(addr['privateKey'], Buffer.from(record.tapleafHash, 'hex'))
        const tweakedPub = Buffer.from(ecc.pointFromScalar(tweakedPriv, true))
        cancelPsbt.signInput(0, {
            publicKey: tweakedPub,
            signSchnorr: (hash) => Buffer.from(ecc.signSchnorr(hash, tweakedPriv))
        })
        cancelPsbt.finalizeAllInputs()
        cancelPsbt.setMaximumFeeRate(100000)
        const cancelTx = cancelPsbt.extractTransaction()

        // A key-path spend is one 64-byte signature and nothing else. A script-path
        // spend would carry three witness elements, so this distinguishes the cancel
        // from a reveal even before the node weighs in.
        assert.strictEqual(cancelTx.ins[0].witness.length, 1, 'key-path spend: a single witness element')
        assert.strictEqual(cancelTx.ins[0].witness[0].length, 64, 'a bare Schnorr signature, no sighash byte')

        const cancelTxid = await nodeConnector.broadcastTx(cancelTx.toHex())
        assert.strictEqual(cancelTxid, cancelTx.getId(),
            'the node accepted the cancel, which is the chain asserting the tweak was rebuilt correctly')
        await regtestMinerConnector.generateBlocks(1)

        // ── The commit output is spent, and its value came home. ──
        const spent = await nodeConnector.getTransaction(cancelTxid)
        assert(spent && spent.blockhash, 'the cancel confirmed')
        const paidToRecovery = spent.vout.some(o =>
            o.scriptPubKey && (o.scriptPubKey.address === recovery ||
                (o.scriptPubKey.addresses || []).includes(recovery)))
        assert(paidToRecovery, 'the commit value landed at the recovery destination')

        // ── The reveal is now a double spend: cancel conflicts with it by construction. ──
        let revealRejected = null
        try { await nodeConnector.broadcastTx(revealHex) } catch (err) { revealRejected = err }
        assert(revealRejected,
            'the reveal must be unbroadcastable once the commit is spent; both outstanding would mean the wallet could publish an action it believed it had cancelled')

        // ── And no action ever existed. ──
        assert(await waitForIndexerToCatchUp(),
            'the indexer must reach the commit and cancel blocks before their emptiness means anything')
        assert.strictEqual(await fileCountByName(fileName), 0,
            'an unrevealed commit produces no action, cancelled or not (§3.7)')
        console.log('   commit cancelled to', recovery, '- no action, reveal dead')
    })
})
