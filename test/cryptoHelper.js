const axios = require('axios');
const crypto = require('crypto');
const bip39 = require('bip39');
const ecc = require('tiny-secp256k1')
const { BIP32Factory } = require('bip32')
const bip32 = BIP32Factory(ecc)
const bitcoin = require('bitcoinjs-lib')
const CryptoNetworks = require('../src/CryptoNetworks')

const rpcUser = 'rpc';
const rpcPassword = 'rpc';
const url = 'http://localhost:8333';        

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
        }
        console.log(wallet)
        wallet["addresses"].push({privateKey: address.privateKey, publicKey: address.publicKey, address:testAddress})
        return {mnemonic:mnemonic, privateKey: address.privateKey, publicKey: address.publicKey, address:testAddress}
    }
}

