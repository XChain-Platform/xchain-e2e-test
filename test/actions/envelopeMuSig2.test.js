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
 * TAPROOT ENVELOPE UNDER MUSIG2 CO-SIGNING ( §3.9)
 * spec: claude/specs/resolved/taproot-envelope-and-payload-compression.md
 *
 * §3.9 calls MuSig2 composition "work, not free" and names three deltas the
 * envelope needed from the shipped co-signer interface: a script-path sighash
 * over the envelope leaf for the reveal, the tap-tweaked key-path round for the
 * cancel, and the policy daemon learning to read the intended ACTION out of an
 * envelope PSBT. All three were built and proven on chain during S4, by a one-off
 * driver (claude/bin/xc990-s4-e2e.js --scenarios musig2) against a throwaway
 * venue. That driver proves a moment: nothing running on its own notices when a
 * change to the encoder's commit builder, the co-signer's envelope role
 * classification or the decoder's attribution rule stops the composition working.
 *
 * This is the standing version. Nothing here is stubbed: the daemon is a real
 * CoSigner with a real policy and a real window store, the agent round is a real
 * MuSig2 aggregation, and the transactions go to the venue's own node through the
 * deployed encoder SERVICE rather than the encoder library.
 *
 * The assertions that matter are the ones a mock could not make:
 *
 *   - the encoder's commit output is the one the co-signer derives INDEPENDENTLY
 *     from the envelope script (deriveEnvelopeCommit), so both halves agree on
 *     what is being committed to before anything is signed;
 *   - the daemon reads FILE out of the envelope PSBT, on both halves, and charges
 *     its rate-limit window ONCE for the pair, not twice;
 *   - the reveal's aggregated signature verifies under the leaf's bare aggregate
 *     key, which is the proof that the message was the tapleaf sighash and the
 *     round carried no tweak;
 *   - the node accepting both transactions is full consensus Schnorr/Taproot
 *     validation of the aggregate, not the SDK grading its own homework;
 *   - and the indexed action's source is the aggregate ACCOUNT (§3.4), which is
 *     what makes token gating and ownership work for a co-signed publisher.
 *
 * BTC and LTC only: DOGE has no segwit, so there is no envelope to co-sign.
 ********************************************************************/

const assert = require('assert')
const crypto = require('crypto')
const os = require('os')
const fs = require('fs')
const path = require('path')

const bitcoin = require('bitcoinjs-lib')
const ecc = require('tiny-secp256k1')
bitcoin.initEccLib(ecc)

const envelopeHelper = require('../helpers/envelopeHelper')
const nativeFeeHelper = require('../helpers/nativeFeeHelper')
const addressHelper = require('../helpers/addressHelper')

// The SDK is a sibling checkout, resolved the way test/sdk/sdkHelper.js resolves
// it. These are internal modules rather than package entry points, so they are
// reached through the package root instead of by deep-requiring a bare specifier.
function sdkModule(relative){
    let pkg = null
    for (const candidate of ['xchain-sdk/package.json', '../../../xchain-sdk/package.json']){
        try { pkg = require.resolve(candidate); break } catch (e) { /* next candidate */ }
    }
    if (!pkg) throw new Error('could not resolve the xchain-sdk checkout beside xchain-e2e-test')
    return require(path.join(path.dirname(pkg), relative))
}

const BODY = Buffer.from(
    ('A FILE published by a 2-of-2 MuSig2 account, carried by one tapscript reveal. ').repeat(45)
)

async function sleep(ms){ return new Promise(r => setTimeout(r, ms)) }

// Fund an address the miner knows nothing about and return the outpoint the
// encoder needs. The aggregate account is not a suite wallet, so nothing else
// tracks it; the UTXO is handed to the encoder explicitly.
async function fundAggregate(address, amount){
    const txid = await regtestMinerConnector.sendFunds(address, amount)
    assert(txid, 'the regtest miner should fund the aggregate account')
    assert(await nodeConnector.waitForTx(txid, 60000), 'the funding tx should reach the chain')
    try { await regtestMinerConnector.generateBlocks(1) } catch (e) { /* the miner auto-mines anyway */ }

    const raw = await nodeConnector._rpc('getrawtransaction', [txid, true])
    // Both vout shapes, because litecoind still reports the pre-Core-22
    // `addresses` array; matching only `address` made this test structurally
    // unable to pass on LTC (see addressHelper.findVoutPayingAddress).
    const out = addressHelper.findVoutPayingAddress(raw, address)
    assert(out, 'the funding tx should pay the aggregate account')
    return {
        txid,
        vout: out.n,
        value: Math.round(out.value * 1e8),
        scriptPubKey: out.scriptPubKey.hex,
        confirmations: 1
    }
}

