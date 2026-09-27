'use strict';

const NETWORK_BY_COIN = { BTC: 'bitcoin-testnet', DOGE: 'dogecoin-testnet' };

function isBlank(value) {
    return value === undefined || value === null || String(value).trim() === '';
}

function readTestnetTreasury(env) {
    const missing = [];
    if (isBlank(env.TESTNET_TREASURY_WIF)) missing.push('TESTNET_TREASURY_WIF');
    if (isBlank(env.TESTNET_TREASURY_ADDRESS)) missing.push('TESTNET_TREASURY_ADDRESS');
    if (missing.length) throw new Error('readTestnetTreasury: missing ' + missing.join(', '));
    return { wif: env.TESTNET_TREASURY_WIF, address: env.TESTNET_TREASURY_ADDRESS };
}

function buildTestnetSdk(XChainSDK, coin, explorerUrl) {
    const network = NETWORK_BY_COIN[coin];
    if (!network) throw new Error('buildTestnetSdk: unknown coin ' + coin);
    if (isBlank(explorerUrl)) throw new Error('buildTestnetSdk: explorerUrl is required');
    return new XChainSDK({ network, explorerUrl: explorerUrl.replace(/\/+$/, '') });
}

module.exports = { readTestnetTreasury, buildTestnetSdk };
