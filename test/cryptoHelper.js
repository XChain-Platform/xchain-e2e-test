// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const axios = require('axios');
const crypto = require('crypto');
const bip39 = require('bip39');
const ecc = require('tiny-secp256k1')
const { BIP32Factory } = require('bip32')
const bip32 = BIP32Factory(ecc)
const bitcoin = require('bitcoinjs-lib')
const CryptoNetworks = require('../src/CryptoNetworks')

global.wallets = {}

module.exports = {
    async getWallet(label){
        if (label in wallets){
                return wallets[label]
        } else {
            let newWallet = {
                mnemonic: null,
                seed: null,
                coin: null,
                network: null,
                addresses: []
            }
            wallets[label] = newWallet
            return newWallet
        }
    },
    
    async getNewAddress(label, coin, network, mnemonic = null, addressType="legacy", addressIndex=0){
        network = CryptoNetworks.getBitcoinJsNetwork(coin+"-"+network)
        
        let wallet = await this.getWallet(label)
        wallet.coin = coin
        wallet.network = network
        
        if (wallet.mnemonic == null){
            if (!mnemonic){
                mnemonic = bip39.generateMnemonic()
            }
            wallet.mnemonic = mnemonic
            
            var seed = bip39.mnemonicToSeedSync(mnemonic)
            wallet.seed = seed
        }
        
        var root = bip32.fromSeed(wallet.seed, network)
        var account = root.derivePath("m/44'/0'/0'") //master -> legacy -> bitcoin coin -> first account
        var address = account.derive(0).derive(addressIndex) // no change -> address index
        
        var testAddress = null
        switch (addressType){
            case "legacy":
                testAddress = bitcoin.payments.p2pkh({ pubkey: address.publicKey, network }).address
                break
            case "segwit":
                // Native segwit (P2WPKH). Required by the Taproot envelope: its commit
                // inputs must all be segwit (envelope spec §3.5) because a legacy input's
                // txid still moves when it is signed, and the reveal is pre-built
                // against the UNSIGNED commit's txid.
                testAddress = bitcoin.payments.p2wpkh({ pubkey: address.publicKey, network }).address
                break
        }
        if (testAddress == null){
            throw new Error("unsupported addressType \""+addressType+"\" (supported: legacy, segwit)")
        }
        wallet["addresses"].push({privateKey: address.privateKey, publicKey: address.publicKey, address:testAddress})
        return {mnemonic: wallet.mnemonic, privateKey: address.privateKey, publicKey: address.publicKey, address:testAddress}
    },
    
    async getNewFundedAddress(label, coin, network, mnemonic = null, addressType="legacy", addressIndex=0, amountToFund, seedGas = true){
        let newAddressInfo = await this.getNewAddress(label, coin, network, mnemonic, addressType, addressIndex)
        let newAddress = newAddressInfo["address"]

        console.log("Sending funds ("+amountToFund+") to "+newAddress)
        let txId = await regtestMinerConnector.sendFunds(newAddress, amountToFund)
        try {
            let txExists = await nodeConnector.waitForTx(txId)

            if (!txExists){
                throw new Error("The sent tx didn't appear in the blockchain")
            }
        } catch (err){
            throw new Error("The sent tx didn't appear in the blockchain")
        }
        console.log("Waiting for the utxos for "+newAddress)
        // First pass: short wait, then if it stalls force-mine a block in case
        // the funding tx is stuck in the regtest miner's mempool (happens under
        // full-suite load when many funding txes pile up). Late-suite tests
        // (OWNERSHIP onwards) flake here under accumulated load; bumped from
        // 3×20s to 6×30s (60s → 180s patience) to absorb that.
        let addressHasUtxos = false
        for (let attempt = 1; attempt <= 6 && !addressHasUtxos; attempt++){
            try {
                addressHasUtxos = await utxoTrackerConnector.waitForUtxos(newAddress, 30000)
            } catch (err) {
                addressHasUtxos = false
            }
            if (!addressHasUtxos) {
                // Log tracker/node sync state so the next stall has diagnosable
                // evidence (block-height lag vs total stuck vs node not advancing).
                const sync = await utxoTrackerConnector.getSyncStatus()
                const syncStr = sync ? `tracker=${sync.tracker_height} node=${sync.node_height} lag=${sync.lag}` : "sync-status=unavailable"
                console.log(`UTXOs still not visible (${syncStr}); nudging miner to mine a block (attempt ${attempt}/6)`)
                try { await regtestMinerConnector.generateBlocks(1) } catch (e) {}
            }
        }
        if (!addressHasUtxos){
            const sync = await utxoTrackerConnector.getSyncStatus()
            const syncStr = sync ? `tracker=${sync.tracker_height} node=${sync.node_height} lag=${sync.lag}` : "sync-status=unavailable"
            throw new Error(`The utxo tracker couldn't parse the utxo (${syncStr})`)
        }

        if (seedGas) {
            // UNIFIED_FEES + ISSUANCE_FEE activate at block 0 on regtest/testnet, so a
            // freshly funded address can't pay gas-schedule fees (ISSUE = 1 XCHAIN).
            // XCHAIN is an open-mint faucet on test networks; grab gas here so every
            // "funded" address is actually usable. Tests that need a zero-gas address
            // (e.g. the native-fee negative case) pass seedGas=false.
            const gasHelper = require('./helpers/gasHelper')
            console.log("Minting 100 XCHAIN gas to " + newAddress)
            await gasHelper.ensureGasBalance(newAddressInfo, 100)
        }

        return newAddressInfo
    }
}

