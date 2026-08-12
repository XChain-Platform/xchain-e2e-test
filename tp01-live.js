#!/usr/bin/env node
/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 *********************************************************************/

// TP-01 live regtest round-trip test
// Run from xchain-e2e-test/ directory: node /tmp/tp01-live.js

'use strict'

const bitcoin = require('bitcoinjs-lib')
const ecc = require('tiny-secp256k1')
const { ECPairFactory } = require('ecpair')
const psbtutils = require('bitcoinjs-lib/src/psbt/psbtutils')
const axios = require('axios')
const mariadb = require('mariadb')
require('dotenv').config()

// Credentials come from the environment, never from this file. A committed
// literal is a launch-gate blocker even for regtest, because these
// repos go public. Fail closed rather than defaulting, so a missing variable
// is an obvious error instead of a silent connection to the wrong database.
function requiredEnv(name){
    const v = process.env[name]
    if(!v) throw new Error(name + " is not set; export it or add it to xchain-e2e-test/.env")
    return v
}
const { BIP32Factory } = require('bip32')
const bip32 = BIP32Factory(ecc)
bitcoin.initEccLib(ecc)
const ECPair = ECPairFactory(ecc)

const BTC_ENCODER  = 'http://172.19.0.10:3003'
const BTC_MINER    = 'http://localhost:3005'
const DOGE_ENCODER = 'http://localhost:3123'
const DOGE_MINER   = 'http://localhost:3125'

const BTC_DB_CFG = {
    host:'127.0.0.1', port:13306,
    database:'XChain_BTC_Regtest_Decoder',
    user:'xchain_decoder_bitcoin_regtest',
    password: requiredEnv('TP01_BTC_DECODER_DB_PASS'), connectionLimit:2
}
const DOGE_DB_CFG = {
    host:'127.0.0.1', port:13306,
    database:'XChain_DOGE_Regtest_Decoder',
    user:'xchain_decoder_dogecoin_regtest',
    password: requiredEnv('TP01_DOGE_DECODER_DB_PASS'), connectionLimit:2
}

// fixed key so results are reproducible
const TEST_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const DOGE_MNEMONIC = 'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong'

const CryptoNetworks = require('./src/CryptoNetworks')
const BTC_NET  = CryptoNetworks.getBitcoinJsNetwork('bitcoin-regtest')
const DOGE_NET = CryptoNetworks.getBitcoinJsNetwork('dogecoin-regtest')

async function rpc(url, method, params) {
    const resp = await axios.post(url, { jsonrpc:'2.0', method, params: params||{}, id:1 }, { timeout:30000 })
    if (resp.data.error) throw new Error(`RPC ${method}: ${JSON.stringify(resp.data.error)}`)
    return resp.data.result
}

function deriveKey(mnemonic, network, index=0) {
    const bip39 = require('bip39')
    const seed  = bip39.mnemonicToSeedSync(mnemonic)
    const root  = bip32.fromSeed(seed, network)
    const acct  = root.derivePath("m/44'/0'/0'")
    const child = acct.derive(0).derive(index)
    const addr  = bitcoin.payments.p2pkh({ pubkey: child.publicKey, network }).address
    return { privateKey: child.privateKey, publicKey: child.publicKey,
             compressedPubKey: child.publicKey.toString('hex'), address: addr }
}

async function sendFunds(minerUrl, address, amount) {
    return rpc(minerUrl, 'send_funds', { address, amount })
}

async function generateBlocks(minerUrl, count) {
    return rpc(minerUrl, 'generate_blocks', { count })
}

// Poll decoder DB for a transaction by txid
async function waitForTxInDb(pool, txid, timeoutMs=60000) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
        const conn = await pool.getConnection()
        try {
            const rows = await conn.query('SELECT data, raw_data FROM transactions WHERE hash=? LIMIT 1', [txid])
            if (rows.length > 0) return rows[0]
        } finally { conn.release() }
        await new Promise(r => setTimeout(r, 1000))
    }
    return null
}

