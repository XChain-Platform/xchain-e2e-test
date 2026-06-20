/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 ********************************************************************/

const bitcoin = require('bitcoinjs-lib');

class CryptoNetworks {
    static getBitcoinJsNetwork(networkName){
        switch(networkName){
            case "bitcoin-mainnet":
                return { ...bitcoin.networks.bitcoin, dustThreshold: 546, minStandardTxNonWitnessSize: 65, singleOpReturnPolicy: true }
            case "bitcoin-testnet":
                return { ...bitcoin.networks.testnet, dustThreshold: 546, minStandardTxNonWitnessSize: 65, singleOpReturnPolicy: true }
            case "bitcoin-regtest":
                return { ...bitcoin.networks.regtest, dustThreshold: 546, minStandardTxNonWitnessSize: 65, singleOpReturnPolicy: true }
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
                    "dustThreshold": 100000,
                    "supportsSegwit": false,
                    "singleOpReturnPolicy": false
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
                    "dustThreshold": 100000,
                    "supportsSegwit": false,
                    "singleOpReturnPolicy": false
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
                    "dustThreshold": 100000,
                    "supportsSegwit": false,
                    "singleOpReturnPolicy": false
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
                    "dustThreshold": 5460,
                    "minStandardTxNonWitnessSize": 85,
                    "singleOpReturnPolicy": false
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
                    "dustThreshold": 5460,
                    "minStandardTxNonWitnessSize": 85,
                    "singleOpReturnPolicy": false
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
                    "dustThreshold": 5460,
                    "minStandardTxNonWitnessSize": 85,
                    "singleOpReturnPolicy": false
                }   
        }
    }
    
    static getFirstBlock(networkName){
        // Kept in sync with xchain-decoder / xchain-encoder (the canonical start
        // heights). These are the indexing boundary only, not part of any consensus
        // hash. Re-pinned near tip pre-launch (2026-06-19); dogecoin-mainnet sits just
        // below its first live anchor (6,243,921) so anchors are kept. e2e runs on
        // regtest, where all networks return 0 via the default.
        switch(networkName){
            case "bitcoin-mainnet":
                return 950000
            case "bitcoin-testnet":
                return 138000
            case "litecoin-mainnet":
                return 3120000
            case "litecoin-testnet":
                return 4765000
            case "dogecoin-mainnet":
                return 6240000
            case "dogecoin-testnet":
                // DOGE testnet mints min-difficulty blocks ~every 20s and runs tens of
                // millions of blocks ahead of the other networks; anchored near tip.
                return 64800000
            // All regtest networks start parsing at block 0
            default:
                return 0
        }
    }
}

module.exports = CryptoNetworks