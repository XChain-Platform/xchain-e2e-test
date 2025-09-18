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

module.exports = {
    async getNewAddress(coin, network, mnemonic = null, addressType, addressIndex){
        network = CryptoNetworks.getBitcoinJsNetwork(coin+"-"+network)
        
        if (!mnemonic){
            mnemonic = bip39.generateMnemonic()
        }
        
        var seed = bip39.mnemonicToSeedSync(mnemonic)
        var root = bip32.fromSeed(seed, network)
        var account = root.derivePath("m/44'/0'/0'") //master -> legacy -> bitcoin coin -> first account
        var address = account.derive(0).derive(0) // no change -> first address
        
        var testAddress = null
        switch (addressType){ 
            case "legacy":
                testAddress = bitcoin.payments.p2pkh({ pubkey: address.publicKey, network }).address
                break
        }
        
        return {mnemonic:mnemonic, privateKey: address.privateKey, publicKey: address.publicKey, address:testAddress}
    }
}

