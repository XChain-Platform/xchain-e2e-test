/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 *********************************************************************/

'use strict';

const { encode: wifEncode } = require('wif');
const CryptoNetworks = require('../../../../src/crypto_networks');

// The hub wallet's private key as a WIF for the regtest coin network.
function wifEncodeFor(wallet){
    const network = CryptoNetworks.getBitcoinJsNetwork(COIN + '-' + NETWORK);
    return wifEncode(network.wif, Buffer.from(wallet.privateKey), true);
}

module.exports = { wifEncodeFor };