function xchainP2shFinalizer(inputIndex, input, script, isSegwit, isP2SH, isP2WSH) {
    let payment = {
        network: bitcoin.networks.regtest,
        input: bitcoin.script.compile([ input.partialSig[0].signature, input.partialSig[0].pubkey ]),
        output: script
    }
    if (isP2SH) {
        payment = bitcoin.payments.p2sh({ network: bitcoin.networks.regtest, redeem: payment })
        return { finalScriptSig: payment.input, finalScriptWitness: undefined }
    } else if (isP2WSH) {
        payment = bitcoin.payments.p2wsh({ network: bitcoin.networks.regtest, redeem: payment })
        return { finalScriptSig: undefined, finalScriptWitness: psbtutils.witnessStackToScriptWitness(payment.witness) }
    }
    throw new Error('unknown encoding in finalizer')
}

// Must start with a valid ACTION name for the decoder to accept it
function makePayload(rawBytes) {
    const prefix = 'SEND|0|TEST|1.00000000|mrCDrCybB6J1vRfbwM5hemdJz73FwDBC2k|'
    if (rawBytes <= prefix.length) {
        return prefix.slice(0, rawBytes)
    }
    return prefix + 'X'.repeat(rawBytes - prefix.length)
}

function compiledSize(rawLen) {
    if (rawLen <= 75)  return rawLen + 1
    if (rawLen <= 255) return rawLen + 2
    return rawLen + 3
}

function rawForCompiled(compiled) {
    if (compiled <= 76)  return compiled - 1  // push opcode 1..75
    if (compiled <= 257) return compiled - 2  // OP_PUSHDATA1
    return compiled - 3                        // OP_PUSHDATA2
}

async function doSingleTxRoundTrip(encoderUrl, minerUrl, dbPool, keyInfo, network, encoding, rawLen) {
    const payload = makePayload(rawLen)
    const compiledLen = compiledSize(rawLen)
    let txid = null
    try {
        let res = await rpc(encoderUrl, 'create_tx', {
            utxos: [], pubkey: keyInfo.address,
            data: payload, rawData: null,
            encoding, change: keyInfo.address,
            compressedPubKey: keyInfo.compressedPubKey,
            unconfirmed: true
        })
        const encType  = res.encoding
        const psbtHex  = res.psbt
        const psbt     = bitcoin.Psbt.fromHex(psbtHex)
        const ecpair   = ECPair.fromPrivateKey(keyInfo.privateKey, { network })
        for (let i = 0; i < psbt.data.inputs.length; i++) psbt.signInput(i, ecpair)
        psbt.finalizeAllInputs()
        psbt.setMaximumFeeRate(100000)
        const tx       = psbt.extractTransaction()
        txid           = tx.getId()
        const txHex    = tx.toHex()
        await rpc(encoderUrl, 'broadcast_tx', { tx_hex: txHex })
        await generateBlocks(minerUrl, 1)
        const row = await waitForTxInDb(dbPool, txid, 45000)
        if (!row) return { ok:false, txid, payload, compiledLen, err:'not found in DB after 45s' }
        const match = (row.data === payload)
        return { ok:match, txid, payload, compiledLen, decoded: row.data,
                 err: match ? null : `mismatch: expected ${payload.length} chars got ${row.data ? row.data.length : 0}` }
    } catch(e) {
        return { ok:false, txid, payload, compiledLen, err: e.message }
    }
}