describe('Taproot Envelope under MuSig2 co-signing ( §3.9)', function () {
    this.timeout(0)

    before(function (){
        if (!envelopeHelper.envelopeSupported()) this.skip()   // no segwit, no envelope
    })

    it('publishes a co-signed commit/reveal pair and attributes it to the aggregate account', async function () {
        const MuSig2 = sdkModule('src/musig2.js')
        const CoSigner = sdkModule('src/cosigner/coSigner.js')
        const CoSignerClient = sdkModule('src/cosigner/client.js')
        const WindowStore = sdkModule('src/cosigner/windowStore.js')
        const { deriveMuSig2P2TR } = sdkModule('src/cosigner/account.js')
        const { deriveEnvelopeCommit } = sdkModule('src/cosigner/envelope.js')

        // Fresh keys per run: a fixed pair would reuse one account across runs and
        // leave earlier UTXOs lying in it, which turns a funding mistake into a test
        // that passes on the wrong coin.
        const agentSk = crypto.randomBytes(32)
        const daemonSk = crypto.randomBytes(32)
        const agentPk = Buffer.from(ecc.pointFromScalar(agentSk, true))
        const daemonPk = Buffer.from(ecc.pointFromScalar(daemonSk, true))
        const publicKeys = [agentPk, daemonPk]

        const account = deriveMuSig2P2TR(publicKeys, NETWORK_OBJECT)
        console.log('   MuSig2 aggregate account', account.address)

        const utxo = await fundAggregate(account.address, 0.05)

        // ── build the pair through the deployed encoder ──────────────────────────
        const fileName = 'xc990-musig2-' + Date.now().toString().slice(-6) + '.txt'
        const action = 'FILE|0|' + fileName + '|text/plain| MuSig2 envelope|co-signed commit and reveal'
        const feeOutput = await nativeFeeHelper.getNativeFeeOutput()

        const built = await encoderConnector.createTx(
            [utxo],
            account.address,
            feeOutput ? [feeOutput] : [],
            action,
            BODY.toString('binary'),
            null,
            false,
            'TAPROOT',
            account.address,
            null,
            null,
            // The envelope's internal key is the account aggregate, so the commit
            // output is a tree-committed P2TR the co-signer can re-derive.
            Buffer.concat([Buffer.from([0x02]), account.aggregateXOnly]).toString('hex'),
            false,
            true
        )
        assert.strictEqual(built['encoding'], 'TAPROOT', 'the encoder should have built an envelope')

        const commitPsbt = bitcoin.Psbt.fromHex(built['psbt'], { network: NETWORK_OBJECT })
        const revealPsbt = bitcoin.Psbt.fromHex(built['revealPsbt'], { network: NETWORK_OBJECT })
        const envelopeScript = revealPsbt.data.inputs[0].tapLeafScript[0].script

        // The co-signer derives the commit from the envelope script alone. If this
        // disagrees, the daemon would be authorizing a spend into an output it cannot
        // reconstruct, which is the stranded-funds shape §3.5 exists to prevent.
        const derived = deriveEnvelopeCommit({
            internalXOnly: account.aggregateXOnly,
            envelopeScript,
            network: NETWORK_OBJECT
        })
        assert(commitPsbt.txOutputs.some(o => o.script.equals(derived.output)),
            'the encoder-built commit output must be the one the co-signer derives independently')

        // ── the policy daemon: real policy, real window, real fee cap ────────────
        //
        // The allow-list entry is the composition requirement §3.9 did not name, and
        // it exists because of §3.5: the native fee-destination output rides the
        // COMMIT. The co-signer's anti-drain gate authorizes exactly three kinds of
        // output - change back to the account, the one envelope commit output, and
        // operator-allow-listed payment legs - so on a native-fee chain the fee
        // output is a fourth kind and the whole pair is refused without this. An
        // operator running a MuSig2 publisher must allow-list FEE_DESTINATION, and
        // the negative below pins that so the requirement cannot be lost again.
        const allowedOutputs = feeOutput ? [{ address: feeOutput.address, maxValue: feeOutput.value }] : []
        const policy = { allowedActions: new Set(['FILE']), maxPerWindow: { hours: 24, maxActions: 10 } }

        const windowPath = path.join(os.tmpdir(), 'xc990-musig2-window-' + process.pid + '-' + Date.now() + '.json')
        try { fs.unlinkSync(windowPath) } catch (e) { /* fresh run */ }
        const store = new WindowStore(windowPath, 24, null, { init: true })
        const daemon = new CoSigner({
            secretKey: daemonSk,
            publicKeys,
            tweaks: [],
            policy,
            allowedOutputs,
            windowStore: store,
            maxFeeSats: 500000,
            network: NETWORK_OBJECT
        })
        const client = new CoSignerClient({
            transport: CoSignerClient.inProcessTransport(daemon),
            publicKeys,
            tweaks: []
        })

        // The negative half of the same requirement, on a chain that charges a native
        // fee: an otherwise identical daemon with no allow-list refuses this exact
        // commit. Free to assert (the PSBT is already built) and it is the difference
        // between "we configured it right" and "it has to be configured this way".
        if (feeOutput){
            const strictPath = windowPath.replace('.json', '-strict.json')
            const strictStore = new WindowStore(strictPath, 24, null, { init: true })
            try {
                const strictClient = new CoSignerClient({
                    transport: CoSignerClient.inProcessTransport(new CoSigner({
                        secretKey: daemonSk, publicKeys, tweaks: [], policy,
                        windowStore: strictStore, maxFeeSats: 500000, network: NETWORK_OBJECT
                    })),
                    publicKeys,
                    tweaks: []
                })
                let refusal = null
                try {
                    await strictClient.signAll({
                        psbt: built['psbt'], secretKey: agentSk, inputIndexes: [0],
                        envelopeScript: envelopeScript.toString('hex'), network: NETWORK_OBJECT
                    })
                } catch (err){ refusal = err }
                assert(refusal, 'a daemon with no allow-list must refuse the fee-bearing commit')
                assert(/UNAUTHORIZED_OUTPUT/.test(refusal.message + ' ' + (refusal.code || '')),
                    'the refusal should name the unauthorized output, not fail obscurely: ' + refusal.message)
            } finally {
                strictStore.release()
                try { fs.unlinkSync(strictPath) } catch (e) { /* best effort */ }
            }
        }

        let revealTxid = null
        try {
            // ── commit: key-path spend of the account, authorized off the leaf ───
            const commitRes = await client.signAll({
                psbt: built['psbt'],
                secretKey: agentSk,
                inputIndexes: commitPsbt.data.inputs.map((_, i) => i),
                envelopeScript: envelopeScript.toString('hex'),
                network: NETWORK_OBJECT
            })
            assert.strictEqual(commitRes.action, 'FILE',
                'the daemon must read the intended ACTION out of the envelope PSBT (§3.9 delta c)')
            assert.strictEqual(store.snapshot().count, 1, 'the window should be charged once for the commit')

            for (const s of commitRes.signatures){
                commitPsbt.updateInput(s.index, { tapKeySig: Buffer.from(s.signature) })
                commitPsbt.finalizeInput(s.index)
            }
            commitPsbt.setMaximumFeeRate(100000)
            const commitTx = commitPsbt.extractTransaction()

            // ── reveal: script-path spend of the envelope leaf ───────────────────
            const revealRes = await client.sign({
                psbt: built['revealPsbt'],
                secretKey: agentSk,
                inputIndex: 0,
                envelopeScript: envelopeScript.toString('hex'),
                network: NETWORK_OBJECT
            })
            assert.strictEqual(revealRes.action, 'FILE',
                'the daemon must recognize the reveal as the same FILE')
            assert.strictEqual(store.snapshot().count, 1,
                'the reveal is the second half of one authorization, not a second action: the window must NOT be charged again')

            // A signature that verifies under the LEAF's bare aggregate key is the
            // proof that the message was the tapleaf sighash and the session carried
            // no tap tweak. Verified locally first because a node rejection alone
            // would not say which of the two went wrong.
            assert(ecc.verifySchnorr(revealRes.msg, account.aggregateXOnly, revealRes.signature),
                'the aggregated reveal signature must verify under the envelope leaf key')

            revealPsbt.updateInput(0, {
                tapScriptSig: [{
                    pubkey: account.aggregateXOnly,
                    leafHash: derived.leafHash,
                    signature: Buffer.from(revealRes.signature)
                }]
            })
            revealPsbt.finalizeInput(0)
            revealPsbt.setMaximumFeeRate(100000)
            const revealTx = revealPsbt.extractTransaction()
            revealTxid = revealTx.getId()

            assert.strictEqual(
                Buffer.from(revealPsbt.txInputs[0].hash).reverse().toString('hex'), commitTx.getId(),
                'reveal input 0 must be the commit outpoint (§3.5)')

            // ── the chain is the verifier ────────────────────────────────────────
            await nodeConnector.broadcastTx(commitTx.toHex())
            await nodeConnector.broadcastTx(revealTx.toHex())
            console.log('   node accepted the co-signed pair: commit', commitTx.getId().slice(0, 16) + '...',
                        'reveal', revealTxid.slice(0, 16) + '...')
        } finally {
            store.release()
            try { fs.unlinkSync(windowPath) } catch (e) { /* best effort */ }
        }

        // ── indexed, attributed and served ───────────────────────────────────────
        const row = await indexerDatabase.waitForFile({
            txHash: revealTxid,
            source: account.address,
            name: fileName,
            title: ' MuSig2 envelope',
            status: 'valid'
        }, 180000)
        assert(row, 'the co-signed envelope action should be indexed')

        // §3.4 on a co-signed publisher: the source is the address that funded the
        // COMMIT, which here is the aggregate account itself. Attributing to the
        // one-time commit address would leave a MuSig2 publisher unable to hold the
        // tokens its own gated files are gated on.
        assert.strictEqual(row.source, account.address,
            'the action must be attributed to the MuSig2 aggregate account')

        const served = await envelopeHelper.waitForServedFile(row.action_index)
        assert.strictEqual(served.status, 200)
        assert.strictEqual(envelopeHelper.sha256(served.body), envelopeHelper.sha256(BODY),
            'the payload a co-signed envelope carries must serve byte-exactly, like any other')

        const onChain = await envelopeHelper.readEnvelopeFromChain(revealTxid)
        assert(onChain.grammarOk && onChain.terminated,
            'a co-signed reveal carries the same frozen §3.2 grammar as any other')
        console.log('   indexed at action_index', row.action_index, 'source', row.source)
    })
})
