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

const CryptoNetworks = require('../../../src/crypto_networks');
const { loadHubModule, resolveHubFile } = require('../../helpers/multiValidatorHubHelper');
const { S } = require('./state');

// The staged production signer, exactly as anchorAcceptance stages it: the
// module an operator installs in ~/hub-signer, loaded through the hub's REAL
// signer-loader, driving the sdk two-phase P2SH pipeline. A walletSign-only
// hook would skip the phase-2 reveal leg, which is where the 2026-06-11
// mainnet shakedown bug hid. Staged once and reused by every federation.
function stageProductionSigner(addressInfo){
    const examplePath = resolveHubFile('examples/doge-signer.example.js');
    // os.tmpdir(), never __dirname: the e2e tree may sit on a Parallels share
    // where symlink creation is unreliable.
    S.signerDir = path.join(require('os').tmpdir(), 'xchain-degraded-archive-signer-' + process.pid);
    fs.rmSync(S.signerDir, { recursive: true, force: true });
    fs.mkdirSync(path.join(S.signerDir, 'node_modules'), { recursive: true });
    fs.copyFileSync(examplePath, path.join(S.signerDir, 'signer.js'));
    for (const dep of ['xchain-sdk', 'dotenv']) {
        let target;
        try { target = path.dirname(require.resolve(dep + '/package.json')); }
        catch (e) {
            target = path.resolve(__dirname, '../../../', dep);            // monorepo sibling checkout
            if (!fs.existsSync(target)) throw new Error('cannot resolve ' + dep + ' for the staged signer');
        }
        fs.symlinkSync(target, path.join(S.signerDir, 'node_modules', dep), 'dir');
    }

    // The signer's .env contract via process env (dotenv never overrides an
    // existing var, no .env file is written, the WIF stays in memory).
    const network = CryptoNetworks.getBitcoinJsNetwork(COIN + '-' + NETWORK);
    process.env.DOGE_NETWORK     = COIN + '-' + NETWORK;
    process.env.DOGE_ADDRESS     = addressInfo.address;
    process.env.DOGE_WIF         = wifEncode(network.wif, Buffer.from(addressInfo.privateKey), true);
    process.env.DOGE_ENCODER_URL = 'http://' + (process.env.ENCODER_URL || 'localhost') + ':' +
                                   (process.env.ENCODER_API_PORT || '3023');
    process.env.HUB_SIGNER_MODULE = path.join(S.signerDir, 'signer.js');

    const { loadSignerHooks } = loadHubModule('src/lib/signer_loader.js');
    const hooks = loadSignerHooks(process.env);
    assert.ok(hooks && hooks.broadcastFn, 'signer-loader wired the example signer\'s broadcast hook');
    return hooks;
}

module.exports = { stageProductionSigner };