async function doTwoTxRoundTrip(encoderUrl, minerUrl, dbPool, keyInfo, network, encoding, rawLen) {
    const payload    = makePayload(rawLen)
    const compiledLen = compiledSize(rawLen)
    let spentTxid = null
    try {
        // Tx1: create data outputs
        let res1 = await rpc(encoderUrl, 'create_tx', {
            utxos: [], pubkey: keyInfo.address,
            data: payload, rawData: null,
            encoding, change: keyInfo.address,
            compressedPubKey: null,
            unconfirmed: true
        })
        const psbt1   = bitcoin.Psbt.fromHex(res1.psbt)
        const ecpair  = ECPair.fromPrivateKey(keyInfo.privateKey, { network })
        for (let i = 0; i < psbt1.data.inputs.length; i++) psbt1.signInput(i, ecpair)
        psbt1.finalizeAllInputs()
        psbt1.setMaximumFeeRate(100000)
        const tx1     = psbt1.extractTransaction()
        const tx1id   = tx1.getId()
        const tx1hex  = tx1.toHex()
        await rpc(encoderUrl, 'broadcast_tx', { tx_hex: tx1hex })
        // Tx2: spend (reveal), passing tx1 hash+hex
        let res2 = await rpc(encoderUrl, 'create_tx', {
            utxos: [], pubkey: keyInfo.address,
            data: payload, rawData: null,
            encoding, change: keyInfo.address,
            compressedPubKey: null,
            p2shHash: tx1id, p2shHex: tx1hex,
            unconfirmed: true
        })
        const psbt2  = bitcoin.Psbt.fromHex(res2.psbt)
        for (let i = 0; i < psbt2.data.inputs.length; i++) psbt2.signInput(i, ecpair)
        for (let i = 0; i < psbt2.data.inputs.length; i++) psbt2.finalizeInput(i, xchainP2shFinalizer)
        psbt2.setMaximumFeeRate(100000)
        const tx2    = psbt2.extractTransaction()
        spentTxid    = tx2.getId()
        const tx2hex = tx2.toHex()
        await rpc(encoderUrl, 'broadcast_tx', { tx_hex: tx2hex })
        await generateBlocks(minerUrl, 1)
        const row = await waitForTxInDb(dbPool, spentTxid, 60000)
        if (!row) return { ok:false, txid:spentTxid, payload, compiledLen, err:'not found in DB after 60s' }
        const match = (row.data === payload)
        return { ok:match, txid:spentTxid, payload, compiledLen, decoded: row.data,
                 err: match ? null : `mismatch` }
    } catch(e) {
        return { ok:false, txid:spentTxid, payload, compiledLen, err: e.message }
    }
}

