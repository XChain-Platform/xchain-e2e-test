/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 *********************************************************************/

'use strict';

const assert = require('assert');
const path   = require('path');
const fs     = require('fs');
const { encode: wifEncode } = require('wif');

const CryptoNetworks = require('../../../../src/crypto_networks');
const { loadHubModule, resolveHubFile } = require('../../../helpers/multiValidatorHubHelper');
const { S } = require('./state');

// Resolve a dependency for the staged signer: the checkout the e2e host already
// has, else the monorepo sibling.
function resolveSignerDep(dep){
    try { return path.dirname(require.resolve(dep + '/package.json')); }
    catch (e) {
        const target = path.resolve(__dirname, '../../../../../', dep);            // monorepo sibling checkout
        if (!fs.existsSync(target)) throw new Error('cannot resolve ' + dep + ' for the staged signer');
        return target;
    }
}

// The signer's .env contract, via process env (dotenv never overrides
// existing vars, and no .env file is written; the WIF stays in memory).
function exportSignerEnv(addressInfo){
    const network = CryptoNetworks.getBitcoinJsNetwork(COIN + '-' + NETWORK);
    process.env.DOGE_NETWORK     = COIN + '-' + NETWORK;
    process.env.DOGE_ADDRESS     = addressInfo.address;
    process.env.DOGE_WIF         = wifEncode(network.wif, Buffer.from(addressInfo.privateKey), true);
    process.env.DOGE_ENCODER_URL = 'http://' + (process.env.ENCODER_URL || 'localhost') + ':' +
                                   (process.env.ENCODER_API_PORT || '3023');
    process.env.HUB_SIGNER_MODULE = path.join(S.signerDir, 'signer.js');
}

// Stage examples/doge-signer.example.js the way an operator installs it:
// its own directory with its own node_modules (symlinked to the checkouts
// the e2e host already has), loaded via HUB_SIGNER_MODULE through the
// hub's REAL signer-loader boot path.
function stageProductionSigner(addressInfo){
    const examplePath = resolveHubFile('examples/doge-signer.example.js');
    // os.tmpdir(), NOT __dirname: the e2e tree may live on a Parallels
    // share where symlink creation is unreliable; /tmp is always local.
    S.signerDir = path.join(require('os').tmpdir(), 'xchain-anchor-signer-' + process.pid);
    fs.rmSync(S.signerDir, { recursive: true, force: true });
    fs.mkdirSync(path.join(S.signerDir, 'node_modules'), { recursive: true });
    fs.copyFileSync(examplePath, path.join(S.signerDir, 'signer.js'));
    for (const dep of ['xchain-sdk', 'dotenv'])
        fs.symlinkSync(resolveSignerDep(dep), path.join(S.signerDir, 'node_modules', dep), 'dir');

    exportSignerEnv(addressInfo);

    const { loadSignerHooks } = loadHubModule('src/lib/signer_loader.js');
    const hooks = loadSignerHooks(process.env);
    assert.ok(hooks && hooks.broadcastFn, 'signer-loader wired the example signer\'s broadcast hook');
    return hooks;
}

module.exports = { stageProductionSigner };
