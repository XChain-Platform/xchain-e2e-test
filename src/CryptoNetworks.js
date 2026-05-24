/*********************************************************************
 * 
 * Copyright © 2025 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * Licensed under the Dankest Community License (Apache License 2.0 + Additional Terms).
 * You may not use this file except in compliance with that License.
 * 
 * A copy of the License is available at:
 *     https://dankest.llc/license
 *
 * This software is provided “AS IS”, without warranties or conditions of any kind.
 * 
 **********************************************************************
 *
 * XChain End-to-End Test Suite - Crypto Networks Class
 * 
 * This file handles getting a bitcoinJS config for a specific network
 * 
 ********************************************************************/

// Load required libraries
const bitcoin = require('bitcoinjs-lib');

class CryptoNetworks {
    static getBitcoinJsNetwork(networkName){
        switch(networkName){
            case "bitcoin-mainnet":
                return { ...bitcoin.networks.bitcoin, dustThreshold: 546 }
            case "bitcoin-testnet":
                return { ...bitcoin.networks.testnet, dustThreshold: 546 }
            case "bitcoin-regtest":
                return { ...bitcoin.networks.regtest, dustThreshold: 546 }
            case "dogecoin-mainnet":
                return {
                    "messagePrefix": '\x19Dogecoin Signed Message:\n',
                    "bip32": {
                       "public": 0x02facafd,
                       "private": 0x02fac398
                    },
                    "pubKeyHash": 0x1e,
                    "scriptHash": 0x16,
                    "wif": 0x9e,
                    "dustThreshold": 546
                }
            case "dogecoin-testnet":
                return {
                    "messagePrefix": '\x19Dogecoin Signed Message:\n',
                    "bip32": {
                       "public": 0x0432a9a8,
                       "private": 0x0432a243
                    },
                    "pubKeyHash": 0x71,
                    "scriptHash": 0xc4,
                    "wif": 0xf1,
                    "dustThreshold": 546
                }
            case "dogecoin-regtest":
                // Dogecoin v1.14.x regtest reuses Bitcoin-testnet-style address
                // prefixes (pubKeyHash 0x6f → 'm'/'n', WIF 0xef → 'c'). It does
                // NOT use the Dogecoin testnet prefix (0x71 → 'n' starts but
                // different checksum space). Generating addresses with 0x71
                // here produces strings that dogecoind regards as "Invalid
                // Dogecoin address" and rejects any sendtoaddress against.
                return {
                    "messagePrefix": '\x19Dogecoin Signed Message:\n',
                    "bip32": {
                       "public": 0x043587cf,
                       "private": 0x04358394
                    },
                    "pubKeyHash": 0x6f,
                    "scriptHash": 0xc4,
                    "wif": 0xef,
                    "dustThreshold": 546
                }
            case "litecoin-mainnet":
                return {
                    "messagePrefix": '\x19Litecoin Signed Message:\n',
                    "bech32": 'ltc',
                    "bip32": {
                       "public": 0x019da462,
                       "private": 0x019d9cfe 
                    },
                    "pubKeyHash": 0x30,
                    "scriptHash": 0x32,
                    "wif": 0xb0,
                    "dustThreshold": 546
                }
            case "litecoin-testnet":
                return {
                    "messagePrefix": '\x19Litecoin Signed Message:\n',
                    "bech32": 'tltc',
                    "bip32": {
                       "public": 0x0436f6e1,
                       "private": 0x0436ef7d 
                    },
                    "pubKeyHash": 0x6f,
                    "scriptHash": 0xc4,
                    "wif": 0xef,
                    "dustThreshold": 546
                }
            case "litecoin-regtest":
                return {
                    "messagePrefix": '\x19Litecoin Signed Message:\n',
                    "bech32": 'rltc',
                    "bip32": {
                       "public": 0x0436f6e1,
                       "private": 0x0436ef7d 
                    },
                    "pubKeyHash": 0x6f,
                    "scriptHash": 0xc4,
                    "wif": 0xef,
                    "dustThreshold": 546
                }   
        }
    }
    
    static getFirstBlock(networkName){
        //TODO: this should get a config file from a server
        switch(networkName){
            case "bitcoin-mainnet":
                return 844000
            case "bitcoin-testnet":
                return 0
            case "bitcoin-regtest":
                return 0
        }
        
        return 0
    }
}

module.exports = CryptoNetworks