async function main() {
    // target compiled sizes → derive raw string lengths
    // spec: 1, 75, 76, 475, 476, 3570, 3571, 8192 compiled bytes
    // Note: compiled=1 means OP_0 (empty push), which the decoder rejects as not-a-Buffer
    // So for compiled=1 we use the minimum valid payload (compiled=2, raw=1)
    const compiledTargets = [2, 75, 76, 475, 476, 3570, 3571, 8192]

    // Payload size capped at MAX_DATA_BYTES=8189 (validator rejects raw >8189)
    // For compiled=8192 → raw=8189 (8192-3, OP_PUSHDATA2 overhead)
    const rawSizes = compiledTargets.map(c => {
        const r = rawForCompiled(c)
        return Math.min(r, 8189)
    })

    const results = { BTC: {}, DOGE: {} }

    console.log('\n=== BTC REGTEST ===')
    let btcPool
    try {
        btcPool = mariadb.createPool(BTC_DB_CFG)
        await btcPool.query('SELECT 1')
    } catch(e) { console.error('BTC DB not reachable:', e.message); process.exit(1) }

    const btcKey = deriveKey(TEST_MNEMONIC, BTC_NET, 0)
    console.log('BTC test address:', btcKey.address)

    // Fund the address
    console.log('Funding BTC address...')
    await sendFunds(BTC_MINER, btcKey.address, 5)  // 5 BTC
    await generateBlocks(BTC_MINER, 2)
    await new Promise(r => setTimeout(r, 3000))

    const btcEncodings = ['OP_RETURN', 'P2SH', 'P2WSH', 'MULTISIGN']
    for (const enc of btcEncodings) {
        results.BTC[enc] = []
        for (const rawLen of rawSizes) {
            // skip absurd MULTISIGN sizes (> 8000 bytes = many chunks, very slow)
            if (enc === 'MULTISIGN' && rawLen > 500) {
                results.BTC[enc].push({ ok:'SKIP', rawLen, compiledLen:compiledSize(rawLen), err:'skipped (MULTISIGN large size, performance)' })
                continue
            }
            console.log(`BTC ${enc} raw=${rawLen} compiled=${compiledSize(rawLen)}...`)
            let r
            if (enc === 'P2SH' || enc === 'P2WSH') {
                r = await doTwoTxRoundTrip(BTC_ENCODER, BTC_MINER, btcPool, btcKey, BTC_NET, enc, rawLen)
            } else {
                r = await doSingleTxRoundTrip(BTC_ENCODER, BTC_MINER, btcPool, btcKey, BTC_NET, enc, rawLen)
            }
            results.BTC[enc].push({ ...r, rawLen, compiledLen:compiledSize(rawLen) })
            console.log(`  → ${r.ok===true?'PASS':r.ok==='SKIP'?'SKIP':'FAIL'} ${r.err||''}`)
            await new Promise(r => setTimeout(r, 1000))
        }
    }
    await btcPool.end()

    console.log('\n=== DOGE REGTEST ===')
    let dogePool
    try {
        dogePool = mariadb.createPool(DOGE_DB_CFG)
        await dogePool.query('SELECT 1')
    } catch(e) { console.error('DOGE DB not reachable:', e.message) }

    if (dogePool) {
        const dogeKey = deriveKey(DOGE_MNEMONIC, DOGE_NET, 0)
        console.log('DOGE test address:', dogeKey.address)

        console.log('Funding DOGE address...')
        const dogesFundResult = await sendFunds(DOGE_MINER, dogeKey.address, 5000000000)  // 50k DOGE in koinu
        if (dogesFundResult && dogesFundResult.error) throw new Error('send_funds failed: ' + dogesFundResult.error)
        await generateBlocks(DOGE_MINER, 2)
        // Poll until UTXOs appear (DOGE UTXO tracker indexing can lag > 3 s cold-start)
        {
            const deadline = Date.now() + 30000
            while (Date.now() < deadline) {
                try {
                    const utxos = await rpc(DOGE_ENCODER, 'get_utxos', { address: dogeKey.address })
                    if (utxos && utxos.length > 0) break
                } catch (_) {}
                await new Promise(r => setTimeout(r, 1000))
            }
        }

        const dogeEncodings = ['OP_RETURN', 'P2SH', 'MULTISIGN']  // no P2WSH on DOGE
        for (const enc of dogeEncodings) {
            results.DOGE[enc] = []
            for (const rawLen of rawSizes) {
                if (enc === 'MULTISIGN' && rawLen > 500) {
                    results.DOGE[enc].push({ ok:'SKIP', rawLen, compiledLen:compiledSize(rawLen), err:'skipped (MULTISIGN large size)' })
                    continue
                }
                console.log(`DOGE ${enc} raw=${rawLen} compiled=${compiledSize(rawLen)}...`)
                let r
                if (enc === 'P2SH') {
                    r = await doTwoTxRoundTrip(DOGE_ENCODER, DOGE_MINER, dogePool, dogeKey, DOGE_NET, enc, rawLen)
                } else {
                    r = await doSingleTxRoundTrip(DOGE_ENCODER, DOGE_MINER, dogePool, dogeKey, DOGE_NET, enc, rawLen)
                }
                results.DOGE[enc].push({ ...r, rawLen, compiledLen:compiledSize(rawLen) })
                console.log(`  → ${r.ok===true?'PASS':r.ok==='SKIP'?'SKIP':'FAIL'} ${r.err||''}`)
                await new Promise(r => setTimeout(r, 1000))
            }
        }
        await dogePool.end()
    }

    console.log('\n\n===== RESULTS SUMMARY =====\n')
    for (const [chain, chainResults] of Object.entries(results)) {
        if (Object.keys(chainResults).length === 0) continue
        console.log(`\n## ${chain}`)
        for (const [enc, rows] of Object.entries(chainResults)) {
            console.log(`\n### ${enc}`)
            console.log('compiled_size | raw_size | result | txid | err')
            for (const row of rows) {
                const status = row.ok===true?'PASS':row.ok==='SKIP'?'SKIP':'FAIL'
                console.log(`${row.compiledLen} | ${row.rawLen} | ${status} | ${row.txid||'-'} | ${row.err||''}`)
            }
        }
    }

    const fs = require('fs')
    fs.writeFileSync('/tmp/tp01-results.json', JSON.stringify(results, null, 2))
    console.log('\nResults written to /tmp/tp01-results.json')
}

main().catch(e => { console.error('Fatal:', e); process.exit(1) })
