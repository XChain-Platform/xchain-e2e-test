'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { encode: wifEncode } = require('wif');
const CryptoNetworks = require('../../../../src/crypto_networks');
const { loadHubModule, resolveHubFile } = require('../../../helpers/multiValidatorHubHelper');

async function indexedBtcBlock(){
    const url = process.env.BTC_INDEXER_API_URL;
    assert.ok(url, 'the BTC indexer URL is configured');
    const headers = { 'content-type': 'application/json' };
    if(process.env.BTC_INDEXER_API_KEY) headers['x-api-key'] = process.env.BTC_INDEXER_API_KEY;
    const response = await fetch(url, {
        method: 'POST', headers,
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getlatestblock', params: {} })
    });
    assert.ok(response.ok, 'the BTC indexer latest-block request succeeded');
    const body = await response.json();
    const block = Number(body.result && body.result.block_index);
    assert.ok(Number.isSafeInteger(block) && block >= 0, 'the BTC indexer returned a committed block');
    return block;
}

async function unusedSnapshotBlock(indexerQuery){
    const latest = await indexedBtcBlock();
    const floor = Math.max(0, latest - 1024);
    const ceiling = Math.max(0, latest - 12);
    const rows = await indexerQuery(
        'SELECT DISTINCT snapshot_block FROM capability_snapshots WHERE snapshot_block BETWEEN ? AND ?',
        [floor, ceiling]);
    const occupied = new Set(rows.map((row) => Number(row.snapshot_block)));
    for(let candidate = ceiling; candidate >= floor; candidate--)
        if(!occupied.has(candidate)) return candidate;
    assert.fail('no unused BTC snapshot block is available for the isolated capability fixture');
}

function stageProductionSigner(addressInfo){
    const example = resolveHubFile('examples/doge-signer.example.js');
    const signerDir = path.join(require('os').tmpdir(), 'xchain-fold-silenced-signer-' + process.pid);
    fs.rmSync(signerDir, { recursive: true, force: true });
    fs.mkdirSync(path.join(signerDir, 'node_modules'), { recursive: true });
    fs.copyFileSync(example, path.join(signerDir, 'signer.js'));
    for(const dependency of ['xchain-sdk', 'dotenv']){
        let target;
        try { target = path.dirname(require.resolve(dependency + '/package.json')); }
        catch(internalError){
            target = path.resolve(__dirname, '../../../../../', dependency);
            if(!fs.existsSync(target)) throw new Error('cannot resolve ' + dependency + ' for the staged signer');
        }
        fs.symlinkSync(target, path.join(signerDir, 'node_modules', dependency), 'dir');
    }
    const network = CryptoNetworks.getBitcoinJsNetwork(COIN + '-' + NETWORK);
    process.env.DOGE_NETWORK = COIN + '-' + NETWORK;
    process.env.DOGE_ADDRESS = addressInfo.address;
    process.env.DOGE_WIF = wifEncode(network.wif, Buffer.from(addressInfo.privateKey), true);
    process.env.DOGE_ENCODER_URL = 'http://' + (process.env.ENCODER_URL || 'localhost') + ':' +
        (process.env.ENCODER_API_PORT || '3023');
    process.env.HUB_SIGNER_MODULE = path.join(signerDir, 'signer.js');
    const hooks = loadHubModule('src/lib/signer_loader.js').loadSignerHooks(process.env);
    assert.ok(hooks && hooks.broadcastFn, 'the production signer exposes its broadcast hook');
    return { hooks, signerDir };
}

module.exports = { unusedSnapshotBlock, stageProductionSigner };
