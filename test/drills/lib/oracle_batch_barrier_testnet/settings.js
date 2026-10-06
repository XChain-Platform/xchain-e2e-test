'use strict';

const {
    DEFAULT_MAX_BLOCK_AGE_S,
    DEFAULT_CATCHUP_SLACK_BLOCKS,
    DEFAULT_CATCHUP_TOLERANCE_S,
    DEFAULT_ORIGIN_ACTION_PAGE
} = require('./common');

function required(env, name, why) {
    const v = env[name];
    if (v === undefined || v === null || String(v).trim() === '') {
        throw new Error('oracleBatchBarrierTestnet: ' + name + ' is required (' + why + ')');
    }
    return String(v).trim();
}

function composeLiveChainFromEnv(env) {
    env = env || {};
    const decoder = {
        host: required(env, 'AT5_DECODER_DB_HOST', 'the decoder database is the chain in parsed form'),
        port: required(env, 'AT5_DECODER_DB_PORT', 'the decoder database port'),
        name: required(env, 'AT5_DECODER_DB_NAME', 'the decoder database name'),
        user: required(env, 'AT5_DECODER_DB_USER', 'the decoder database user'),
        pass: required(env, 'AT5_DECODER_DB_PASS', 'the decoder database password')
    };
    const coinNode = {
        host: required(env, 'AT5_NODE_HOST', 'the coin node RPC host'),
        port: required(env, 'AT5_NODE_PORT', 'the coin node RPC port'),
        user: required(env, 'AT5_NODE_USER', 'the coin node RPC user'),
        pass: required(env, 'AT5_NODE_PASS', 'the coin node RPC password')
    };
    const tracker = {
        host: required(env, 'AT5_TRACKER_HOST', 'the utxo tracker host'),
        port: required(env, 'AT5_TRACKER_PORT', 'the utxo tracker API port')
    };
    const feeDestination = required(env, 'AT5_FEE_DESTINATION',
        'a node replaying with the wrong fee destination rejects every fee the chain accepted');
    const btcHost = required(env, 'BTC_SERVICE_HOST',
        'the host publishing the Bitcoin indexer this node resolves signer sets from');
    const btcPort = required(env, 'BTC_INDEXER_API_PORT', 'the PUBLISHED JSON-RPC port of that Bitcoin indexer');
    const btcKey = required(env, 'BTC_INDEXER_API_KEY',
        'the Bitcoin indexer is authenticated; without the key the hub resolves no signer set at all');
    return {
        decoder,
        node: coinNode,
        tracker,
        btcOracle: {
            host: btcHost,
            port: btcPort,
            url: 'http://' + btcHost + ':' + btcPort,
            apiKey: btcKey,
            db: null
        },
        feeDestination,
        liveIndexer: null
    };
}

function readSettings(env) {
    env = env || {};
    const int = (name, dflt) => {
        const v = parseInt(env[name], 10);
        return Number.isFinite(v) && v > 0 ? v : dflt;
    };
    return {
        label: String(env.AT5_LABEL || 'at5').replace(/[^A-Za-z0-9]/g, '') || 'at5',
        basePort: int('AT5_BASE_PORT', 61000),
        observeBlocks: int('AT5_OBSERVE_BLOCKS', 6),
        minVerdicts: int('AT5_MIN_VERDICTS', 1),
        maxMinutes: int('AT5_MAX_MINUTES', 240),
        maxBlockAgeS: int('AT5_MAX_BLOCK_AGE_S', DEFAULT_MAX_BLOCK_AGE_S),
        originActionPage: int('AT5_ORIGIN_ACTION_PAGE', DEFAULT_ORIGIN_ACTION_PAGE),
        catchUpSlackBlocks: int('AT5_CATCHUP_SLACK_BLOCKS', DEFAULT_CATCHUP_SLACK_BLOCKS),
        catchUpToleranceS: int('AT5_CATCHUP_TOLERANCE_S', DEFAULT_CATCHUP_TOLERANCE_S),
        resultPath: String(env.AT5_RESULT || './at5-result.json'),
        originIndexerUrl: String(env.AT5_ORIGIN_INDEXER_URL || ''),
        explorerUrl: String(env.AT5_EXPLORER_URL || 'https://explorer.xchain.io').replace(/\/+$/, '')
    };
}

module.exports = { composeLiveChainFromEnv, readSettings };
